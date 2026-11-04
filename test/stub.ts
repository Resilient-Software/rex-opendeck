import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StubResponse = { stdout?: string; stderr?: string; exit?: number; delayMs?: number };

export type StubCall = {
	kind: string;
	flags: { autostart?: boolean; "-S"?: string; "--timeout"?: string; "-C"?: string };
	command: string[];
	argv: string[];
};

/** Scripts test/stub/stub.mjs for one test and reads back what it was called with. */
export class StubRex {
	public readonly dir = mkdtempSync(join(tmpdir(), "rex-stub-"));
	private readonly scenario: Record<string, StubResponse | StubResponse[]> = {};

	constructor() {
		process.env.REX_STUB_DIR = this.dir;
	}

	public calls(kind?: string): StubCall[] {
		const file = join(this.dir, "calls.jsonl");
		if (!existsSync(file)) {
			return [];
		}
		const calls = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as StubCall);
		return kind ? calls.filter((call) => call.kind === kind) : calls;
	}

	public dispose(): void {
		delete process.env.REX_STUB_DIR;
		rmSync(this.dir, { recursive: true, force: true });
	}

	public emit(...events: unknown[]): void {
		appendFileSync(join(this.dir, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
	}

	public endStream(exit: number, stderr = ""): void {
		writeFileSync(join(this.dir, "events.end"), JSON.stringify({ exit, stderr }));
	}

	public on(kind: string, response: StubResponse | StubResponse[]): this {
		this.scenario[kind] = response;
		writeFileSync(join(this.dir, "scenario.json"), JSON.stringify(this.scenario));
		return this;
	}

	/** The JSON a script call passed through --args. */
	public scriptArgs(call: StubCall): Record<string, unknown> {
		return JSON.parse(call.command[call.command.indexOf("--args") + 1]) as Record<string, unknown>;
	}

	public snapshot(raw: unknown): this {
		return this.on("snapshot", { stdout: `${JSON.stringify(raw)}\n` });
	}
}

/** `rex events --all --json` line shapes, as a real server prints them. */
export const event = {
	top: (type: string, payload: unknown = {}) => ({ type, payload }),
	session: (session_id: string, type: string, payload: unknown = {}) => ({
		type: "session_event",
		payload: { session_id, event: { type, payload } },
	}),
	block: (session_id: string, block_id: string, name: string, payload: unknown = {}) => ({
		type: "session_event",
		payload: {
			session_id,
			event: { type: "block_event", payload: { block_id, creator_name: "com.superlogical.terminal", name, payload } },
		},
	}),
};
