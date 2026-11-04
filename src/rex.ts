/**
 * Talks to the rex CLI to observe and control the current Rex server. Every
 * call is one short process, on purpose: the CLI carries the whole protocol,
 * and each script holds one connection for as long as it needs.
 */
import { execFile } from "node:child_process";
import { isAbsolute, basename as pathBasename } from "node:path";
import { statSync } from "node:fs";
import { promisify } from "node:util";

import { resolveBinary } from "./rex-binary";
import { classifyRexError, RexApiError } from "./rex-errors";
import { ChangeFilter, type ChangeStream, startChangeStream } from "./rex-events";
import { chooseAppClient, FocusTracker, isRexFrontmost, readFocusPreference, REX_BUNDLE_ID, type RexClient } from "./rex-focus";
import { toRexKey } from "./rex-keys";
import { buildSnapshot, list, type RawBlock, type RawChild, type RawRecord, type RawSession, type RawSnapshot, type RawWindow, SeenTracker, type Snapshot, type Workspace } from "./rex-snapshot";
import { CLIENTS_SCRIPT, INPUT_SCRIPT, PROMPT_SCRIPT, SNAPSHOT_SCRIPT, WRITE_SCRIPT } from "./snapshot-lua";

export { resolveBinary } from "./rex-binary";
export type { AgentStatus, Layout, Pane, Snapshot, Tab, Workspace, Worktree } from "./rex-snapshot";

const execFileAsync = promisify(execFile);

const RUN_TIMEOUT_MS = 2500;
/** Below the kill above, so rex reports the failure itself. Default 10 s; -C to a non-app client blocks for all of it. */
const CLI_TIMEOUT = "2s";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type GitInfo = {
	/** Repository directory name, or the cwd's basename outside git. */
	repo: string;
	/** Current branch, or short commit hash when detached; empty outside git. */
	branch: string;
};

export type BridgeOptions = {
	log?: (message: string) => void;
	readPreference?: () => Promise<string | null>;
	isFrontmost?: () => Promise<boolean>;
	now?: () => number;
};

