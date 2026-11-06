import { describe, expect, test } from "vitest";

import type { Workspace } from "../src/rex";
import {
	connectingTile,
	controlTile,
	emptyTile,
	newSpaceTile,
	noSpacesTile,
	missingTile,
	offlineTile,
	pagerTile,
	spaceTile,
	summaryTile,
} from "../src/render";
import type { Counts } from "../src/state";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

function svg(image: string): string {
	return Buffer.from(image.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
}

function counts(overrides: Partial<Counts>): Counts {
	const base: Counts = {
		blocked: 0,
		working: 0,
		background: 0,
		scheduled: 0,
		done: 0,
		idle: 0,
		total: 0,
		nextAt: null,
		loop: false,
		...overrides,
	};
	if (overrides.total === undefined) {
		base.total = base.blocked + base.working + base.background + base.scheduled + base.done + base.idle;
	}
	return base;
}

function space(overrides: Partial<Workspace>): Workspace {
	return {
		workspace_id: "w1",
		number: 1,
		label: "api-server",
		agent_status: "idle",
		pane_count: 1,
		tab_count: 1,
		focused: false,
		worktree: null,
		...overrides,
	};
}

describe("Rex wording", () => {
	test("message tiles and the new session key", () => {
		expect(svg(connectingTile())).toMatch(/>REX<.*>CONNECTING</);
		expect(svg(noSpacesTile())).toMatch(/>NO SESSIONS<.*>OPEN REX</);
		expect(svg(offlineTile())).toMatch(/>REX<.*>OFFLINE</);
		expect(svg(missingTile())).toMatch(/>REX<.*>NOT FOUND<.*>INSTALL REX</);
		expect(svg(newSpaceTile(false))).toContain(">NEW SESSION<");
	});

	test("the footer says ERROR when the status word asks", () => {
		const errored = spaceTile(space({ agent_status: "done", status_word: "ERROR" }), { repo: "", branch: "" }, { now: NOW });
		expect(svg(errored)).toContain(">ERROR<");
		expect(svg(spaceTile(space({ agent_status: "done" }), { repo: "", branch: "" }, { now: NOW }))).toContain(">DONE<");
	});

	test("done gets a teal field and still names itself, since teal sits close to the focused green", () => {
		const field = (overrides: Partial<Workspace>) => /<rect width="144" height="144" fill="(#[0-9a-f]{6})"/.exec(svg(spaceTile(space(overrides), { repo: "", branch: "" }, { now: NOW })))?.[1];
		const done = svg(spaceTile(space({ agent_status: "done" }), { repo: "", branch: "" }, { now: NOW }));
		expect(field({ agent_status: "done" })).toBe("#94e2d5");
		expect(done).toMatch(/fill="#1e1e2e"[^>]*>api-server</);
		expect(done).toMatch(/fill="#313244"[^>]*>DONE</);
		expect(svg(spaceTile(space({ agent_status: "done", status_word: "ERROR" }), { repo: "", branch: "" }, { now: NOW }))).toMatch(/fill="#94e2d5"[\s\S]*>ERROR</);
		expect(field({ agent_status: "done", focused: true })).toBe("#a6e3a1");
		expect(field({ agent_status: "done", tokens: { rsact_v: "1", rsact_state: "subagents", rsact_subagents: "1" } })).toBe("#89b4fa");
		expect(field({ agent_status: "idle" })).toBeUndefined();
		expect(svg(spaceTile(space({ agent_status: "done" }), { repo: "", branch: "" }, { now: NOW, dim: true }))).not.toContain("#94e2d5");
	});

	test("a failure footer stays readable on every field", () => {
		const failed = { footer: "FAILED · TRY AGAIN", footerRed: true, now: NOW };
		const fill = (overrides: Partial<Workspace>) =>
			/fill="(#[0-9a-f]{6})"[^>]*>FAILED/.exec(svg(spaceTile(space(overrides), { repo: "", branch: "" }, failed)))?.[1];
		expect(fill({ agent_status: "idle" })).toBe("#f38ba8");
		expect(fill({ agent_status: "blocked" })).toBe("#313244");
		expect(fill({ agent_status: "working" })).toBe("#313244");
		expect(fill({ focused: true })).toBe("#313244");
		expect(fill({ agent_status: "done" })).toBe("#313244");
		expect(fill({ tokens: { rsact_v: "1", rsact_state: "subagents", rsact_subagents: "1" } })).toBe("#313244");
		expect(fill({ tokens: { rsact_v: "1", rsact_state: "scheduled", rsact_next_at: new Date(NOW + 60_000).toISOString() } })).toBe("#f38ba8");
	});
});

describe("summaryTile", () => {
	test("ring counts the total and calls out blocked agents in red", () => {
		const out = svg(summaryTile(counts({ blocked: 2, working: 3, idle: 1 }), "ring"));
		expect(out).toContain(">6</text>");
		expect(out).toMatch(/fill="#f38ba8"[^>]*>2 BLOCKED</);
		expect(out.match(/<path d="M/g)).toHaveLength(3);
	});

	test("ring falls back to done, then the soonest check, then busy", () => {
		expect(svg(summaryTile(counts({ done: 2, working: 1 }), "ring"))).toMatch(/fill="#94e2d5"[^>]*>2 DONE</);
		const scheduled = svg(summaryTile(counts({ scheduled: 1, nextAt: NOW + 17 * 60_000, loop: true }), "ring", { now: NOW }));
		expect(scheduled).toContain('fill="#cba6f7"');
		expect(scheduled).toContain(">17M</text>");
		expect(svg(summaryTile(counts({ working: 2 }), "ring"))).toContain(">ALL BUSY<");
		expect(svg(summaryTile(counts({ background: 1, working: 1 }), "ring"))).toContain(">ALL BUSY<");
		expect(svg(summaryTile(counts({}), "ring"))).toContain(">NO AGENTS<");
	});

	test("ring says ALL BUSY only when no agent is idle", () => {
		const one = svg(summaryTile(counts({ idle: 1 }), "ring"));
		expect(one).toContain(">1 IDLE<");
		expect(one).not.toContain("ALL BUSY");
		const mixed = svg(summaryTile(counts({ idle: 2, working: 3 }), "ring"));
		expect(mixed).toContain(">2 IDLE<");
		expect(mixed).not.toContain("ALL BUSY");
	});

	test("one state draws a whole circle", () => {
		const out = svg(summaryTile(counts({ working: 4 }), "ring"));
		expect(out).toContain('<circle cx="72" cy="62" r="40" fill="none" stroke="#f9e2af"');
	});

	test("list shows only states present, in priority order", () => {
		const out = svg(summaryTile(counts({ idle: 1, blocked: 2 }), "list"));
		expect(out).not.toContain("WORKING");
		expect(out.indexOf("BLOCKED")).toBeLessThan(out.indexOf("IDLE"));
		expect(svg(summaryTile(counts({}), "list"))).toContain(">NO AGENTS<");
	});

	test("without counts there are no numbers, only the footer", () => {
		const out = svg(summaryTile(null, "list", { dim: true, footer: "OFFLINE", footerRed: true }));
		expect(out).toContain('opacity="0.45"');
		expect(out).toMatch(/fill="#f38ba8"[^>]*>OFFLINE</);
		expect(out).not.toMatch(/>\d+<\/text>/);
	});
});

describe("controlTile", () => {
	test("shows caption, value and target", () => {
		const out = svg(controlTile({ caption: "command", value: "/review", footer: "> api-server", tone: "blue" }));
		expect(out).toContain(">COMMAND<");
		expect(out).toMatch(/fill="#89b4fa"[^>]*>\/review</);
		expect(out).toContain(">&gt; api-server<");
	});

	test("long values wrap at a space, or truncate", () => {
		const wrapped = svg(controlTile({ caption: "text", value: "please continue with the plan", footer: "", tone: "blue" }));
		expect(wrapped).toContain(">please<");
		const long = svg(controlTile({ caption: "text", value: "x".repeat(30), footer: "", tone: "blue" }));
		expect(long).toContain(`>${"x".repeat(12)}…<`);
	});

	test("dims the face but keeps the footer readable, and flashes the result", () => {
		const out = svg(controlTile({ caption: "keys", value: "esc", footer: "GONE", tone: "blue", dim: true }));
		expect(out).toMatch(/<g opacity="0.45">.*esc.*<\/g><text[^>]*>GONE</);
		expect(svg(controlTile({ caption: "keys", value: "esc", footer: "", tone: "blue", flash: { text: "SENT", ok: true } }))).toMatch(
			/fill="#a6e3a1"[^>]*>SENT</,
		);
		expect(svg(controlTile({ caption: "keys", value: "esc", footer: "", tone: "blue", flash: { text: "BLOCKED", ok: false } }))).toMatch(
			/fill="#f38ba8"[^>]*>BLOCKED</,
		);
	});
});

describe("every key image", () => {
	test("uses no emoji or symbol characters that hosts render differently", () => {
		const activity = { rsact_v: "1", rsact_state: "subagents", rsact_subagents: "2", rsact_background: "1", rsact_monitors: "1" };
		const images = [
			spaceTile(space({ tokens: activity }), { repo: "backend", branch: "main" }, { now: NOW }),
			spaceTile(space({ focused: true }), { repo: "backend", branch: "main" }, { footer: "FOCUSING…" }),
			summaryTile(counts({ blocked: 1, scheduled: 1, nextAt: NOW + 60_000 }), "ring", { now: NOW }),
			summaryTile(counts({ blocked: 1, done: 2 }), "list"),
			controlTile({ caption: "cycle", value: "opus", footer: "#2 webapp", tone: "blue" }),
			pagerTile(true, 1, 2, true, false),
			newSpaceTile(false),
			emptyTile(),
			connectingTile(),
			noSpacesTile(),
			offlineTile(),
			missingTile(),
		];
		for (const image of images) {
			for (const char of svg(image)) {
				expect(char.codePointAt(0)!).toBeLessThan(0x3000);
			}
		}
	});
});
