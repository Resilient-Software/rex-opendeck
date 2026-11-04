import { describe, expect, test } from "vitest";

import { ChangeFilter } from "../src/rex-events";
import type { SizeChange } from "../src/rex-focus";
import type { RawRecord } from "../src/rex-snapshot";
import { event } from "./stub";

const S = "session:01a1a685-8b8e-72ee-bdf5-945c8c4340ef";
const B = "block:01a1a685-8b8e-74d2-bc02-c8e45579e6d4";

function filter(recordsOf?: (blockId: string) => readonly RawRecord[]) {
	const sizes: SizeChange[] = [];
	const state = { changes: 0 };
	const instance = new ChangeFilter({ onChange: () => state.changes++, onSizeChanged: (change) => sizes.push(change) }, recordsOf && ((blockId) => ({ records: [...recordsOf(blockId)] })));
	const send = (...events: unknown[]) => {
		const before = state.changes;
		for (const line of events) {
			instance.line(typeof line === "string" ? line : JSON.stringify(line));
		}
		return state.changes - before;
	};
	return { send, sizes };
}

const status = (id: string, state: string, extra: object = {}) => event.block(S, B, "program_status_changed", { id, record: { state, app: "claude-code", ...extra }, reason: "report" });

describe("whitelist", () => {
	test.each([
		["session_created", event.top("session_created", { session: { session_id: S, label: "api-server" } })],
		["session_destroyed", event.top("session_destroyed", { session_id: S })],
		["session_moved", event.top("session_moved", { session_id: S })],
		["session_label_changed", event.session(S, "session_label_changed", { label: "x" })],
		["window_created", event.session(S, "window_created", { window_id: "window:1", label: "logs" })],
		["window_closed", event.session(S, "window_closed", { window_id: "window:1" })],
		["window_label_changed", event.session(S, "window_label_changed", { window_id: "window:1", label: "y" })],
		["active_window_changed", event.session(S, "active_window_changed", { window_id: "window:1" })],
		["block_created", event.session(S, "block_created", { block_id: B })],
		["block_closed", event.session(S, "block_closed", { block_id: B })],
		["session_view_changed", event.session(S, "session_view_changed", { revision: 2 })],
		["program_status_changed", status("", "working")],
		["program_status_removed", event.block(S, B, "program_status_removed", { ids: [""], reason: "clear" })],
		["process_changed", event.block(S, B, "process_changed", { generation: 2, foreground: { pid: 1, argv0: "claude", cwd: "/work" } })],
		["child_exited", event.block(S, B, "child_exited", { exit_code: 0 })],
		["size_changed", event.block(S, B, "size_changed", { columns: 80, rows: 24, owner: "client:1", principal: { pid: 1 } })],
	])("%s triggers a refresh", (_name, line) => {
		expect(filter().send(line)).toBe(1);
	});

	test.each([
		["client_joined", event.top("client_joined", { client: { client_id: "client:1" } })],
		["client_left", event.top("client_left", { client_id: "client:1" })],
		["client_changed", event.top("client_changed", { client: {} })],
		["client_performed", event.top("client_performed", { action: "session.select" })],
		["client_connected", event.session(S, "client_connected", { client_id: "client:1" })],
		["client_disconnected", event.session(S, "client_disconnected", { client_id: "client:1" })],
		["client_connection_changed", event.session(S, "client_connection_changed", { connection_state: "lost" })],
		["block_owner_changed", event.session(S, "block_owner_changed", { block_id: B, reason: "take" })],
		["pwd_changed", event.block(S, B, "pwd_changed", { pwd: "/work" })],
		["title_changed", event.block(S, B, "title_changed", { title: "zsh" })],
		["an event never seen before", event.top("server_tea_time")],
	])("%s is ignored", (_name, line) => {
		expect(filter().send(line)).toBe(0);
	});

	test("an unparseable line is skipped, the stream goes on", () => {
		expect(filter().send("not json", '{"type":', status("", "working"))).toBe(1);
	});
});

describe("program_status_changed churn", () => {
	test("a repeat of the same state and kind is dropped, msg or not", () => {
		const { send } = filter();
		expect(send(status("", "working", { msg: "one" }))).toBe(1);
		expect(send(status("", "working", { msg: "two", updated_at: "t2" }))).toBe(0);
	});

	test("a change of state or kind passes", () => {
		const { send } = filter();
		expect(send(status("", "blocked", { kind: "permission" }))).toBe(1);
		expect(send(status("", "blocked", { kind: "question" }))).toBe(1);
		expect(send(status("", "working"))).toBe(1);
	});

	test("the same state from a new owner passes", () => {
		const { send } = filter();
		expect(send(status("", "idle", { owner: { pid: 100 } }))).toBe(1);
		expect(send(status("", "idle", { owner: { pid: 100 }, msg: "again" }))).toBe(0);
		expect(send(status("", "idle", { owner: { pid: 200 } }))).toBe(1);
	});

	test("records and blocks are tracked apart", () => {
		const { send } = filter();
		expect(send(status("", "working"), status("agent_a", "working"), event.block(S, "block:2", "program_status_changed", { id: "", record: { state: "working" } }))).toBe(3);
		expect(send(status("", "working"), status("agent_a", "working"))).toBe(0);
	});

	test("a record removed and reported again passes", () => {
		const { send } = filter();
		send(status("", "working"));
		expect(send(event.block(S, B, "program_status_removed", { ids: [""], reason: "prompt" }))).toBe(1);
		expect(send(status("", "working"))).toBe(1);
	});
});

