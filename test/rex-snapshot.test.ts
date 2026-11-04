import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { attentionQueue, countStates, spaceState } from "../src/state";
import { activityCounts, agentOf, buildSnapshot, isAtPrompt, isShellForeground, paneStatus, type RawBlock, type RawRecord, type RawSnapshot, SeenTracker } from "../src/rex-snapshot";

const TERMINAL = "com.superlogical.terminal";
const CLAUDE = { pid: 10, name: "2.1.318", argv0: "claude", cwd: "/work/api-server" };
const ZSH = { pid: 11, name: "zsh", argv0: "-zsh", cwd: "/work/api-server" };

function block(id: string, foreground: RawBlock["foreground"], records: RawRecord[] | object = {}): RawBlock {
	return { block_id: id, creator_name: TERMINAL, foreground, records };
}

function session(id: string, number: number, blocks: RawBlock[], active = true) {
	const window = `window:${id}`;
	return {
		session_id: id,
		number,
		label: id,
		...(active ? { active_window_id: window } : {}),
		windows: [{ window_id: window, label: "main", focused_block_id: blocks[0]?.block_id, blocks }],
	};
}

const statusOf = (foreground: RawBlock["foreground"], records: RawRecord[], seenAt?: string) => paneStatus(block("b", foreground, records), seenAt);

describe("isShellForeground", () => {
	test.each([
		[undefined, true],
		[null, true],
		[{ pid: 1, name: "login" }, true],
		[{ pid: 1, argv0: "-zsh", name: "zsh" }, true],
		[{ pid: 1, argv0: "/bin/bash", name: "bash" }, true],
		[{ pid: 1, argv0: "-fish" }, true],
		[{ pid: 1, name: "dash" }, true],
		[{ pid: 1, argv0: "ksh" }, true],
		[{ pid: 1, argv0: "tcsh" }, true],
		[{ pid: 1, argv0: "sh" }, true],
		[{ pid: 1, argv0: "claude", name: "2.1.318" }, false],
		[{ pid: 1, argv0: "/usr/bin/vim", name: "vim" }, false],
		[{ pid: 1, argv0: "zsh-wrapper" }, false],
	])("%j is a shell: %s", (foreground, expected) => {
		expect(isShellForeground(foreground)).toBe(expected);
	});
});

describe("agentOf", () => {
	test("a known agent by argv0 basename, since Claude's name is a version string", () => {
		expect(agentOf(CLAUDE, [])).toBe("claude");
		expect(agentOf({ pid: 1, argv0: "/opt/bin/codex" }, [])).toBe("codex");
		for (const name of ["opencode", "gemini", "aider", "amp", "cursor-agent", "goose"]) {
			expect(agentOf({ pid: 1, argv0: name }, [])).toBe(name);
		}
	});

	test("a shell never hosts an agent, whatever its records say", () => {
		expect(agentOf(ZSH, [{ state: "working", app: "claude-code", owner: { pid: 11 } }])).toBeUndefined();
		expect(agentOf(undefined, [{ state: "working", app: "claude-code" }])).toBeUndefined();
	});

	test("a wrapper needs a record the foreground itself reported", () => {
		const node = { pid: 20, argv0: "node", name: "node" };
		expect(agentOf(node, [])).toBeUndefined();
		expect(agentOf(node, [{ state: "working", app: "my-agent", owner: { pid: 21 } }])).toBeUndefined();
		expect(agentOf(node, [{ state: "working", app: "my-agent", owner: { pid: 20 } }])).toBe("my-agent");
		expect(agentOf(node, [{ state: "working", effective_app: "other", owner: { pid: 20 } }])).toBe("other");
		expect(agentOf(node, [{ state: "working", owner: { pid: 20 } }])).toBe("node");
	});

	test("rsact records and ownerless records do not make an agent", () => {
		const node = { pid: 20, argv0: "node" };
		expect(agentOf(node, [{ id: "rsact/bg/1", state: "working", app: "x", owner: { pid: 20 } }])).toBeUndefined();
		expect(agentOf(node, [{ state: "working", app: "x" }])).toBeUndefined();
	});
});

