/**
 * A failed rex CLI call. Exit codes on API revision 10: 1 general and
 * timeouts, 2 usage and bad keys, 3 not found, 4 server down.
 */
export class RexApiError extends Error {
	public override readonly name = "RexApiError";

	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export function classifyRexError(exitCode: number | null | undefined, stderr: string): string {
	const api = /\(status=\d+ code=([a-z_]+)\)/.exec(stderr)?.[1];
	if (api) {
		return api;
	}
	// `rex do` exits 4 for a lost app client, which would read as a dead server.
	if (/is waiting to reconnect/.test(stderr)) {
		return "client_unavailable";
	}
	for (const code of ["agent_blocked", "agent_not_ready"]) {
		if (stderr.includes(code)) {
			return code;
		}
	}
	if (exitCode === 4 || /reading API control/.test(stderr)) {
		return "server_down";
	}
	if (/timed out after|context deadline exceeded/.test(stderr)) {
		return "timeout";
	}
	if (/did not answer within/.test(stderr)) {
		return "client_timeout";
	}
	if (/^Error: invalid key /m.test(stderr)) {
		return "invalid_key";
	}
	if (/^Error: client target /m.test(stderr)) {
		return "no_client";
	}
	if (/^Error: session target /m.test(stderr) || /session scope: session /.test(stderr)) {
		return "session_not_found";
	}
	if (/^Error: block( or window)? target /m.test(stderr)) {
		return "not_found";
	}
	return "unknown";
}