describe("process_changed churn", () => {
	const process = (foreground: unknown) => event.block(S, B, "process_changed", { generation: Math.random(), foreground });

	test("a busy shell triggers nothing past the first sighting", () => {
		const { send } = filter();
		expect(send(process({ pid: 1, argv0: "-zsh", name: "zsh", cwd: "/work" }))).toBe(1);
		for (const pid of [2, 3, 4, 5]) {
			expect(send(process({ pid, argv0: "/bin/sleep", name: "sleep", cwd: "/work" }))).toBe(0);
			expect(send(process({ pid: 1, argv0: "-zsh", name: "zsh", cwd: "/work" }))).toBe(0);
		}
	});

	test("the agent appearing and leaving pass", () => {
		const { send } = filter();
		send(process({ pid: 1, argv0: "-zsh", cwd: "/work" }));
		expect(send(process({ pid: 2, argv0: "claude", name: "2.1.318", cwd: "/work" }))).toBe(1);
		expect(send(process({ pid: 1, argv0: "-zsh", cwd: "/work" }))).toBe(1);
	});

	test("a cwd change passes", () => {
		const { send } = filter();
		send(process({ pid: 1, argv0: "-zsh", cwd: "/work" }));
		expect(send(process({ pid: 1, argv0: "-zsh", cwd: "/work/api-server" }))).toBe(1);
	});

	test("startup's null foreground and root login keep the last cwd", () => {
		const { send } = filter();
		send(process({ pid: 1, argv0: "-zsh", cwd: "/work" }));
		expect(send(process(null))).toBe(0);
		expect(send(process({ pid: 1, name: "login", path: "/usr/bin/login" }))).toBe(0);
		expect(send(process({ pid: 1, argv0: "-zsh", cwd: "/work" }))).toBe(0);
	});

	test("a wrapper counts as an agent through its own record", () => {
		const { send } = filter(() => [{ state: "working", app: "my-agent", owner: { pid: 7 } }]);
		send(process({ pid: 1, argv0: "-zsh", cwd: "/work" }));
		expect(send(process({ pid: 7, argv0: "node", cwd: "/work" }))).toBe(1);
		expect(send(process({ pid: 1, argv0: "-zsh", cwd: "/work" }))).toBe(1);
	});
});

describe("process_changed and what the pane reads", () => {
	const process = (foreground: unknown) => event.block(S, B, "process_changed", { generation: Math.random(), foreground });
	const SHELL = { pid: 1, argv0: "-zsh", cwd: "/work" };
	const TAIL = { pid: 2, argv0: "tail", cwd: "/work" };

	test("a record that means something only away from a shell flips the tile at once", () => {
		const { send } = filter(() => [{ state: "working" }]);
		send(process(SHELL));
		expect(send(process(TAIL))).toBe(1);
		expect(send(process(SHELL))).toBe(1);
	});

	test("a dead agent's idle reads the same everywhere, so a busy shell stays quiet", () => {
		const { send } = filter(() => [{ state: "idle", owner: { pid: 99 } }]);
		send(process(SHELL));
		for (const pid of [2, 3, 4]) {
			expect(send(process({ ...TAIL, pid }))).toBe(0);
			expect(send(process(SHELL))).toBe(0);
		}
	});

	test("the same agent replaced by a new process passes, since its records stop counting", () => {
		const { send } = filter(() => [{ state: "done", owner: { pid: 7 } }]);
		send(process({ pid: 7, argv0: "claude", cwd: "/work" }));
		expect(send(process({ pid: 7, argv0: "claude", cwd: "/work" }))).toBe(0);
		expect(send(process({ pid: 8, argv0: "claude", cwd: "/work" }))).toBe(1);
	});

	test("a dead agent's done too", () => {
		const { send } = filter(() => [{ state: "done", owner: { pid: 99 } }]);
		send(process(SHELL));
		expect(send(process(TAIL))).toBe(0);
		expect(send(process(SHELL))).toBe(0);
	});
});

describe("size_changed", () => {
	test("hands focus the session, owner and principal", () => {
		const { send, sizes } = filter();
		send(event.block(S, B, "size_changed", { columns: 80, rows: 24, cell_width_px: 8, cell_height_px: 16, owner: "client:1", principal: { kind: "peer", transport: "unix", pid: 42 } }));
		expect(sizes).toEqual([{ session_id: S, owner: "client:1", principal: { kind: "peer", transport: "unix", pid: 42 } }]);
	});

	test("reports the handback form, with no principal", () => {
		const { send, sizes } = filter();
		send(event.block(S, B, "size_changed", { columns: 80, rows: 24, owner: "client:1" }));
		expect(sizes).toEqual([{ session_id: S, owner: "client:1" }]);
	});
});
