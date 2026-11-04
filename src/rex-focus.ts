/**
 * Which Rex session the Mac app is showing, and whether the app is in front.
 * No API field reports either, so focus rests on two undocumented signals:
 * size_changed block events from the app's own client, and the private
 * Workspace.lastFocusedSession preference. See DESIGN.md.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REX_BUNDLE_ID = "com.superlogical.rex";

const DEFAULTS = "/usr/bin/defaults";
const LSAPPINFO = "/usr/bin/lsappinfo";
const PROBE_TIMEOUT_MS = 1000;
const PREFERENCE_MIN_GAP_MS = 1000;

export type RexClient = {
	client_id: string;
	connection_state?: string;
	info?: { kind?: string };
	principal?: { pid?: number; transport?: string };
};

/**
 * A lost entry stays listed for 60 s, ahead of a relaunched app, and selecting
 * it fails. A client on another transport is someone's phone: driving it would
 * switch their view, so there is deliberately no fallback to it.
 */
export function chooseAppClient(clients: readonly RexClient[]): RexClient | undefined {
	return clients
		.filter((client) => client.info?.kind === "app" && client.connection_state !== "lost" && client.principal?.transport === "unix")
		.at(-1);
}

const LAST_FOCUSED = /<key>Workspace\.lastFocusedSession<\/key>\s*<data>([\s\S]*?)<\/data>/;

export function parseLastFocusedSession(plistXml: string): string | null {
	const match = LAST_FOCUSED.exec(plistXml);
	if (!match) {
		return null;
	}
	try {
		const decoded = Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString("utf8");
		const id = (JSON.parse(decoded) as { sessionID?: unknown }).sessionID;
		return typeof id === "string" && id.startsWith("session:") ? id : null;
	} catch {
		return null;
	}
}

export async function readFocusPreference(): Promise<string | null> {
	const domain = process.env.REX_DECK_FOCUS_PREF_DOMAIN || REX_BUNDLE_ID;
	try {
		const { stdout } = await execFileAsync(DEFAULTS, ["export", domain, "-"], {
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
		});
		return parseLastFocusedSession(stdout);
	} catch {
		return null;
	}
}

export function parseFrontBundle(lsappinfoOutput: string): string | undefined {
	return /(?:bundleID|CFBundleIdentifier)"?\s*=\s*"([^"]+)"/.exec(lsappinfoOutput)?.[1];
}

export async function isRexFrontmost(): Promise<boolean> {
	const override = process.env.REX_DECK_FRONTMOST;
	if (override === "always" || override === "never") {
		return override === "always";
	}
	if (process.platform !== "darwin") {
		return true;
	}
	try {
		const { stdout: asn } = await execFileAsync(LSAPPINFO, ["front"], { timeout: PROBE_TIMEOUT_MS });
		const { stdout } = await execFileAsync(LSAPPINFO, ["info", "-only", "bundleid", asn.trim()], { timeout: PROBE_TIMEOUT_MS });
		return parseFrontBundle(stdout) === REX_BUNDLE_ID;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT";
	}
}

export type SizeChange = {
	session_id: string;
	owner?: string;
	principal?: { pid?: number };
};

/**
 * Holds the focused session. An event moves it only when the app itself
 * resized: a block returning to the app from another client fires size_changed
 * with the app as owner and no principal, for a session it may not be showing.
 */
export class FocusTracker {
	private clients: readonly RexClient[] = [];
	private focused: string | undefined;
	private held: SizeChange | undefined;
	private lastPreference: string | undefined;
	private preferenceReadAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly readPreference: () => Promise<string | null> = readFocusPreference,
		private readonly now: () => number = Date.now,
	) {}

	public get focusedSessionId(): string | undefined {
		return this.focused;
	}

	public async refreshPreference(): Promise<void> {
		const now = this.now();
		if (now - this.preferenceReadAt < PREFERENCE_MIN_GAP_MS) {
			return;
		}
		this.preferenceReadAt = now;
		const value = await this.readPreference();
		if (value !== null && value !== this.lastPreference) {
			this.lastPreference = value;
			this.moveTo(value);
		}
	}

	public sizeChanged(change: SizeChange): void {
		if (!change.principal || !change.owner) {
			return;
		}
		if (this.qualifies(change)) {
			this.moveTo(change.session_id);
		} else if (!this.clients.some((client) => client.client_id === change.owner)) {
			// A relaunched app can resize before a snapshot has listed it.
			this.held = change;
		}
	}

	/** The app clients from the latest snapshot; a held event gets its one retry. */
	public updateClients(clients: readonly RexClient[]): void {
		this.clients = clients;
		const held = this.held;
		this.held = undefined;
		if (held && this.qualifies(held)) {
			this.moveTo(held.session_id);
		}
	}

	private moveTo(sessionId: string): void {
		this.focused = sessionId;
		this.held = undefined;
	}

	private qualifies(change: SizeChange): boolean {
		const app = chooseAppClient(this.clients);
		return app !== undefined && app.client_id === change.owner && app.principal?.pid === change.principal?.pid;
	}
}
