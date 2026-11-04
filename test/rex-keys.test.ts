import { describe, expect, test } from "vitest";

import { toRexKey } from "../src/rex-keys";

describe("toRexKey", () => {
	test.each([
		["esc", "esc"],
		["escape", "esc"],
		["enter", "enter"],
		["return", "enter"],
		["tab", "tab"],
		["space", "space"],
		["backspace", "backspace"],
		["up", "up"],
		["f12", "f12"],
		["a", "a"],
		["1", "1"],
		["/", "/"],
		["-", "-"],
		["A", "shift+a"],
		["Z", "shift+z"],
		["!", "shift+1"],
		["@", "shift+2"],
		["#", "shift+3"],
		["$", "shift+4"],
		["%", "shift+5"],
		["^", "shift+6"],
		["&", "shift+7"],
		["*", "shift+8"],
		["(", "shift+9"],
		[")", "shift+0"],
		["_", "shift+-"],
		["+", "shift+="],
		["{", "shift+["],
		["}", "shift+]"],
		["|", "shift+\\"],
		[":", "shift+;"],
		['"', "shift+'"],
		["<", "shift+,"],
		[">", "shift+."],
		["?", "shift+/"],
		["~", "shift+`"],
		["ctrl+c", "ctrl+c"],
		["control+d", "ctrl+d"],
		["CTRL+C", "ctrl+c"],
		["option+b", "alt+b"],
		["alt+enter", "alt+enter"],
		["alt+return", "alt+enter"],
		["meta+x", "alt+x"],
		["meta+return", "alt+enter"],
		["ctrl+escape", "ctrl+esc"],
		["shift+tab", "shift+tab"],
		["shift+a", "shift+a"],
		["shift+!", "shift+1"],
		["shift+?", "shift+/"],
		["ctrl+i", "tab"],
		["ctrl+m", "enter"],
		["ctrl+[", "esc"],
		["control+i", "tab"],
		["ctrl+-", "ctrl+-"],
		["ctrl+`", "ctrl+`"],
	])("%s becomes %s", (token, rex) => {
		expect(toRexKey(token)).toBe(rex);
	});

	test.each(["é", "ñ", "日", "🦖", "ctrl+é", "alt+日", "ctrl+!", "alt+!", "meta+?", "ctrl+shift+!"])(
		"%s cannot be delivered",
		(token) => {
			expect(toRexKey(token)).toBeUndefined();
		},
	);
});
