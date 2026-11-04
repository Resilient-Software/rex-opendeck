/**
 * The change stream: a long-lived `rex events --all --json` child, filtered
 * down to what can alter the deck. The filter whitelists because every
 * connection emits client_joined and client_left, and because a busy shell
 * fires process_changed about seven times a second.
 */
import { spawn } from "node:child_process";

import { classifyRexError, RexApiError } from "./rex-errors";
import type { SizeChange } from "./rex-focus";
import { agentOf, list, type RawForeground, type RawRecord } from "./rex-snapshot";

const ALIVE_MS = 250;

const TOP_LEVEL = new Set(["session_created", "session_destroyed", "session_moved"]);
const SESSION_LEVEL = new Set([
	"session_label_changed",
	"window_created",
	"window_closed",
	"window_label_changed",
	"active_window_changed",
	"block_created",
	"block_closed",
	"session_view_changed",
]);

type BlockPayload = {
	block_id?: string;
	name?: string;
	payload?: {
		id?: string;
		ids?: string[];
		record?: { state?: string; kind?: string };
		foreground?: RawForeground | null;
		owner?: string;
		principal?: { pid?: number };
	};
};

type StreamEvent = {
	type?: string;
	payload?: {
		session_id?: string;
		event?: { type?: string; payload?: BlockPayload };
	};
};

export type ChangeHandlers = {
	onChange: () => void;
	onSizeChanged: (change: SizeChange) => void;
};

/** Per-block signatures, so a repeated status or a busy shell triggers nothing. */
export class ChangeFilter {
	private readonly process = new Map<string, { agent: string; cwd: string }>();
	private readonly status = new Map<string, string>();

	constructor(
		private readonly handlers: ChangeHandlers,
		private readonly recordsOf: (blockId: string) => readonly RawRecord[] = () => [],
	) {}

	public line(line: string): void {
		let event: StreamEvent;
		try {
			event = JSON.parse(line) as StreamEvent;
		} catch {
			return;
		}
		if (this.triggers(event)) {
			this.handlers.onChange();
		}
	}

	private blockTriggers(sessionId: string, inner: BlockPayload): boolean {
		const blockId = inner.block_id ?? "";
		const payload = inner.payload ?? {};
		switch (inner.name) {
			case "program_status_changed":
				return this.statusChanged(blockId, payload);
			case "program_status_removed":
				for (const id of list<string>(payload.ids)) {
					this.status.delete(`${blockId}\n${id}`);
				}
				return true;
			case "process_changed":
				return this.processChanged(blockId, payload.foreground);
			case "child_exited":
				return true;
			case "size_changed":
				this.handlers.onSizeChanged({ session_id: sessionId, owner: payload.owner, principal: payload.principal });
				return true;
			default:
				return false;
		}
	}

	private processChanged(blockId: string, foreground: RawForeground | null | undefined): boolean {
		const previous = this.process.get(blockId);
		// A foreground can be absent, or a root login with no cwd, during startup.
		const next = { agent: agentOf(foreground, this.recordsOf(blockId)) ?? "", cwd: foreground?.cwd ?? previous?.cwd ?? "" };
		this.process.set(blockId, next);
		return previous?.agent !== next.agent || previous.cwd !== next.cwd;
	}

	private statusChanged(blockId: string, payload: NonNullable<BlockPayload["payload"]>): boolean {
		const key = `${blockId}\n${payload.id ?? ""}`;
		const signature = JSON.stringify([payload.id ?? "", payload.record?.state, payload.record?.kind ?? null]);
		if (this.status.get(key) === signature) {
			return false;
		}
		this.status.set(key, signature);
		return true;
	}

	private triggers(event: StreamEvent): boolean {
		if (event.type === undefined) {
			return false;
		}
		if (TOP_LEVEL.has(event.type)) {
			return true;
		}
		if (event.type !== "session_event") {
			return false;
		}
		const inner = event.payload?.event;
		if (inner?.type === "block_event") {
			return this.blockTriggers(event.payload?.session_id ?? "", inner.payload ?? {});
		}
		return SESSION_LEVEL.has(inner?.type ?? "");
	}
}

export type ChangeStream = { close(): void };

/**
 * rex prints no readiness line and never reconnects, exiting 4 when the server
 * goes away. Resolves once the child has stayed alive briefly and rejects if it
 * exits sooner; a hung server stays silent, so only the caller's poll sees that.
 */
export function startChangeStream(
	binary: string,
	args: string[],
	filter: ChangeFilter,
	onClose: () => void,
): Promise<ChangeStream> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		const killChild = () => child.kill();
		process.once("exit", killChild);
		const stream: ChangeStream = { close: killChild };
		let settled = false;
		let stderr = "";
		let buffered = "";
		const alive = setTimeout(() => {
			settled = true;
			resolve(stream);
		}, ALIVE_MS);
		const fail = (err: Error) => {
			if (!settled) {
				settled = true;
				clearTimeout(alive);
				reject(err);
			}
		};
		child.stdout.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
				filter.line(buffered.slice(0, i));
				buffered = buffered.slice(i + 1);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", fail);
		child.on("close", (code) => {
			process.removeListener("exit", killChild);
			if (settled) {
				onClose();
			} else {
				fail(new RexApiError(classifyRexError(code, stderr), stderr.trim() || `rex events exited with ${code}`));
			}
		});
	});
}