describe("a script that did not exec its agent", () => {
	const SCRIPT = { pid: 30, name: "sh", argv0: "/bin/sh", cwd: "/work/api-server" };
	const ENV_BASH = { pid: 30, name: "bash", argv0: "bash", cwd: "/work/api-server" };
	const ROOT = { pid: 29 };
	const own: RawRecord[] = [{ state: "blocked", app: "claude-code", owner: { pid: 30 } }];

	test.each([
		["a script's shell with its own record", SCRIPT, own, ROOT, false],
		["env bash with its own record", ENV_BASH, own, ROOT, false],
		["a script's shell before its first report", SCRIPT, [], ROOT, true],
		["a record someone else left", SCRIPT, [{ state: "blocked", owner: { pid: 31 } }], ROOT, true],
		["an ownerless record", SCRIPT, [{ state: "blocked" }], ROOT, true],
		["only an activity record", SCRIPT, [{ id: "rsact/bg/1", state: "working", owner: { pid: 30 } }], ROOT, true],
		["a login shell that printed a record", { ...ZSH, pid: 30 }, own, ROOT, true],
		["the pane's first process that printed a record", SCRIPT, own, { pid: 30 }, true],
		["no foreground", undefined, own, ROOT, true],
		["not a shell at all", CLAUDE, [], ROOT, false],
	])("%s", (_name, foreground, records, child, expected) => {
		expect(isAtPrompt(foreground, records, child)).toBe(expected);
	});

	test("it counts as the agent and reads blocked", () => {
		const raw = block("b", SCRIPT, own);
		raw.child = ROOT;
		expect(agentOf(SCRIPT, own, ROOT)).toBe("claude-code");
		expect(paneStatus(raw, undefined).status).toBe("blocked");
		const snap = buildSnapshot({ sessions: [session("s", 1, [raw])] });
		expect(snap.panes[0]).toMatchObject({ agent: "claude-code", agent_status: "blocked" });
		expect(snap.workspaces[0].agent_status).toBe("blocked");
	});

	test("its activity counts, because it is the agent's pane", () => {
		const records = [...own, { id: "rsact/bg/1", state: "working", owner: { pid: 30 } }];
		const raw = block("b", SCRIPT, records);
		raw.child = ROOT;
		expect(buildSnapshot({ sessions: [session("s", 1, [raw])] }).panes[0].tokens).toMatchObject({ rsact_background: "1" });
	});

	test("a login shell that printed a blocked record stays a shell", () => {
		const raw = block("b", { ...ZSH, pid: 30 }, own);
		raw.child = ROOT;
		expect(buildSnapshot({ sessions: [session("s", 1, [raw])] }).panes[0]).toMatchObject({ agent_status: "unknown" });
		expect(buildSnapshot({ sessions: [session("s", 1, [raw])] }).panes[0].agent).toBeUndefined();
	});
});

