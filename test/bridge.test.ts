import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Bridge, resolveBinary, type Snapshot, type Workspace, workingDir } from "../src/rex";
import { RexApiError } from "../src/rex-errors";
import { event, StubRex } from "./stub";

const SESSION = "session:01a1a685-8b8e-72ee-bdf5-945c8c4340ef";
const OTHER = "session:01a1a685-8ba9-7259-819b-f4dab2b30dd8";
const WINDOW = "window:01a1a685-8bab-70b3-b7cb-9879b82334f5";
const PANE = "block:01a1a685-8ba9-731c-90a2-ba14ff6d071f";
const APP = "client:01a1a685-8e30-78c2-a0a6-8021051867d3";

const appClient = {
	client_id: APP,
	connected_at: "2026-11-04T12:25:32.976575Z",
	connection_state: "connected",
	info: { kind: "app", label: "fake-mac", name: "Rex.app", platform: "macos", version: "0.0.0-fake" },
	principal: { display: "uid 501", gid: 20, kind: "peer", pid: 4242, transport: "unix", uid: 501 },
	session_ids: [SESSION],
};

function raw(overrides: object = {}) {
	return {
		clients: [appClient],
		sessions: [
			{
				session_id: SESSION,
				number: 1,
				label: "api-server",
				active_window_id: WINDOW,
				windows: [
					{
						window_id: WINDOW,
						label: "Window b82334f5",
						focused_block_id: PANE,
						blocks: [
							{
								block_id: PANE,
								creator_name: "com.superlogical.terminal",
								foreground: { argv0: "/usr/local/bin/claude", cwd: "/work/api-server", name: "2.1.318", pid: 99 },
								records: [{ app: "claude-code", effective_app: "claude-code", owner: { name: "claude", pid: 99 }, state: "working", updated_at: "2026-11-04T12:25:33.659798Z" }],
							},
						],
					},
				],
			},
			{ session_id: OTHER, number: 2, label: "webapp", windows: {} },
		],
		skipped: {},
		...overrides,
	};
}

let stub: StubRex;
let bridge: Bridge;
const logs: string[] = [];

beforeEach(() => {
	stub = new StubRex();
	logs.length = 0;
	bridge = new Bridge({ log: (line) => logs.push(line), readPreference: async () => null, isFrontmost: async () => true });
});

afterEach(() => {
	bridge.close();
	stub.dispose();
});

/** The app client's id for selects, plus the block map for sends. */
function withApp(): StubRex {
	return stub.snapshot(raw()).on("clients", { stdout: `${JSON.stringify({ clients: [appClient] })}\n` });
}

