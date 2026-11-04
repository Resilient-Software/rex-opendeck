/**
 * Every suite runs against the stub. rex quietly falls back to its default
 * socket when REX_SERVER names one that is gone, so REX_SERVER alone cannot keep
 * a stray call of a real binary off the user's server: HOME and REX_RUNTIME_DIR
 * move the default socket as well.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "rex-deck-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

process.env.REX_PATH = fileURLToPath(new URL("./stub/rex", import.meta.url));
process.env.REX_STUB_NODE = process.execPath;
process.env.REX_SERVER = `unix://${join(scratch, "none.sock")}`;
process.env.REX_RUNTIME_DIR = join(scratch, "runtime");
process.env.HOME = join(scratch, "home");
process.env.REX_DECK_NO_RAISE = "1";
process.env.REX_DECK_FRONTMOST = "always";
process.env.REX_DECK_FOCUS_PREF_DOMAIN = "com.resilientsoftware.rexdeck.unused-test-domain";
for (const name of ["REX_SESSION", "REX_BLOCK", "REX_BIN_DIR", "REX_CLIENT", "REX_HOME"]) {
	delete process.env[name];
}