describe("paneStatus", () => {
	test.each<[string, RawBlock["foreground"], RawRecord[], string]>([
		["no records", CLAUDE, [], "unknown"],
		["root working", CLAUDE, [{ state: "working" }], "working"],
		["root idle", CLAUDE, [{ state: "idle" }], "idle"],
		["root done", CLAUDE, [{ state: "done" }], "done"],
		["root error is done", CLAUDE, [{ state: "error" }], "done"],
		["root blocked", CLAUDE, [{ state: "blocked", kind: "permission" } as RawRecord], "blocked"],
		["blocked with no kind", CLAUDE, [{ state: "blocked" }], "blocked"],
		["empty id is root", CLAUDE, [{ id: "", state: "done" }], "done"],
		["a child blocked blocks the root", CLAUDE, [{ state: "working" }, { id: "agent1", state: "blocked" }], "blocked"],
		["root wins over working children", CLAUDE, [{ state: "idle" }, { id: "agent1", state: "working" }], "idle"],
		["no root: most urgent child", CLAUDE, [{ id: "a", state: "idle" }, { id: "b", state: "working" }], "working"],
		["no root: done beats working", CLAUDE, [{ id: "a", state: "working" }, { id: "b", state: "done" }], "done"],
		["an unknown state reads unknown", CLAUDE, [{ state: "pondering" }], "unknown"],
		["rsact never feeds status", CLAUDE, [{ id: "rsact/bg/1", state: "working" }], "unknown"],
		["rsact blocked never blocks", CLAUDE, [{ state: "idle" }, { id: "rsact/sub/1", state: "blocked" }], "idle"],
		["a non-shell, non-agent program still reports", { pid: 1, argv0: "terraform" }, [{ state: "working" }], "working"],
		["under a shell, root done keeps done", ZSH, [{ state: "done" }], "done"],
		["under a shell, root error keeps done", ZSH, [{ state: "error" }], "done"],
		["under a shell, root idle is ignored", ZSH, [{ state: "idle" }], "unknown"],
		["under a shell, ownerless working is ignored", ZSH, [{ state: "working" }], "unknown"],
		["under a shell, blocked is ignored", ZSH, [{ state: "blocked" }], "unknown"],
		["under a shell, children are ignored", ZSH, [{ id: "a", state: "done" }], "unknown"],
		["absent foreground is a shell", undefined, [{ state: "working" }], "unknown"],
		["absent foreground, root done", undefined, [{ state: "done" }], "done"],
	])("%s", (_name, foreground, records, expected) => {
		expect(statusOf(foreground, records).status).toBe(expected);
	});

	test("Lua's empty table for records", () => {
		expect(paneStatus(block("b", CLAUDE, {}), undefined).status).toBe("unknown");
	});

	test("error is reported only for an unseen root error", () => {
		expect(statusOf(CLAUDE, [{ state: "error", updated_at: "t1" }])).toEqual({ status: "done", error: true });
		expect(statusOf(CLAUDE, [{ state: "done", updated_at: "t1" }])).toEqual({ status: "done", error: false });
		expect(statusOf(CLAUDE, [{ state: "error", updated_at: "t1" }], "t1")).toEqual({ status: "idle", error: false });
		expect(statusOf(ZSH, [{ state: "error", updated_at: "t1" }])).toEqual({ status: "done", error: true });
	});

	test("a seen root reads idle until its updated_at moves", () => {
		expect(statusOf(CLAUDE, [{ state: "done", updated_at: "t1" }], "t1").status).toBe("idle");
		expect(statusOf(CLAUDE, [{ state: "done", updated_at: "t2" }], "t1").status).toBe("done");
		expect(statusOf(CLAUDE, [{ state: "done" }], undefined).status).toBe("done");
	});

	test("with no agent in front a seen root reads unknown, so the session leaves the summary", () => {
		const done: RawRecord[] = [{ state: "done", updated_at: "t1", owner: { pid: 99 } }];
		expect(statusOf(ZSH, done, "t1")).toEqual({ status: "unknown", error: false });
		expect(statusOf(ZSH, [{ state: "error", updated_at: "t1" }], "t1")).toEqual({ status: "unknown", error: false });
		expect(statusOf(undefined, done, "t1").status).toBe("unknown");
		expect(statusOf({ pid: 1, argv0: "terraform" }, [{ state: "done", updated_at: "t1" }], "t1").status).toBe("unknown");
		expect(statusOf({ pid: 1, argv0: "terraform" }, [{ state: "done", updated_at: "t1", owner: { pid: 1 } }], "t1").status).toBe("idle");
		const snap = buildSnapshot({ sessions: [session("s", 1, [block("b", ZSH, done)])] }, { seen: new Map([["b", "t1"]]) });
		expect(snap.workspaces[0].agent_status).toBe("unknown");
		expect(spaceState(snap.workspaces[0], snap)).toBe("none");
		expect(countStates(snap).total).toBe(0);
		expect(attentionQueue(snap)).toEqual([]);
	});

	test("seen says nothing about working or blocked", () => {
		expect(statusOf(CLAUDE, [{ state: "working", updated_at: "t1" }], "t1").status).toBe("working");
		expect(statusOf(CLAUDE, [{ state: "blocked", updated_at: "t1" }], "t1").status).toBe("blocked");
	});
});