describe("safety net", () => {
	test("the suite's environment points nothing at a real server", async () => {
		expect(process.env.REX_PATH).toMatch(/test\/stub\/rex$/);
		await expect(resolveBinary()).resolves.toBe(process.env.REX_PATH);
		expect(existsSync((process.env.REX_SERVER ?? "").replace("unix://", ""))).toBe(false);
		expect(process.env.REX_SERVER).toMatch(/^unix:\/\/.*rex-deck-.*none\.sock$/);
		expect(process.env.REX_RUNTIME_DIR).toMatch(/rex-deck-.*runtime$/);
		expect(process.env.HOME).toMatch(/rex-deck-.*home$/);
		expect(process.env.REX_DECK_NO_RAISE).toBe("1");
		expect(process.env.REX_DECK_FRONTMOST).toBe("always");
		expect(process.env.REX_DECK_FOCUS_PREF_DOMAIN).not.toBe("com.superlogical.rex");
		for (const name of ["REX_SESSION", "REX_BLOCK", "REX_BIN_DIR", "REX_CLIENT"]) {
			expect(process.env[name]).toBeUndefined();
		}
	});

	test("with no scenario the stub behaves like a dead server", async () => {
		stub.dispose();
		const err = await new Bridge({ readPreference: async () => null }).snapshot().catch((e: unknown) => e);
		expect(err).toMatchObject({ name: "RexApiError", code: "server_down" });
		expect((err as Error).message).toContain("none.sock");
		stub = new StubRex();
	});

	test("every spawn carries --autostart=false and an explicit -S, with --timeout on one-shot calls", async () => {
		withApp();
		await bridge.snapshot();
		await bridge.focusWorkspace(SESSION);
		await bridge.createWorkspace();
		await bridge.createTab(SESSION, undefined);
		await bridge.promptAgent(PANE, "/review");
		await bridge.sendInput(PANE, "ls");
		await bridge.sendText(PANE, "ls");
		await bridge.sendKeys(PANE, ["esc"]);
		await bridge.subscribeChanges(() => {}, () => {});
		const calls = stub.calls();
		expect(calls.map((call) => call.kind).sort()).toEqual(
			["clients", "clients", "clients", "events", "input", "new", "prompt", "select", "select", "select", "send-key", "snapshot", "window", "write"].sort(),
		);
		for (const call of calls) {
			expect(call.flags.autostart).toBe(false);
			expect(call.flags["-S"]).toBe(process.env.REX_SERVER);
			if (call.kind !== "events") {
				expect(call.flags["--timeout"]).toBe("2s");
			}
		}
	});

	test("without REX_SERVER the default socket is left to rex", async () => {
		const saved = process.env.REX_SERVER;
		delete process.env.REX_SERVER;
		try {
			await bridge.snapshot();
		} finally {
			process.env.REX_SERVER = saved;
		}
		expect(stub.calls()[0].flags["-S"]).toBeUndefined();
	});

	// A real binary, when one is installed, proves the environment rather than the stub.
	const realRex = join(userInfo().homedir, "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex");

	test.runIf(existsSync(realRex))("a stray real rex with no -S cannot reach a server", () => {
		const result = spawnSync(realRex, ["--autostart=false", "--timeout", "2s", "api", "call", "server.version"], { encoding: "utf8" });
		expect(result.status).toBe(4);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(process.env.REX_RUNTIME_DIR);
	});

	test.runIf(existsSync(realRex))("the bridge on a real rex fails on the named socket instead of falling back", async () => {
		const saved = process.env.REX_PATH;
		process.env.REX_PATH = realRex;
		try {
			const err = await new Bridge({ readPreference: async () => null }).snapshot().catch((e: unknown) => e);
			expect(err).toMatchObject({ code: "server_down" });
			expect((err as Error).message).toContain("none.sock");
		} finally {
			process.env.REX_PATH = saved;
		}
	});
});

