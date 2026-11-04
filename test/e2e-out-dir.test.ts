import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

// @ts-expect-error A plain script with no type declarations.
import { prepareOutDir } from "../scripts/e2e/out-dir.mjs";

const scratch = mkdtempSync(join(tmpdir(), "rex-out-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function folder(name: string, files: string[] = []): string {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	for (const file of files) {
		writeFileSync(join(dir, file), "kept");
	}
	return dir;
}

describe("the e2e artifact directory", () => {
	test("a folder holding anything else is refused and left alone", () => {
		const dir = folder("thesis", ["thesis.txt", "summary.json"]);
		expect(() => prepareOutDir(dir)).toThrow(/refusing to use/);
		expect(readdirSync(dir).sort()).toEqual(["summary.json", "thesis.txt"]);
	});

	test("a new or empty folder is used and marked", () => {
		const fresh = join(scratch, "new", "deep");
		prepareOutDir(fresh);
		expect(existsSync(fresh)).toBe(true);
		const empty = folder("empty");
		prepareOutDir(empty);
		expect(readdirSync(empty)).toHaveLength(1);
	});

	test("an earlier run's folder is cleared, subfolders too", () => {
		const dir = folder("earlier");
		prepareOutDir(dir);
		const [marker] = readdirSync(dir);
		writeFileSync(join(dir, "summary.json"), "{}");
		mkdirSync(join(dir, "connect"));
		writeFileSync(join(dir, "connect", "key.svg"), "");
		prepareOutDir(dir);
		expect(readdirSync(dir)).toEqual([marker]);
	});
});