describe("records from a process no longer in front", () => {
	const DEAD = { owner: { pid: 99 } };
	const TAIL = { pid: 50, argv0: "tail", name: "tail" };
	const raw = (foreground: RawBlock["foreground"], records: RawRecord[]) => ({ sessions: [session("s", 1, [block("b", foreground, records)])] });

	test.each<[string, RawBlock["foreground"], RawRecord[], string]>([
		["a program does not inherit a dead agent's idle", TAIL, [{ state: "idle", ...DEAD }], "unknown"],
		["or its working", TAIL, [{ state: "working", ...DEAD }], "unknown"],
		["or a child", TAIL, [{ id: "a", state: "working", ...DEAD }], "unknown"],
		["or a blocked record", TAIL, [{ state: "blocked", ...DEAD }], "unknown"],
		["a dead agent's done still waits to be seen", TAIL, [{ state: "done", ...DEAD }], "done"],
		["its own report still counts", TAIL, [{ state: "working", owner: { pid: 50 } }], "working"],
		["an ownerless record stays as it was", TAIL, [{ state: "working" }], "working"],
		["a new agent is not its predecessor's idle", CLAUDE, [{ state: "idle", ...DEAD }], "unknown"],
		["or its done", CLAUDE, [{ state: "done", ...DEAD }], "unknown"],
		["or its error", CLAUDE, [{ state: "error", ...DEAD }], "unknown"],
		["a new agent's own report wins", CLAUDE, [{ state: "working", owner: { pid: 10 } }], "working"],
		["a live child still counts beside a dead root", CLAUDE, [{ state: "done", ...DEAD }, { id: "a", state: "working", owner: { pid: 10 } }], "working"],
	])("%s", (_name, foreground, records, expected) => {
		expect(statusOf(foreground, records).status).toBe(expected);
	});

	test("a program under a dead agent's seen done reads unknown", () => {
		expect(statusOf(TAIL, [{ state: "done", updated_at: "t1", ...DEAD }], "t1").status).toBe("unknown");
	});

	test("the summary does not count that program", () => {
		const snap = buildSnapshot(raw(TAIL, [{ state: "idle", ...DEAD }]));
		expect(snap.panes[0].agent).toBeUndefined();
		expect(spaceState(snap.workspaces[0], snap)).toBe("none");
	});

	test("a new agent shows neither a dead session's schedule nor its background work", () => {
		const gemini = { pid: 60, argv0: "gemini" };
		const leftovers: RawRecord[] = [
			{ id: "rsact/next/1893456000.loop", state: "idle", ...DEAD },
			{ id: "rsact/bg/1", state: "working", ...DEAD },
			{ id: "rsact/sub/1", state: "working", ...DEAD },
		];
		const snap = buildSnapshot(raw(gemini, [...leftovers, { state: "done", app: "gemini", owner: { pid: 60 } }]));
		expect(snap.panes[0].tokens).toBeUndefined();
		expect(snap.workspaces[0].tokens).toBeUndefined();
		expect(spaceState(snap.workspaces[0], snap)).toBe("done");
	});

	test("records the agent itself published count, as do ownerless ones", () => {
		const records: RawRecord[] = [{ id: "rsact/next/1893456000.loop", state: "idle", owner: { pid: 10 } }, { id: "rsact/bg/1", state: "working" }];
		expect(buildSnapshot(raw(CLAUDE, records)).panes[0].tokens).toMatchObject({ rsact_background: "1", rsact_next_at: new Date(1893456000000).toISOString() });
	});
});

