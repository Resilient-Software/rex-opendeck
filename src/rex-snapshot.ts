/**
 * Turns the snapshot script's output into the deck's model. Workspace = Rex
 * session, Tab = Rex window, Pane = Rex block. Lua encodes empty tables as {}
 * and drops nil fields, so every list goes through list().
 */
import type { Tokens } from "./activity";
import type { RexClient } from "./rex-focus";
import { SHELLS } from "./snapshot-lua";

export type AgentStatus = "blocked" | "done" | "idle" | "unknown" | "working";

export type Pane = {
	pane_id: string;
	workspace_id: string;
	tab_id?: string;
	agent?: string;
	agent_status: AgentStatus;
	focused: boolean;
	cwd?: string;
	/** Synthesised from child program status records, see activityTokens. */
	tokens?: Tokens;
};

export type Tab = {
	tab_id: string;
	workspace_id: string;
	number: number;
	label?: string;
	focused: boolean;
};

/** Per tab; focused_pane_id is kept while the tab is in the background. */
export type Layout = {
	tab_id: string;
	focused_pane_id?: string;
};

export type Worktree = {
	checkout_path: string;
	repo_name: string;
};

export type Workspace = {
	workspace_id: string;
	number: number;
	label: string;
	agent_status: AgentStatus;
	/** Overrides the footer word: the winning pane's root reported an error. */
	status_word?: "ERROR";
	pane_count: number;
	tab_count: number;
	focused: boolean;
	worktree: Worktree | null;
	active_tab_id?: string;
	tokens?: Tokens;
};

/** The focused_* ids are absent when no session is known to be in view. */
export type Snapshot = {
	focused_workspace_id?: string;
	focused_tab_id?: string;
	focused_pane_id?: string;
	panes: Pane[];
	workspaces: Workspace[];
	tabs?: Tab[];
	layouts?: Layout[];
};

export type RawRecord = {
	id?: string;
	state?: string;
	app?: string;
	effective_app?: string;
	updated_at?: string;
	owner?: { pid?: number };
};

export type RawForeground = {
	pid?: number;
	name?: string;
	argv0?: string;
	cwd?: string;
};

/** The pane's first process: its shell when started with no login step, else login. */
export type RawChild = { pid?: number } | null;

export type RawBlock = {
	block_id: string;
	creator_name?: string;
	records?: RawRecord[] | object;
	foreground?: RawForeground | null;
	child?: RawChild;
};

export type RawWindow = {
	window_id: string;
	label?: string;
	focused_block_id?: string;
	blocks?: RawBlock[] | object;
};

export type RawSession = {
	session_id: string;
	number: number;
	label?: string;
	active_window_id?: string;
	windows?: RawWindow[] | object;
};

export type RawSnapshot = {
	clients?: RexClient[] | object;
	sessions?: RawSession[] | object;
};

const TERMINAL = "com.superlogical.terminal";
const KNOWN_AGENTS = new Set(["claude", "codex", "opencode", "gemini", "aider", "amp", "cursor-agent", "goose"]);
const SHELL_NAMES = new Set(SHELLS);
const UNLABELLED_WINDOW = /^Window [0-9a-f]{8}$/;

export function list<T>(value: T[] | object | null | undefined): T[] {
	return Array.isArray(value) ? value : [];
}

function terminalBlocks(window: RawWindow): RawBlock[] {
	return list<RawBlock>(window.blocks).filter((block) => block.creator_name === TERMINAL);
}

function program(path: string | undefined): string {
	return (path ?? "").split("/").at(-1)?.replace(/^-/, "") ?? "";
}

export function isShellForeground(foreground: RawForeground | null | undefined): boolean {
	return !foreground || SHELL_NAMES.has(program(foreground.argv0 ?? foreground.name));
}

function isActivityRecord(record: RawRecord): boolean {
	return (record.id ?? "").startsWith("rsact/");
}

