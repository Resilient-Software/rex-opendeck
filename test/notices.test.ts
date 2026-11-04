import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "rex-notices-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(name: string, inputs: string[]) {
	const metafile = join(scratch, `${name}.json`);
	writeFileSync(metafile, JSON.stringify({ inputs: Object.fromEntries(inputs.map((input) => [input, {}])) }));
	return { metafile, result: spawnSync(process.execPath, ["scripts/notices.mjs", metafile, scratch], { cwd: repo, encoding: "utf8" }) };
}

describe("the licences a copy of the plugin carries", () => {
	test("this project's licence and each bundled package's, and nothing else", () => {
		const { metafile, result } = run("ok", ["src/plugin.ts", "node_modules/ws/lib/stream.js", "node_modules/ws/lib/sender.js", "node_modules/@elgato/utils/dist/index.js"]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(readFileSync(join(scratch, "LICENSE.txt"), "utf8")).toBe(readFileSync(join(repo, "LICENSE"), "utf8"));
		const notices = readFileSync(join(scratch, "THIRD_PARTY_NOTICES.txt"), "utf8");
		expect(notices.match(/^ws \d/gm)).toHaveLength(1);
		expect(notices).toContain(readFileSync(join(repo, "node_modules/ws/LICENSE"), "utf8").trim());
		expect(notices).toMatch(/^@elgato\/utils \d\S* \(MIT\)$/m);
		expect(notices).not.toContain("plugin.ts");
		expect(existsSync(metafile)).toBe(false);
	});

	test("a bundled package with no licence to carry fails the build", () => {
		const unlicensed = join(scratch, "node_modules", "unlicensed");
		mkdirSync(unlicensed, { recursive: true });
		writeFileSync(join(unlicensed, "package.json"), JSON.stringify({ name: "unlicensed", version: "1.0.0" }));
		const { result } = run("missing", ["node_modules/@elgato/utils/dist/index.js", `${relative(repo, unlicensed)}/index.js`]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("unlicensed has no licence file to carry");
	});

	test("the build makes them, and every installer ships the folder they land in", () => {
		const { scripts } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: { build: string } };
		expect(scripts.build).toContain("--metafile=plugin/bin/meta.json");
		expect(scripts.build).toContain("node scripts/notices.mjs plugin/bin/meta.json plugin/bin");
		for (const script of ["pack.sh", "install.sh", "install-elgato.sh"]) {
			const text = readFileSync(join(repo, "scripts", script), "utf8");
			expect(text).toMatch(/npm run --silent build/);
			expect(text).toMatch(/cp -R .*plugin\/bin/);
		}
	});
});
