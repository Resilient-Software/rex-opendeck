/**
 * A throwaway Rex server for end-to-end tests: its own socket and state, no
 * restore, an empty config. Layout under `root`: sb/ holds the state, the empty
 * config and the server log; rt/ is REX_RUNTIME_DIR; home/ is HOME and ZDOTDIR.
 * rex.sock sits directly under root because macOS caps socket paths at 104 bytes.
 *
 * rex falls back to its default socket when REX_SERVER names one that is gone,
 * so every call here passes -S and every child gets REX_RUNTIME_DIR and a temp
 * HOME too: a phase that stops the server must not reach the user's real one.
 * Terminals the plugin creates start a login shell, and login resets HOME to the
 * real one but keeps ZDOTDIR, which is what keeps zsh off the user's rc files.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Environment variables that would tie a process to the caller's real Rex pane or terminal. */
export const LEAKY = [
	"REX_SERVER",
	"REX_SESSION",
	"REX_BLOCK",
	"REX_BIN_DIR",
	"REX_CLIENT",
	"REX_HOME",
	"REX_RUNTIME_DIR",
	"REX_PATH",
	"SSH_AUTH_SOCK",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERMINFO",
	"GHOSTTY_RESOURCES_DIR",
	"GHOSTTY_BIN_DIR",
	"GHOSTTY_SHELL_FEATURES",
	"GHOSTTY_SURFACE_ID",
	"KITTY_WINDOW_ID",
	"WEZTERM_EXECUTABLE",
	"ITERM_SESSION_ID",
];

export class RexSandbox {
	constructor({ root, binary }) {
		this.root = root;
		this.binary = binary;
		this.sb = join(root, "sb");
		this.home = join(root, "home");
		this.socket = join(root, "rex.sock");
		this.endpoint = `unix://${this.socket}`;
		this.runtime = join(root, "rt");
		this.rcMarker = join(this.sb, "zshrc-read");
		mkdirSync(this.sb, { recursive: true });
		mkdirSync(this.home, { recursive: true });
		writeFileSync(join(this.home, ".zshrc"), `: > '${this.rcMarker}'\nPS1='$ '\n`);
		if (Buffer.byteLength(this.socket) > 103) {
			throw new Error(`socket path is ${Buffer.byteLength(this.socket)} bytes, over the 103 macOS allows: ${this.socket}`);
		}
	}

	/** Env for anything that talks to this sandbox: the server, a CLI call, the plugin. */
	env(extra = {}) {
		const env = { ...process.env };
		for (const key of LEAKY) {
			delete env[key];
		}
		return { ...env, HOME: this.home, ZDOTDIR: this.home, REX_SERVER: this.endpoint, REX_RUNTIME_DIR: this.runtime, ...extra };
	}

	async start() {
		const config = join(this.sb, "none.lua");
		writeFileSync(config, "");
		const log = openSync(join(this.sb, "server.log"), "a");
		this.server = spawn(this.binary, ["server", "run", "--listen", this.endpoint, "--state-dir", this.sb, "--restore=false", "--config", config], {
			env: this.env(),
			stdio: ["ignore", log, log],
		});
		closeSync(log);
		for (let i = 0; i < 100; i++) {
			try {
				await this.rex("api", "call", "server.version");
				return;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		throw new Error("sandbox server did not start");
	}

	/** Async on purpose: execFileSync of `rex -C` stalls a fake app in the same process. */
	async rex(...args) {
		const { stdout } = await execFileAsync(this.binary, ["-S", this.endpoint, "--autostart=false", "--timeout", "2s", ...args], { env: this.env() });
		return stdout;
	}

	async json(...args) {
		return JSON.parse(await this.rex(...args));
	}

	pause() {
		this.server?.kill("SIGSTOP");
	}

	resume() {
		this.server?.kill("SIGCONT");
	}

	async stop() {
		await this.#signal("SIGTERM");
		rmSync(this.socket, { force: true });
	}

	/** Dies without cleaning up: the socket file stays behind. */
	crash() {
		return this.#signal("SIGKILL");
	}

	async #signal(signal) {
		const server = this.server;
		this.server = undefined;
		if (server && server.exitCode === null && server.signalCode === null) {
			const exited = new Promise((resolve) => server.once("exit", resolve));
			// A stopped process would hold SIGTERM until it is continued.
			server.kill("SIGCONT");
			server.kill(signal);
			await exited;
		}
	}
}
