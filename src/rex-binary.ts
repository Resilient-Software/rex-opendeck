/**
 * Finds the rex CLI. The host application runs plugins with a minimal PATH
 * and no REX_BIN_DIR, which is why the steps before a bare "rex" exist.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BinaryEnvironment = {
	env: NodeJS.ProcessEnv;
	home: string;
	bundleRoot: string;
	exists(path: string): boolean;
	readText(path: string): string;
	processNames(): Promise<string[]>;
};

function defaultEnvironment(): BinaryEnvironment {
	return {
		env: process.env,
		home: homedir(),
		bundleRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
		exists: existsSync,
		readText: (path) => readFileSync(path, "utf8"),
		processNames: async () => {
			// `command=` truncates at the space in "Application Support".
			const { stdout } = await execFileAsync("/bin/ps", ["-axo", "comm="]);
			return stdout.split("\n");
		},
	};
}

function installLocations({ env, home }: BinaryEnvironment): string[] {
	return [
		join(home, "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"),
		"/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
		"/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
		...(env.REX_BIN_DIR ? [join(env.REX_BIN_DIR, "rex")] : []),
		join(home, ".local/bin/rex"),
		"/opt/homebrew/bin/rex",
		"/usr/local/bin/rex",
		"/usr/bin/rex",
	];
}

async function runningBinary(host: BinaryEnvironment): Promise<string | undefined> {
	try {
		const names = await host.processNames();
		return names.map((name) => name.trim()).find((name) => name.startsWith("/") && basename(name) === "rex" && host.exists(name));
	} catch {
		return undefined;
	}
}

export async function resolveBinary(host: BinaryEnvironment = defaultEnvironment()): Promise<string> {
	if (host.env.REX_PATH) {
		return host.env.REX_PATH;
	}
	try {
		const recorded = host.readText(join(host.bundleRoot, "rex-path.txt")).trim();
		if (recorded && host.exists(recorded)) {
			return recorded;
		}
	} catch {
		// No recorded path; keep looking.
	}
	return installLocations(host).find((path) => host.exists(path)) ?? (await runningBinary(host)) ?? "rex";
}
