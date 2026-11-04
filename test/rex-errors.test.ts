import { describe, expect, test } from "vitest";

import { classifyRexError, RexApiError } from "../src/rex-errors";

/** Exit codes and stderr recorded from rex on API revision 10. */
describe("classifyRexError", () => {
	test.each<[string, number, string]>([
		["session_not_found", 3, 'Error: stream response "control-1" failed: session session:01a1 not found (status=404 code=session_not_found)'],
		["not_found", 3, 'Error: stream response "control-2" failed: block not found: block:01a1 (status=404 code=not_found)'],
		["not_found", 1, 'Error: stream response "control-2" failed: block not found: block:01a1 (status=404 code=not_found)'],
		["conflict", 1, 'Error: stream response "control-1" failed: stream is not attached to session session:01a1 (status=409 code=conflict)'],
		["internal", 1, "Error: posix_spawn /no/such/cmd: no such file or directory (status=500 code=internal)"],
		["client_unavailable", 1, 'Error: stream response "control-1" failed: "fake-mac" is waiting to reconnect (status=409 code=client_unavailable)'],
		["client_unavailable", 4, 'Error: "fake-mac" is waiting to reconnect'],
		["agent_blocked", 1, "Error: agent_blocked"],
		["agent_not_ready", 1, "Error: agent_not_ready"],
		["agent_not_ready", 1, "Error: -e:1: agent_not_ready"],
		["server_down", 4, "Error: no Rex server is running at /work/x.sock, and autostart is disabled"],
		["server_down", 4, "Error: server socket path /work/x is 176 bytes, longer than the 103 bytes this system allows for a Unix socket; set REX_RUNTIME_DIR to a shorter directory"],
		["server_down", 4, "Error: server went away: reading API control: reading control message: failed to get reader: failed to read frame header: EOF"],
		["server_down", 1, "Error: reading API control: reading control message: failed to get reader: failed to read frame header: EOF"],
		["timeout", 1, "Error: session.view request timed out after 400ms; increase --timeout: context deadline exceeded"],
		["timeout", 1, "Error: connecting to the server timed out after 2s; increase --timeout: context deadline exceeded"],
		["client_timeout", 1, 'Error: "fake-mac" did not answer within 2s; the action may still run. Requests to a busy client can wait longer than the timeout in total.'],
		["invalid_key", 2, 'Error: invalid key "foo": unknown key "foo"\n\nUsage:\n  rex send-key KEY... [flags]\n'],
		["invalid_key", 2, 'Error: invalid key "hyper+a": unknown key "hyper"'],
		["no_client", 3, 'Error: client target "client:01a1" not found'],
		["no_client", 3, "Error: client target default not found: no app client is connected"],
		["session_not_found", 3, 'Error: session target "session:01a1" not found'],
		["session_not_found", 3, 'Error: block target "block:01a1" not found: session scope: session "session:01a1" not found'],
		["not_found", 3, 'Error: block target "block:01a1" not found'],
		["not_found", 3, 'Error: block or window target "window:01a1" not found'],
		["unknown", 1, "Error: fake app refused"],
		["unknown", 3, "Error: session.attach: session session:01a1 not found"],
		["unknown", 2, 'Error: invalid argument "abc" for "--timeout" flag: time: invalid duration "abc"'],
	])("%s from exit %i: %s", (code, exit, stderr) => {
		expect(classifyRexError(exit, stderr)).toBe(code);
	});

	test("a code suffix wins over the exit code", () => {
		expect(classifyRexError(4, "Error: boom (status=403 code=refused)")).toBe("refused");
	});

	test("waiting to reconnect is tested before exit 4 reads as a dead server", () => {
		expect(classifyRexError(4, 'Error: "fake-mac" is waiting to reconnect')).not.toBe("server_down");
	});
});

describe("RexApiError", () => {
	test("carries its code", () => {
		const err = new RexApiError("agent_blocked", "agent is blocked");
		expect(err).toBeInstanceOf(Error);
		expect(err).toMatchObject({ name: "RexApiError", code: "agent_blocked", message: "agent is blocked" });
	});
});
