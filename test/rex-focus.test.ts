import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";

import { chooseAppClient, FocusTracker, isRexFrontmost, parseFrontBundle, parseLastFocusedSession, readFocusPreference, type RexClient } from "../src/rex-focus";

function client(id: string, overrides: Partial<RexClient> = {}): RexClient {
	return {
		client_id: id,
		connection_state: "connected",
		info: { kind: "app" },
		principal: { pid: 100, transport: "unix" },
		...overrides,
	};
}

describe("chooseAppClient", () => {
	test("no clients, no choice", () => {
		expect(chooseAppClient([])).toBeUndefined();
	});

	test("a lost entry is listed ahead of a relaunched app and never chosen", () => {
		expect(chooseAppClient([client("old", { connection_state: "lost" }), client("new")])?.client_id).toBe("new");
		expect(chooseAppClient([client("old", { connection_state: "lost" })])).toBeUndefined();
	});

	test("a client on another transport is someone's phone: no fallback to it", () => {
		const phone = client("phone", { principal: { pid: 7, transport: "tcp" } });
		expect(chooseAppClient([client("mac"), phone])?.client_id).toBe("mac");
		expect(chooseAppClient([phone])).toBeUndefined();
	});

	test("the entry with the app's pid and no info is a ghost", () => {
		expect(chooseAppClient([client("ghost", { info: undefined })])).toBeUndefined();
		expect(chooseAppClient([client("mac"), client("ghost", { info: undefined })])?.client_id).toBe("mac");
	});

	test("a CLI client does not qualify", () => {
		expect(chooseAppClient([client("cli", { info: { kind: "cli" } })])).toBeUndefined();
	});

	test("takes the last qualifying entry", () => {
		expect(chooseAppClient([client("a"), client("b")])?.client_id).toBe("b");
	});

	test("a real listing: a crashed app, then its relaunch", () => {
		const { clients } = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8")) as { clients: RexClient[] };
		expect(clients.map((c) => c.connection_state)).toEqual(["lost", "connected"]);
		expect(chooseAppClient(clients)).toBe(clients[1]);
	});
});

const APP = client("app", { principal: { pid: 200, transport: "unix" } });
const ownResize = (session_id: string, owner = "app", pid = 200) => ({ session_id, owner, principal: { pid } });

function tracker(preference: (string | null)[] = [null], clock = { now: 0 }) {
	let reads = 0;
	const focus = new FocusTracker(
		async () => {
			reads++;
			return preference[Math.min(reads - 1, preference.length - 1)];
		},
		() => clock.now,
	);
	return { focus, clock, reads: () => reads };
}

describe("FocusTracker events", () => {
	test("the app's own resize moves focus", () => {
		const { focus } = tracker();
		focus.updateClients([APP]);
		focus.sizeChanged(ownResize("session:a"));
		expect(focus.focusedSessionId).toBe("session:a");
	});

	test("no principal never moves focus: a block handed back by another client", () => {
		const { focus } = tracker();
		focus.updateClients([APP]);
		focus.sizeChanged(ownResize("session:a"));
		focus.sizeChanged({ session_id: "session:b", owner: "app" });
		expect(focus.focusedSessionId).toBe("session:a");
	});

	test("a principal with another pid does not move focus and is not held", () => {
		const { focus } = tracker();
		focus.updateClients([APP]);
		focus.sizeChanged(ownResize("session:a", "app", 999));
		expect(focus.focusedSessionId).toBeUndefined();
		focus.updateClients([APP]);
		expect(focus.focusedSessionId).toBeUndefined();
	});

	test("a listed client that is not the chosen one does not move focus", () => {
		const { focus } = tracker();
		const lost = client("lost", { connection_state: "lost", principal: { pid: 200, transport: "unix" } });
		focus.updateClients([lost, APP]);
		focus.sizeChanged(ownResize("session:a", "lost"));
		expect(focus.focusedSessionId).toBeUndefined();
		focus.updateClients([lost, APP]);
		expect(focus.focusedSessionId).toBeUndefined();
	});

	test("an unlisted owner is held for one snapshot, applied if it then qualifies", () => {
		const { focus } = tracker();
		focus.updateClients([]);
		focus.sizeChanged(ownResize("session:a"));
		expect(focus.focusedSessionId).toBeUndefined();
		focus.updateClients([APP]);
		expect(focus.focusedSessionId).toBe("session:a");
	});

	test("a held event gets one try", () => {
		const { focus } = tracker();
		focus.updateClients([]);
		focus.sizeChanged(ownResize("session:a"));
		focus.updateClients([]);
		focus.updateClients([APP]);
		expect(focus.focusedSessionId).toBeUndefined();
	});

	test("a held event from a CLI's resize never qualifies", () => {
		const { focus } = tracker();
		focus.updateClients([APP]);
		focus.sizeChanged(ownResize("session:a", "cli", 300));
		focus.updateClients([APP]);
		expect(focus.focusedSessionId).toBeUndefined();
	});

	test("a later move drops a held event", () => {
		const { focus } = tracker();
		focus.updateClients([APP]);
		focus.sizeChanged(ownResize("session:old", "relaunched", 300));
		focus.sizeChanged(ownResize("session:new"));
		focus.updateClients([APP, client("relaunched", { principal: { pid: 300, transport: "unix" } })]);
		expect(focus.focusedSessionId).toBe("session:new");
	});

	test("an event with no owner is ignored", () => {
		const { focus } = tracker();
		focus.updateClients([APP]);
		focus.sizeChanged({ session_id: "session:a", principal: { pid: 200 } });
		expect(focus.focusedSessionId).toBeUndefined();
	});
});

