/**
 * A stand-in rex CLI for the unit suites. Its default outputs and the shapes in
 * test/stub.ts are what a real server printed: Lua's empty tables as {}, create
 * results with no label, nothing on stdout from send-key or session.select.
 * Without REX_STUB_DIR it behaves like a server that is down.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
	snapshot: { stdout: '{"clients":{},"sessions":{},"skipped":{}}\n' },
	clients: { stdout: '{"clients":{}}\n' },
	new: {
		stdout: `{
  "session_id": "session:01a1a685-92de-7ca6-9b43-9e923573a1b6",
  "initial_windows": [
    {
      "window_id": "window:01a1a685-92ef-73e4-8944-18c631607b24",
      "block_ids": [
        "block:01a1a685-92de-7d7d-963e-a0ccdb58b0dc"
      ],
      "revision": 1
    }
  ]
}
`,
	},
	window: {
		stdout: `{
  "window_id": "window:01a1a685-9312-7b4e-8618-dc30a667bf2d",
  "block_ids": [
    "block:01a1a685-9304-7027-b0bb-d7c329e8bd30"
  ],
  "revision": 10
}
`,
	},
};

function parse(argv) {
	const flags = {};
	let i = 0;
	for (; i < argv.length; i++) {
		if (argv[i] === "--autostart=false") {
			flags.autostart = false;
		} else if (argv[i] === "-S" || argv[i] === "--timeout" || argv[i] === "-C") {
			flags[argv[i]] = argv[++i];
		} else {
			break;
		}
	}
	return { flags, command: argv.slice(i) };
}

function kindOf(command) {
	if (command[0] === "do" && command[1] === "-e") {
		const script = command[2] ?? "";
		if (script.includes("session.view")) {
			return "snapshot";
		}
		if (script.includes("rex.sleep(0.3)")) {
			return "prompt";
		}
		if (script.includes("paste()\nwrite")) {
			return "input";
		}
		if (script.includes("write(text)")) {
			return "write";
		}
		return script.includes("client.list") ? "clients" : "script";
	}
	if (command[0] === "do") {
		return "select";
	}
	if (command[0] === "window" && command[1] === "new") {
		return "window";
	}
	return command[0] ?? "none";
}

function respond({ stdout = "", stderr = "", exit = 0, delayMs = 0 }) {
	setTimeout(() => {
		process.stdout.write(stdout);
		process.stderr.write(stderr);
		process.exitCode = exit;
	}, delayMs);
}

function streamEvents(dir, response) {
	if (response) {
		respond(response);
		return;
	}
	process.on("SIGTERM", () => process.exit(130));
	const file = join(dir, "events.jsonl");
	let offset = 0;
	const timer = setInterval(() => {
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		process.stdout.write(text.slice(offset));
		offset = text.length;
		const end = join(dir, "events.end");
		if (existsSync(end)) {
			clearInterval(timer);
			const { exit, stderr } = JSON.parse(readFileSync(end, "utf8"));
			process.stderr.write(stderr);
			process.exitCode = exit;
		}
	}, 10);
}

const { flags, command } = parse(process.argv.slice(2));
const dir = process.env.REX_STUB_DIR;

if (flags.autostart !== false) {
	process.stderr.write("stub: every call must pass --autostart=false\n");
	process.exit(99);
}
if (!dir) {
	process.stderr.write(`Error: no Rex server is running at ${(flags["-S"] ?? "").replace("unix://", "")}, and autostart is disabled\n`);
	process.exit(4);
}

const kind = kindOf(command);
const calls = join(dir, "calls.jsonl");
const earlier = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line && JSON.parse(line).kind === kind).length : 0;
appendFileSync(calls, `${JSON.stringify({ kind, flags, command, argv: process.argv.slice(2) })}\n`);
const scenario = existsSync(join(dir, "scenario.json")) ? JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) : {};
const scripted = scenario[kind];
const response = Array.isArray(scripted) ? scripted[Math.min(earlier, scripted.length - 1)] : scripted;

if (kind === "events") {
	streamEvents(dir, response);
} else {
	respond(response ?? DEFAULTS[kind] ?? {});
}
