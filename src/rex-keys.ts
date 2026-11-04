/**
 * Maps a token src/keys.ts accepts to what `rex send-key` needs. Rex takes US
 * key names, so typed capitals and shifted symbols become shift+<base>.
 * `meta` means cmd in Rex and delivers nothing for letters; the deck's meta is
 * alt. ctrl+i, ctrl+m and ctrl+[ exit 0 and deliver nothing, so they use the
 * keys with the same bytes.
 */
const SHIFTED: Record<string, string> = {
	"!": "1",
	"@": "2",
	"#": "3",
	$: "4",
	"%": "5",
	"^": "6",
	"&": "7",
	"*": "8",
	"(": "9",
	")": "0",
	_: "-",
	"+": "=",
	"{": "[",
	"}": "]",
	"|": "\\",
	":": ";",
	'"': "'",
	"<": ",",
	">": ".",
	"?": "/",
	"~": "`",
};
const BASE_ALIASES: Record<string, string> = { escape: "esc", return: "enter" };
const MODIFIER_ALIASES: Record<string, string> = { control: "ctrl", option: "alt", meta: "alt" };
const C0_ALIASES: Record<string, string> = { "ctrl+i": "tab", "ctrl+m": "enter", "ctrl+[": "esc" };

const PRINTABLE_ASCII = /^[\x21-\x7e]$/;

function normaliseSingle(char: string): string | undefined {
	if (/^[A-Z]$/.test(char)) {
		return `shift+${char.toLowerCase()}`;
	}
	if (SHIFTED[char] !== undefined) {
		return `shift+${SHIFTED[char]}`;
	}
	return PRINTABLE_ASCII.test(char) ? char : undefined;
}

/** The Rex key name, or undefined when `rex send-key` cannot deliver the token. */
export function toRexKey(token: string): string | undefined {
	if ([...token].length === 1) {
		return normaliseSingle(token);
	}
	const parts = token.toLowerCase().split("+");
	const base = parts.pop() ?? "";
	const modifiers = parts.map((modifier) => MODIFIER_ALIASES[modifier] ?? modifier);
	if ([...base].length === 1 && !PRINTABLE_ASCII.test(base)) {
		return undefined;
	}
	if (SHIFTED[base] !== undefined) {
		// Only plain shift keeps the character: alt+shift+1 sends ESC 1, ctrl+shift+1 nothing.
		return modifiers.length === 1 && modifiers[0] === "shift" ? `shift+${SHIFTED[base]}` : undefined;
	}
	const name = [...modifiers, BASE_ALIASES[base] ?? base].join("+");
	return C0_ALIASES[name] ?? name;
}