describe("FocusTracker preference", () => {
	test("seeds focus at startup", async () => {
		const { focus } = tracker(["session:seed"]);
		await focus.refreshPreference();
		expect(focus.focusedSessionId).toBe("session:seed");
	});

	test("is read at most once per second", async () => {
		const { focus, clock, reads } = tracker(["session:a"]);
		await focus.refreshPreference();
		clock.now = 999;
		await focus.refreshPreference();
		expect(reads()).toBe(1);
		clock.now = 1000;
		await focus.refreshPreference();
		expect(reads()).toBe(2);
	});

	test("overwrites focus when its value differs from the previous read", async () => {
		const { focus, clock } = tracker(["session:a", "session:b"]);
		await focus.refreshPreference();
		clock.now = 1000;
		await focus.refreshPreference();
		expect(focus.focusedSessionId).toBe("session:b");
	});

	test("an unchanged value leaves a focus an event moved", async () => {
		const { focus, clock } = tracker(["session:a"]);
		focus.updateClients([APP]);
		await focus.refreshPreference();
		focus.sizeChanged(ownResize("session:b"));
		clock.now = 1000;
		await focus.refreshPreference();
		expect(focus.focusedSessionId).toBe("session:b");
	});

	test("a missing value keeps focus, and its return is not a change", async () => {
		const { focus, clock } = tracker(["session:a", null, "session:a"]);
		focus.updateClients([APP]);
		await focus.refreshPreference();
		focus.sizeChanged(ownResize("session:b"));
		clock.now = 1000;
		await focus.refreshPreference();
		expect(focus.focusedSessionId).toBe("session:b");
		clock.now = 2000;
		await focus.refreshPreference();
		expect(focus.focusedSessionId).toBe("session:b");
	});
});

describe("parseLastFocusedSession", () => {
	const data = (value: string) => Buffer.from(value).toString("base64");

	test.each<[string, string, string | null]>([
		["no key", "<plist><dict/></plist>", null],
		["not base64 json", "<key>Workspace.lastFocusedSession</key><data>AAAA</data>", null],
		["wrong shape", `<key>Workspace.lastFocusedSession</key><data>${data('{"x":1}')}</data>`, null],
		["not a session id", `<key>Workspace.lastFocusedSession</key><data>${data('{"sessionID":"block:1"}')}</data>`, null],
		["plain", `<key>Workspace.lastFocusedSession</key><data>${data('{"sessionID":"session:abc"}')}</data>`, "session:abc"],
		[
			"wrapped base64",
			`<key>Workspace.lastFocusedSession</key>\n\t<data>\n\t${data('{"sessionID":"session:abc"}').replace(/(.{8})/, "$1\n\t")}\n\t</data>`,
			"session:abc",
		],
	])("%s", (_name, xml, expected) => {
		expect(parseLastFocusedSession(xml)).toBe(expected);
	});
});

describe("parseFrontBundle", () => {
	test("lsappinfo's multi-line report", () => {
		const report = '[ NULL ]  ASN:0x0-0x88088: (in front) \n    bundleID="com.superlogical.rex"\n    bundle path=[ NULL ] \n';
		expect(parseFrontBundle(report)).toBe("com.superlogical.rex");
	});

	test("its one-line form", () => {
		expect(parseFrontBundle('"CFBundleIdentifier"="com.superlogical.rex"\n')).toBe("com.superlogical.rex");
	});

	test("nothing in front", () => {
		expect(parseFrontBundle("")).toBeUndefined();
	});
});

describe("environment overrides", () => {
	const saved = process.env.REX_DECK_FRONTMOST;

	afterEach(() => {
		process.env.REX_DECK_FRONTMOST = saved;
	});

	test("REX_DECK_FRONTMOST decides without asking the system", async () => {
		process.env.REX_DECK_FRONTMOST = "always";
		await expect(isRexFrontmost()).resolves.toBe(true);
		process.env.REX_DECK_FRONTMOST = "never";
		await expect(isRexFrontmost()).resolves.toBe(false);
	});

	test("an unused preference domain reads as no value", async () => {
		await expect(readFocusPreference()).resolves.toBeNull();
	});
});
