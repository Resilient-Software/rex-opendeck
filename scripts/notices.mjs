/**
 * Writes what a copy of the plugin has to carry: this project's licence, and the
 * licence of every package esbuild bundled, since its output keeps neither. Reads
 * esbuild's metafile, so the list is what was actually bundled, and deletes it.
 *
 *   node scripts/notices.mjs <metafile> <output dir>
 */
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const [metafile, outDir] = process.argv.slice(2);

const packages = new Set();
for (const input of Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs)) {
	const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
	if (match) {
		packages.add(match[1]);
	}
}

const sections = [...packages].sort().map((dir) => {
	const root = join(REPO, dir);
	const { name, version, license } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const file = readdirSync(root).find((entry) => /^licen[cs]e/i.test(entry));
	if (!file) {
		throw new Error(`${name} has no licence file to carry`);
	}
	return `${name} ${version} (${license})\n\n${readFileSync(join(root, file), "utf8").trim()}\n`;
});

copyFileSync(join(REPO, "LICENSE"), join(outDir, "LICENSE.txt"));
writeFileSync(join(outDir, "THIRD_PARTY_NOTICES.txt"), `Rex Deck bundles the packages below, each under its own licence.\n\n${sections.join("\n---\n\n")}`);
rmSync(metafile);
