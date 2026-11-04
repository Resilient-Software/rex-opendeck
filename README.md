# Rex Deck

Mirror your [Rex](https://www.superlogical.com/rex/docs) sessions onto a Stream
Deck and drive your coding agents from it.
TypeScript on the official [Stream Deck SDK](https://docs.elgato.com/streamdeck/sdk);
runs in both the Elgato Stream Deck app and
[OpenDeck](https://github.com/nekename/OpenDeck).

Free to use. Apache-2.0. Not an official Rex or Elgato product.

## How it works

**Live tiles.** Keys become live tiles for Rex sessions: label, repository,
branch, and a background colour carrying state (green focused, yellow working,
red blocked). Pressing a tile shows that session in the Rex app and raises the
app. When there are more sessions than keys, the last two keys become `←`/`→`
pagers. Updates stream from a long-lived `rex events` child, so state changes
land in well under a second; when the stream is down the plugin falls back to
polling the CLI at 1 Hz.

**Idle isn't always done.** Agents often go quiet while subagents, background
shells or a scheduled loop keep running. Claude Code reports its own subagents,
so the deck shows those as is: a blue tile with an icon and a count. With the
optional [rex-agent-activity](https://github.com/Resilient-Software/rex-agent-activity)
companion installed, the deck also counts background shells and monitors, and
shows a dark mauve tile with a loop or clock icon and a countdown such as `17M`
for a scheduled check. A plain tile really means finished. The Agent Summary
key counts every state on one key, and a press jumps to the session that needs
you most, blocked first.

**Done means not yet seen.** Rex keeps an agent's `done` until its next turn.
The deck clears it for you: a tile reads `DONE` until you have looked at that
pane with Rex in front, then `IDLE`, or `UNKNOWN` if the agent has since gone.

**Drive agents.** Control keys send a slash command, a phrase, key presses or
the next value of a cycle to the agent you are focused on, or to a session you
pin the key to, and show that target on the key (`> api-server`, `#2 webapp`).
They check first and do not type into an agent that reports it is waiting at a
permission prompt; Send Keys still goes through, so its default `esc` can
interrupt or dismiss.

See [DESIGN.md](DESIGN.md) for the full UX.

## Actions

| Action | What it does | Settings |
|---|---|---|
| Rex Session | One live session tile per key; press to focus it | none |
| New Rex Session | Creates a session and focuses it | none |
| Agent Summary | Counts sessions by state, as a ring or a list; press focuses the one that needs you most | look |
| Slash Command | Sends a command such as `/review`, then Enter | command, target |
| Send Text | Types a phrase, then Enter unless turned off | text, press Enter, target |
| Send Keys | Sends key presses; `esc` by default | keys, target |
| Cycle | Steps through values: `/model opus`, then `sonnet`, then `haiku` | command, values, target |
| New Tab | Opens a tab in the target pane's folder, or a folder you choose | folder, target |

The target is the focused agent unless you pin the key to a session.

Two things to know when sending to Claude Code:

- A deck prompt is pasted after whatever is already in the input box, so a
  prompt Claude restored after you interrupted it merges with the one the key
  sends.
- Send Keys forwards what you configure, including `left`. On an empty Claude
  prompt, `left` opens its agents view and moves the conversation to a hidden
  pty, after which the pane shows no status at all.

## Install

Build from source:

```sh
sh scripts/install.sh
```

builds the bundle and installs it into OpenDeck's plugins directory,
recording the `rex` CLI path for the plugin to use. For the official
Elgato Stream Deck app, use `sh scripts/install-elgato.sh` instead — the
same bundle works in both hosts. `sh scripts/pack.sh` produces a
`.streamDeckPlugin` installer under `dist/`; tagged releases publish one.

Restart OpenDeck, then place the "Rex Session" action on the keys you
want to participate — keys without one of the plugin's actions are never
touched, which is how you reserve keys for other uses. With OpenDeck quit,
`python3 scripts/fill-profile.py` places the action on every empty key of a
profile in one go.

Sessions fill the participating keys in stable slots with live state
backgrounds. When there are more sessions than keys, the last two keys become
`←`/`→` pagers with the page count below the arrows. Agent Summary and the
control keys can go anywhere, including between session keys; the sessions skip
them. Configure a control key in its property inspector.

## Requirements

- Rex with the Mac app. Tested against Rex API revision 10. Knowing which
  session the app is showing rests on undocumented behaviour (see Focus in
  [DESIGN.md](DESIGN.md)), so a Rex update can break the green tile while
  everything else keeps working. The plugin finds the `rex` CLI via `REX_PATH`,
  the recorded install path or the official install locations
- Elgato Stream Deck 7.1+, or OpenDeck 2.14+ with Node.js 24+ installed
- macOS. The Elgato app also runs on Windows, but the plugin has not been tested there
- Node.js 24+ and npm to build

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test
npm run build && npm run e2e
```

`npm test` drives the bridge with a stub `rex` and never reaches a real server.
CI runs lint, typecheck, unit tests and the build.

`npm run e2e` runs locally because it needs a Rex binary. It runs the built
plugin against a fake Stream Deck host, a throwaway sandbox Rex server and a
fake Mac app client, never your own sessions, presses keys the way a user would
and checks what reaches the sandbox's panes, byte for byte. It compiles a small
stand-in agent with `cc`, and refuses to start unless the plugin's `REX_SERVER`
names the run's own temp socket. It takes about three minutes.

- `REX_BIN` picks the rex binary (default: `rex` on `PATH`).
- `E2E_ACTIVITY=0` runs it without any `rsact/*` records, as the deck looks when
  the companion is not installed.
- `E2E_TMP` is where the temp root goes (default `/tmp`). The socket path must
  fit in 103 bytes.
- `E2E_OUT` moves the artifacts. A run clears that folder first, so it refuses
  one that is not empty unless an earlier run made it.
- `E2E_SKIP` skips phases by name; `E2E_NODE` and `E2E_PLUGIN` pick the plugin's
  Node and the bundle to test.

Key images, boards (PNG via `rsvg-convert`), the frames both ways, the sandbox's
event stream and `summary.json` land in `e2e-out/`.

`sh scripts/render-sheet.sh` renders every key image variant into contact
sheets at real key size under `dist/sheet/`.

## Layout

- `src/plugin.ts` — entry point; registers the actions and connects
- `src/controller.ts` — snapshot loop and key coordination: slots, paging,
  the summary, control key presses, repaints
- `src/controls.ts` — control key faces and what a press sends
- `src/actions.ts` — the action classes
- `src/state.ts` — session states, summary counts, attention order and
  target resolution
- `src/keys.ts` — Send Keys parsing and Cycle values
- `src/rex.ts` — the bridge: snapshot, focus, create, send and new tab through
  the CLI, git context, raising the app
- `src/snapshot-lua.ts` — the Lua scripts the bridge runs with `rex do`
- `src/rex-snapshot.ts` — maps script output to the deck's model: pane status,
  agents, activity tokens, rollup, what you have seen
- `src/rex-focus.ts` — which session is in view, and the app client to drive
- `src/rex-events.ts` — the `rex events` child and its filter
- `src/rex-errors.ts` — classifies CLI failures
- `src/rex-keys.ts` — maps key names to what `rex send-key` takes
- `src/rex-binary.ts` — finds the `rex` binary
- `src/schedule.ts` — poll cadence and event coalescing
- `src/layout.ts` — pure key-assignment and paging logic
- `src/activity.ts` — activity tokens
- `src/render.ts` — SVG rendering: session tiles, summary, control keys
- `src/glyphs.ts` — activity icons
- `plugin/` — `.sdPlugin` bundle assets (manifest, icons, property
  inspectors)
- `scripts/e2e/` — end-to-end harness
- `test/` — vitest suites

## License

Apache-2.0. See [LICENSE](LICENSE). The built plugin carries this licence and the
licences of the packages it bundles, in `bin/LICENSE.txt` and
`bin/THIRD_PARTY_NOTICES.txt`.
