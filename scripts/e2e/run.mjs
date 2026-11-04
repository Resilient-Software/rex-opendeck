/**
 * End-to-end run of the built plugin bundle against a fake Stream Deck host, a
 * throwaway Rex server and a fake Mac app client. No device, no Elgato app, no
 * human, and never your own sessions.
 *
 *   npm run build && npm run e2e
 *
 * Env:
 *   REX_BIN     rex binary (default: rex on PATH)
 *   E2E_TMP     parent of the temp root (default /tmp); the socket must fit in 103 bytes
 *   E2E_NODE    node binary for the plugin (default: the Elgato app's bundled
 *               Node if installed, else this node)
 *   E2E_OUT     artifact directory (default: e2e-out/)
 *   E2E_SKIP    comma list of phases to skip; later phases rely on earlier ones
 *   E2E_PLUGIN  .sdPlugin dir to test instead of ./plugin (copied, never modified)
 *   E2E_ACTIVITY=0  publish no rsact/* records: the deck as it looks without the
 *               activity companion
 *
 * Artifacts: per-phase key SVG/PNGs, board PNGs, messages.jsonl (every websocket
 * frame both ways), events.jsonl (the sandbox's event stream), rex-calls.log,
 * summary.json. Each phase runs even if an earlier one failed; the exit code is
 * 1 on any failure.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FakeApp } from "./fake-app.mjs";
import { FakeStreamDeck, sleep, STREAM_DECK_15 } from "./fake-streamdeck.mjs";
import { renderBoard, svgToPng } from "./render-board.mjs";
import { LEAKY, RexSandbox } from "./rex-sandbox.mjs";

const execFileAsync = promisify(execFile);

for (const key of LEAKY.filter((name) => name.startsWith("REX_"))) {
	delete process.env[key];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PLUGIN_SRC = resolve(process.env.E2E_PLUGIN ?? join(REPO, "plugin"));
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_SRC, "manifest.json"), "utf8"));
const UUID = (name) => `com.resilientsoftware.rexdeck.${name}`;
const REX_BIN = process.env.REX_BIN ?? which("rex");
const SKIP = new Set((process.env.E2E_SKIP ?? "").split(",").filter(Boolean));
const ACTIVITY = process.env.E2E_ACTIVITY !== "0";
const PREF_DOMAIN = "com.resilientsoftware.rexdeck.e2e-unused";

const COLORS = {
	focused: "#a6e3a1",
	working: "#f9e2af",
	blocked: "#f38ba8",
	activity: "#89b4fa",
	scheduled: "#362a52",
	mauve: "#cba6f7",
	done: "#94e2d5",
	plain: "plain",
};

/** A fragment of each footer pictogram's path, from src/glyphs.ts. */
const GLYPHS = {
	subagents: 'cx="12" cy="2.7"',
	shell: "M4 3h16a3 3",
	monitor: "M0.5 12C3.8",
	loop: "M14.8 5.4A",
	clock: "M0.8 12a11.2",
};

function which(name) {
	try {
		return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
	} catch {
		throw new Error(`${name} not found on PATH; set REX_BIN`);
	}
}

function elgatoNode() {
	const base = join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck", "NodeJS");
	try {
		const major = `${MANIFEST.Nodejs?.Version ?? "24"}.`;
		const latest = readdirSync(base)
			.filter((v) => v.startsWith(major))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
			.at(-1);
		const bin = latest && join(base, latest, "node");
		return bin && existsSync(bin) ? bin : undefined;
	} catch {
		return undefined;
	}
}

const hex = (text) => Buffer.from(text).toString("hex");
const bracketed = (text) => `1b5b3230307e${hex(text)}1b5b3230317e`;
const CR = "0d";

const root = mkdtempSync(join(realpathSync(process.env.E2E_TMP ?? "/tmp"), "rxe-"));
const out = resolve(process.env.E2E_OUT ?? join(REPO, "e2e-out"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
async function phase(name, fn) {
	if (SKIP.has(name)) {
		console.log(`SKIP  ${name}`);
		return;
	}
	console.log(`----  ${name}`);
	try {
		await fn();
	} catch (err) {
		check(`phase ${name} completed`, false, String(err?.message ?? err));
	}
}

async function eventually(predicate, timeoutMs = 4000, everyMs = 25) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			return undefined;
		}
		await sleep(everyMs);
	}
}

/** Records how long the condition took, or what was there instead. */
async function expectSoon(name, predicate, { timeoutMs = 4000, everyMs = 25, instead } = {}) {
	const start = Date.now();
	const value = await eventually(predicate, timeoutMs, everyMs);
	check(name, value, value ? `${Date.now() - start} ms` : `not within ${timeoutMs} ms${instead ? `: ${instead()}` : ""}`);
	return value;
}

const sandbox = new RexSandbox({ root, binary: REX_BIN });

function assertOwnServer(env) {
	if (env.REX_SERVER !== `unix://${join(root, "rex.sock")}` || env.REX_RUNTIME_DIR !== join(root, "rt")) {
		console.error(`refusing to run: REX_SERVER=${env.REX_SERVER} REX_RUNTIME_DIR=${env.REX_RUNTIME_DIR} is not this run's temp server under ${root}`);
		process.exit(1);
	}
}
assertOwnServer(sandbox.env());

// ---- stage the bundle like an installed plugin -------------------------
const pluginDir = join(root, `${MANIFEST.UUID}.sdPlugin`);
cpSync(PLUGIN_SRC, pluginDir, {
	recursive: true,
	filter: (src) => !/\/logs(\/|$)/.test(src.slice(PLUGIN_SRC.length)),
});
if (!existsSync(join(pluginDir, MANIFEST.CodePath))) {
	throw new Error(`no ${MANIFEST.CodePath} in ${PLUGIN_SRC}; run npm run build first`);
}

// The plugin finds rex through rex-path.txt, as an installed one does. What it
// finds logs every call before becoming the real binary, same pid.
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });
const callLog = join(root, "rex-calls.log");
const loggingRex = join(binDir, "rex");
writeFileSync(
	loggingRex,
	`#!/bin/sh
kind=other
case "$*" in
  *session.attach_all*client.list*"skipped = skipped"*) kind=snapshot ;;
esac
printf '%s %s %s %s\\n' "$kind" "$1" "$2" "$3" >> '${callLog}'
exec '${REX_BIN}' "$@"
`,
);
chmodSync(loggingRex, 0o755);
writeFileSync(callLog, "");
writeFileSync(join(pluginDir, "rex-path.txt"), `${loggingRex}\n`);
const rexCalls = () => readFileSync(callLog, "utf8").split("\n").filter(Boolean);
const snapshotCount = () => rexCalls().filter((line) => line.startsWith("snapshot ")).length;

// The deck knows agents by argv0: "claude" is a known agent, "tool" is not.
const agentBin = join(root, "agentbin");
mkdirSync(agentBin, { recursive: true });
const CLAUDE = join(agentBin, "claude");
const TOOL = join(agentBin, "tool");
execFileSync("cc", ["-O2", "-w", "-o", CLAUDE, join(HERE, "fake-agent.c")]);
cpSync(CLAUDE, TOOL);
// A script that does not exec: it stays the foreground, with the agent as its child.
const WRAPPER = join(agentBin, "wrapped-agent");
writeFileSync(WRAPPER, `#!/bin/sh\nexport ACCOUNT=work\n${CLAUDE} "$@"\n`);
chmodSync(WRAPPER, 0o755);

const repos = join(root, "repos");
const gitEnv = { ...process.env, HOME: sandbox.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function gitRepo(name, branch) {
	const dir = join(repos, name);
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", branch, dir], { env: gitEnv });
	execFileSync("git", ["-C", dir, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv });
	return dir;
}
const plainDir = join(root, "plain");
mkdirSync(plainDir, { recursive: true });

// The plugin gets a launchd-like minimal environment, not the caller's.
function pluginEnv(extra = {}) {
	const { REX_SERVER, REX_RUNTIME_DIR } = sandbox.env();
	const env = {
		HOME: sandbox.home,
		USER: process.env.USER ?? "",
		LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		LANG: "en_US.UTF-8",
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		REX_SERVER,
		REX_RUNTIME_DIR,
		REX_DECK_NO_RAISE: "1",
		REX_DECK_FRONTMOST: "always",
		REX_DECK_FOCUS_PREF_DOMAIN: PREF_DOMAIN,
		...extra,
	};
	assertOwnServer(env);
	return env;
}

function makeHost(extraEnv) {
	return new FakeStreamDeck({
		pluginDir,
		nodeBin: process.env.E2E_NODE ?? elgatoNode() ?? process.execPath,
		nodeArgs: ["--no-global-search-paths", "--enable-source-maps"],
		env: pluginEnv(extraEnv),
		devices: [{ ...STREAM_DECK_15 }],
	});
}

const host = makeHost();

/*
 * Layout on the 5x3 deck:
 *   row 0: space space space space  newspace
 *   row 1: space space space space  summary
 *   row 2: command text keys cycle  newtab
 */
const ctx = (column, row) => `key-${column}-${row}`;
const spaceKeys = [
	[0, 0],
	[1, 0],
	[2, 0],
	[3, 0],
	[0, 1],
	[1, 1],
	[2, 1],
	[3, 1],
];
const K = {
	newSpace: ctx(4, 0),
	summary: ctx(4, 1),
	command: ctx(0, 2),
	text: ctx(1, 2),
	keys: ctx(2, 2),
	cycle: ctx(3, 2),
	newTab: ctx(4, 2),
};
const DEFAULT_SETTINGS = {
	command: { command: "/review" },
	text: { text: "go ahead", submit: true },
	keys: {},
	cycle: { command: "/model", values: "opus, sonnet, haiku" },
};

function placeKeys(h) {
	for (const [column, row] of spaceKeys) {
		h.willAppear({ context: ctx(column, row), action: UUID("space"), coordinates: { column, row } });
	}
	const control = (context, action, settings = {}) => {
		const [, column, row] = context.split("-").map(Number);
		h.willAppear({ context, action: UUID(action), coordinates: { column, row }, settings });
	};
	control(K.newSpace, "newspace");
	control(K.summary, "summary");
	control(K.command, "command", DEFAULT_SETTINGS.command);
	control(K.text, "text", DEFAULT_SETTINGS.text);
	control(K.keys, "keys", DEFAULT_SETTINGS.keys);
	control(K.cycle, "cycle", DEFAULT_SETTINGS.cycle);
	control(K.newTab, "newtab");
}

const svgOf = (context, h = host) => h.image(context)?.text ?? "";
const svgAt = (column, row, h = host) => svgOf(ctx(column, row), h);
const spaceContexts = spaceKeys.map(([column, row]) => ctx(column, row));
const tileWith = (text, h = host) => spaceContexts.find((context) => h.placed.has(context) && svgOf(context, h).includes(text));
const tile = (label, h = host) => {
	const context = tileWith(`>${label}<`, h);
	return context ? svgOf(context, h) : "";
};
const background = (svg) => /<rect width="144" height="144" fill="(#[0-9a-f]{6})"\/>/.exec(svg)?.[1] ?? COLORS.plain;
const words = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const footer = (svg) => words(svg).at(-1) ?? "";
const glyphsOf = (svg) => Object.entries(GLYPHS).filter(([, fragment]) => svg.includes(fragment)).map(([name]) => name);
const describe = (svg) => `${background(svg)} [${words(svg).join(" | ")}] ${glyphsOf(svg).join(",")}`;
const mark = () => Date.now() - host.t0;

function imagesSince(context, t) {
	return host
		.messagesFromPlugin("setImage")
		.filter((entry) => entry.msg.context === context && entry.t >= t)
		.map((entry) => Buffer.from(entry.msg.payload.image.split(",")[1], "base64").toString("utf8"));
}

const canRender = (() => {
	try {
		execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		console.log("rsvg-convert not found: board PNGs skipped");
		return false;
	}
})();

function board(name, title) {
	if (!canRender) {
		return undefined;
	}
	const dir = join(out, name);
	for (const file of host.dumpImages(dir).filter((f) => f.endsWith(".svg"))) {
		svgToPng(file, file.replace(/\.svg$/, ".png"));
	}
	const cells = [...host.placed.entries()]
		.filter(([, placed]) => placed.controller === "Keypad")
		.map(([context, placed]) => ({ ...placed.coordinates, svg: svgOf(context) }));
	return renderBoard({ columns: 5, rows: 3, cells, title, svgFile: join(out, `board-${name}.svg`), pngFile: join(out, `board-${name}.png`) });
}

/** The server's own view, independent of the plugin. rex prints no readiness line. */
class EventLog {
	events = [];

	async start() {
		this.child = spawn(REX_BIN, ["-S", sandbox.endpoint, "--autostart=false", "events", "--all", "--json"], {
			env: sandbox.env(),
			stdio: ["ignore", "pipe", "ignore"],
		});
		let buffered = "";
		this.child.stdout.on("data", (chunk) => {
			buffered += chunk;
			for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
				try {
					this.events.push({ at: Date.now(), event: JSON.parse(buffered.slice(0, i)) });
				} catch {
					// A partial line from a stream cut short.
				}
				buffered = buffered.slice(i + 1);
			}
		});
		await sleep(250);
	}

	stop() {
		this.child?.kill();
		this.child = undefined;
	}

	sizeChanges(since = 0) {
		return this.events
			.filter(({ at, event }) => at >= since && event.type === "session_event" && event.payload.event.type === "block_event" && event.payload.event.payload.name === "size_changed")
			.map(({ at, event }) => ({ at, session_id: event.payload.session_id, ...event.payload.event.payload.payload }));
	}

	blockEvents(name, since = 0) {
		return this.events.filter(({ at, event }) => at >= since && event.type === "session_event" && event.payload.event.type === "block_event" && event.payload.event.payload.name === name);
	}

	joined(since = 0) {
		return this.events.filter(({ at, event }) => at >= since && event.type === "client_joined" && event.payload.client.info?.kind === "cli").length;
	}
}
const eventLog = new EventLog();