describe("snapshot", () => {
	test("runs the script through do -e and maps the output", async () => {
		stub.snapshot(raw());
		const snap = await bridge.snapshot();
		const [call] = stub.calls("snapshot");
		expect(call.command.slice(0, 2)).toEqual(["do", "-e"]);
		expect(call.command[2]).toContain('call("client.list", { kinds = { "app" } })');
		expect(snap.workspaces.map((w) => [w.workspace_id, w.number, w.label, w.agent_status, w.pane_count, w.tab_count])).toEqual([
			[SESSION, 1, "api-server", "working", 1, 1],
			[OTHER, 2, "webapp", "unknown", 0, 0],
		]);
		expect(snap.panes[0]).toEqual({
			pane_id: PANE,
			workspace_id: SESSION,
			tab_id: WINDOW,
			agent: "claude",
			agent_status: "working",
			focused: false,
			cwd: "/work/api-server",
		});
	});

	test("an empty server, as Lua encodes it", async () => {
		await expect(bridge.snapshot()).resolves.toEqual({ panes: [], workspaces: [], tabs: [], layouts: [] });
	});

	test.each<[string, number, string, string]>([
		["server down", 4, "Error: no Rex server is running at /work/x.sock, and autostart is disabled\n", "server_down"],
		["killed mid-script", 1, "Error: reading API control: reading control message: failed to get reader: failed to read frame header: EOF\n", "server_down"],
		["hung", 1, "Error: session.view request timed out after 2s; increase --timeout: context deadline exceeded\n", "timeout"],
	])("%s rejects with a classified error", async (_name, exit, stderr, code) => {
		stub.on("snapshot", { exit, stderr });
		await expect(bridge.snapshot()).rejects.toMatchObject({ name: "RexApiError", code, message: stderr.trim() });
	});

	test("output that is not JSON rejects, so it counts as a failed poll", async () => {
		stub.on("snapshot", { stdout: "panic\n" });
		await expect(bridge.snapshot()).rejects.toThrow(SyntaxError);
	});

	test("a binary that cannot run is a RexApiError", async () => {
		const saved = process.env.REX_PATH;
		process.env.REX_PATH = "/nonexistent/rex";
		try {
			await expect(new Bridge({ readPreference: async () => null }).snapshot()).rejects.toMatchObject({ name: "RexApiError", code: "no_binary" });
		} finally {
			process.env.REX_PATH = saved;
		}
	});

	test("the binary is looked for again every ten failures", async () => {
		const saved = process.env.REX_PATH;
		const dir = mkdtempSync(join(tmpdir(), "rex-resolve-"));
		try {
			process.env.REX_PATH = join(dir, "first");
			for (let i = 0; i < 9; i++) {
				await bridge.snapshot().catch(() => {});
			}
			process.env.REX_PATH = saved;
			await bridge.snapshot().catch(() => {});
			expect(stub.calls("snapshot")).toHaveLength(0);
			await bridge.snapshot();
			expect(stub.calls("snapshot")).toHaveLength(1);
		} finally {
			process.env.REX_PATH = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a session gone by the time it was viewed just drops out", async () => {
		stub.snapshot(
			raw({
				sessions: [{ session_id: SESSION, number: 1, label: "api-server", windows: {} }],
				skipped: [{ session_id: OTHER, error: `session ${OTHER} not found (status=404 code=session_not_found)` }],
			}),
		);
		expect((await bridge.snapshot()).workspaces.map((w) => w.label)).toEqual(["api-server"]);
	});
});

describe("focus through the bridge", () => {
	const resize = (session: string, owner: string, principal?: object) =>
		event.block(session, PANE, "size_changed", { columns: 80, rows: 24, cell_width_px: 8, cell_height_px: 16, owner, ...(principal ? { principal } : {}) });

	const focused = async (b = bridge) => (await b.snapshot()).focused_workspace_id;

	test("no signal means no focus", async () => {
		stub.snapshot(raw());
		await expect(focused()).resolves.toBeUndefined();
	});

	test("the preference seeds focus and a later value overwrites it", async () => {
		stub.snapshot(raw());
		let value = SESSION;
		let clock = 0;
		const b = new Bridge({ readPreference: async () => value, now: () => clock });
		await expect(focused(b)).resolves.toBe(SESSION);
		value = OTHER;
		clock = 500;
		await expect(focused(b)).resolves.toBe(SESSION);
		clock = 1000;
		await expect(focused(b)).resolves.toBe(OTHER);
	});

	test("a preference naming a session not in the snapshot means no focus", async () => {
		stub.snapshot(raw());
		const b = new Bridge({ readPreference: async () => "session:01a1a685-0000-7000-8000-0123456789ab" });
		const snap = await b.snapshot();
		expect(snap.focused_workspace_id).toBeUndefined();
		expect(snap.workspaces.some((w) => w.focused)).toBe(false);
	});

	test("the app's own size_changed moves focus and triggers a refresh", async () => {
		stub.snapshot(raw());
		await bridge.snapshot();
		let changes = 0;
		await bridge.subscribeChanges(() => changes++, () => {});
		stub.emit(resize(OTHER, APP, { kind: "peer", transport: "unix", display: "uid 501", uid: 501, gid: 20, pid: 4242 }));
		await vi.waitFor(() => expect(changes).toBe(1));
		await expect(focused()).resolves.toBe(OTHER);
	});

	test("the handback form, with no principal, triggers a refresh but does not move focus", async () => {
		stub.snapshot(raw());
		await bridge.snapshot();
		let changes = 0;
		await bridge.subscribeChanges(() => changes++, () => {});
		stub.emit(resize(OTHER, APP));
		await vi.waitFor(() => expect(changes).toBe(1));
		await expect(focused()).resolves.toBeUndefined();
	});

	test("a relaunched app's event is held for the next snapshot", async () => {
		stub.snapshot(raw({ clients: {} }));
		await bridge.snapshot();
		let changes = 0;
		await bridge.subscribeChanges(() => changes++, () => {});
		stub.emit(resize(OTHER, APP, { pid: 4242 }));
		await vi.waitFor(() => expect(changes).toBe(1));
		stub.snapshot(raw());
		await expect(focused()).resolves.toBe(OTHER);
	});

	test("a select is not optimistic: with the stream down, focus does not move", async () => {
		withApp();
		await bridge.snapshot();
		await bridge.focusWorkspace(OTHER);
		await expect(focused()).resolves.toBeUndefined();
	});
});

describe("seen-aware done through the bridge", () => {
	const finished = (state: string, updated_at: string) =>
		raw({
			sessions: [
				{
					session_id: SESSION,
					number: 1,
					label: "api-server",
					active_window_id: WINDOW,
					windows: [
						{
							window_id: WINDOW,
							focused_block_id: PANE,
							blocks: [{ block_id: PANE, creator_name: "com.superlogical.terminal", foreground: { argv0: "claude", pid: 99 }, records: [{ state, updated_at }] }],
						},
					],
				},
			],
		});

	test("done in view reads idle while Rex is in front, DONE again when reported anew", async () => {
		const b = new Bridge({ readPreference: async () => SESSION, isFrontmost: async () => true });
		stub.snapshot(finished("done", "t1"));
		expect((await b.snapshot()).workspaces[0].agent_status).toBe("idle");
		stub.snapshot(finished("working", "t2"));
		expect((await b.snapshot()).workspaces[0].agent_status).toBe("working");
		stub.snapshot(finished("done", "t3"));
		expect((await b.snapshot()).workspaces[0].agent_status).toBe("idle");
	});

	test("done stays DONE while Rex is in the background, then clears when viewed", async () => {
		let frontmost = false;
		const b = new Bridge({ readPreference: async () => SESSION, isFrontmost: async () => frontmost });
		stub.snapshot(finished("done", "t1"));
		expect((await b.snapshot()).workspaces[0].agent_status).toBe("done");
		frontmost = true;
		expect((await b.snapshot()).workspaces[0].agent_status).toBe("idle");
	});

	test("done in a session not in view stays DONE, with ERROR when it errored", async () => {
		const b = new Bridge({ readPreference: async () => null, isFrontmost: async () => true });
		stub.snapshot(finished("error", "t1"));
		expect((await b.snapshot()).workspaces[0]).toMatchObject({ agent_status: "done", status_word: "ERROR" });
	});

	test("a plugin restart forgets what was seen", async () => {
		stub.snapshot(finished("done", "t1"));
		const first = new Bridge({ readPreference: async () => SESSION, isFrontmost: async () => true });
		expect((await first.snapshot()).workspaces[0].agent_status).toBe("idle");
		const restarted = new Bridge({ readPreference: async () => null, isFrontmost: async () => true });
		expect((await restarted.snapshot()).workspaces[0].agent_status).toBe("done");
	});
});

describe("focusWorkspace", () => {
	test("selects through the chosen app client", async () => {
		withApp();
		await bridge.focusWorkspace(OTHER);
		const [call] = stub.calls("select");
		expect(call.flags["-C"]).toBe(APP);
		expect(call.command).toEqual(["do", "session.select", `session_id=${OTHER}`]);
	});

	test("no app client: no_client, nothing sent", async () => {
		await expect(bridge.focusWorkspace(OTHER)).rejects.toMatchObject({ code: "no_client" });
		expect(stub.calls("select")).toEqual([]);
	});

	test.each([
		["a lost client", { ...appClient, connection_state: "lost" }],
		["a client off the unix socket", { ...appClient, principal: { ...appClient.principal, transport: "tcp" } }],
		["a ghost with no info", { ...appClient, info: undefined }],
	])("%s is not selected", async (_name, client) => {
		stub.on("clients", { stdout: `${JSON.stringify({ clients: [client] })}\n` });
		await expect(bridge.focusWorkspace(OTHER)).rejects.toMatchObject({ code: "no_client" });
	});

	test("a relaunched app after a lost one gets the select", async () => {
		const relaunched = { ...appClient, client_id: "client:relaunched" };
		stub.on("clients", { stdout: `${JSON.stringify({ clients: [{ ...appClient, connection_state: "lost" }, relaunched] })}\n` });
		await bridge.focusWorkspace(OTHER);
		expect(stub.calls("select")[0].flags["-C"]).toBe("client:relaunched");
	});

	test.each<[string, number, string, string]>([
		["app gone between calls", 3, `Error: client target "${APP}" not found\n`, "no_client"],
		["app waiting to reconnect", 4, 'Error: "fake-mac" is waiting to reconnect\n', "client_unavailable"],
		["app hung", 1, 'Error: "fake-mac" did not answer within 2s; the action may still run. Requests to a busy client can wait longer than the timeout in total.\n', "client_timeout"],
		["app refused", 1, "Error: fake app refused\n", "unknown"],
	])("%s is classified", async (_name, exit, stderr, code) => {
		withApp().on("select", { exit, stderr });
		await expect(bridge.focusWorkspace(OTHER)).rejects.toMatchObject({ name: "RexApiError", code });
	});
});

describe("createWorkspace", () => {
	test("chooses the client first, creates, then selects", async () => {
		withApp();
		await bridge.createWorkspace();
		expect(stub.calls().map((call) => call.kind)).toEqual(["clients", "new", "select"]);
		expect(stub.calls("new")[0].command).toEqual(["new", "--json"]);
		const [select] = stub.calls("select");
		expect(select.flags["-C"]).toBe(APP);
		expect(select.command).toEqual(["do", "session.select", "session_id=session:01a1a685-92de-7ca6-9b43-9e923573a1b6"]);
	});

	test("no app client: nothing is created", async () => {
		await expect(bridge.createWorkspace()).rejects.toMatchObject({ code: "no_client" });
		expect(stub.calls("new")).toEqual([]);
	});

	test("a failed select is logged, so a second press cannot make a duplicate", async () => {
		withApp().on("select", { exit: 1, stderr: "Error: fake app refused\n" });
		await expect(bridge.createWorkspace()).resolves.toBeUndefined();
		expect(logs.join("\n")).toContain("fake app refused");
	});

	test("a failed create rejects", async () => {
		withApp().on("new", { exit: 4, stderr: "Error: no Rex server is running at /work/x.sock, and autostart is disabled\n" });
		await expect(bridge.createWorkspace()).rejects.toMatchObject({ code: "server_down" });
		expect(stub.calls("select")).toEqual([]);
	});
});

describe("createTab", () => {
	const scratch = mkdtempSync(join(tmpdir(), "rex-tab-"));
	const file = join(scratch, "a-file");
	writeFileSync(file, "");
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	test("opens in the folder, then selects that session and window", async () => {
		withApp();
		await bridge.createTab(SESSION, scratch);
		expect(stub.calls("window")[0].command).toEqual(["window", "new", "-s", SESSION, "-c", scratch, "--json"]);
		const [select] = stub.calls("select");
		expect(select.flags["-C"]).toBe(APP);
		expect(select.command).toEqual(["do", "session.select", `session_id=${SESSION}`, "window_id=window:01a1a685-9312-7b4e-8618-dc30a667bf2d"]);
	});

	test("no folder leaves the flag off", async () => {
		withApp();
		await bridge.createTab(SESSION, undefined);
		expect(stub.calls("window")[0].command).toEqual(["window", "new", "-s", SESSION, "--json"]);
	});

	test.each([
		["relative", "relative/dir"],
		["missing", join(scratch, "missing")],
		["a file", file],
	])("a %s folder throws no_such_dir and nothing is created", async (_name, cwd) => {
		withApp();
		await expect(bridge.createTab(SESSION, cwd)).rejects.toMatchObject({ code: "no_such_dir" });
		expect(stub.calls("window")).toEqual([]);
		expect(stub.calls("select")).toEqual([]);
	});

	test("no app client: nothing is created", async () => {
		await expect(bridge.createTab(SESSION, scratch)).rejects.toMatchObject({ code: "no_client" });
		expect(stub.calls("window")).toEqual([]);
	});

	test("a failed select is logged, not thrown", async () => {
		withApp().on("select", { exit: 1, stderr: "Error: fake app refused\n" });
		await expect(bridge.createTab(SESSION, scratch)).resolves.toBeUndefined();
		expect(logs).toHaveLength(1);
	});

	test("a session gone is reported", async () => {
		withApp().on("window", { exit: 3, stderr: `Error: session target "${SESSION}" not found\n` });
		await expect(bridge.createTab(SESSION, scratch)).rejects.toMatchObject({ code: "session_not_found" });
	});
});

describe("sends", () => {
	beforeEach(async () => {
		withApp();
		await bridge.snapshot();
	});

	test("a pane not in the latest snapshot is not_found, and nothing runs", async () => {
		const gone = "block:01a1a685-0000-7000-8000-0123456789ab";
		for (const send of [() => bridge.promptAgent(gone, "x"), () => bridge.sendInput(gone, "x"), () => bridge.sendText(gone, "x"), () => bridge.sendKeys(gone, ["esc"])]) {
			await expect(send()).rejects.toMatchObject({ name: "RexApiError", code: "not_found" });
		}
		expect(stub.calls().filter((call) => call.kind !== "snapshot")).toEqual([]);
	});

	test("the map follows the snapshot", async () => {
		stub.snapshot(raw({ sessions: {} }));
		await bridge.snapshot();
		await expect(bridge.sendText(PANE, "x")).rejects.toMatchObject({ code: "not_found" });
	});

	test("sendKeys maps every token and names session and block", async () => {
		await bridge.sendKeys(PANE, ["esc", "return", "A", "!", "ctrl+i", "meta+x", "-"]);
		const [call] = stub.calls("send-key");
		expect(call.command).toEqual(["send-key", "-s", SESSION, "-b", PANE, "--", "esc", "enter", "shift+a", "shift+1", "tab", "alt+x", "-"]);
	});

	test("sendKeys reports what rex refuses", async () => {
		stub.on("send-key", { exit: 2, stderr: 'Error: invalid key "foo": unknown key "foo"\n\nUsage:\n  rex send-key KEY... [flags]\n' });
		await expect(bridge.sendKeys(PANE, ["esc"])).rejects.toMatchObject({ code: "invalid_key", message: 'Error: invalid key "foo": unknown key "foo"' });
	});

	test("sendKeys refuses a token rex cannot deliver without calling it", async () => {
		await expect(bridge.sendKeys(PANE, ["é"])).rejects.toMatchObject({ code: "invalid_key" });
		expect(stub.calls("send-key")).toEqual([]);
	});

	test("a block closed since the snapshot reads as gone", async () => {
		stub.on("send-key", { exit: 3, stderr: `Error: block target "${PANE}" not found\n` });
		await expect(bridge.sendKeys(PANE, ["esc"])).rejects.toMatchObject({ code: "not_found" });
		stub.on("send-key", { exit: 3, stderr: `Error: block target "${PANE}" not found: session scope: session "${SESSION}" not found\n` });
		await expect(bridge.sendKeys(PANE, ["esc"])).rejects.toMatchObject({ code: "session_not_found" });
	});

	test("user text travels as JSON args, so 123 stays a string", async () => {
		await bridge.sendText(PANE, "123");
		await bridge.sendInput(PANE, "-n go");
		await bridge.promptAgent(PANE, 'quote " and\nnewline');
		const argsOf = (kind: string) => stub.scriptArgs(stub.calls(kind)[0]);
		expect(argsOf("write")).toEqual({ session_id: SESSION, block_id: PANE, text: "123" });
		expect(argsOf("input")).toEqual({ session_id: SESSION, block_id: PANE, text: "-n go" });
		expect(argsOf("prompt")).toEqual({ session_id: SESSION, block_id: PANE, text: 'quote " and\nnewline' });
	});

	test("the scripts attach first and send what the design says", async () => {
		await bridge.sendText(PANE, "x");
		await bridge.sendInput(PANE, "x");
		await bridge.promptAgent(PANE, "x");
		const script = (kind: string) => stub.calls(kind)[0].command[2];
		for (const kind of ["write", "input", "prompt"]) {
			expect(script(kind)).toContain('call("session.attach_all", { event_scope = "session" })');
		}
		expect(script("write")).toContain("write(text)");
		expect(script("input")).toMatch(/paste\(\)\nwrite\("\\r"\)/);
		expect(script("prompt")).toMatch(/paste\(\)\nrex\.sleep\(0\.3\)\nwrite\("\\r"\)/);
	});

	test.each<[string, number, string, string]>([
		["the guard refused a blocked agent", 1, "Error: agent_blocked\n", "agent_blocked"],
		["the guard found no agent", 1, "Error: agent_not_ready\n", "agent_not_ready"],
		["the block closed", 1, `Error: stream response "control-2" failed: block not found: ${PANE} (status=404 code=not_found)\n`, "not_found"],
		["the session closed", 1, `Error: stream response "control-2" failed: session ${SESSION} not found (status=404 code=session_not_found)\n`, "session_not_found"],
		["the server stopped", 4, "Error: no Rex server is running at /work/x.sock, and autostart is disabled\n", "server_down"],
	])("promptAgent: %s", async (_name, exit, stderr, code) => {
		stub.on("prompt", { exit, stderr });
		const err = await bridge.promptAgent(PANE, "/review").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RexApiError);
		expect(err).toMatchObject({ code });
	});
});

