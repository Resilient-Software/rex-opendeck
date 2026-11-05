/**
 * Finds the rex CLI. The host application runs plugins with a minimal PATH
 * and no REX_BIN_DIR, which is why the steps before a bare "rex" exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BinaryEnvironment = {
	env: NodeJS.ProcessEnv;
	home: string;
	bundleRoot: string;
	exists(path: string): boolean;
	readText(path: string): string;
};

/** The plugin folder, or "" when the bundle was not loaded from a file. */
function bundleRoot(): string {
	try {
		return join(dirname(fileURLToPath(import.meta.url)), "..");
	} catch {
		return "";
	}
}

function defaultEnvironment(): BinaryEnvironment {
	return {
		env: process.env,
		home: homedir(),
		bundleRoot: bundleRoot(),
		exists: existsSync,
		readText: (path) => readFileSync(path, "utf8"),
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

/**
 * Never a process found running: ps lists every local user's, and the bridge
 * runs what this returns on every poll.
 */
export async function resolveBinary(host: BinaryEnvironment = defaultEnvironment()): Promise<string> {
	if (host.env.REX_PATH) {
		return host.env.REX_PATH;
	}
	try {
		const recorded = host.bundleRoot ? host.readText(join(host.bundleRoot, "rex-path.txt")).trim() : "";
		if (recorded && host.exists(recorded)) {
			return recorded;
		}
	} catch {
		// No recorded path; keep looking.
	}
	return installLocations(host).find((path) => host.exists(path)) ?? "rex";
}