describe("activityCounts", () => {
	test("native subagents and rsact/sub union by last id segment", () => {
		const counts = activityCounts([
			{ state: "working", app: "claude-code" },
			{ id: "agent_a", state: "working", app: "claude-code" },
			{ id: "agent_b", state: "blocked", effective_app: "claude-code" },
			{ id: "rsact/sub/agent_a", state: "working" },
			{ id: "rsact/sub/agent_c", state: "working" },
		]);
		expect(counts.subagents).toBe(3);
	});

	test("a native record needs a working state and the claude-code app", () => {
		const counts = activityCounts([
			{ id: "a", state: "idle", app: "claude-code" },
			{ id: "b", state: "done", app: "claude-code" },
			{ id: "c", state: "working", app: "terraform" },
			{ id: "d", state: "working" },
			{ id: "e", state: "working", app: "terraform", effective_app: "claude-code" },
		]);
		expect(counts.subagents).toBe(0);
	});

	test("background shells and monitors count when working", () => {
		const counts = activityCounts([
			{ id: "rsact/bg/1", state: "working" },
			{ id: "rsact/bg/2", state: "working" },
			{ id: "rsact/mon/1", state: "working" },
			{ id: "rsact/bg/3", state: "idle" },
		]);
		expect(counts).toMatchObject({ background: 2, monitors: 1, subagents: 0, nextAt: null });
	});

	test("a next record gives the wake-up, in seconds, looping or not", () => {
		expect(activityCounts([{ id: "rsact/next/1893456000", state: "idle" }])).toMatchObject({ nextAt: 1893456000000, loop: false });
		expect(activityCounts([{ id: "rsact/next/1893456000.loop", state: "idle" }])).toMatchObject({ nextAt: 1893456000000, loop: true });
	});

	test("a next time past what a Date can hold counts for nothing", () => {
		expect(activityCounts([{ id: "rsact/next/8640000000000", state: "idle" }]).nextAt).toBe(8640000000000000);
		for (const seconds of ["8640000000001", "99999999999999", "9".repeat(32), "9".repeat(400)]) {
			expect(activityCounts([{ id: `rsact/next/${seconds}.loop`, state: "idle" }])).toMatchObject({ nextAt: null, loop: false });
		}
		expect(activityCounts([{ id: "rsact/next/99999999999999.loop", state: "idle" }, { id: "rsact/next/1893456000", state: "idle" }])).toMatchObject({ nextAt: 1893456000000, loop: false });
	});

	test("malformed activity records fail open", () => {
		const counts = activityCounts([
			{ id: "rsact/next/soon", state: "idle" },
			{ id: "rsact/next/", state: "idle" },
			{ id: "rsact/whatever/1", state: "working" },
			{ id: "rsact2/sub/1", state: "working" },
		]);
		expect(counts).toEqual({ subagents: 0, background: 0, monitors: 0, nextAt: null, loop: false });
	});
});