describe("subscribeChanges", () => {
	test("spawns rex events with no timeout, and resolves once it stayed alive", async () => {
		const started = Date.now();
		await bridge.subscribeChanges(() => {}, () => {});
		expect(Date.now() - started).toBeGreaterThanOrEqual(240);
		const [call] = stub.calls("events");
		expect(call.command).toEqual(["events", "--all", "--json"]);
		expect(call.flags["--timeout"]).toBeUndefined();
	});

	test("rejects with a classified error if it exits sooner", async () => {
		stub.on("events", { exit: 4, stderr: "Error: no Rex server is running at /work/x.sock, and autostart is disabled\n" });
		await expect(bridge.subscribeChanges(() => {}, () => {})).rejects.toMatchObject({ name: "RexApiError", code: "server_down" });
	});

	test("rejects when the binary cannot run", async () => {
		const saved = process.env.REX_PATH;
		process.env.REX_PATH = "/nonexistent/rex";
		try {
			await expect(new Bridge().subscribeChanges(() => {}, () => {})).rejects.toThrow(/ENOENT/);
		} finally {
			process.env.REX_PATH = saved;
		}
	});

	test("filters the stream and reports its close", async () => {
		let changes = 0;
		let closed = 0;
		await bridge.subscribeChanges(() => changes++, () => closed++);
		const status = (msg: string) => event.block(SESSION, PANE, "program_status_changed", { id: "", record: { state: "working", msg }, reason: "report" });
		stub.emit(event.top("client_joined", { client: {} }), status("one"), status("two"), event.block(SESSION, PANE, "pwd_changed", { pwd: "/work" }), event.top("session_created", { session: { session_id: OTHER } }));
		await vi.waitFor(() => expect(changes).toBe(2));
		expect(closed).toBe(0);
		stub.endStream(4, "Error: server went away: reading API control: reading control message: failed to get reader: failed to read frame header: EOF\n");
		await vi.waitFor(() => expect(closed).toBe(1));
		expect(changes).toBe(2);
	});

	test("process_changed classifies against the latest snapshot's records", async () => {
		stub.snapshot(
			raw({
				sessions: [
					{
						session_id: SESSION,
						number: 1,
						windows: [
							{
								window_id: WINDOW,
								blocks: [{ block_id: PANE, creator_name: "com.superlogical.terminal", foreground: { argv0: "node", pid: 77 }, records: [{ state: "working", app: "my-agent", owner: { pid: 77 } }] }],
							},
						],
					},
				],
			}),
		);
		await bridge.snapshot();
		let changes = 0;
		await bridge.subscribeChanges(() => changes++, () => {});
		const process = (pid: number, argv0: string) => event.block(SESSION, PANE, "process_changed", { generation: pid, foreground: { pid, argv0, cwd: "/work" } });
		stub.emit(process(1, "-zsh"));
		await vi.waitFor(() => expect(changes).toBe(1));
		stub.emit(process(77, "node"));
		await vi.waitFor(() => expect(changes).toBe(2));
		stub.emit(process(1, "-zsh"));
		await vi.waitFor(() => expect(changes).toBe(3));
	});

	test("close stops the child", async () => {
		let closed = 0;
		await bridge.subscribeChanges(() => {}, () => closed++);
		bridge.close();
		await vi.waitFor(() => expect(closed).toBe(1));
	});

	test("a later subscribe starts a new child", async () => {
		let closed = 0;
		await bridge.subscribeChanges(() => {}, () => closed++);
		stub.endStream(4);
		await vi.waitFor(() => expect(closed).toBe(1));
		rmSync(join(stub.dir, "events.end"));
		await bridge.subscribeChanges(() => {}, () => {});
		expect(stub.calls("events")).toHaveLength(2);
	});
});

