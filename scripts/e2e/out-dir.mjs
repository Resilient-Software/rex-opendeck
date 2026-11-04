/**
 * The e2e artifact directory. A run starts by clearing it, and E2E_OUT can name
 * any path, so only a directory an earlier run marked as its own is ever cleared.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = ".rex-deck-e2e-out";

export function prepareOutDir(out) {
	const entries = existsSync(out) ? readdirSync(out) : [];
	if (entries.length > 0 && !entries.includes(MARKER)) {
		throw new Error(`refusing to use ${out} for artifacts: a run clears its output folder, and this one is not empty and did not come from an earlier run`);
	}
	for (const entry of entries) {
		rmSync(join(out, entry), { recursive: true, force: true });
	}
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, MARKER), "");
}