function isRoot(record: RawRecord): boolean {
	return !record.id;
}

/**
 * Rex credits a report to whichever process is in front at the time and keeps
 * that pid, so a record naming another pid comes from something now gone or
 * behind. An ownerless record could be anyone's.
 */
function isLeftover(record: RawRecord, foreground: RawForeground | null | undefined): boolean {
	return record.owner?.pid !== undefined && record.owner.pid !== foreground?.pid;
}

function ownRecord(foreground: RawForeground, records: readonly RawRecord[]): RawRecord | undefined {
	return records.find((record) => !isActivityRecord(record) && record.owner?.pid !== undefined && record.owner.pid === foreground.pid);
}

/**
 * Rex names the process group leader as the foreground and credits a report to
 * it, so an agent behind a script that does not exec shows the script's shell,
 * which then owns the agent's records. A login shell or the pane's first process
 * owning a record is only a shell that printed one at its prompt.
 */
export function isAtPrompt(foreground: RawForeground | null | undefined, records: readonly RawRecord[], child?: RawChild): boolean {
	if (!foreground || !isShellForeground(foreground)) {
		return !foreground;
	}
	return (foreground.argv0 ?? foreground.name ?? "").startsWith("-") || foreground.pid === child?.pid || !ownRecord(foreground, records);
}

/**
 * Claude's foreground `name` is a version string, so the basename of argv0 is
 * what identifies it. A wrapper can show `node`, `python` or a shell, and then
 * needs a record the foreground process itself reported.
 */
export function agentOf(foreground: RawForeground | null | undefined, records: readonly RawRecord[], child?: RawChild): string | undefined {
	if (!foreground || isAtPrompt(foreground, records, child)) {
		return undefined;
	}
	const name = program(foreground.argv0);
	if (KNOWN_AGENTS.has(name)) {
		return name;
	}
	const own = ownRecord(foreground, records);
	return own ? own.app || own.effective_app || name : undefined;
}

const PRIORITY: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };

function fromState(state: string | undefined): AgentStatus {
	switch (state) {
		case "blocked":
		case "working":
		case "idle":
		case "done":
			return state;
		case "error":
			return "done";
		default:
			return "unknown";
	}
}

function isFinished(record: RawRecord | undefined): boolean {
	return record?.state === "done" || record?.state === "error";
}

export type PaneStatus = { status: AgentStatus; error: boolean };

/**
 * Rex keeps `done` until the next prompt, whether or not anyone looked, so a
 * root the user has seen reads as idle, or as unknown with no agent left to be
 * idle. With no agent in front only a finished root outlives its owner: under a
 * shell every other record is ignored, and under another program so is any other
 * leftover. A new agent starts clean, so a leftover root says nothing about it.
 */
export function paneStatus(block: RawBlock, seenAt: string | undefined): PaneStatus {
	const all = list<RawRecord>(block.records);
	const records = all.filter((record) => !isActivityRecord(record));
	const root = records.find(isRoot);
	const agent = agentOf(block.foreground, all, block.child);
	const finished = (): PaneStatus =>
		root?.updated_at !== undefined && root.updated_at === seenAt
			? { status: agent ? "idle" : "unknown", error: false }
			: { status: "done", error: root?.state === "error" };
	if (isAtPrompt(block.foreground, all, block.child)) {
		return isFinished(root) ? finished() : { status: "unknown", error: false };
	}
	const current = records.filter((record) => !isLeftover(record, block.foreground));
	if (current.some((record) => record.state === "blocked")) {
		return { status: "blocked", error: false };
	}
	if (root && current.includes(root)) {
		return isFinished(root) ? finished() : { status: fromState(root.state), error: false };
	}
	if (!agent && isFinished(root)) {
		return finished();
	}
	const urgent = current.map((record) => fromState(record.state)).sort((a, b) => PRIORITY[b] - PRIORITY[a])[0];
	return { status: urgent ?? "unknown", error: false };
}