describe("workingDir", () => {
	const space = { workspace_id: "w1", active_tab_id: "t2" } as Workspace;
	const panes = (entries: [string, string, string?][]): Snapshot["panes"] =>
		entries.map(([pane_id, tab_id, cwd]) => ({ pane_id, tab_id, workspace_id: "w1", agent_status: "idle", focused: false, ...(cwd ? { cwd } : {}) }));

	test("prefers the session's active pane over the first pane", () => {
		const snap: Snapshot = {
			workspaces: [],
			layouts: [{ tab_id: "t2", focused_pane_id: "p3" }],
			panes: panes([["p1", "t1", "/work/first"], ["p2", "t2", "/work/second"], ["p3", "t2", "/work/active"]]),
		};
		expect(workingDir(snap, space)).toBe("/work/active");
	});

	test("then a pane in the active tab, then any pane", () => {
		const noActive: Snapshot = {
			workspaces: [],
			layouts: [{ tab_id: "t2", focused_pane_id: "p3" }],
			panes: panes([["p1", "t1", "/work/first"], ["p2", "t2", "/work/second"], ["p3", "t2"]]),
		};
		expect(workingDir(noActive, space)).toBe("/work/second");
		expect(workingDir({ workspaces: [], panes: panes([["p1", "t1", "/work/first"]]) }, space)).toBe("/work/first");
	});

	test("nothing when no pane has a folder", () => {
		expect(workingDir({ workspaces: [], panes: panes([["p1", "t1"]]) }, space)).toBe("");
	});

	test("ignores other sessions' panes", () => {
		const other = panes([["p1", "t1", "/work/elsewhere"]]).map((pane) => ({ ...pane, workspace_id: "w2" }));
		expect(workingDir({ workspaces: [], panes: other }, space)).toBe("");
	});
});

describe("the stub", () => {
	test("refuses a call without --autostart=false", () => {
		const result = spawnSync(process.env.REX_PATH ?? "", ["api", "call", "server.version"], { encoding: "utf8" });
		expect(result.status).toBe(99);
	});

	test("records real argv", () => {
		execFileSync(process.env.REX_PATH ?? "", ["--autostart=false", "-S", "unix:///x", "send-key", "--", "esc"]);
		expect(readFileSync(join(stub.dir, "calls.jsonl"), "utf8")).toContain('"send-key","--","esc"');
	});
});
