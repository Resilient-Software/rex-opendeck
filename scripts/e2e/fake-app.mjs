#!/usr/bin/env node
// A stand-in for the Rex Mac app, for e2e runs against a sandbox `rex server run`.
// It speaks rex.control.v1, which the server documents at GET /llms.txt on its socket.
//
//   node fake-app.mjs --socket /abs/path.sock [--label fake-mac] [--select-delay-ms 150] [--ghost]
//
// Prints one JSON object per line. As a library: new FakeApp({ socket }), await start(), and the
// getters and methods below. Never drive an in-process FakeApp with execFileSync: blocking the
// event loop stops it answering, and the CLI call waits for the answer.
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const PROTOCOL = "rex.control.v1";
const API_REVISION = 10;
const TERMINAL = "com.superlogical.terminal";

const SESSION_SELECT = {
	name: "session.select",
	kind: "client",
	title: "Go to Session",
	args: {
		type: "object",
		properties: { session_id: { type: "string" }, window_id: { type: "string" } },
		required: ["session_id"],
		additionalProperties: false,
	},
};

class ControlError extends Error {
	constructor(method, error) {
		super(`${method}: ${error.message}`);
		this.code = error.code;
		this.status = error.status;
	}
}

class Connection {
	#ws;
	#pending = new Map();
	#nextId = 0;