export type ActivityCounts = {
	subagents: number;
	background: number;
	monitors: number;
	nextAt: number | null;
	loop: boolean;
};

const NEXT_ID = /^rsact\/next\/(\d+)(\.loop)?$/;

function lastSegment(id: string): string {
	return id.split("/").at(-1) ?? id;
}

/**
 * The record contract's rsact/* ids plus Claude's native subagent records,
 * which share their last segment with rsact/sub ids when both report one.
 */
export function activityCounts(records: readonly RawRecord[]): ActivityCounts {
	const counts: ActivityCounts = { subagents: 0, background: 0, monitors: 0, nextAt: null, loop: false };
	const subagents = new Set<string>();
	for (const record of records) {
		const id = record.id ?? "";
		const next = NEXT_ID.exec(id);
		if (next && record.state === "idle") {
			const at = Number(next[1]) * 1000;
			// Any bytes reaching the terminal can set this id, and a time past what a Date holds would fail the whole snapshot.
			if (!Number.isNaN(new Date(at).getTime()) && (counts.nextAt === null || at < counts.nextAt)) {
				counts.nextAt = at;
				counts.loop = next[2] !== undefined;
			}
		} else if (id.startsWith("rsact/sub/") && record.state === "working") {
			subagents.add(lastSegment(id));
		} else if (id.startsWith("rsact/bg/") && record.state === "working") {
			counts.background++;
		} else if (id.startsWith("rsact/mon/") && record.state === "working") {
			counts.monitors++;
		} else if (
			id &&
			!id.startsWith("rsact/") &&
			(record.state === "working" || record.state === "blocked") &&
			(record.app || record.effective_app) === "claude-code"
		) {
			subagents.add(lastSegment(id));
		}
	}
	counts.subagents = subagents.size;
	return counts;
}

function primaryState(counts: ActivityCounts): string | null {
	if (counts.subagents > 0) {
		return "subagents";
	}
	if (counts.background + counts.monitors > 0) {
		return "background";
	}
	return counts.nextAt !== null ? "scheduled" : null;
}

function tokensFrom(counts: ActivityCounts): Tokens | undefined {
	const state = primaryState(counts);
	if (!state) {
		return undefined;
	}
	const tokens: Tokens = { rsact_v: "1", rsact_state: state };
	if (counts.subagents) {
		tokens.rsact_subagents = String(counts.subagents);
	}
	if (counts.background) {
		tokens.rsact_background = String(counts.background);
	}
	if (counts.monitors) {
		tokens.rsact_monitors = String(counts.monitors);
	}
	if (counts.nextAt !== null) {
		tokens.rsact_next_at = new Date(counts.nextAt).toISOString();
	}
	if (counts.loop) {
		tokens.rsact_loop = "1";
	}
	return tokens;
}

function mergeCounts(all: readonly ActivityCounts[]): ActivityCounts {
	const merged: ActivityCounts = { subagents: 0, background: 0, monitors: 0, nextAt: null, loop: false };
	for (const counts of all) {
		merged.subagents += counts.subagents;
		merged.background += counts.background;
		merged.monitors += counts.monitors;
		if (counts.nextAt !== null && (merged.nextAt === null || counts.nextAt < merged.nextAt)) {
			merged.nextAt = counts.nextAt;
			merged.loop = counts.loop;
		}
	}
	return merged;
}

export type BuildOptions = {
	focusedSessionId?: string;
	seen?: ReadonlyMap<string, string>;
};

