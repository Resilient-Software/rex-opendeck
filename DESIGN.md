# Rex Deck UX

## Product stance

Build a live physical index of Rex first, and a small set of agent controls second.

- **The sessions grid is the default and needs no setup.** Placing the Rex Session action on keys is the whole configuration: every such key becomes a live session tile. Each session's rolled-up status carries the attention signal.
- **Control keys are opt-in and take per-key settings.** Agent Summary, Slash Command, Send Text, Send Keys, Cycle and New Tab are separate actions the user places deliberately and configures in the property inspector. Each does one thing, and a control key always shows on its face where a press will go.
- No modes and no hidden alternate actions: a key does the same thing on every press, and a long press is the same as a press.

**Naming.** User-facing text says session, tab and pane. The code keeps its internal model names: `Workspace = Rex session, Tab = Rex window, Pane = Rex block`.

## Physical map

Stream Deck MK.2 coordinates are zero-based. Slot numbers are row-major.

**Keys are opted in by placing an action on them.** Any key without one of this plugin's actions is never rendered to, bound, or handled — the user reserves keys (for example an fn key mapping at top-right) simply by leaving the action off them. Placement is the configuration; the plugin has no hardcoded reserved slots.

Example placement on an MK.2 with the top-right key reserved:

|      | Col 0 | Col 1 | Col 2 | Col 3 | Col 4 |
|------|-------|-------|-------|-------|-------|
| Row 0 | Session | Session | Session | Session | *(no action — user's fn key)* |
| Row 1 | Session | Session | Session | Session | Session |
| Row 2 | Session | Session | Session | Session or pager ← | Session or pager → |

- Sessions fill the Rex Session keys row-major, in Rex's own session order, then by ID; keep surviving session IDs in their existing slots between polls so keys do not shuffle unnecessarily.
- Agent Summary, control keys and New Rex Session may sit anywhere, including between session keys. They are not slots: the grid skips them and fills the next Rex Session key.
- **The pager is dynamic and takes two keys.** While sessions fit the participating keys there is no pager: every key is a session tile and unused keys show an inert dot. With more sessions than keys, the last two keys become `←` and `→` pagers and the remaining keys page through the sessions.
- An external focus change reveals the page containing the newly focused session.
- None of the actions are available inside multi-actions.

## Key image language

Author each key at `144 × 144`, system sans text, flat geometry, no gradients, shadows, or decorative animation. Pictograms are inline SVG paths, never emoji, so they take the footer colour and look the same in the Elgato app and OpenDeck.

**The whole tile background carries state.** No rings: the key lights up as a solid field of colour behind the text.

### Tile anatomy

- **Background:** state colour (see below). This is the primary signal, readable across a room.
- **Corner:** the session's position in Rex's list, from 1.
- **Centre:** the session's label as Rex presents it, else `Session N`. One line, ellipsized.
- **Text budget — where it operates:** below the name, the repository directory name and `⎇ branch`, derived from the folder of the session's active pane. Rex has no worktree metadata, so the active pane wins over the first pane. Omit lines that do not apply rather than shrinking type.
- **Footer:** one of
  - a literal lifecycle word (`IDLE`, `DONE`, `ERROR`) when the background is plain, so state is never colour-only;
  - an activity row of pictograms and counts when the session has agent activity (below);
  - `FOCUSING…` or `FAILED · TRY AGAIN` after a press (see interactions).

### Status language

| State | Background | Text |
|-------|------------|------|
| focused / selected | green `#A6E3A1` | dark `#1E1E2E` |
| `working` | yellow `#F9E2AF` | dark `#1E1E2E` |
| `blocked` (needs input) | red `#F38BA8` | dark `#1E1E2E` |
| idle, but subagents or background tasks still running (activity) | blue `#89B4FA` | dark `#1E1E2E`; footer shows a pictogram and count per kind of work |
| `idle` / `done` / `unknown` — neither working nor focused | plain `#1E1E2E` | light `#CDD6F4`, footer carries the word |
| idle, only a scheduled check pending (activity) | near-black mauve `#362A52` | light `#CDD6F4`; footer shows the loop or clock pictogram and a countdown in mauve `#CBA6F7` (`17M`) |

Precedence: focused > blocked > working > background activity > scheduled check > plain. Use `#A6ADC8` for metadata text on plain tiles.

### Pane status

Rex's program status protocol reports one root record per terminal and any number of child records. A block method gives the records and another the foreground process; the deck derives each pane's status from both.

- A **foreground** is a shell when it is absent, or when the basename of its `argv0` (or `name` if there is no `argv0`), with any leading `-` stripped, is one of `sh bash zsh fish dash ksh tcsh login`.
- `rsact/*` records never feed status.
- A shell-named foreground is **at its prompt** unless it owns a non-`rsact` record and is neither a login shell (`argv0` with a leading `-`) nor the pane's first process (the `child` of the block method `process`). Rex names the process group leader as the foreground and credits every report to it, so an agent behind a script that does not exec shows the script's shell, which owns the agent's records. A login shell or a first process owns a record only by printing one at its own prompt.
- At a prompt, a root `done` or `error` keeps meaning done, and every other record is ignored and the pane reads `unknown`: records can outlive the program that wrote them.
- Otherwise, records whose `owner.pid` is not the foreground's are leftovers and do not count: Rex credits a report to whichever process is in front at the time and keeps that pid after it dies. Ownerless records could be anyone's and do count. Then any record `blocked` means blocked, with or without a `kind`; else the root's state; else the most urgent child; else `unknown`. `error` maps to `done`, and the footer word says `ERROR` when the winning pane's root errored.
- A leftover root that finished keeps meaning done under any program that is not an agent, the same as at a prompt. A new agent starts clean, so its tile reads `unknown` until its own first report, whatever its predecessor left.
- **An agent is present** when the foreground is not at a prompt and its `argv0` basename is a known agent (`claude`, `codex`, `opencode`, `gemini`, `aider`, `amp`, `cursor-agent`, `goose`), or a non-`rsact` record's `owner.pid` is the foreground's pid. A wrapper can show `argv0` as `node`, `python` or a shell and then needs such a record to count. Two wrappers read as a plain shell: one that has not reported yet, and one run as the pane's first process, which nothing separates from a shell. The sending checks below still refuse text to the second while its own record is blocked.
- A session rolls up as blocked > done > working > idle > unknown across its terminal panes. Blocks that are not terminals are not panes and are not counted.

### Done means not yet seen

Rex keeps `done` until the next prompt, whether or not anyone looked, so the deck keeps its own memory. A root `done` or `error` in the active window of the focused session is marked seen while the Rex app is frontmost; a pane whose root `updated_at` equals its seen value reads `idle`, or `unknown` when no agent is in front, so a session whose agent has gone leaves the summary once you have looked at it. The memory is per block, in process, and dropped with the block, so after a plugin restart panes read `DONE` until viewed. The system is asked what is in front only when there is something to mark.

### Agent activity (optional)

Activity comes from child records and only ever *refines* the state above. Claude Code reports each running subagent as a child record of its own. The optional [rex-agent-activity](https://github.com/Resilient-Software/rex-agent-activity) companion adds `rsact/*` child records from agent hooks, under its [record contract](https://github.com/Resilient-Software/rex-agent-activity/blob/main/CONTRACT.md):

| Record id | State | Meaning |
|---|---|---|
| `rsact/sub/<id>` | working | A subagent still running, when the agent does not report its own child record |
| `rsact/bg/<id>` | working | A background shell |
| `rsact/mon/<id>` | working | A monitor |
| `rsact/next/<epoch seconds>` or `rsact/next/<epoch seconds>.loop` | idle | Next scheduled wake-up; `.loop` when it recurs |

A child record counts as a native subagent when its id has no `rsact/` prefix, its state is `working` or `blocked`, and its `app` (else `effective_app`) is `claude-code`. Native records and `rsact/sub/*` union by last id segment, so one subagent reported both ways counts once. The bridge sums these per pane and per session into tokens the tiles read.

- It never overrides focused, blocked or working; on those tiles the activity appears in the footer only.
- An idle session whose agents still have subagents or background tasks running is not finished, so it gets its own blue field.
- An idle session whose only activity is a scheduled check is waiting on a timer, not finished, so it gets a near-black mauve field with a mauve countdown footer; the countdown is computed locally and repainted every 15 s. A next time in the past reads `NOW`, and one past what a date can hold counts for nothing: any bytes reaching a terminal can set a record.
- **Fail open:** without child records, or with unknown ids, including an `rsact/` kind not in the table above, tiles render exactly as described above. `rsact/*` records on a pane with no agent are SIGKILL leftovers and are ignored, as are those whose `owner.pid` is not the foreground's, so a new agent never shows a dead session's schedule. The companion's hooks report while the agent is in front, so its own records pass.

The activity footer is a row of pictograms, each followed by its count:

| Pictogram | Glyph | Shows |
|-----------|-------|-------|
| robot head | `subagents` | subagents running |
| terminal window with a prompt | `shell` | background shells |
| eye | `monitor` | monitors |
| clockwise circular arrow | `loop` | time until a recurring scheduled check |
| clock face | `clock` | time until a one-shot scheduled check |

- **Counts first:** subagents, then shells, then monitors, at most three items. Each item is a 20-unit pictogram, a 2-unit gap and the count in 18 px bold; items sit 9 units apart, centred on the key, with the band centred at y = 124. Trailing items are dropped if the row would exceed 132 units.
- **Countdown only when there are no counts:** the `loop` glyph for a recurring check, otherwise `clock`, followed by the time left: `45S`, `17M`, `2H`, `NOW`.
- **Colour:** dark `#1E1E2E` on the light fields (green, yellow, red, blue), mauve `#CBA6F7` on the mauve field.
- Lifecycle words, `FOCUSING…` and `FAILED · TRY AGAIN` stay 13 px text.

Working is a static yellow field; any motion experiment comes later and must not reduce legibility.

### Pager keys (dynamic)

Pagers exist only while sessions exceed the participating keys. They are controls, not data tiles:

- Two keys: a large `←` and a large `→` arrow, each with the `<current>/<total>` page indicator below.
- Press moves one page in that direction; no wrap and no auto-repeat.
- If the focused session is off the visible page, the arrow pointing toward it is accented.
- When the session count fits the keys again, both pager keys return to being session tiles.

## Agent Summary

One key that counts sessions by state, so the sum answers "how many are really finished?".

Each session is counted once, in the first state that applies: blocked, working, busy in the background (activity other than a lone scheduled check), scheduled, done, idle. A session that reads `unknown` with no pane running an agent is not counted. The summary has no focused colour; it counts agent state only.

| State | Colour | List word |
|-------|--------|-----------|
| blocked | red `#F38BA8` | `BLOCKED` |
| working | yellow `#F9E2AF` | `WORKING` |
| background activity | blue `#89B4FA` | `BUSY` |
| scheduled check | mauve `#CBA6F7` | `TIMER` |
| done | teal `#94E2D5` | `DONE` |
| idle | overlay `#6C7086` | `IDLE` |

States always appear in that order. The key has two looks, chosen in the property inspector:

- **Ring** (default): a donut of proportional segments on the plain background (a grey ring when nothing is counted), with the total in the centre. The footer names what matters most: `2 BLOCKED` in red; else `1 DONE` in teal; else, with a scheduled check pending, the loop or clock pictogram and the soonest countdown; else `1 IDLE` if any agent is idle; else `ALL BUSY`; with nothing counted, `NO AGENTS`.
- **List:** one row per non-zero state — a colour swatch, the count and the state word. With nothing counted the key shows `NO AGENTS`.

**Press** focuses the session that needs you most and raises the Rex app, exactly like a session tile, with `FOCUSING…` and `FAILED · TRY AGAIN` in the summary's footer. The order is blocked, then done, then idle, each by session number, skipping the session that is already focused. With nothing waiting, the footer flashes `ALL CLEAR`.

## Control keys

Five actions act on a target through Rex. Each one shows a small uppercase caption at the top left, a large value in the centre, and in the footer where a press will go (New Tab shows the folder it will open):

| Action | Settings | Press sends | Face |
|--------|----------|-------------|------|
| Slash Command | command, e.g. `/review` | the command, then Enter | `COMMAND`, `/review` |
| Send Text | text; "press Enter" (on by default) | the text, then Enter unless turned off | `TEXT`, first line of the text |
| Send Keys | keys, default `esc` | the key presses | `KEYS`, the keys separated by spaces |
| Cycle | command, e.g. `/model`; values, e.g. `opus, sonnet, haiku` | `<command> <next value>`, then Enter | the command (or `CYCLE`), the value the next press sends |
| New Tab | folder (empty means the target pane's folder) | opens a tab in the target session | `NEW TAB`, a green `+`; footer is the folder's name |

The value is blue (green for New Tab), sized to fit and truncated with `…` when long. A Slash Command with no command shows `—` and `NOT SET`.

### Targeting

Every control key has a target setting: **Focused agent** (the default) or a **pinned session** picked from a list of the current sessions.

- **Focused agent:** the focused session and its focused pane. If that pane runs no agent but exactly one other pane in the session does, the key targets that agent instead. Footer: `> api-server`.
- **Pinned session:** the focused pane of the session's active tab, else its first pane, with the same agent rule. Footer: `#2 webapp`.
- A pinned key stores the session's ID and its name. While the plugin watches that ID without a gap in the connection, the pin follows it and keeps the saved name current. After a gap (Rex may have restarted) the pin holds only if the ID still belongs to a session with that name. If the ID is gone or now names a different session, but exactly one session has the pinned name as its label, the key re-pins to it and saves the new ID; names derived from a session's number never re-pin, and duplicate labels, which Rex allows, count as no match. Otherwise the key shows `GONE`, dims, and a press does nothing. A pin saved without a name matches by ID alone.
- With no focused session the footer shows `NO AGENT`, the key dims, and a press does nothing.

The footer always shows where a press will go before it is pressed. The exception is the moment after a session tile or the summary asked for focus: the footer still names the old session until the app confirms, so a press of an unpinned key made during that `FOCUSING…` waits for it, then goes to the session that arrived. If the focus fails, or has not arrived after 5 s, it sends nothing and flashes `FAILED`. Pinned keys do not wait.

### Sending

| Target | Enter on | Enter off |
|--------|----------|-----------|
| pane runs an agent | the prompt guard, a paste, 300 ms, the guard again, Enter | the blocked check, then a raw write |
| plain shell | the blocked check, a paste, then Enter | the blocked check, then a raw write |

Send Keys uses `rex send-key` with session and block always named; New Tab uses `rex window new`, then selects the new tab in the app and raises it. Text is appended to whatever is already typed in the pane; the deck does not clear a draft first, so a prompt restored after an interrupt can merge with a deck prompt.

- **Blocked agents:** Slash Command, Send Text and Cycle never type into an agent waiting at a permission prompt; the key flashes `BLOCKED` and sends nothing. Rex itself does not refuse prompts to a blocked agent, so the prompt guard rechecks on the sending connection, once before the paste and once before Enter: it raises not ready if the foreground is at a prompt or absent, or if it is Claude with no root record (during Claude's folder-trust dialog there are no records and the default choice exits; other agents' reporting is unverified, so this rule is Claude only; a root another pid left does not count), and blocked if any non-`rsact` record that is not a leftover is blocked. A raw write and text to a pane with no agent are checked too, and refused if the foreground owns a blocked record: that can be an agent behind a script the deck could not tell from a shell. A blocked record the foreground does not own does not stop them, because a shell with a leftover has to stay usable. The checks narrow the race and cannot close it: a dialog raised after the last read, a moment before the write, still gets the byte. When the second check of a prompt refuses, the pasted text stays in the input with no Enter. Send Keys always sends, so `esc` can dismiss a prompt or interrupt a run.
- **Send Keys** takes names separated by commas or spaces: `esc`/`escape`, `enter`/`return`, `tab`, `space`, `backspace`, `up`, `down`, `left`, `right`, `f1`–`f12`, or `ctrl+`, `control+`, `alt+`, `meta+`, `option+` or `shift+` followed by one of those names or a single character (`ctrl+c`, `shift+tab`, `alt+enter`). Names are case-insensitive (`Ctrl+C` becomes `ctrl+c`); a single character is sent as typed, so `A` types a capital. `meta+` means alt here, because Rex's own `meta` is cmd. Anything `rex send-key` cannot deliver (`é`, `ctrl+!`) or the deck does not take (`home`, `S-Tab`) makes the face show `BAD KEY` in red, and a press sends nothing. Send Keys forwards what the user configured, including `left`, which on an empty Claude prompt opens its agents view and moves the conversation to a hidden pty; the pane then shows no records.
- **Cycle** splits its values on commas or new lines. Each press sends the command and the next value (just the value when the command is empty), then advances, wrapping from the last value to the first. The position is saved in the key's settings, so it survives restarts, and fast presses each send the next value. The key shows what it will send; it does not read back what the agent actually uses.
- **New Tab** checks the folder first: Rex never validates one and would silently start in the home directory, so a missing, relative or non-directory folder flashes `NO SUCH DIR` and opens nothing.

**Flashes.** After a press the footer shows the result for about a second: green `SENT` or `OPENED`; red `BLOCKED`, `NOT READY` (no agent is the pane's foreground process, or it is not reporting yet), `BAD KEY`, `NO SUCH DIR`, `NOT SET`, `GONE` (the session or pane closed) or `FAILED`. Then the live face returns. Control keys do not use the host's generic alert overlay.

**One send at a time.** Presses are sent in order, each after the previous one finishes: a prompt's Enter comes shortly after its text, so overlapping prompts would interleave in the agent's input.

## Focus

No API field says which session the Mac app is showing, so focus rests on two signals, both undocumented or private:

- **`size_changed`** is a declared terminal event; reading it as "this session became visible" is the undocumented part. It moves focus when its `owner` is the chosen app client and its `principal.pid` is that client's. An event with no `principal` must not move focus: that is the server re-applying a stored size when a block returns to the app from another client, for a session the app may not be showing. If the owner is not in the last client list and the event has a principal, that one event is held, a snapshot is triggered, and it applies if the owner then qualifies, which covers a relaunched app.
- **The private `Workspace.lastFocusedSession` preference** seeds focus at startup and overwrites it whenever its value differs from the previous read. It is read at most once per second from `defaults export`. It tracks every switch while Rex is frontmost and does not change while Rex is in the background, which is why the event is needed too.

This is the one place an event payload is applied directly: the snapshot cannot say which session is in view, so it stays authoritative for everything except focus. There is no optimistic focus, so with the stream down focus moves only through the preference. A focused session that is not in the snapshot means no focus.

The app client to drive comes from `client.list`: a `kind` of `app`, not `lost` (a dead client stays listed for a minute, ahead of a relaunched one), on the unix transport, the last such entry. With no such entry there is no app, and the deck never falls back to another transport: that would switch someone's phone. Create actions check for the client first and create nothing without one.

## Interaction vocabulary

| Key | Press | Long press |
|-----|-------|------------|
| Session | Show the session in the Rex app **and raise the app** | Same as press; no hidden alternate action |
| Pager `←` / `→` (only when present) | One page in that direction | Same as press |
| New Rex Session | Create a session, show it and raise the app | Same as press |
| Agent Summary | Focus the session that needs you most (blocked, then done, then idle; never the focused one) and raise the app; `ALL CLEAR` when none | Same as press |
| Slash Command | Send the command and Enter to the target | Same as press |
| Send Text | Send the text to the target, with Enter unless turned off | Same as press |
| Send Keys | Send the key presses to the target, even to a blocked agent | Same as press |
| Cycle | Send the command and the next value with Enter, then advance | Same as press |
| New Tab | Open a tab in the target session, in the target pane's folder or the configured one; show it and raise the app | Same as press |
| Empty key | No-op | No-op |
| Key without the action | Never touched | Never touched |

The New Rex Session key renders as a green `+` with `NEW SESSION` below; it dims and goes inert while Rex is offline.

- Every key acts exactly once on key-up. Holding it must not create a second action, and a key-up without a preceding key-down is ignored.
- Pager keys move one page in their direction. Do not auto-repeat or wrap at either end.
- Key-down only records the press; nothing changes on the key until key-up acts. After a focus request, render `FOCUSING…` in the footer until the snapshot confirms it (the background does not turn green until confirmed). On command failure, render `FAILED · TRY AGAIN` for one second, in red on a dark field and dark on a light one, then restore live state. The one use of the host's generic alert overlay is New Rex Session failing, for example with no app connected.
- The app is raised only after it has answered, so a stopped app is never launched by a press.
- Keep gesture state per key context; cancel timers on disappearance or disconnect.

## Overflow and live updates

- Without a pager, all 14 keys are session tiles. The pager takes two of them, so with one a page holds 12 sessions.
- A manual page change is view-only and persists until the user focuses an item or the focused ID changes externally.
- Additions fill the first free position after existing IDs. Removals compact; clamp the page only when its old index no longer exists.
- Track the server with a long-lived `rex events --all --json` child. Whitelisted events trigger a debounced snapshot refresh (75 ms coalesce, at most one refresh per 300 ms), with a 5 s reconciliation poll while the stream is live, because a hung server keeps the stream alive and silent. `program_status_changed` is dropped when a record's state and kind have not changed, and `process_changed` when the pane's agent (and that agent's pid), folder and derived status have not, because a busy shell fires about seven a second. Everything else, including `pwd_changed` and every connection's `client_joined`, is ignored.
- The stream counts as up once its child has stayed alive 250 ms. It exits when the server goes away and never reconnects, so without it fall back to polling the snapshot at 1 Hz and restart it with exponential backoff (1 s doubling to a 15 s cap; reset on success). Redraw only keys whose image model changed in either mode.
- Every CLI call passes `--autostart=false`, because the default would launch a server, and one-shot calls pass `--timeout 2s`, below the 2.5 s kill, so rex reports the failure itself.
- A snapshot failure counts toward offline; a failed press does not.
- The pager, when present, always takes the last two Rex Session keys, wherever those sit; never reinterpret any other session tile as navigation.
- Countdowns on session tiles and the summary repaint every 15 s.

## Empty, loading, and offline states

- **Starting:** top-left shows `REX · CONNECTING`; every other session key shows an inert dot. The summary shows `CONNECTING` and control keys are dim; both are inert until the first snapshot.
- **Online, no sessions:** top-left shows `NO SESSIONS · OPEN REX`; the other session keys show an inert dot, and there are no pagers.
- **Unused positions:** an inert dot on black; do not show fake slot numbers or plus buttons.
- **Transient poll failure:** keep the last good frame for two failed polls to avoid flicker.
- **Offline after three failures:** freeze and dim last-known labels on plain backgrounds, disable all focus and page actions, and show `REX OFFLINE` in red text on the top-left key. Summary and control keys dim and go inert, presses send nothing, and the summary does not keep showing stale counts. Recover automatically on the next valid snapshot.

## Staged roadmap

### 0.1 — live deck and agent controls (built)

- Session tiles with stable slots, the dynamic pager, focus feedback, offline grace and redraw deduplication.
- Change stream with polling fallback, and a seen-aware done.
- Agent activity tiles (blue background work, mauve scheduled checks) with pictogram footers.
- Agent Summary key with ring and list looks.
- Control keys: Slash Command, Send Text, Send Keys, Cycle and New Tab, targeting the focused agent or a pinned session.
- Property inspectors for every action, and an end-to-end harness against a sandbox Rex server and a fake Mac app client.

### Device polish

Calibrate type, colours, brightness, and acknowledgement timing on a physical MK.2. Add working-state motion only if it remains legible and does not disturb live updates. Ship the OpenDeck profile/install path after a full reconnect, hot-plug, overflow, and offline recovery pass.

## Non-goals

- No answer or approve presets for permission prompts. Send Text types whatever the user configures, but the plugin ships no key that says yes on the user's behalf.
- No Stream Deck+ dials or touch strip.
- No automatic launching of Rex.
- No optimistic focus state.
- No touching keys the user has not placed an action on, under any circumstance.