	constructor(socket, client, onEvent, onClose) {
		// Compression stays off because a hello must not be compressed.
		this.#ws = new WebSocket(`ws+unix:${socket}:/api/control`, [PROTOCOL], { perMessageDeflate: false });
		this.welcome = new Promise((resolve, reject) => {
			this.#ws.on("open", () => {
				const hello = { type: "hello", api_revision: API_REVISION };
				if (client) hello.client = client;
				this.#ws.send(JSON.stringify(hello));
			});
			this.#ws.on("message", (data) => {
				const message = JSON.parse(data.toString());
				if (message.type === "welcome") resolve(message);
				else if (message.type === "response") this.#settle(message);
				else if (message.type === "event") onEvent(message.payload);
			});
			this.#ws.on("error", reject);
			this.#ws.on("close", (code, reason) => {
				reject(new Error(`closed before welcome: ${code} ${reason}`));
				for (const { reject: fail, method } of this.#pending.values()) {
					fail(new ControlError(method, { code: "closed", message: "connection closed" }));
				}
				this.#pending.clear();
				onClose?.(code, reason.toString());
			});
		});
	}

	#settle(message) {
		const entry = this.#pending.get(message.id);
		if (!entry) return;
		this.#pending.delete(message.id);
		if (message.error) entry.reject(new ControlError(entry.method, message.error));
		else entry.resolve(message.payload ?? {});
	}

	call(method, payload = {}) {
		return new Promise((resolve, reject) => {
			const id = `fake-${++this.#nextId}`;
			this.#pending.set(id, { resolve, reject, method });
			this.#ws.send(JSON.stringify({ type: "request", id, method, payload }));
		});
	}

	close() {
		return new Promise((resolve) => {
			if (this.#ws.readyState === 3) return resolve();
			this.#ws.once("close", resolve);
			this.#ws.close(1000);
		});
	}

	// No close frame, so the server keeps the client as `lost` for its reconnect grace.
	terminate() {
		return new Promise((resolve) => {
			if (this.#ws.readyState === 3) return resolve();
			this.#ws.once("close", resolve);
			this.#ws.terminate();
		});
	}
}

export class FakeApp extends EventEmitter {
	#conn;
	#ghost;
	#options;
	#visible = null;
	#generation = 0;
	#timer = null;

	// "ok" answers, "refuse" answers with code refused, "ignore" never answers.
	mode = "ok";
	clientId = null;
	selects = [];

	constructor({ socket, label = "fake-mac", kind = "app", name = "Rex.app", version = "0.0.0-fake", platform = "macos", selectDelayMs = 150, ghost = false, size = null }) {
		super();
		this.#options = { socket, label, kind, name, version, platform, selectDelayMs, ghost, size };
	}

	get visible() {
		return this.#visible;
	}

	#log(event, fields = {}) {
		this.emit("log", { event, ...fields });
	}

	async start() {
		const { socket, label, kind, name, version, platform, ghost } = this.#options;
		this.#conn = new Connection(
			socket,
			{ kind, platform, name, version, label },
			(event) => this.#onEvent(event),
			(code, reason) => {
				clearTimeout(this.#timer);
				this.#log("closed", { code, reason });
				this.emit("closed", code, reason);
			},
		);
		const welcome = await this.#conn.welcome;
		this.clientId = welcome.client.id;

		const boot = await this.#conn.call("session.bootstrap", { event_scope: "all", attach_session_ids: [] });
		await this.#conn.call("client.keymap", { actions: [SESSION_SELECT] });
		for (const { session_id } of boot.attach_all?.sessions ?? []) await this.#attach(session_id);

		// The real app shows one more entry with its pid and no info.
		if (ghost) {
			this.#ghost = new Connection(socket, null, () => {});
			await this.#ghost.welcome;
		}
		this.#log("ready", { client_id: this.clientId, pid: process.pid, label });
		return this;
	}

	#attach(sessionId) {
		return this.#conn.call("session.attach", { session_id: sessionId });
	}

	#onEvent(event) {
		switch (event.type) {
			case "client_perform_requested":
				this.#onPerform(event.payload).catch((error) => this.#log("error", { where: "perform", message: error.message }));
				break;
			case "session_created":
				this.#attach(event.payload.session.session_id).catch((error) => this.#log("error", { where: "attach", message: error.message }));
				break;
			case "session_destroyed":
				if (this.#visible?.session_id === event.payload.session_id) this.#clearVisible();
				break;
			case "session_event": {
				const inner = event.payload.event;
				if (inner.type !== "block_event" || inner.payload.name !== "size_changed") break;
				if (inner.payload.payload.owner !== this.clientId) break;
				this.#log("size_changed_seen", { session_id: event.payload.session_id, block_id: inner.payload.block_id, has_principal: Boolean(inner.payload.payload.principal) });
				this.emit("size_changed", { session_id: event.payload.session_id, block_id: inner.payload.block_id });
				break;
			}
		}
	}

	#clearVisible() {
		this.#generation++;
		clearTimeout(this.#timer);
		this.#visible = null;
		this.#log("visible_cleared");
	}

	async #onPerform(request) {
		const { call_id: callId, action, args = {}, origin } = request;
		this.#log("perform", { action, args, origin, mode: this.mode });
		if (this.mode === "ignore") return;
		if (this.mode === "refuse") return this.#reply(callId, { error: { code: "refused", message: "fake app refused" } });
		if (action !== "session.select") {
			return this.#reply(callId, { error: { code: "not_supported", message: `fake app has no action ${action}` } });
		}
		try {
			await this.select(args.session_id ?? request.session_id, args.window_id);
		} catch (error) {
			const code = error.code === "session_not_found" ? "not_found" : (error.code ?? "internal");
			return this.#reply(callId, { error: { code, message: error.message } });
		}
		return this.#reply(callId, { result: null });
	}

	#reply(callId, outcome) {
		return this.#conn.call("client.reply", { call_id: callId, ...outcome });
	}

	/** Show a session, as a client.perform does or as a person clicking in the app would. */
	async select(sessionId, windowId) {
		await this.#attach(sessionId);
		if (windowId) await this.#conn.call("session.focus_window", { session_id: sessionId, window_id: windowId });
		this.#visible = { session_id: sessionId, window_id: windowId ?? null };
		this.selects.push({ ...this.#visible, at: Date.now() });
		this.#log("select", this.#visible);
		const generation = ++this.#generation;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#present(generation).catch((error) => this.#log("error", { where: "present", message: error.message }));
		}, this.#options.selectDelayMs);
	}

	/** Re-lay out the visible session without changing it, as toggling the sidebar does. */
	nudge() {
		return this.#visible ? this.#present(this.#generation) : Promise.resolve();
	}

	// An owner's resize emits size_changed even at the current size, so the terminal never sees SIGWINCH.
	async #present(generation) {
		if (generation !== this.#generation || !this.#visible) return;
		const sessionId = this.#visible.session_id;
		const view = await this.#conn.call("session.view", { session_id: sessionId });
		const shown = view.windows?.find((w) => w.window_id === view.active_window_id) ?? view.windows?.[0];
		const blocks = (shown?.layers ?? []).flatMap((l) => l.blocks ?? []).filter((b) => b.creator_name === TERMINAL);
		if (blocks.length === 0 || generation !== this.#generation) return;
		await this.#conn.call("session.own_block", { session_id: sessionId, block_ids: blocks.map((b) => b.block_id), mode: "take" });
		for (const { block_id: blockId } of blocks) {
			const target = { session_id: sessionId, block_id: blockId };
			const size = this.#options.size ?? (await this.#conn.call(`${TERMINAL}.size`, target));
			await this.#conn.call(`${TERMINAL}.resize`, { ...target, args: { columns: size.columns, rows: size.rows } });
		}
	}

	/** Quit cleanly. The client disappears from client.list at once. */
	async stop() {
		clearTimeout(this.#timer);
		await this.#ghost?.close();
		await this.#conn?.close();
	}

	/** Die without a close frame. The client stays listed with connection_state "lost". */
	async kill() {
		clearTimeout(this.#timer);
		await this.#ghost?.terminate();
		await this.#conn?.terminate();
	}
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--socket") options.socket = argv[++i];
		else if (flag === "--label") options.label = argv[++i];
		else if (flag === "--name") options.name = argv[++i];
		else if (flag === "--platform") options.platform = argv[++i];
		else if (flag === "--select-delay-ms") options.selectDelayMs = Number(argv[++i]);
		else if (flag === "--ghost") options.ghost = true;
		else throw new Error(`unknown flag ${flag}`);
	}
	if (!options.socket) throw new Error("--socket is required");
	return options;
}

function isMain() {
	if (!process.argv[1]) return false;
	return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMain()) {
	const app = new FakeApp(parseArgs(process.argv.slice(2)));
	let stopping = false;
	app.on("log", (line) => process.stdout.write(`${JSON.stringify(line)}\n`));
	app.on("closed", () => process.exit(stopping ? 0 : 1));
	for (const signal of ["SIGTERM", "SIGINT"]) {
		process.on(signal, () => {
			stopping = true;
			app.stop();
		});
	}
	app.start().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	});
}
