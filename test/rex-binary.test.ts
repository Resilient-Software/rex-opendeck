import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { type BinaryEnvironment, resolveBinary } from "../src/rex-binary";

const HOME = "/work/home";
const BUNDLE = "/work/plugin";
const RECORD = join(BUNDLE, "rex-path.txt");
const VERSIONS = `${HOME}/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`;

function host(present: string[], options: { env?: NodeJS.ProcessEnv; recorded?: string } = {}): BinaryEnvironment {
	return {
		env: options.env ?? {},
		home: HOME,
		bundleRoot: BUNDLE,
		exists: (path) => present.includes(path),
		readText: (path) => {
			if (path === RECORD && options.recorded !== undefined) {
				return options.recorded;
			}
			throw new Error("ENOENT");
		},
	};
}

describe("resolveBinary", () => {
	test("REX_PATH wins, even when nothing checks it exists", async () => {
		await expect(resolveBinary(host([VERSIONS], { env: { REX_PATH: "/work/stub/rex" }, recorded: VERSIONS }))).resolves.toBe("/work/stub/rex");
	});

	test("a recorded path counts only if the file it names exists", async () => {
		await expect(resolveBinary(host(["/work/opt/rex", VERSIONS], { recorded: "/work/opt/rex\n" }))).resolves.toBe("/work/opt/rex");
		await expect(resolveBinary(host([VERSIONS], { recorded: "/work/opt/rex\n" }))).resolves.toBe(VERSIONS);
		await expect(resolveBinary(host([VERSIONS], { recorded: "" }))).resolves.toBe(VERSIONS);
	});

	test("install locations in order", async () => {
		const order = [
			VERSIONS,
			"/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
			"/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
			"/work/bindir/rex",
			`${HOME}/.local/bin/rex`,
			"/opt/homebrew/bin/rex",
			"/usr/local/bin/rex",
			"/usr/bin/rex",
		];
		for (let i = 0; i < order.length; i++) {
			const env = { REX_BIN_DIR: "/work/bindir" };
			await expect(resolveBinary(host(order.slice(i), { env }))).resolves.toBe(order[i]);
		}
	});

	test("REX_BIN_DIR is skipped when unset", async () => {
		await expect(resolveBinary(host(["/undefined/rex", "/usr/bin/rex"]))).resolves.toBe("/usr/bin/rex");
	});

	test("falls back to bare rex", async () => {
		await expect(resolveBinary(host([]))).resolves.toBe("rex");
	});

	test("nothing that merely happens to be running is ever chosen", async () => {
		const source = readFileSync(new URL("../src/rex-binary.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/\bps\b.*-ax|node:child_process/);
	});
});