describe("buildSnapshot", () => {
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8")) as RawSnapshot & {
		sessions: { session_id: string; label: string; active_window_id?: string; windows: { window_id: string; focused_block_id?: string }[] }[];
	};
	const [api, webapp, docs, empty] = fixture.sessions;

	test("real server output, unfocused", () => {
		const snap = buildSnapshot(fixture);
		expect(snap.workspaces.map((w) => [w.number, w.label, w.pane_count, w.tab_count, w.agent_status, w.focused])).toEqual([
			[1, "api-server", 4, 2, "unknown", false],
			[2, "webapp", 1, 1, "done", false],
			[3, "docs", 1, 2, "unknown", false],
			[4, "empty", 0, 0, "unknown", false],
		]);
		expect(snap.focused_workspace_id).toBeUndefined();
		expect(snap.focused_tab_id).toBeUndefined();
		expect(snap.focused_pane_id).toBeUndefined();
		expect(snap.workspaces[0].worktree).toBeNull();
		expect(snap.workspaces[0].active_tab_id).toBe(api.active_window_id);
		expect(snap.workspaces[3].active_tab_id).toBeUndefined();
	});

	test("default window labels read as unlabelled", () => {
		const snap = buildSnapshot(fixture);
		expect(snap.tabs?.filter((t) => t.workspace_id === api.session_id).map((t) => [t.number, t.label])).toEqual([
			[1, undefined],
			[2, "logs"],
		]);
	});

	test("the agent's pane carries status, cwd and synthesised tokens", () => {
		const snap = buildSnapshot(fixture);
		const pane = snap.panes.find((p) => p.workspace_id === webapp.session_id);
		expect(pane).toMatchObject({
			agent: "claude",
			agent_status: "done",
			cwd: "/work/api-server",
			tokens: {
				rsact_v: "1",
				rsact_state: "subagents",
				rsact_subagents: "1",
				rsact_background: "1",
				rsact_next_at: new Date(1893456000000).toISOString(),
				rsact_loop: "1",
			},
		});
		expect(snap.workspaces[1].tokens).toEqual(pane?.tokens);
	});

	test("non-terminal blocks are not panes and not counted", () => {
		const snap = buildSnapshot(fixture);
		expect(snap.panes.filter((p) => p.workspace_id === docs.session_id)).toHaveLength(1);
		expect(snap.tabs?.filter((t) => t.workspace_id === docs.session_id)).toHaveLength(2);
	});

	test("focus follows the given session and its active window", () => {
		const snap = buildSnapshot(fixture, { focusedSessionId: api.session_id });
		const activeWindow = api.windows.find((w) => w.window_id === api.active_window_id);
		expect(snap.focused_workspace_id).toBe(api.session_id);
		expect(snap.focused_tab_id).toBe(api.active_window_id);
		expect(snap.focused_pane_id).toBe(activeWindow?.focused_block_id);
		expect(snap.workspaces.filter((w) => w.focused).map((w) => w.label)).toEqual(["api-server"]);
		expect(snap.panes.filter((p) => p.focused).map((p) => p.pane_id)).toEqual([activeWindow?.focused_block_id]);
		expect(snap.tabs?.filter((t) => t.focused).map((t) => t.tab_id)).toEqual([api.active_window_id]);
		expect(snap.layouts?.find((l) => l.tab_id === api.active_window_id)?.focused_pane_id).toBe(activeWindow?.focused_block_id);
	});

	test("a focused session with an empty or non-terminal focus has no focused pane", () => {
		const onlyOnboarding = { ...docs, active_window_id: docs.windows[1].window_id };
		const snap = buildSnapshot({ sessions: [onlyOnboarding, empty] }, { focusedSessionId: docs.session_id });
		expect(snap.focused_workspace_id).toBe(docs.session_id);
		expect(snap.focused_tab_id).toBe(docs.windows[1].window_id);
		expect(snap.focused_pane_id).toBeUndefined();
	});

	test("a focused session missing from the snapshot means no focus", () => {
		const snap = buildSnapshot(fixture, { focusedSessionId: "session:01a1a685-0000-7000-8000-0123456789ab" });
		expect(snap.focused_workspace_id).toBeUndefined();
		expect(snap.workspaces.some((w) => w.focused)).toBe(false);
	});

	test("an empty server", () => {
		expect(buildSnapshot({ clients: {}, sessions: {} })).toEqual({ panes: [], workspaces: [], tabs: [], layouts: [] });
	});

	describe("rollup", () => {
		const rollup = (...panes: RawRecord[][]) =>
			buildSnapshot({ sessions: [session("s", 1, panes.map((records, i) => block(`b${i}`, CLAUDE, records)))] }).workspaces[0];

		test.each<[string, RawRecord[][], string]>([
			["no panes", [], "unknown"],
			["blocked beats done", [[{ state: "done" }], [{ state: "blocked" }]], "blocked"],
			["done beats working", [[{ state: "working" }], [{ state: "done" }]], "done"],
			["working beats idle", [[{ state: "idle" }], [{ state: "working" }]], "working"],
			["idle beats unknown", [[], [{ state: "idle" }]], "idle"],
			["all unknown", [[], []], "unknown"],
		])("%s", (_name, panes, expected) => {
			expect(rollup(...panes).agent_status).toBe(expected);
		});

		test("status_word only when the winning pane's root errored", () => {
			expect(rollup([{ state: "error" }]).status_word).toBe("ERROR");
			expect(rollup([{ state: "done" }], [{ state: "error" }]).status_word).toBe("ERROR");
			expect(rollup([{ state: "done" }]).status_word).toBeUndefined();
			expect(rollup([{ state: "error" }], [{ state: "blocked" }]).status_word).toBeUndefined();
		});

		test("a seen error leaves no word", () => {
			const snap = buildSnapshot({ sessions: [session("s", 1, [block("b0", CLAUDE, [{ state: "error", updated_at: "t1" }])])] }, { seen: new Map([["b0", "t1"]]) });
			expect(snap.workspaces[0]).toMatchObject({ agent_status: "idle" });
			expect(snap.workspaces[0].status_word).toBeUndefined();
		});
	});

	test("one bad record cannot take the other sessions down with it", () => {
		const snap = buildSnapshot({
			sessions: [
				session("s1", 1, [block("b1", CLAUDE, [{ state: "idle" }, { id: "rsact/next/99999999999999", state: "idle" }])]),
				session("s2", 2, [block("b2", CLAUDE, [{ state: "blocked" }])]),
			],
		});
		expect(snap.panes[0].tokens).toBeUndefined();
		expect(snap.workspaces.map((space) => space.agent_status)).toEqual(["idle", "blocked"]);
	});

	describe("activity tokens", () => {
		const records: RawRecord[] = [{ state: "idle" }, { id: "rsact/bg/1", state: "working" }, { id: "agent_a", state: "working", app: "claude-code" }];

		test("ignored on a pane with no agent", () => {
			const snap = buildSnapshot({ sessions: [session("s", 1, [block("b0", ZSH, records), block("b1", { pid: 9, argv0: "vim" }, records)])] });
			expect(snap.panes.map((p) => p.tokens)).toEqual([undefined, undefined]);
			expect(snap.workspaces[0].tokens).toBeUndefined();
		});

		test("without child records there are no tokens at all", () => {
			const snap = buildSnapshot({ sessions: [session("s", 1, [block("b0", CLAUDE, [{ state: "idle" }])])] });
			expect(snap.panes[0].tokens).toBeUndefined();
			expect(snap.workspaces[0].tokens).toBeUndefined();
		});

		test("a session sums its panes and takes the soonest wake-up", () => {
			const snap = buildSnapshot({
				sessions: [
					session("s", 1, [
						block("b0", CLAUDE, [{ id: "rsact/next/2000000000", state: "idle" }, { id: "rsact/bg/1", state: "working" }]),
						block("b1", CLAUDE, [{ id: "rsact/next/1900000000", state: "idle" }, { id: "rsact/mon/1", state: "working" }, { id: "x", state: "working", app: "claude-code" }]),
					]),
				],
			});
			expect(snap.workspaces[0].tokens).toEqual({
				rsact_v: "1",
				rsact_state: "subagents",
				rsact_subagents: "1",
				rsact_background: "1",
				rsact_monitors: "1",
				rsact_next_at: new Date(1900000000000).toISOString(),
			});
			expect(snap.panes[0].tokens?.rsact_state).toBe("background");
		});

		test("a lone wake-up is scheduled", () => {
			const snap = buildSnapshot({ sessions: [session("s", 1, [block("b0", CLAUDE, [{ id: "rsact/next/1900000000.loop", state: "idle" }])])] });
			expect(snap.panes[0].tokens).toMatchObject({ rsact_state: "scheduled", rsact_loop: "1" });
		});
	});
});