const apps = [];
let app;
async function startApp(options = {}) {
	const started = new FakeApp({ socket: sandbox.socket, ghost: true, ...options });
	apps.push(started);
	await started.start();
	return started;
}

const argv0Base = (foreground) => (foreground?.argv0 ?? "").split("/").at(-1).replace(/^-/, "");
const processOf = (pane) => sandbox.json("block", "call", "-s", pane.session, "-b", pane.block, "process");

async function attachTty(pane, wanted) {
	const foreground = await eventually(async () => {
		const current = (await processOf(pane)).foreground;
		return wanted.includes(argv0Base(current)) ? current : undefined;
	}, 6000, 50);
	if (!foreground) {
		throw new Error(`${pane.label} never ran ${wanted.join(" or ")}`);
	}
	const { stdout } = await execFileAsync("/bin/ps", ["-o", "tty=", "-p", String(foreground.pid)]);
	pane.tty = stdout.trim();
	if (!/^ttys?\d+$/.test(pane.tty)) {
		throw new Error(`${pane.label} has no tty: "${pane.tty}"`);
	}
	return pane;
}

function paneFrom(label, created, tag) {
	return { label, tag, session: created.session_id, window: created.initial_windows[0].window_id, block: created.initial_windows[0].block_ids[0] };
}

/** `tag` prefixes what a stand-in agent prints; bp turns on bracketed paste, as a real agent's input box does. */
async function newAgent(label, dir, { bin = CLAUDE, flags = [], tag = label } = {}) {
	const created = await sandbox.json("new", label, "--json", "--shell=none", "-c", dir, "--", bin, tag, ...flags);
	return attachTty(paneFrom(label, created, tag), [bin.split("/").at(-1)]);
}

/** A plain shell with no login step and no rc file. */
async function newShell(label, dir) {
	const created = await sandbox.json("new", label, "--json", "--shell=none", "-c", dir, "--", "/bin/sh");
	return attachTty(paneFrom(label, created, label), ["sh"]);
}

/** One OSC 7501 report on the pane's tty; Rex attributes it to the foreground process. */
function oscReport(pane, body) {
	if (!ACTIVITY && body.includes("rsact/")) {
		throw new Error(`E2E_ACTIVITY=0 must publish no rsact records: ${body}`);
	}
	const fd = openSync(`/dev/${pane.tty}`, constants.O_WRONLY | constants.O_NOCTTY);
	try {
		writeSync(fd, `\x1b]7501;${body}\x1b\\`);
	} finally {
		closeSync(fd);
	}
}

function report(pane, state, { kind, id, app: reporter = "claude-code" } = {}) {
	oscReport(pane, [`state=${state}`, `app=${reporter}`, ...(kind ? [`kind=${kind}`] : []), ...(id ? [`id=${id}`] : [])].join(":"));
}

const clearRecords = (pane, id) => oscReport(pane, id ? `state=clear:id=${id}` : "state=clear");

/** Hex chunks the stand-in agent has printed so far, one per read(). */
async function chunks(pane) {
	const text = await sandbox.rex("capture", "-s", pane.session, "-b", pane.block, "--unwrap");
	return [...text.matchAll(new RegExp(`${pane.tag}\\.K\\d+:([0-9a-f]*)`, "g"))].map((m) => m[1]);
}

const screen = (pane) => sandbox.rex("capture", "-s", pane.session, "-b", pane.block, "--unwrap");

/**
 * Runs `action` and checks what reaches the agent: an array means exactly those
 * chunks, a string means those bytes however they were split. It keeps watching
 * briefly, so a stray trailing byte fails too.
 */
async function expectBytes(name, pane, action, expected) {
	const before = (await chunks(pane)).length;
	await action();
	const matches = (got) => (Array.isArray(expected) ? JSON.stringify(got) === JSON.stringify(expected) : got.join("") === expected);
	const fresh = async () => (await chunks(pane)).slice(before);
	if (Array.isArray(expected) && expected.length === 0) {
		await sleep(600);
	} else {
		await eventually(async () => matches(await fresh()), 4000, 50);
		await sleep(400);
	}
	const got = await fresh();
	check(name, matches(got), got.join(" ") || "nothing arrived");
	return got;
}

const faceSays = (context, text) => svgOf(context).includes(`>${text}<`);
const expectFace = (name, context, text, timeoutMs = 3000) =>
	expectSoon(name, () => faceSays(context, text), { timeoutMs, instead: () => `[${words(svgOf(context)).join(" | ")}]` });

/** A flash lasts about a second, and an unchanged image is not sent again, so look at the history and the face. */
const expectFlash = (name, context, text, since, timeoutMs = 2000) =>
	expectSoon(name, () => faceSays(context, text) || imagesSince(context, since).some((svg) => svg.includes(`>${text}<`)), { timeoutMs, instead: () => `[${words(svgOf(context)).join(" | ")}]` });

async function focusOn(pane) {
	await app.select(pane.session);
	const green = await eventually(() => background(tile(pane.label)) === COLORS.focused, 6000);
	if (!green) {
		throw new Error(`${pane.label} never turned green: ${describe(tile(pane.label))}`);
	}
}

async function eventsChild(h = host) {
	const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-P", String(h.child.pid)]).catch(() => ({ stdout: "" }));
	for (const pid of stdout.split("\n").filter(Boolean)) {
		const args = await execFileAsync("/bin/ps", ["-o", "command=", "-p", pid]).then(({ stdout: text }) => text, () => "");
		if (args.includes(" events --all --json")) {
			return { pid: Number(pid), args };
		}
	}
	return undefined;
}

/**
 * Holds the plugin's stream still, so its last snapshot goes stale the way it
 * does between an event and the refresh it triggers. The 5 s reconcile still
 * runs, so `fn` starts right after one and has seconds before the next.
 */
async function withStaleSnapshot(fn) {
	const child = await eventsChild();
	if (!child) {
		throw new Error("no rex events child to hold");
	}
	const base = snapshotCount();
	process.kill(child.pid, "SIGSTOP");
	try {
		await eventually(() => snapshotCount() > base, 7000);
		await sleep(300);
		return await fn();
	} finally {
		process.kill(child.pid, "SIGCONT");
	}
}

async function closeSession(pane) {
	await sandbox.rex("kill", pane.session);
	await eventually(() => !tile(pane.label), 3000);
}

const setSettings = (context, settings) => host.inspectorSetSettings(context, settings);
const settle = (ms = 800) => sleep(ms);

async function windowsOf(pane) {
	return (await sandbox.json("window", "ls", "-s", pane.session, "--json")).windows;
}

async function shellCwdIn(sessionId, windowId) {
	return eventually(async () => {
		const block = (await sandbox.json("block", "ls", "-s", sessionId, "-w", windowId, "--json")).blocks?.[0];
		const foreground = block && (await sandbox.json("block", "call", "-s", sessionId, "-b", block.block_id, "process")).foreground;
		return foreground?.cwd;
	}, 4000, 100);
}

let pinger;
const rtts = [];
const s = {};
let cleaned = false;

async function cleanup() {
	if (cleaned) {
		return;
	}
	cleaned = true;
	clearInterval(pinger);
	await host.stop().catch(() => {});
	eventLog.stop();
	for (const started of apps) {
		await started.kill().catch(() => {});
	}
	await sandbox.stop().catch(() => {});
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => {
		void cleanup().finally(() => process.exit(130));
	});
}