function toRexError(err: unknown): RexApiError {
	const failure = err as NodeJS.ErrnoException & { stderr?: unknown; killed?: boolean };
	const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
	const exitCode = typeof failure.code === "number" ? failure.code : undefined;
	if (exitCode === undefined && !stderr) {
		return new RexApiError(failure.killed ? "timeout" : "no_binary", failure.message);
	}
	return new RexApiError(classifyRexError(exitCode, stderr), stderr.trim().split("\n")[0] || failure.message);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export class Bridge {
	private binary = "";
	private readonly blocks = new Map<string, { sessionId: string; records: readonly RawRecord[]; child?: RawChild }>();
	private failuresSinceResolve = 0;
	private readonly focus: FocusTracker;
	private readonly log: (message: string) => void;
	private readonly seen: SeenTracker;
	private stream: ChangeStream | undefined;

	constructor(opts?: BridgeOptions) {
		this.log = opts?.log ?? (() => {});
		this.focus = new FocusTracker(opts?.readPreference ?? readFocusPreference, opts?.now);
		this.seen = new SeenTracker(opts?.isFrontmost ?? isRexFrontmost);
	}

	public close(): void {
		this.stream?.close();
		this.stream = undefined;
	}

	/** A select failure is logged, not thrown: a second press must not create a duplicate. */
	public async createTab(workspaceId: string, cwd: string | undefined): Promise<void> {
		if (cwd && !(isAbsolute(cwd) && isDirectory(cwd))) {
			throw new RexApiError("no_such_dir", `no such directory: ${cwd}`);
		}
		const client = await this.requireClient();
		const created = JSON.parse(await this.run(["window", "new", "-s", workspaceId, ...(cwd ? ["-c", cwd] : []), "--json"])) as { window_id: string };
		await this.selectAfterCreate(client, workspaceId, created.window_id);
	}

	public async createWorkspace(): Promise<void> {
		const client = await this.requireClient();
		const created = JSON.parse(await this.run(["new", "--json"])) as { session_id: string };
		await this.selectAfterCreate(client, created.session_id);
	}

	public async focusWorkspace(workspaceId: string): Promise<void> {
		await this.select(await this.requireClient(), workspaceId);
	}

	public async promptAgent(paneId: string, text: string): Promise<void> {
		await this.script(PROMPT_SCRIPT, { session_id: this.sessionOf(paneId), block_id: paneId, text });
	}

	public async sendInput(paneId: string, text: string): Promise<void> {
		await this.script(INPUT_SCRIPT, { session_id: this.sessionOf(paneId), block_id: paneId, text });
	}

	public async sendKeys(paneId: string, keys: string[]): Promise<void> {
		const mapped = keys.map((key) => {
			const name = toRexKey(key);
			if (name === undefined) {
				throw new RexApiError("invalid_key", `unsupported key ${key}`);
			}
			return name;
		});
		await this.run(["send-key", "-s", this.sessionOf(paneId), "-b", paneId, "--", ...mapped]);
	}

	public async sendText(paneId: string, text: string): Promise<void> {
		await this.script(WRITE_SCRIPT, { session_id: this.sessionOf(paneId), block_id: paneId, text });
	}

	public async snapshot(): Promise<Snapshot> {
		const [raw] = await Promise.all([this.rawSnapshot(), this.focus.refreshPreference()]);
		this.focus.updateClients(list<RexClient>(raw.clients));
		const focusedSessionId = this.focus.focusedSessionId;
		await this.seen.update(raw, focusedSessionId);
		this.rememberBlocks(raw);
		return buildSnapshot(raw, { focusedSessionId, seen: this.seen.seen });
	}

	public async subscribeChanges(onChange: () => void, onClose: () => void): Promise<void> {
		const binary = await this.resolved();
		const filter = new ChangeFilter(
			{ onChange, onSizeChanged: (change) => this.focus.sizeChanged(change) },
			(blockId) => this.blocks.get(blockId) ?? {},
		);
		this.stream = await startChangeStream(binary, [...this.serverArgs(), "events", "--all", "--json"], filter, () => {
			this.stream = undefined;
			onClose();
		});
	}

	private async rawSnapshot(): Promise<RawSnapshot> {
		let out: string;
		try {
			out = await this.script(SNAPSHOT_SCRIPT);
			this.failuresSinceResolve = 0;
		} catch (err) {
			// The binary may have been (re)installed since the last resolve;
			// occasionally look again rather than staying offline forever.
			this.failuresSinceResolve++;
			if (this.failuresSinceResolve % 10 === 0) {
				this.binary = "";
			}
			throw err;
		}
		return JSON.parse(out) as RawSnapshot;
	}

	private rememberBlocks(raw: RawSnapshot): void {
		this.blocks.clear();
		for (const session of list<RawSession>(raw.sessions)) {
			for (const window of list<RawWindow>(session.windows)) {
				for (const block of list<RawBlock>(window.blocks)) {
					if (block.creator_name === "com.superlogical.terminal") {
						this.blocks.set(block.block_id, { sessionId: session.session_id, records: list<RawRecord>(block.records), child: block.child });
					}
				}
			}
		}
	}

	private async requireClient(): Promise<string> {
		const { clients } = JSON.parse(await this.script(CLIENTS_SCRIPT)) as { clients?: RexClient[] | object };
		const app = chooseAppClient(list<RexClient>(clients));
		if (!app) {
			throw new RexApiError("no_client", "no Rex app is connected");
		}
		return app.client_id;
	}

	private async resolved(): Promise<string> {
		if (!this.binary) {
			this.binary = await resolveBinary();
		}
		return this.binary;
	}

	private async run(args: string[], client?: string): Promise<string> {
		const binary = await this.resolved();
		const flags = [...this.serverArgs(), "--timeout", CLI_TIMEOUT, ...(client ? ["-C", client] : [])];
		try {
			const { stdout } = await execFileAsync(binary, [...flags, ...args], { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
			return stdout;
		} catch (err) {
			throw toRexError(err);
		}
	}

	private script(source: string, args?: Record<string, string>): Promise<string> {
		return this.run(["do", "-e", source, ...(args ? ["--args", JSON.stringify(args)] : [])]);
	}

	private select(client: string, sessionId: string, windowId?: string): Promise<string> {
		return this.run(["do", "session.select", `session_id=${sessionId}`, ...(windowId ? [`window_id=${windowId}`] : [])], client);
	}

	private async selectAfterCreate(client: string, sessionId: string, windowId?: string): Promise<void> {
		try {
			await this.select(client, sessionId, windowId);
		} catch (err) {
			this.log(`rex: created ${windowId ?? sessionId} but could not show it: ${err}`);
		}
	}

	/**
	 * autostart would launch a server, and the deck never launches Rex. -S, not
	 * the variable alone: rex quietly falls back to the default socket when
	 * REX_SERVER names one that is gone, so a sandbox run whose server stopped
	 * would reach the user's real server.
	 */
	private serverArgs(): string[] {
		const server = process.env.REX_SERVER;
		return ["--autostart=false", ...(server ? ["-S", server] : [])];
	}

	private sessionOf(paneId: string): string {
		const block = this.blocks.get(paneId);
		if (!block) {
			throw new RexApiError("not_found", `pane ${paneId} is not in the latest snapshot`);
		}
		return block.sessionId;
	}
}

/** Rex has no worktree metadata, so the session's active pane says where it operates. */
export function workingDir(snapshot: Snapshot, space: Workspace): string {
	if (space.worktree?.checkout_path) {
		return space.worktree.checkout_path;
	}
	const panes = snapshot.panes.filter((pane) => pane.workspace_id === space.workspace_id);
	const activeId = snapshot.layouts?.find((layout) => layout.tab_id === space.active_tab_id)?.focused_pane_id;
	return (
		panes.find((pane) => pane.pane_id === activeId)?.cwd ||
		panes.find((pane) => pane.tab_id === space.active_tab_id && pane.cwd)?.cwd ||
		panes.find((pane) => pane.cwd)?.cwd ||
		""
	);
}

const GIT_CACHE_TTL_MS = 5000;
const gitCache = new Map<string, { info: GitInfo; fetchedAt: number; refreshing: boolean }>();

/**
 * Returns the cached repository/branch for a directory, refreshing in the
 * background. The first call for a directory answers with the cwd basename
 * while git runs; onRefresh fires when a refresh lands so the caller can
 * repaint.
 */
export function gitInfoFor(cwd: string, onRefresh: () => void): GitInfo {
	if (!cwd) {
		return { repo: "", branch: "" };
	}
	const cached = gitCache.get(cwd);
	if (cached && (Date.now() - cached.fetchedAt < GIT_CACHE_TTL_MS || cached.refreshing)) {
		return cached.info;
	}
	const placeholder: GitInfo = cached?.info ?? { repo: basename(cwd), branch: "" };
	gitCache.set(cwd, { info: placeholder, fetchedAt: cached?.fetchedAt ?? 0, refreshing: true });
	void refreshGitInfo(cwd).then((info) => {
		const previous = gitCache.get(cwd)?.info;
		gitCache.set(cwd, { info, fetchedAt: Date.now(), refreshing: false });
		if (!previous || previous.repo !== info.repo || previous.branch !== info.branch) {
			onRefresh();
		}
	});
	return placeholder;
}

async function refreshGitInfo(cwd: string): Promise<GitInfo> {
	const top = await gitOutput(cwd, "rev-parse", "--show-toplevel");
	if (!top) {
		return { repo: basename(cwd), branch: "" };
	}
	let branch = await gitOutput(cwd, "rev-parse", "--abbrev-ref", "HEAD");
	if (branch === "HEAD") {
		branch = await gitOutput(cwd, "rev-parse", "--short", "HEAD");
	}
	return { repo: basename(top), branch };
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: RUN_TIMEOUT_MS });
		return stdout.trim();
	} catch {
		return "";
	}
}

function basename(path: string): string {
	return pathBasename(path.replace(/[/\\]+$/, ""));
}

/** Raises the Rex app. Callers do this only after the app answered, so a stopped app is not launched. */
export async function raiseClient(): Promise<void> {
	if (process.platform !== "darwin" || process.env.REX_DECK_NO_RAISE === "1") {
		return;
	}
	await execFileAsync("/usr/bin/open", ["-b", REX_BUNDLE_ID]);
}