describe("SeenTracker", () => {
	const raw = (focusedRoot: RawRecord, other: RawRecord = { state: "done", updated_at: "other" }): RawSnapshot => ({
		sessions: [session("session:a", 1, [block("a", CLAUDE, [focusedRoot])]), session("session:b", 2, [block("b", CLAUDE, [other])])],
	});

	function seen(frontmost = true) {
		let asks = 0;
		const tracker = new SeenTracker(async () => {
			asks++;
			return frontmost;
		});
		return { tracker, asks: () => asks };
	}

	test("a finished root in view is seen while Rex is in front", async () => {
		const { tracker } = seen();
		await tracker.update(raw({ state: "done", updated_at: "t1" }), "session:a");
		expect(tracker.seen.get("a")).toBe("t1");
		expect(tracker.seen.has("b")).toBe(false);
	});

	test("an error root counts too", async () => {
		const { tracker } = seen();
		await tracker.update(raw({ state: "error", updated_at: "t1" }), "session:a");
		expect(tracker.seen.get("a")).toBe("t1");
	});

	test("not while Rex is in the background", async () => {
		const { tracker } = seen(false);
		await tracker.update(raw({ state: "done", updated_at: "t1" }), "session:a");
		expect(tracker.seen.size).toBe(0);
	});

	test("the system is asked only when there is a candidate", async () => {
		const { tracker, asks } = seen();
		await tracker.update(raw({ state: "working", updated_at: "t1" }), "session:a");
		expect(asks()).toBe(0);
		await tracker.update(raw({ state: "done", updated_at: "t2" }), "session:a");
		expect(asks()).toBe(1);
		await tracker.update(raw({ state: "done", updated_at: "t2" }), "session:a");
		expect(asks()).toBe(1);
		await tracker.update(raw({ state: "done", updated_at: "t2" }), undefined);
		expect(asks()).toBe(1);
	});

	test("a pane in a hidden window of the focused session is not seen", async () => {
		const { tracker, asks } = seen();
		const hidden = {
			sessions: [
				{
					session_id: "session:a",
					number: 1,
					active_window_id: "window:front",
					windows: [
						{ window_id: "window:front", blocks: [block("front", CLAUDE, [{ state: "idle" }])] },
						{ window_id: "window:back", blocks: [block("back", CLAUDE, [{ state: "done", updated_at: "t1" }])] },
					],
				},
			],
		};
		await tracker.update(hidden, "session:a");
		expect(asks()).toBe(0);
		expect(tracker.seen.size).toBe(0);
	});

	test("every pane in the active window is seen, floating included", async () => {
		const { tracker } = seen();
		const two = {
			sessions: [
				session("session:a", 1, [block("tiled", CLAUDE, [{ state: "done", updated_at: "t1" }]), block("floating", CLAUDE, [{ state: "error", updated_at: "t2" }])]),
			],
		};
		await tracker.update(two, "session:a");
		expect(Object.fromEntries(tracker.seen)).toEqual({ tiled: "t1", floating: "t2" });
	});

	test("entries for gone blocks are dropped", async () => {
		const { tracker } = seen();
		await tracker.update(raw({ state: "done", updated_at: "t1" }), "session:a");
		await tracker.update({ sessions: [session("session:b", 1, [block("b", CLAUDE, [])])] }, "session:b");
		expect(tracker.seen.size).toBe(0);
	});

	test("a done reported again later reads as new", async () => {
		const { tracker } = seen();
		await tracker.update(raw({ state: "done", updated_at: "t1" }), "session:a");
		const later = raw({ state: "done", updated_at: "t2" });
		const snap = buildSnapshot(later, { seen: tracker.seen });
		expect(snap.panes.find((p) => p.pane_id === "a")?.agent_status).toBe("done");
	});
});