try {
	await phase("seed", async () => {
		await sandbox.start();
		await eventLog.start();
		s.api = await newAgent("api", gitRepo("api-server", "feat/login"));
		s.web = await newAgent("web", gitRepo("web-app", "main"));
		s.infra = await newAgent("infra", gitRepo("infra", "fix/dns"));
		s.docs = await newAgent("docs", gitRepo("docs", "main"));
		s.scratch = await newAgent("scratch", plainDir);
		s.agent = await newAgent("agent", gitRepo("agent", "main"), { flags: ["bp"] });
		s.notes = await newShell("notes", gitRepo("notes", "main"));
		report(s.api, "working");
		report(s.web, "blocked", { kind: "permission" });
		for (const pane of [s.infra, s.docs, s.scratch, s.agent]) {
			report(pane, "idle");
		}
		if (ACTIVITY) {
			report(s.infra, "working", { id: "rsact/sub/one" });
			report(s.infra, "working", { id: "rsact/sub/two" });
			report(s.infra, "working", { id: "rsact/bg/one" });
			report(s.docs, "idle", { id: `rsact/next/${Math.floor(Date.now() / 1000) + 17 * 60}.loop` });
		}
		app = await startApp();
		const clients = (await sandbox.json("client", "ls", "--json")).clients;
		check(
			"sandbox seeded; the fake app is listed as an app over unix",
			clients.some((client) => client.client_id === app.clientId && client.info?.kind === "app" && client.principal?.transport === "unix"),
			`${Object.keys(s).length} sessions, ${clients.length} clients`,
		);
	});

	await phase("connect", async () => {
		const registered = await host.start();
		check("plugin registers over websocket", registered.event === "registerPlugin");
		pinger = setInterval(() => host.ping().then((ms) => rtts.push(ms), () => rtts.push(Infinity)), 500);
		placeKeys(host);
		await expectSoon("first paint is REX · CONNECTING on the top-left key", () => svgAt(0, 0).includes("CONNECTING"), { timeoutMs: 3000 });
		await expectSoon("live tiles arrive", () => tileWith(">notes<"), { timeoutMs: 8000 });
		await host.waitForQuiet(1500);
		const stream = await eventsChild();
		check("the plugin's stream names the sandbox, with autostart off", stream?.args.includes(`-S ${sandbox.endpoint}`) && stream.args.includes("--autostart=false"), stream?.args.trim());
		const defaults = execFileSync("/usr/bin/defaults", ["export", PREF_DOMAIN, "-"], { encoding: "utf8" });
		check("the focus preference has nothing to offer", !defaults.includes("lastFocusedSession"));
		const green = spaceContexts.filter((context) => background(svgOf(context)) === COLORS.focused);
		check("no tile is green before the app shows a session", green.length === 0, green.join(","));
		check("a control key with no focused session says so", faceSays(K.command, "NO AGENT") && svgOf(K.command).includes('opacity="0.45"'), words(svgOf(K.command)).join(" | "));
		const t0 = Date.now();
		await app.select(s.notes.session);
		await expectSoon("the app showing a session turns its tile green, with no preference", () => background(tile("notes")) === COLORS.focused);
		check("that took the app's own resize", eventLog.sizeChanges(t0).some((e) => e.session_id === s.notes.session && e.owner === app.clientId && e.principal?.pid === process.pid));
		await host.waitForQuiet(800);
		board("initial", "initial: 7 sessions, summary and control keys");
	});

	await phase("states", async () => {
		await expectSoon("tiles show repository and branch from git", () => tile("api").includes(">api-server<") && tile("api").includes("feat/login") && tile("infra").includes("fix/dns"), {
			instead: () => words(tile("api")).join(" | "),
		});
		check("tiles carry their session number", words(tile("api"))[0] === "1" && words(tile("notes"))[0] === "7", `${words(tile("api"))[0]}, ${words(tile("notes"))[0]}`);
		check("outside git a tile shows the folder and no branch", tile("scratch").includes(">plain<") && !tile("scratch").includes("⎇"), words(tile("scratch")).join(" | "));
		check("working tile is yellow", background(tile("api")) === COLORS.working, describe(tile("api")));
		check("blocked tile is red", background(tile("web")) === COLORS.blocked, describe(tile("web")));
		const infra = tile("infra");
		const docs = tile("docs");
		if (ACTIVITY) {
			check(
				"subagent activity tile is blue with icon counts, no SUB/BG words",
				background(infra) === COLORS.activity && glyphsOf(infra).join() === "subagents,shell" && words(infra).includes("2") && words(infra).includes("1") && !/SUB|BG/.test(infra),
				describe(infra),
			);
			check("scheduled-check tile is mauve with a loop countdown", background(docs) === COLORS.scheduled && docs.includes(COLORS.mauve) && glyphsOf(docs).join() === "loop" && /1[67]M/.test(docs), describe(docs));
		} else {
			for (const [label, svg] of [["infra", infra], ["docs", docs]]) {
				check(`without activity, idle ${label} is a plain IDLE tile`, background(svg) === COLORS.plain && footer(svg) === "IDLE" && !svg.includes("<g transform"), describe(svg));
			}
		}
		const noTokens = ["api", "web", "scratch", "notes"].filter((label) => tile(label).includes("<g transform"));
		check("sessions without activity never show activity icons", noTokens.length === 0, noTokens.join(","));
		check("plain idle tile names its state", background(tile("scratch")) === COLORS.plain && footer(tile("scratch")) === "IDLE", describe(tile("scratch")));
		check("focused tile is green", background(tile("notes")) === COLORS.focused);
		check("unused participating key is an inert dot", svgAt(3, 1).includes("<circle"));
		check("control keys never take a session slot", !svgOf(K.command).includes(">api<") && svgOf(K.command).includes("/review"));
		check("New Session key is live (not dimmed)", svgOf(K.newSpace).includes("NEW SESSION") && !svgOf(K.newSpace).includes("opacity"));
		check("no host alert overlays used", host.alerts.length === 0);
	});

	await phase("press", async () => {
		const apiKey = tileWith(">api<");
		const since = mark();
		await host.press(apiKey);
		const t0 = Date.now();
		const selectMs = await eventually(() => (app.selects.at(-1)?.session_id === s.api.session ? Date.now() - t0 + 1 : 0), 3000);
		check("keyUp on a tile makes the fake app select that session", selectMs, `${selectMs} ms keyUp -> app select`);
		check("the app was asked for the session alone", app.visible?.session_id === s.api.session && app.visible?.window_id === null);
		const greenMs = await eventually(() => (background(svgOf(apiKey)) === COLORS.focused ? Date.now() - t0 : 0), 3000);
		check("pressed tile turns green once the app's resize arrives", greenMs, `${greenMs} ms keyUp -> green setImage`);
		check("it shows FOCUSING… until then", imagesSince(apiKey, since).some((svg) => svg.includes("FOCUSING")));
		await expectSoon("previously focused tile loses green", () => background(tile("notes")) !== COLORS.focused, { timeoutMs: 2000 });
		await host.waitForQuiet(800);
		board("after-press", "after keyUp on 'api'");

		await app.select(s.web.session);
		await expectSoon("a person switching in the app moves the green tile", () => background(tile("web")) === COLORS.focused, { timeoutMs: 2000 });
		check("the old one loses it", background(tile("api")) !== COLORS.focused, describe(tile("api")));

		await app.nudge();
		await settle();
		check("the app re-laying out the visible session changes nothing", background(tile("web")) === COLORS.focused);

		await host.press(tileWith(">infra<"));
		await host.press(tileWith(">docs<"));
		await expectSoon("two quick presses end on the second", () => background(tile("docs")) === COLORS.focused && background(tile("infra")) !== COLORS.focused, {
			instead: () => `${describe(tile("infra"))} / ${describe(tile("docs"))}`,
		});
	});

	await phase("false-positive", async () => {
		await focusOn(s.infra);
		await focusOn(s.web);
		// Not kind "app": every fake is on the unix socket, so a second app would be the deck's chosen client.
		const phone = new FakeApp({ socket: sandbox.socket, label: "fake-phone", kind: "web", platform: "ios", name: "Rex", size: { columns: 44, rows: 20 } });
		apps.push(phone);
		await phone.start();
		const t0 = Date.now();
		await phone.select(s.infra.session);
		const own = await eventually(() => eventLog.sizeChanges(t0).find((e) => e.owner === phone.clientId));
		check("another client's resize of a hidden session fires size_changed", own?.session_id === s.infra.session && own.principal, JSON.stringify(own ?? {}).slice(0, 120));
		await settle();
		check("another client's resize does not move focus", background(tile("web")) === COLORS.focused && background(tile("infra")) !== COLORS.focused, describe(tile("infra")));
		const t1 = Date.now();
		const base = snapshotCount();
		await phone.stop();
		const handback = await eventually(() => eventLog.sizeChanges(t1).find((e) => e.owner === app.clientId));
		check(
			"the block returning to the app fires size_changed with the app as owner and no principal",
			handback?.session_id === s.infra.session && handback.principal === undefined && app.visible?.session_id === s.web.session,
			JSON.stringify(handback ?? {}).slice(0, 160),
		);
		check("and the plugin took a snapshot on it", await eventually(() => snapshotCount() > base, 2000));
		await settle();
		check("that false positive does not move focus", background(tile("web")) === COLORS.focused && background(tile("infra")) !== COLORS.focused, `web ${describe(tile("web"))}; infra ${describe(tile("infra"))}`);
		await focusOn(s.infra);
		check("the app's own next select still does", background(tile("web")) !== COLORS.focused);
	});

	await phase("no-app", async () => {
		await focusOn(s.notes);
		const sessionsBefore = (await sandbox.json("ls", "--json")).sessions.length;
		const windowsBefore = (await windowsOf(s.notes)).length;
		await app.stop();
		await eventually(async () => !(await sandbox.json("client", "ls", "--json")).clients.some((client) => client.info?.kind === "app"), 3000, 100);
		const apiKey = tileWith(">api<");
		await host.press(apiKey);
		await expectSoon("with no app, pressing a tile shows FAILED", () => svgOf(apiKey).includes("FAILED"), { timeoutMs: 2000, instead: () => describe(svgOf(apiKey)) });
		check("and focus stays where it was", background(tile("notes")) === COLORS.focused && background(tile("api")) !== COLORS.focused);
		const alertsBefore = host.alerts.length;
		await host.press(K.newSpace);
		await expectSoon("with no app, New Session alerts", () => host.alerts.length > alertsBefore, { timeoutMs: 2000 });
		await settle(500);
		check("and creates nothing", (await sandbox.json("ls", "--json")).sessions.length === sessionsBefore);
		const since = mark();
		await host.press(K.newTab);
		await expectFlash("with no app, New Tab shows FAILED", K.newTab, "FAILED", since);
		check("and creates nothing", (await windowsOf(s.notes)).length === windowsBefore);
		board("no-app", "no app connected: pressing fails");

		app = await startApp();
		await host.press(apiKey);
		await expectSoon("a relaunched app works on the next press", () => background(svgOf(apiKey)) === COLORS.focused && app.selects.at(-1)?.session_id === s.api.session, {
			timeoutMs: 2000,
			instead: () => describe(svgOf(apiKey)),
		});

		const lost = app;
		await lost.kill();
		const listedLost = await eventually(async () => (await sandbox.json("client", "ls", "--json")).clients.find((client) => client.client_id === lost.clientId && client.connection_state === "lost"), 3000, 100);
		check("an app that dies stays listed as lost", listedLost);
		const webKey = tileWith(">web<");
		await host.press(webKey);
		await expectSoon("with only a lost app, pressing a tile shows FAILED", () => svgOf(webKey).includes("FAILED"), { timeoutMs: 3000, instead: () => describe(svgOf(webKey)) });
		const failedFill = /fill="(#[0-9a-f]{6})"[^>]*>FAILED/.exec(svgOf(webKey))?.[1];
		check("and FAILED can be read on a red tile", background(svgOf(webKey)) === COLORS.blocked && failedFill !== COLORS.blocked, `${failedFill} on ${background(svgOf(webKey))}`);
		app = await startApp();
		await host.press(webKey);
		await expectSoon("a new app replacing a lost one is picked up", () => background(svgOf(webKey)) === COLORS.focused && app.selects.at(-1)?.session_id === s.web.session, {
			timeoutMs: 2000,
			instead: () => describe(svgOf(webKey)),
		});
		check("the lost entry is still listed ahead of it", (await sandbox.json("client", "ls", "--json")).clients.some((client) => client.client_id === lost.clientId && client.connection_state === "lost"));

		await app.stop();
		app = await startApp();
		await app.select(s.docs.session);
		await expectSoon("a relaunched app's first resize counts before any snapshot listed it", () => background(tile("docs")) === COLORS.focused, { timeoutMs: 1500, instead: () => describe(tile("docs")) });

		app.mode = "refuse";
		const scratchKey = tileWith(">scratch<");
		await host.press(scratchKey);
		await expectSoon("an app refusing the select shows FAILED", () => svgOf(scratchKey).includes("FAILED"), { timeoutMs: 2000, instead: () => describe(svgOf(scratchKey)) });
		await sleep(1100);
		app.mode = "ignore";
		const t0 = Date.now();
		await host.press(scratchKey);
		await expectSoon("an app that never answers shows FAILED", () => svgOf(scratchKey).includes("FAILED"), { timeoutMs: 4000, instead: () => describe(svgOf(scratchKey)) });
		check("within the CLI timeout", Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
		app.mode = "ok";
		await sleep(1100);
		await host.press(scratchKey);
		await expectSoon("the next press works", () => background(svgOf(scratchKey)) === COLORS.focused, { timeoutMs: 2000, instead: () => describe(svgOf(scratchKey)) });
	});

	await phase("summary", async () => {
		await focusOn(s.agent);
		await host.waitForQuiet(500);
		const summary = svgOf(K.summary);
		// Working api, blocked web, busy infra, timer docs (idle without activity), idle scratch + agent; notes runs no agent.
		check("summary counts the six sessions running agents", summary.includes(">6</text>"), words(summary).join(" | "));
		check(
			ACTIVITY ? "summary ring includes the busy and timer states" : "summary ring has no busy or timer segments without activity",
			ACTIVITY === (summary.includes(`stroke="${COLORS.activity}"`) && summary.includes(`stroke="${COLORS.mauve}"`)),
		);
		check("summary calls out the blocked agent", summary.includes("1 BLOCKED"));
		setSettings(K.summary, { look: "list" });
		await expectSoon("the list look names each state", () => ["BLOCKED", "WORKING", "IDLE"].every((word) => words(svgOf(K.summary)).includes(word)), {
			timeoutMs: 1000,
			instead: () => words(svgOf(K.summary)).join(" | "),
		});
		setSettings(K.summary, {});
		await host.press(K.summary);
		await expectSoon("pressing the summary jumps to the blocked session", () => app.visible?.session_id === s.web.session && background(tile("web")) === COLORS.focused);
	});

	await phase("steady", async () => {
		await focusOn(s.notes);
		await host.waitForQuiet(1200);
		const before = new Map(host.imageCounts);
		const countdowns = new Set([tileWith(">docs<"), K.summary]);
		const snapshotsBefore = snapshotCount();
		const callsBefore = rexCalls().length;
		const t0 = Date.now();
		await sleep(12000);
		const churn = [...host.imageCounts.entries()].filter(([context, n]) => n !== (before.get(context) ?? 0) && !countdowns.has(context));
		check("no redundant setImage in 12 s of steady state", churn.length === 0, churn.map(([c]) => c).join(",") || "0 repaints");
		const snapshots = snapshotCount() - snapshotsBefore;
		check("a snapshot causes no further snapshots: 12 idle seconds hold only the 5 s reconcile", snapshots >= 1 && snapshots <= 3, `${snapshots} snapshots`);
		check("the server agrees on how many connections came", eventLog.joined(t0) === rexCalls().length - callsBefore, `${eventLog.joined(t0)} joined, ${rexCalls().length - callsBefore} calls`);
	});

	await phase("churn", async () => {
		let base = snapshotCount();
		for (let i = 0; i < 30; i++) {
			report(s.scratch, "idle");
			await sleep(50);
		}
		await sleep(600);
		const repeats = snapshotCount() - base;
		check("30 identical status reports trigger at most a first refresh and the reconcile", repeats <= 2, `${repeats} snapshots`);
		base = snapshotCount();
		report(s.scratch, "working");
		await expectSoon("a real change right after still lands", () => background(tile("scratch")) === COLORS.working, { timeoutMs: 1500, instead: () => describe(tile("scratch")) });
		check("and took a snapshot", snapshotCount() > base);
		report(s.scratch, "idle");
		await expectSoon("and back", () => footer(tile("scratch")) === "IDLE", { timeoutMs: 1500 });
		await sleep(500);

		base = snapshotCount();
		const t0 = Date.now();
		await sandbox.rex("send", "-s", s.notes.session, "-b", s.notes.block, "i=0; while [ $i -lt 150 ]; do /bin/sleep 0.02; i=$((i+1)); done\r");
		await sleep(5000);
		const busy = snapshotCount() - base;
		const processEvents = eventLog.blockEvents("process_changed", t0).length;
		check("a busy shell fires process_changed", processEvents >= 5, processEvents >= 5 ? `${processEvents} events` : `${processEvents} events; screen: ${(await screen(s.notes)).trim().slice(-200)}`);
		// The first process_changed from a block always counts as new, and the window can hold two reconciles.
		check("and does not trigger snapshots beyond the reconcile", busy <= 3, `${busy} snapshots`);
	});

	await phase("race", async () => {
		await focusOn(s.notes);
		const lags = [];
		for (const delay of [0, 20, 40, 60]) {
			const base = snapshotCount();
			await eventually(() => snapshotCount() > base, 7000, 1);
			await sleep(delay);
			const wanted = background(tile("api")) === COLORS.working ? COLORS.blocked : COLORS.working;
			report(s.api, wanted === COLORS.working ? "working" : "blocked");
			const t0 = Date.now();
			await eventually(() => background(tile("api")) === wanted, 7000, 5);
			lags.push(Date.now() - t0);
			await sleep(400);
		}
		check("a change landing while a snapshot is running still reaches the tile", Math.max(...lags) < 1500, `${lags.join(", ")} ms`);
	});

	await phase("status", async () => {
		await focusOn(s.notes);
		const scratchIs = (name, want, predicate = () => true) =>
			expectSoon(name, () => predicate(tile("scratch")) && background(tile("scratch")) === want, { timeoutMs: 2000, instead: () => describe(tile("scratch")) });
		report(s.scratch, "working");
		await scratchIs("working: yellow", COLORS.working);
		report(s.scratch, "blocked", { kind: "permission" });
		await scratchIs("blocked with kind: red", COLORS.blocked);
		report(s.scratch, "idle");
		await scratchIs("idle: plain, says IDLE", COLORS.plain, (svg) => footer(svg) === "IDLE");
		report(s.scratch, "blocked");
		await scratchIs("blocked without kind: red", COLORS.blocked);
		report(s.scratch, "done");
		await scratchIs("done: plain, says DONE", COLORS.plain, (svg) => footer(svg) === "DONE");
		await expectSoon("the summary counts it as done", () => svgOf(K.summary).includes(`stroke="${COLORS.done}"`), { timeoutMs: 1000 });
		report(s.scratch, "error");
		await scratchIs("error: plain, says ERROR", COLORS.plain, (svg) => footer(svg) === "ERROR");
		clearRecords(s.scratch);
		await scratchIs("no records: plain, says UNKNOWN", COLORS.plain, (svg) => footer(svg) === "UNKNOWN");

		report(s.scratch, "working", { id: "child-a", app: "other-tool" });
		await scratchIs("no root, a working child: yellow", COLORS.working);
		clearRecords(s.scratch);
		report(s.scratch, "idle");
		report(s.scratch, "blocked", { id: "child-b", app: "other-tool" });
		await scratchIs("root idle, a blocked child: red", COLORS.blocked);
		clearRecords(s.scratch);
		report(s.scratch, "error");
		await scratchIs("ERROR again, for the board", COLORS.plain, (svg) => footer(svg) === "ERROR");
		report(s.agent, "done");
		await expectSoon("DONE on another, for the board", () => footer(tile("agent")) === "DONE", { timeoutMs: 2000 });
		await focusOn(s.docs);
		report(s.notes, "working");
		await settle();
		check("under a shell, a leftover working is ignored", background(tile("notes")) === COLORS.plain && footer(tile("notes")) === "UNKNOWN", describe(tile("notes")));
		board("status", "status: working, blocked, DONE, ERROR, UNKNOWN");

		report(s.notes, "blocked", { kind: "question" });
		await settle();
		check("under a shell, a leftover blocked is ignored", background(tile("notes")) === COLORS.plain && footer(tile("notes")) === "UNKNOWN", describe(tile("notes")));
		report(s.notes, "idle");
		await settle();
		check("under a shell, a leftover idle is ignored", footer(tile("notes")) === "UNKNOWN", describe(tile("notes")));
		report(s.notes, "working", { id: "child-a" });
		await settle();
		check("under a shell, a leftover child is ignored", background(tile("notes")) === COLORS.plain && footer(tile("notes")) === "UNKNOWN", describe(tile("notes")));
		report(s.notes, "done");
		await expectSoon("under a shell, a root done stays DONE", () => footer(tile("notes")) === "DONE", { timeoutMs: 2000, instead: () => describe(tile("notes")) });
		report(s.notes, "error");
		await expectSoon("under a shell, a root error says ERROR", () => footer(tile("notes")) === "ERROR", { timeoutMs: 2000, instead: () => describe(tile("notes")) });
		clearRecords(s.notes);
		await expectSoon("cleared, the shell goes back to UNKNOWN", () => footer(tile("notes")) === "UNKNOWN", { timeoutMs: 2000, instead: () => describe(tile("notes")) });

		const left = await newShell("left", plainDir);
		const startAgent = async () => {
			await sandbox.rex("send", "-s", left.session, "-b", left.block, `${CLAUDE} left\r`);
			await attachTty(left, ["claude"]);
			return (await processOf(left)).foreground.pid;
		};
		let pid = await startAgent();
		report(left, "working");
		await expectSoon("an agent started from a shell: working, yellow", () => background(tile("left")) === COLORS.working, { timeoutMs: 2000, instead: () => describe(tile("left")) });
		process.kill(pid, "SIGKILL");
		await expectSoon("killed, the tile stops being yellow", () => background(tile("left")) === COLORS.plain && footer(tile("left")) === "UNKNOWN", { timeoutMs: 3000, instead: () => describe(tile("left")) });
		pid = await startAgent();
		report(left, "done");
		await expectSoon("a second run: done", () => footer(tile("left")) === "DONE", { timeoutMs: 2000, instead: () => describe(tile("left")) });
		process.kill(pid, "SIGKILL");
		await eventually(async () => argv0Base((await processOf(left)).foreground) === "sh", 3000, 100);
		await settle();
		check("killed, its done survives under the shell", footer(tile("left")) === "DONE", describe(tile("left")));
		await closeSession(left);

		clearRecords(s.agent);
		report(s.agent, "idle");
		clearRecords(s.scratch);
		report(s.scratch, "idle");
	});

	await phase("seen", async () => {
		await focusOn(s.notes);
		report(s.scratch, "done");
		await expectSoon("a done nobody has looked at reads DONE", () => footer(tile("scratch")) === "DONE", { timeoutMs: 2000, instead: () => describe(tile("scratch")) });
		await host.press(tileWith(">scratch<"));
		await expectSoon("looking at it with Rex in front (always)", () => background(tile("scratch")) === COLORS.focused, { timeoutMs: 2000 });
		await focusOn(s.notes);
		await expectSoon("after looking, it reads IDLE", () => footer(tile("scratch")) === "IDLE", { timeoutMs: 2000, instead: () => describe(tile("scratch")) });
		report(s.scratch, "working");
		report(s.scratch, "done");
		await expectSoon("a new turn's done reads DONE again", () => footer(tile("scratch")) === "DONE", { timeoutMs: 2000, instead: () => describe(tile("scratch")) });
		await focusOn(s.scratch);
		await focusOn(s.notes);
		await expectSoon("seen once more", () => footer(tile("scratch")) === "IDLE", { timeoutMs: 2000, instead: () => describe(tile("scratch")) });
		report(s.scratch, "done");
		await expectSoon("a repeated done has the same signature, so the reconcile is what brings it back", () => footer(tile("scratch")) === "DONE", { timeoutMs: 6000, instead: () => describe(tile("scratch")) });
		report(s.scratch, "error");
		await expectSoon("a new error reads ERROR", () => footer(tile("scratch")) === "ERROR", { timeoutMs: 2000, instead: () => describe(tile("scratch")) });
		await focusOn(s.scratch);
		await focusOn(s.notes);
		await expectSoon("a seen error reads IDLE", () => footer(tile("scratch")) === "IDLE", { timeoutMs: 2000, instead: () => describe(tile("scratch")) });

		report(s.scratch, "done");
		await expectSoon("done once more", () => footer(tile("scratch")) === "DONE", { timeoutMs: 2000 });
		const never = makeHost({ REX_DECK_FRONTMOST: "never" });
		try {
			await never.start();
			placeKeys(never);
			await never.waitFor(() => tileWith(">scratch<", never), 8000, "second plugin's tiles");
			check("a plugin that starts later reads DONE until viewed", footer(tile("scratch", never)) === "DONE", describe(tile("scratch", never)));
			await focusOn(s.scratch);
			await expectSoon("with Rex in the background (never) the tile still follows the app", () => background(tile("scratch", never)) === COLORS.focused, { timeoutMs: 2000 });
			await settle();
			await focusOn(s.notes);
			await eventually(() => background(tile("notes", never)) === COLORS.focused, 2000);
			await settle();
			check("Rex in the background: looking does not count, it still reads DONE", footer(tile("scratch", never)) === "DONE", describe(tile("scratch", never)));
			check("Rex in front: the same look counted, it reads IDLE", footer(tile("scratch")) === "IDLE", describe(tile("scratch")));
			const child = await eventsChild(never);
			check("the second plugin has its own stream", child);
			await never.stop();
			const streamGone = await eventually(() => {
				try {
					process.kill(child.pid, 0);
					return false;
				} catch {
					return true;
				}
			}, 2000);
			check("stopping a plugin stops its stream", streamGone);
		} finally {
			await never.stop().catch(() => {});
		}
		report(s.scratch, "idle");
		await sleep(400);
	});

	await phase("activity", async () => {
		await focusOn(s.notes);
		const inFuture = (minutes) => Math.floor(Date.now() / 1000) + minutes * 60;
		const scratchShows = (name, want, glyphs, ok = () => true) =>
			expectSoon(name, () => background(tile("scratch")) === want && glyphsOf(tile("scratch")).join() === glyphs && ok(tile("scratch")), { timeoutMs: 2000, instead: () => describe(tile("scratch")) });

		report(s.scratch, "working", { id: "agent_a" });
		await scratchShows("a native Claude-shaped subagent: blue with one robot", COLORS.activity, "subagents", (svg) => footer(svg) === "1");
		report(s.scratch, "working", { id: "agent_b" });
		await scratchShows("two of them count two", COLORS.activity, "subagents", (svg) => footer(svg) === "2");
		report(s.scratch, "working", { id: "tool_c", app: "other-tool" });
		await settle();
		check("a child of another app is not a subagent", footer(tile("scratch")) === "2", describe(tile("scratch")));
		clearRecords(s.scratch);
		report(s.scratch, "idle");
		await scratchShows("cleared, the tile is plain", COLORS.plain, "", (svg) => footer(svg) === "IDLE");

		if (ACTIVITY) {
			report(s.scratch, "working", { id: "rsact/bg/one" });
			await scratchShows("rsact/bg: blue with a shell", COLORS.activity, "shell", (svg) => footer(svg) === "1");
			report(s.scratch, "working", { id: "rsact/mon/one" });
			await scratchShows("rsact/mon: a monitor beside it", COLORS.activity, "shell,monitor");
			report(s.scratch, "working", { id: "rsact/sub/one" });
			await scratchShows("rsact/sub: a robot first", COLORS.activity, "subagents,shell,monitor");
			clearRecords(s.scratch, "rsact");
			await scratchShows("state=clear on the subtree leaves the root alone", COLORS.plain, "", (svg) => footer(svg) === "IDLE");

			report(s.scratch, "working", { id: "agent_a" });
			report(s.scratch, "working", { id: "rsact/sub/agent_a" });
			await scratchShows("a native child and rsact/sub with the same id count once", COLORS.activity, "subagents", (svg) => footer(svg) === "1");
			report(s.scratch, "working", { id: "rsact/sub/other" });
			await scratchShows("a different rsact/sub id counts as another", COLORS.activity, "subagents", (svg) => footer(svg) === "2");
			clearRecords(s.scratch);
			report(s.scratch, "idle");

			report(s.scratch, "idle", { id: `rsact/next/${inFuture(25)}` });
			await scratchShows("rsact/next: dark mauve, clock and countdown", COLORS.scheduled, "clock", (svg) => /2[45]M/.test(footer(svg)));
			clearRecords(s.scratch, "rsact");
			report(s.scratch, "idle", { id: `rsact/next/${inFuture(40)}.loop` });
			await scratchShows("rsact/next with .loop: the loop icon", COLORS.scheduled, "loop", (svg) => /(39|40)M/.test(footer(svg)));
			board("activity", "activity: busy and timer tiles");
			clearRecords(s.scratch, "rsact");
			report(s.scratch, "idle", { id: `rsact/next/${inFuture(-5)}` });
			await scratchShows("a next time in the past reads NOW", COLORS.scheduled, "clock", (svg) => footer(svg) === "NOW");
			clearRecords(s.scratch, "rsact");
			report(s.scratch, "idle", { id: "rsact/next/soon" });
			report(s.scratch, "idle", { id: "rsact/bg/two" });
			await scratchShows("a malformed next and a non-working bg count for nothing", COLORS.plain, "", (svg) => footer(svg) === "IDLE");
			clearRecords(s.scratch, "rsact");

			await focusOn(s.docs);
			const totalBefore = words(svgOf(K.summary))[0];
			report(s.notes, "working", { id: "rsact/bg/one" });
			report(s.notes, "working", { id: "rsact/sub/one" });
			report(s.notes, "idle", { id: `rsact/next/${inFuture(10)}.loop` });
			await settle();
			check("rsact records under a shell are ignored", background(tile("notes")) === COLORS.plain && glyphsOf(tile("notes")).length === 0 && footer(tile("notes")) === "UNKNOWN", describe(tile("notes")));
			check("and the summary does not count that shell", words(svgOf(K.summary))[0] === totalBefore, `${totalBefore} -> ${words(svgOf(K.summary))[0]}`);
			clearRecords(s.notes);
		} else {
			report(s.scratch, "working", { id: "agent_a" });
			await scratchShows("without the companion a native subagent still shows", COLORS.activity, "subagents", (svg) => footer(svg) === "1");
			board("activity", "no companion: native subagents only");
			clearRecords(s.scratch);
			report(s.scratch, "idle");
		}
		await sleep(400);
	});

	await phase("panes", async () => {
		await focusOn(s.notes);
		const named = await newAgent("named", plainDir);
		await eventually(() => tile("named"), 3000);
		await sandbox.rex("session", "rename", named.session, "r&d <日本>");
		await expectSoon("a label with markup and CJK is escaped on the tile", () => tile("r&amp;d &lt;日本&gt;"), { timeoutMs: 2000, instead: () => spaceContexts.map((context) => words(svgOf(context))[1]).join(",") });
		await sandbox.rex("kill", named.session);
		await eventually(() => !tile("r&amp;d &lt;日本&gt;"), 3000);

		const duo = await newAgent("duo", plainDir, { tag: "one" });
		const split = await sandbox.json("split", "-s", duo.session, "-b", duo.block, "--json", "--shell=none", "--", CLAUDE, "two");
		const other = { label: "duo", tag: "two", session: duo.session, block: split.block_id ?? split.block_ids?.[0] };
		await attachTty(other, ["claude"]);
		const duoIs = (name, want, predicate = () => true) =>
			expectSoon(name, () => predicate(tile("duo")) && background(tile("duo")) === want, { timeoutMs: 2000, instead: () => describe(tile("duo")) });
		report(duo, "working");
		report(other, "idle");
		await duoIs("two panes, one working: yellow", COLORS.working);
		report(other, "blocked", { kind: "permission" });
		await duoIs("one blocked outranks one working: red", COLORS.blocked);
		report(other, "done");
		await duoIs("done outranks working: DONE", COLORS.plain, (svg) => footer(svg) === "DONE");
		report(duo, "error");
		await duoIs("an error in a tie says ERROR", COLORS.plain, (svg) => footer(svg) === "ERROR");
		report(duo, "idle");
		await duoIs("only the done left: DONE", COLORS.plain, (svg) => footer(svg) === "DONE");
		report(other, "idle");
		await duoIs("both idle: IDLE", COLORS.plain, (svg) => footer(svg) === "IDLE");

		const t0 = Date.now();
		await focusOn(duo);
		const sizes = eventLog.sizeChanges(t0).filter((e) => e.session_id === duo.session && e.owner === app.clientId);
		check("showing a two-pane session fires one resize per pane and one green tile", sizes.length === 2, `${sizes.length} resizes`);
		setSettings(K.text, DEFAULT_SETTINGS.text);
		const firstBefore = (await chunks(duo)).length;
		await expectBytes("two agents: a control key types into the focused pane", other, () => host.press(K.text), [hex("go ahead"), CR]);
		check("not the other one", (await chunks(duo)).length === firstBefore);

		const hidden = await sandbox.json("window", "new", "-s", duo.session, "--focus=false", "--json", "--shell=none", "--", CLAUDE, "three");
		const third = { label: "duo", tag: "three", session: duo.session, window: hidden.window_id, block: hidden.block_ids[0] };
		await attachTty(third, ["claude"]);
		await focusOn(s.notes);
		report(third, "done");
		await duoIs("a done in a hidden tab reads DONE", COLORS.plain, (svg) => footer(svg) === "DONE");
		await focusOn(duo);
		await focusOn(s.notes);
		await settle(500);
		check("looking at another tab of that session does not count", footer(tile("duo")) === "DONE", describe(tile("duo")));
		await app.select(duo.session, third.window);
		await eventually(() => background(tile("duo")) === COLORS.focused, 3000);
		await settle(500);
		await focusOn(s.notes);
		await duoIs("looking at that tab does", COLORS.plain, (svg) => footer(svg) === "IDLE");
		await closeSession(duo);

		const empty = await sandbox.json("api", "call", "session.create", JSON.stringify({ label: "empty" }));
		await expectSoon("a session with no windows still gets a tile", () => footer(tile("empty")) === "UNKNOWN" && background(tile("empty")) === COLORS.plain, { timeoutMs: 2000, instead: () => describe(tile("empty")) });
		await sandbox.rex("kill", empty.session_id ?? empty.session?.session_id);
		await eventually(() => !tile("empty"), 3000);
	});

	await phase("command", async () => {
		await focusOn(s.agent);
		await expectFace("command key shows its target", K.command, "&gt; agent");
		const since = mark();
		await expectBytes("Slash Command types /review bracketed, then Enter in its own write", s.agent, () => host.press(K.command), [bracketed("/review"), CR]);
		await expectFlash("command key flashes SENT", K.command, "SENT", since);
		setSettings(K.command, {});
		await expectFace("a command key with nothing set says so", K.command, "NOT SET", 1500);
		await expectBytes("and sends nothing", s.agent, () => host.press(K.command), []);
		setSettings(K.command, DEFAULT_SETTINGS.command);
	});

	await phase("text", async () => {
		await focusOn(s.agent);
		await expectBytes("Send Text pastes bracketed, then Enter", s.agent, () => host.press(K.text), [bracketed("go ahead"), CR]);
		setSettings(K.text, { text: "first\nsecond", submit: true });
		await expectBytes("multi-line text stays one bracketed paste", s.agent, () => host.press(K.text), [bracketed("first\nsecond"), CR]);
		setSettings(K.text, { text: "no enter", submit: false });
		await expectBytes("press Enter off: raw, no bracket, no Enter, with bracketed paste on", s.agent, () => host.press(K.text), [hex("no enter")]);
		setSettings(K.text, { text: "raw\nlines", submit: false });
		await expectBytes("press Enter off keeps newlines as they are", s.agent, () => host.press(K.text), [hex("raw\nlines")]);

		for (const text of ['say "hi" $HOME \\ é🙂', "123", "--help"]) {
			setSettings(K.text, { text, submit: false });
			await expectBytes(`text stays exact: ${text}`, s.agent, () => host.press(K.text), [hex(text)]);
		}
		setSettings(K.text, { text: 'say "hi" $HOME \\ é🙂', submit: true });
		await expectBytes("and pasted", s.agent, () => host.press(K.text), [bracketed('say "hi" $HOME \\ é🙂'), CR]);

		const plain = await newAgent("nobp", plainDir);
		report(plain, "idle");
		await focusOn(plain);
		setSettings(K.text, DEFAULT_SETTINGS.text);
		await expectBytes("with bracketed paste off the text arrives bare, then Enter", plain, () => host.press(K.text), [hex("go ahead"), CR]);
		setSettings(K.text, { text: "first\nsecond", submit: true });
		await expectBytes("with bracketed paste off a newline arrives as CR", plain, () => host.press(K.text), [hex("first\rsecond"), CR]);
		await closeSession(plain);

		const tool = await newAgent("tool", plainDir, { bin: TOOL });
		await focusOn(tool);
		setSettings(K.text, DEFAULT_SETTINGS.text);
		await expectBytes("a program that is not an agent gets the text and Enter", tool, () => host.press(K.text), hex("go ahead") + CR);
		report(tool, "blocked", { app: "wrapper-tool" });
		await settle(1000);
		const since = mark();
		await expectBytes("its own report makes it an agent, and the guard covers it", tool, () => host.press(K.text), []);
		await expectFlash("the key flashes BLOCKED", K.text, "BLOCKED", since);
		await closeSession(tool);

		await focusOn(s.notes);
		setSettings(K.text, { text: "echo deck-ok-$((40+2))", submit: true });
		await host.press(K.text);
		await expectSoon("into a plain shell, text runs as a command", async () => (await screen(s.notes)).includes("deck-ok-42"), { everyMs: 100 });
		setSettings(K.text, DEFAULT_SETTINGS.text);
	});

	await phase("keys", async () => {
		await focusOn(s.agent);
		const since = mark();
		await expectBytes("Send Keys defaults to esc", s.agent, () => host.press(K.keys), "1b");
		await expectFlash("and flashes SENT", K.keys, "SENT", since);
		setSettings(K.keys, { keys: "esc return A ! ctrl+c shift+tab ctrl+i meta+x -" });
		await expectBytes("each name maps to its bytes, in order", s.agent, () => host.press(K.keys), "1b 0d 41 21 03 1b5b5a 09 1b78 2d".replaceAll(" ", ""));
		setSettings(K.keys, { keys: "up space f1 backspace tab" });
		await expectBytes("arrows, space, function keys, backspace, tab", s.agent, () => host.press(K.keys), "1b5b41 20 1b4f50 7f 09".replaceAll(" ", ""));
		for (const bad of ["notakey", "ctrl+é"]) {
			setSettings(K.keys, { keys: bad });
			await expectFace(`"${bad}" shows BAD KEY on the key`, K.keys, "BAD KEY", 1000);
			await expectBytes(`"${bad}" sends nothing`, s.agent, () => host.press(K.keys), []);
		}
		setSettings(K.keys, DEFAULT_SETTINGS.keys);
		await sleep(1600);
	});

	await phase("blocked", async () => {
		await focusOn(s.agent);
		for (const [how, kind] of [["with kind", "permission"], ["with no kind", undefined]]) {
			report(s.agent, "blocked", kind ? { kind } : {});
			await focusOn(s.notes);
			await expectSoon(`the tile turns red (${how})`, () => background(tile("agent")) === COLORS.blocked, { timeoutMs: 2000, instead: () => describe(tile("agent")) });
			await focusOn(s.agent);
			const since = mark();
			await expectBytes(`blocked ${how}: Send Text types nothing`, s.agent, () => host.press(K.text), []);
			await expectFlash(`blocked ${how}: the key flashes BLOCKED`, K.text, "BLOCKED", since);
			await expectBytes(`blocked ${how}: Slash Command types nothing`, s.agent, () => host.press(K.command), []);
			await expectBytes(`blocked ${how}: Send Keys still sends esc`, s.agent, () => host.press(K.keys), "1b");
		}
		report(s.agent, "idle");
		await sleep(600);
		await withStaleSnapshot(async () => {
			report(s.agent, "blocked", { kind: "permission" });
			await sleep(100);
			const since = mark();
			await expectBytes("blocked after the last snapshot: the script on the sending connection refuses", s.agent, () => host.press(K.text), []);
			await expectFlash("and the key flashes BLOCKED", K.text, "BLOCKED", since);
			await expectBytes("Send Keys still goes through", s.agent, () => host.press(K.keys), "1b");
		});
		await sleep(600);
		report(s.agent, "idle");
		report(s.agent, "blocked", { id: "agent_a" });
		await sleep(700);
		await expectBytes("a blocked subagent also blocks typing", s.agent, () => host.press(K.text), []);
		clearRecords(s.agent);
		report(s.agent, "idle");
		await sleep(1700);
		await expectBytes("back to idle, typing works", s.agent, () => host.press(K.text), [bracketed("go ahead"), CR]);
	});

	await phase("not-ready", async () => {
		const fresh = await newAgent("fresh", plainDir, { flags: ["bp"] });
		await focusOn(fresh);
		let since = mark();
		await expectBytes("Claude with no root record gets nothing", fresh, () => host.press(K.text), []);
		await expectFlash("the key flashes NOT READY", K.text, "NOT READY", since);
		await expectBytes("Send Keys still goes through", fresh, () => host.press(K.keys), "1b");
		report(fresh, "idle");
		await sleep(1600);
		await expectBytes("once it reports, typing works", fresh, () => host.press(K.text), [bracketed("go ahead"), CR]);
		await closeSession(fresh);

		const shell = await newShell("gone", plainDir);
		await sandbox.rex("send", "-s", shell.session, "-b", shell.block, `${CLAUDE} gone\r`);
		await attachTty(shell, ["claude"]);
		report(shell, "idle");
		await focusOn(shell);
		await expectFace("the key targets the agent under the shell", K.text, "&gt; gone", 1500);
		await withStaleSnapshot(async () => {
			await sandbox.rex("send", "-s", shell.session, "-b", shell.block, "@@quit@@");
			await eventually(async () => argv0Base((await processOf(shell)).foreground) === "sh", 3000, 50);
			since = mark();
			await host.press(K.text);
			await expectFlash("the agent just left: a shell in front means NOT READY", K.text, "NOT READY", since);
			check("the shell received nothing", !(await screen(shell)).includes("go ahead"));
		});
		await closeSession(shell);
	});

	await phase("cycle", async () => {
		await focusOn(s.agent);
		const since = mark();
		await expectBytes(
			"Cycle sends opus, sonnet, haiku in order, one send at a time",
			s.agent,
			async () => {
				for (let i = 0; i < 3; i++) {
					await host.press(K.cycle);
				}
			},
			["/model opus", "/model sonnet", "/model haiku"].flatMap((text) => [bracketed(text), CR]),
		);
		const indexes = host
			.messagesFromPlugin("setSettings")
			.filter((entry) => entry.msg.context === K.cycle && entry.t >= since)
			.map((entry) => entry.msg.payload.index);
		check("Cycle saves its index after each press", indexes.slice(-3).join(",") === "1,2,0", indexes.join(","));
		await expectFace("Cycle shows the value the next press sends", K.cycle, "opus");
	});

	await phase("wrapper", async () => {
		const wrapped = await newShell("wrapped", plainDir);
		await sandbox.rex("send", "-s", wrapped.session, "-b", wrapped.block, `${WRAPPER} wrapped bp\r`);
		const leader = await eventually(async () => {
			const { foreground, child } = await processOf(wrapped);
			return argv0Base(foreground) === "sh" && foreground.pid !== child?.pid ? foreground : undefined;
		}, 6000, 50);
		check("a script that did not exec is the foreground, under the pane's shell", leader, leader?.argv0);
		await expectSoon("the agent behind it has started", async () => (await screen(wrapped)).includes("READY wrapped"), { everyMs: 100 });
		await focusOn(s.notes);
		const total = Number(words(svgOf(K.summary))[0]);
		report(wrapped, "idle");
		await expectSoon("its report makes the tile an agent's: IDLE, not UNKNOWN", () => footer(tile("wrapped")) === "IDLE", { timeoutMs: 2000, instead: () => describe(tile("wrapped")) });
		await expectSoon("and the summary counts it", () => Number(words(svgOf(K.summary))[0]) === total + 1, { timeoutMs: 1000, instead: () => words(svgOf(K.summary)).join(" | ") });
		report(wrapped, "blocked", { kind: "permission" });
		await expectSoon("blocked behind a script: the tile turns red", () => background(tile("wrapped")) === COLORS.blocked, { timeoutMs: 2000, instead: () => describe(tile("wrapped")) });
		await focusOn(wrapped);
		for (const [name, key] of [["Send Text", K.text], ["Slash Command", K.command], ["Cycle", K.cycle]]) {
			const since = mark();
			await expectBytes(`blocked behind a script: ${name} types nothing`, wrapped, () => host.press(key), []);
			await expectFlash(`and ${name} flashes BLOCKED`, key, "BLOCKED", since);
		}
		await expectBytes("blocked behind a script: Send Keys still sends esc", wrapped, () => host.press(K.keys), "1b");
		report(wrapped, "idle");
		await sleep(1700);
		await expectBytes("back to idle, a prompt reaches it through the guard", wrapped, () => host.press(K.text), [bracketed("go ahead"), CR]);
		await closeSession(wrapped);

		const created = await sandbox.json("new", "firstproc", "--json", "--shell=none", "-c", plainDir, "--", WRAPPER, "firstproc", "bp");
		const first = await attachTty(paneFrom("firstproc", created, "firstproc"), ["sh"]);
		await expectSoon("a script as the pane's first process has started its agent", async () => (await screen(first)).includes("READY firstproc"), { everyMs: 100 });
		report(first, "blocked", { kind: "permission" });
		await settle();
		check("a script as the pane's first process cannot be told from a shell", footer(tile("firstproc")) === "UNKNOWN", describe(tile("firstproc")));
		await focusOn(first);
		const since = mark();
		await expectBytes("but its own blocked record still stops text on the sending connection", first, () => host.press(K.text), []);
		await expectFlash("and the key flashes BLOCKED", K.text, "BLOCKED", since);
		await closeSession(first);

		const hostile = join(root, "hostile.txt");
		writeFileSync(hostile, "\x1b]7501;state=blocked:kind=permission:app=leftover\x1b\\");
		const shell = await newShell("shell", plainDir);
		await sandbox.rex("send", "-s", shell.session, "-b", shell.block, `cat ${hostile}\r`);
		await eventually(async () => {
			const { records } = await sandbox.json("block", "call", "-s", shell.session, "-b", shell.block, "program_status");
			return Array.isArray(records) && records.some((record) => record.state === "blocked");
		}, 3000, 50);
		await focusOn(shell);
		setSettings(K.text, { text: "echo shell-ok-$((40+2))", submit: true });
		await sleep(1600);
		await host.press(K.text);
		await expectSoon("a blocked record some program left does not stop text to a plain shell", async () => (await screen(shell)).includes("shell-ok-42"), { everyMs: 100 });
		setSettings(K.text, DEFAULT_SETTINGS.text);
		await closeSession(shell);
		await sleep(1600);
	});

	await phase("newtab", async () => {
		await focusOn(s.agent);
		const before = await windowsOf(s.agent);
		let since = mark();
		await host.press(K.newTab);
		const after = await eventually(async () => {
			const list = await windowsOf(s.agent);
			return list.length === before.length + 1 ? list : undefined;
		}, 4000, 100);
		check("New Tab opens a tab in the target session", after, `${after?.length} windows`);
		const opened = after?.find((window) => !before.some((other) => other.window_id === window.window_id));
		await expectSoon("the app shows that session and that tab", () => app.visible?.session_id === s.agent.session && app.visible?.window_id === opened?.window_id, {
			instead: () => JSON.stringify(app.visible),
		});
		await expectFlash("and the key flashes OPENED", K.newTab, "OPENED", since);
		const agentCwd = (await processOf(s.agent)).foreground.cwd;
		const openedCwd = await shellCwdIn(s.agent.session, opened.window_id);
		check("New Tab opens in the target pane's folder", openedCwd === agentCwd, `${openedCwd} vs ${agentCwd}`);
		await expectBytes("with the agent's tab now hidden, a control key still reaches the agent", s.agent, () => host.press(K.text), [bracketed("go ahead"), CR]);

		const chosen = join(repos, "docs");
		setSettings(K.newTab, { cwd: chosen });
		const count = (await windowsOf(s.agent)).length;
		await sleep(1000);
		await host.press(K.newTab);
		const withChosen = await eventually(async () => {
			const list = await windowsOf(s.agent);
			return list.length === count + 1 ? list : undefined;
		}, 4000, 100);
		const second = withChosen?.find((window) => window.window_id === app.visible?.window_id);
		const secondCwd = second && (await shellCwdIn(s.agent.session, second.window_id));
		check("a chosen folder is the one that opens", secondCwd === chosen, secondCwd);
		setSettings(K.newTab, { cwd: "/no/such/folder/here" });
		await sleep(1000);
		const total = (await windowsOf(s.agent)).length;
		since = mark();
		await host.press(K.newTab);
		await expectFlash("a folder that does not exist flashes NO SUCH DIR", K.newTab, "NO SUCH DIR", since);
		check("and opens nothing", (await windowsOf(s.agent)).length === total);
		setSettings(K.newTab, {});
		const extra = (await windowsOf(s.agent)).filter((window) => !before.some((other) => other.window_id === window.window_id));
		await sandbox.rex("window", "close", "-s", s.agent.session, ...extra.map((window) => window.window_id));
		await focusOn(s.agent);
	});

	await phase("pinned", async () => {
		setSettings(K.text, { text: "pinned hello", submit: true, target: s.agent.session, targetLabel: "agent" });
		await focusOn(s.notes);
		await expectFace("a pinned key shows its session", K.text, "#6 agent");
		await expectBytes("a key pinned to a session sends there while another is focused", s.agent, () => host.press(K.text), [bracketed("pinned hello"), CR]);
		check("the focused session receives nothing", !(await screen(s.notes)).includes("pinned hello"));
		await sandbox.rex("session", "rename", s.agent.session, "renamed");
		await expectSoon("a rename reaches the tile", () => tile("renamed"), { timeoutMs: 2000 });
		await expectFace("and the pin follows it", K.text, "#6 renamed");
		check("the new name is saved with the pin", host.settings.get(K.text)?.targetLabel === "renamed", JSON.stringify(host.settings.get(K.text)));
		await sandbox.rex("session", "rename", s.agent.session, "agent");
		await expectFace("and back", K.text, "#6 agent");

		const doomed = await newAgent("doomed", plainDir);
		report(doomed, "idle");
		await eventually(() => tile("doomed"), 3000);
		setSettings(K.text, { text: "pinned hello", submit: true, target: doomed.session, targetLabel: "doomed" });
		await expectFace("pinned to a session about to die", K.text, "#8 doomed");
		const since = mark();
		await sandbox.rex("kill", doomed.session);
		await expectFace("when the pinned session dies the key says GONE", K.text, "GONE");
		check("and dims", svgOf(K.text).includes('opacity="0.45"'));
		await host.press(K.text);
		await settle(400);
		check("a press then does nothing", !imagesSince(K.text, since).some((svg) => svg.includes(">SENT<") || svg.includes(">FAILED<")));

		const stale = await newAgent("stale", plainDir);
		report(stale, "idle");
		await eventually(() => tile("stale"), 3000);
		setSettings(K.text, { text: "pinned hello", submit: true, target: stale.session, targetLabel: "stale" });
		setSettings(K.keys, { keys: "esc", target: stale.session, targetLabel: "stale" });
		await expectFace("pinned to another", K.text, "#8 stale");
		await withStaleSnapshot(async () => {
			await sandbox.rex("kill", stale.session);
			await sleep(100);
			check("the deck has not heard yet", faceSays(K.text, "#8 stale"));
			await host.press(K.text);
			await expectFace("a press after it died flashes GONE", K.text, "GONE", 1500);
			await host.press(K.keys);
			await expectFace("and Send Keys too", K.keys, "GONE", 1500);
			const staleKey = tileWith(">stale<");
			await host.press(staleKey);
			await expectSoon("a press of its tile shows FAILED", () => svgOf(staleKey).includes("FAILED"), { timeoutMs: 2000, instead: () => describe(svgOf(staleKey)) });
		});
		setSettings(K.text, DEFAULT_SETTINGS.text);
		setSettings(K.keys, DEFAULT_SETTINGS.keys);
		await sleep(1600);
		await eventually(() => !tile("stale"), 6000);
	});

	await phase("pi", async () => {
		host.propertyInspectorDidAppear(K.command);
		await sleep(200);
		host.sendToPlugin(K.command, { event: "getWorkspaces" });
		const reply = await host.waitFor(() => host.toPropertyInspector.find((m) => m.payload?.event === "getWorkspaces"), 3000, "session list");
		const pinned = reply.payload.items.find((item) => item.children)?.children ?? [];
		check(
			"property inspector gets Focused agent plus every session by name",
			reply.payload.items[0]?.value === "" && pinned.some((c) => c.label === "agent" && c.value === s.agent.session),
			pinned.map((c) => c.label).join(", "),
		);
	});

	if (!ACTIVITY) {
		await phase("no-rsact", async () => {
			const records = [];
			for (const pane of Object.values(s)) {
				const status = await sandbox.json("block", "call", "-s", pane.session, "-b", pane.block, "program_status");
				records.push(...(Array.isArray(status.records) ? status.records : []).filter((record) => (record.id ?? "").startsWith("rsact/")));
			}
			check("E2E_ACTIVITY=0: the server holds no rsact records", records.length === 0, JSON.stringify(records).slice(0, 200));
			check("and its stream never carried one", !eventLog.events.some(({ event }) => JSON.stringify(event).includes("rsact/")));
		});
	}

	let createdSession;
	await phase("newspace", async () => {
		await focusOn(s.notes);
		const before = (await sandbox.json("ls", "--json")).sessions;
		rmSync(sandbox.rcMarker, { force: true });
		await host.press(K.newSpace);
		const sessions = await eventually(async () => {
			const list = (await sandbox.json("ls", "--json")).sessions;
			return list.length === before.length + 1 ? list : undefined;
		}, 4000, 100);
		createdSession = sessions?.find((session) => !before.some((other) => other.session_id === session.session_id));
		check("New Session creates a session", createdSession, createdSession?.label);
		await expectSoon("the app shows it", () => app.visible?.session_id === createdSession?.session_id, { instead: () => JSON.stringify(app.visible) });
		await expectSoon("it fills the first free key, green", () => background(svgAt(3, 1)) === COLORS.focused, { instead: () => describe(svgAt(3, 1)) });
		check("named by the server", svgAt(3, 1).includes(`>${createdSession?.label?.slice(0, 12)}`), words(svgAt(3, 1)).join(" | "));
		const foreground = await eventually(async () => {
			const block = (await sandbox.json("block", "ls", "-s", createdSession.session_id, "--json")).blocks?.[0];
			const current = block && (await sandbox.json("block", "call", "-s", createdSession.session_id, "-b", block.block_id, "process")).foreground;
			return current?.argv0?.startsWith("-") && current.cwd ? current : undefined;
		}, 4000, 100);
		if (argv0Base(foreground) === "zsh") {
			await expectSoon("its login shell read the sandbox's rc file, not the user's", () => existsSync(sandbox.rcMarker), { timeoutMs: 2000 });
		}
		await host.waitForQuiet(800);
		board("after-new-session", "after New Session");
	});

	await phase("pager", async () => {
		const sessionsNow = (await sandbox.json("ls", "--json")).sessions.length;
		const rowOne = spaceKeys.filter(([, row]) => row === 1);
		for (const [column, row] of rowOne) {
			host.willDisappear(ctx(column, row));
		}
		const pages = Math.ceil(sessionsNow / 2);
		await expectSoon("fewer keys than sessions: pager on the last two keys", () => svgAt(2, 0).includes("←") && svgAt(3, 0).includes("→"), { timeoutMs: 3000 });
		check("it shows the page count", svgAt(3, 0).includes(`1/${pages}`), words(svgAt(3, 0)).join(" | "));
		check("→ is accented toward the off-page focused session", svgAt(3, 0).includes(`fill="${COLORS.focused}"`) && !svgAt(2, 0).includes(`fill="${COLORS.focused}"`));
		await host.press(ctx(3, 0));
		await expectSoon("→ pages forward one page", () => svgAt(3, 0).includes(`2/${pages}`) && svgAt(0, 0).includes(">infra<") && svgAt(1, 0).includes(">docs<"), { timeoutMs: 2000, instead: () => words(svgAt(0, 0)).join(" | ") });
		await host.press(ctx(2, 0));
		await host.press(ctx(2, 0));
		await expectSoon("← does not wrap past the first page", () => svgAt(2, 0).includes(`1/${pages}`) && svgAt(0, 0).includes(">api<"), { timeoutMs: 2000 });
		await host.waitForQuiet(600);
		board("pager", `4 session keys, ${sessionsNow} sessions: pager`);
		for (const [column, row] of rowOne) {
			host.willAppear({ context: ctx(column, row), action: UUID("space"), coordinates: { column, row } });
		}
		await expectSoon("pager disappears when keys return", () => !svgAt(3, 0).includes("→"), { timeoutMs: 3000 });

		const more = await newAgent("extra", plainDir);
		report(more, "idle");
		await expectSoon("more sessions than the full grid: pager again", () => svgAt(2, 1).includes("←") && svgAt(3, 1).includes("→"), { timeoutMs: 3000 });
		check("with two pages", /[12]\/2/.test(svgAt(3, 1)), words(svgAt(3, 1)).join(" | "));
		await host.waitForQuiet(600);
		board("pager-full", "8 session keys, 9 sessions: pager");
		await sandbox.rex("kill", more.session);
		await expectSoon("and gone when the extra session closes", () => !svgAt(3, 1).includes("→"), { timeoutMs: 3000 });
		await sandbox.rex("kill", createdSession.session_id);
		await expectSoon("closing the session in view leaves no green tile", () => !spaceContexts.some((context) => background(svgOf(context)) === COLORS.focused), { timeoutMs: 3000 });
		await expectFace("and control keys with no target say so", K.command, "NO AGENT", 1000);
	});

	await phase("hang", async () => {
		sandbox.pause();
		await expectSoon("a hung server is found by the poll: REX OFFLINE", () => svgAt(0, 0).includes("OFFLINE"), { timeoutMs: 30000, everyMs: 100 });
		check("the plugin stays responsive meanwhile", rtts.at(-1) < 1000, `${rtts.at(-1)?.toFixed(1)} ms`);
		sandbox.resume();
		await expectSoon("the server continuing brings the tiles back", () => !svgAt(0, 0).includes("OFFLINE") && tileWith(">api<"), { timeoutMs: 10000, everyMs: 100 });
	});

	await phase("offline", async () => {
		const streamBefore = await eventsChild();
		check("the stream is up before the stop", streamBefore);
		for (const started of apps) {
			await started.kill().catch(() => {});
		}
		eventLog.stop();
		const tStop = Date.now();
		await sandbox.stop();
		await expectSoon("server stop -> REX OFFLINE on top-left", () => words(svgAt(0, 0)).join(" ") === "REX OFFLINE", { timeoutMs: 10000, everyMs: 100, instead: () => words(svgAt(0, 0)).join(" ") });
		console.log(`      ${Date.now() - tStop} ms after stop`);
		check("the rest dim: nothing from another server shows up", spaceContexts.slice(1).every((context) => svgOf(context).includes('opacity="0.45"') || svgOf(context).includes("<circle")), spaceContexts.map((context) => words(svgOf(context))[1] ?? "").join(","));
		check("New Session dims while offline", svgOf(K.newSpace).includes("opacity"));
		check("summary shows OFFLINE, not stale counts", svgOf(K.summary).includes("OFFLINE") && !/>\d+<\/text>/.test(svgOf(K.summary)));
		check("control keys dim while offline", svgOf(K.command).includes('opacity="0.45"') && svgOf(K.command).includes("OFFLINE"));
		const alertsBefore = host.alerts.length;
		await host.press(K.newSpace);
		await host.press(ctx(0, 0));
		await settle(300);
		check("keys do nothing while offline", host.alerts.length === alertsBefore);
		await host.waitForQuiet(600);
		board("offline", "Rex server stopped");

		const tStart = Date.now();
		await sandbox.start();
		await eventLog.start();
		await expectSoon("the server returning clears OFFLINE; this sandbox restores nothing, so it reads NO SESSIONS", () => svgAt(0, 0).includes("NO SESSIONS"), { timeoutMs: 5000, everyMs: 100, instead: () => words(svgAt(0, 0)).join(" ") });
		app = await startApp();
		const phoenix = await newAgent("phoenix", gitRepo("phoenix", "main"));
		report(phoenix, "working");
		await expectSoon("a session on the returned server appears", () => background(tile("phoenix")) === COLORS.working, { timeoutMs: 10000, everyMs: 100, instead: () => words(svgAt(0, 0)).join(" ") });
		const stream = await expectSoon("the stream resubscribes", async () => {
			const child = await eventsChild();
			return child && child.pid !== streamBefore?.pid ? child : undefined;
		}, { timeoutMs: 20000, everyMs: 250 });
		check("the new stream also names the sandbox", stream?.args.includes(`-S ${sandbox.endpoint}`));
		console.log(`      recovery took ${Date.now() - tStart} ms`);
		await sleep(1500);
		report(phoenix, "blocked", { kind: "permission" });
		await expectSoon("state changes land through it", () => background(tile("phoenix")) === COLORS.blocked, { timeoutMs: 1500, instead: () => describe(tile("phoenix")) });
		await sleep(800);
		const base = snapshotCount();
		await sleep(4000);
		const polled = snapshotCount() - base;
		check("polling has dropped back to the reconcile, not 1 Hz", polled <= 2, `${polled} snapshots in 4 s`);
		const key = tileWith(">phoenix<");
		await host.press(key);
		await expectSoon("pressing a tile works again", () => background(svgOf(key)) === COLORS.focused && app.visible?.session_id === phoenix.session, { timeoutMs: 2000 });
		await host.press(K.summary);
		await expectSoon("with nothing needing attention the summary flashes ALL CLEAR", () => svgOf(K.summary).includes("ALL CLEAR"), { timeoutMs: 1500, instead: () => words(svgOf(K.summary)).join(" | ") });
		await host.waitForQuiet(1000);
		board("recovered", "Rex server restarted");

		const crashedStream = await eventsChild();
		await sandbox.crash();
		eventLog.stop();
		await expectSoon("a server killed outright: REX OFFLINE", () => words(svgAt(0, 0)).join(" ") === "REX OFFLINE", { timeoutMs: 10000, everyMs: 100 });
		check("with its stale socket still on disk, the plugin does not fall back", existsSync(sandbox.socket));
		await sandbox.start();
		await eventLog.start();
		await expectSoon("and back after a restart on that stale socket", () => svgAt(0, 0).includes("NO SESSIONS"), { timeoutMs: 5000, everyMs: 100, instead: () => words(svgAt(0, 0)).join(" ") });
		await expectSoon("with a fresh stream again", async () => {
			const child = await eventsChild();
			return child && child.pid !== crashedStream?.pid;
		}, { timeoutMs: 20000, everyMs: 250 });
	});

	const finite = rtts.filter(Number.isFinite).sort((a, b) => a - b);
	check(
		"websocket ping answered throughout (Elgato watchdog proxy)",
		finite.length === rtts.length && finite.length > 0,
		`${finite.length} pings, max ${finite.at(-1)?.toFixed(1)} ms, p50 ${finite[Math.floor(finite.length / 2)]?.toFixed(1)} ms`,
	);
	const calls = rexCalls();
	const strayCalls = calls.filter((line) => !line.endsWith(` --autostart=false -S ${sandbox.endpoint}`));
	check("every rex call the plugin made named the sandbox, with autostart off", calls.length > 0 && strayCalls.length === 0, `${calls.length} calls, ${strayCalls.length} others${strayCalls[0] ? `: ${strayCalls[0]}` : ""}`);
	check("no host alert beyond the one the no-app phase asked for", host.alerts.length <= 1, `${host.alerts.length} alerts`);
} finally {
	await cleanup();
	const { stdout: leftovers } = await eventually(async () => {
		const found = await execFileAsync("/usr/bin/pgrep", ["-fl", root]).catch(() => ({ stdout: "" }));
		return found.stdout.trim() === "" ? found : undefined;
	}, 3000, 100).then((found) => found ?? execFileAsync("/usr/bin/pgrep", ["-fl", root]));
	check("no process from this run is left", leftovers.trim() === "", leftovers.trim().slice(0, 300));
	writeFileSync(join(out, "messages.jsonl"), host.log.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	writeFileSync(join(out, "events.jsonl"), eventLog.events.map(({ event }) => JSON.stringify(event)).join("\n") + "\n");
	writeFileSync(join(out, "plugin-stderr.txt"), host.stderr);
	cpSync(callLog, join(out, "rex-calls.log"));
	const logs = join(pluginDir, "logs");
	if (existsSync(logs)) {
		cpSync(logs, join(out, "plugin-logs"), { recursive: true });
	}
	const summary = {
		plugin: PLUGIN_SRC,
		node: host.opts.nodeBin,
		activity: ACTIVITY,
		passed: results.filter((r) => r.ok).length,
		failed: results.filter((r) => !r.ok).length,
		results,
		setImageCounts: Object.fromEntries(host.imageCounts),
	};
	writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
	console.log(`\n${summary.passed} passed, ${summary.failed} failed — artifacts in ${out}`);
	process.exit(summary.failed ? 1 : 0);
}