export function buildSnapshot(raw: RawSnapshot, { focusedSessionId, seen }: BuildOptions = {}): Snapshot {
	const snapshot: Snapshot = { panes: [], workspaces: [], tabs: [], layouts: [] };
	for (const session of list<RawSession>(raw.sessions)) {
		const windows = list<RawWindow>(session.windows);
		const focused = session.session_id === focusedSessionId;
		if (focused) {
			snapshot.focused_workspace_id = session.session_id;
		}
		const paneResults: PaneStatus[] = [];
		const paneCounts: ActivityCounts[] = [];
		for (const [index, window] of windows.entries()) {
			const active = window.window_id === session.active_window_id;
			const blocks = terminalBlocks(window);
			const focusedBlock = blocks.some((block) => block.block_id === window.focused_block_id) ? window.focused_block_id : undefined;
			snapshot.tabs!.push({
				tab_id: window.window_id,
				workspace_id: session.session_id,
				number: index + 1,
				...(window.label && !UNLABELLED_WINDOW.test(window.label) ? { label: window.label } : {}),
				focused: focused && active,
			});
			snapshot.layouts!.push({ tab_id: window.window_id, ...(focusedBlock ? { focused_pane_id: focusedBlock } : {}) });
			if (focused && active) {
				snapshot.focused_tab_id = window.window_id;
				snapshot.focused_pane_id = focusedBlock;
			}
			for (const block of blocks) {
				const records = list<RawRecord>(block.records);
				const result = paneStatus(block, seen?.get(block.block_id));
				const agent = agentOf(block.foreground, records, block.child);
				const counts = agent ? activityCounts(records.filter((record) => !isLeftover(record, block.foreground))) : undefined;
				const tokens = counts && tokensFrom(counts);
				paneResults.push(result);
				if (counts) {
					paneCounts.push(counts);
				}
				snapshot.panes.push({
					pane_id: block.block_id,
					workspace_id: session.session_id,
					tab_id: window.window_id,
					...(agent ? { agent } : {}),
					agent_status: result.status,
					focused: focused && active && block.block_id === focusedBlock,
					...(block.foreground?.cwd ? { cwd: block.foreground.cwd } : {}),
					...(tokens ? { tokens } : {}),
				});
			}
		}
		const rollup = paneResults.reduce<AgentStatus>((best, { status }) => (PRIORITY[status] > PRIORITY[best] ? status : best), "unknown");
		const tokens = tokensFrom(mergeCounts(paneCounts));
		snapshot.workspaces.push({
			workspace_id: session.session_id,
			number: session.number,
			label: session.label ?? "",
			agent_status: rollup,
			...(rollup === "done" && paneResults.some(({ status, error }) => status === "done" && error) ? { status_word: "ERROR" as const } : {}),
			pane_count: paneResults.length,
			tab_count: windows.length,
			focused,
			worktree: null,
			...(session.active_window_id ? { active_tab_id: session.active_window_id } : {}),
			...(tokens ? { tokens } : {}),
		});
	}
	return snapshot;
}

/**
 * The deck's own "have you looked" memory, per block: the root updated_at last
 * in view while Rex was in front. In memory only, so after a plugin restart
 * panes read DONE until viewed.
 */
export class SeenTracker {
	public readonly seen = new Map<string, string>();

	constructor(private readonly isFrontmost: () => Promise<boolean>) {}

	public async update(raw: RawSnapshot, focusedSessionId: string | undefined): Promise<void> {
		const live = new Set<string>();
		const candidates = new Map<string, string>();
		for (const session of list<RawSession>(raw.sessions)) {
			for (const window of list<RawWindow>(session.windows)) {
				const inView = session.session_id === focusedSessionId && window.window_id === session.active_window_id;
				for (const block of terminalBlocks(window)) {
					live.add(block.block_id);
					const root = list<RawRecord>(block.records).find(isRoot);
					if (inView && isFinished(root) && root?.updated_at && this.seen.get(block.block_id) !== root.updated_at) {
						candidates.set(block.block_id, root.updated_at);
					}
				}
			}
		}
		for (const id of this.seen.keys()) {
			if (!live.has(id)) {
				this.seen.delete(id);
			}
		}
		if (candidates.size > 0 && (await this.isFrontmost())) {
			for (const [id, updatedAt] of candidates) {
				this.seen.set(id, updatedAt);
			}
		}
	}
}
