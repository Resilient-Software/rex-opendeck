/**
 * The Lua scripts the bridge runs through `rex do -e`. rex.call returns nil,err
 * and never raises, so a script that ignored the error would print an empty
 * result with exit 0 from a dead server. session.view, block.method and
 * block.event need session.attach_all on the same connection first; it emits
 * only client_joined and client_left, where a per-session attach would add
 * client_connected for every session.
 */
export const SHELLS: readonly string[] = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "login"];

const STRICT_CALL = `
local function call(method, args)
  local result, err = rex.call(method, args)
  if err ~= nil then
    error(tostring(err), 0)
  end
  return result
end
`;

/** A session or block closing mid-script lands in `skipped`; anything else raises. */
export const SNAPSHOT_SCRIPT = `
local TERMINAL = "com.superlogical.terminal"
local skipped = {}

local function call(method, args)
  local result, err = rex.call(method, args)
  if err == nil then
    return result
  end
  local text = tostring(err)
  if text:find("code=not_found)", 1, true) or text:find("code=session_not_found)", 1, true) then
    skipped[#skipped + 1] = { session_id = args.session_id, block_id = args.block_id, error = text }
    return nil
  end
  error(text, 0)
end

local function inspect_terminal(session_id, block)
  local args = { session_id = session_id, block_id = block.block_id, method = "program_status" }
  local status = call("block.method", args)
  if status == nil then
    return false
  end
  args.method = "process"
  local process = call("block.method", args)
  if process == nil then
    return false
  end
  block.records = status.records
  block.foreground = process.foreground
  block.child = process.child
  return true
end

local sessions = {}
for number, listed in ipairs(call("session.attach_all", { event_scope = "session" }).sessions or {}) do
  local view = call("session.view", { session_id = listed.session_id })
  if view ~= nil then
    local session = {
      session_id = listed.session_id,
      number = number,
      label = view.label,
      active_window_id = view.active_window_id,
      windows = {},
    }
    for _, w in ipairs(view.windows or {}) do
      local window = { window_id = w.window_id, label = w.label, focused_block_id = w.focused_block_id, blocks = {} }
      for _, layer in ipairs(w.layers or {}) do
        for _, b in ipairs(layer.blocks or {}) do
          local block = { block_id = b.block_id, creator_name = b.creator_name }
          if b.creator_name ~= TERMINAL or inspect_terminal(listed.session_id, block) then
            window.blocks[#window.blocks + 1] = block
          end
        end
      end
      session.windows[#session.windows + 1] = window
    end
    sessions[#sessions + 1] = session
  end
end

local clients = call("client.list", { kinds = { "app" } })
return { clients = clients and clients.clients or {}, sessions = sessions, skipped = skipped }
`;

export const CLIENTS_SCRIPT = `
${STRICT_CALL}
return { clients = call("client.list", { kinds = { "app" } }).clients or {} }
`;

const PASTE_TEXT = `
${STRICT_CALL}
call("session.attach_all", { event_scope = "session" })
local session_id, block_id, text = rex.args.session_id, rex.args.block_id, rex.args.text
local function write(data)
  call("block.method", { session_id = session_id, block_id = block_id, method = "write", args = { data = data } })
end
local function paste()
  call("block.event", { session_id = session_id, block_id = block_id, event = { type = "paste", payload = { text = text } } })
end
`;

/**
 * The classification in rex-snapshot.ts, again on the sending connection: the
 * deck's last snapshot can be stale by the time a key is pressed.
 */
const GUARD = `
${PASTE_TEXT}
local SHELLS = { ${SHELLS.map((shell) => `${shell} = true`).join(", ")} }
local function program(path)
  return ((path or ""):match("([^/]*)$"):gsub("^%-", ""))
end
local function inspect()
  local status = call("block.method", { session_id = session_id, block_id = block_id, method = "program_status" })
  local process = call("block.method", { session_id = session_id, block_id = block_id, method = "process" })
  return status.records or {}, process.foreground, process.child
end
local function is_activity(record)
  return (record.id or ""):sub(1, 6) == "rsact/"
end
local function owner_pid(record)
  return record.owner and record.owner.pid
end
local function at_prompt(records, foreground, child)
  if foreground == nil then
    return true
  end
  local name = foreground.argv0 or foreground.name or ""
  if not SHELLS[program(name)] then
    return false
  end
  if name:sub(1, 1) == "-" or (child ~= nil and child.pid == foreground.pid) then
    return true
  end
  for _, record in ipairs(records) do
    if not is_activity(record) and owner_pid(record) == foreground.pid then
      return false
    end
  end
  return true
end
local function is_blocked(records, foreground, prompt)
  for _, record in ipairs(records) do
    if not is_activity(record) and record.state == "blocked" then
      local owner = owner_pid(record)
      if owner == nil and not prompt then
        return true
      end
      if owner ~= nil and foreground ~= nil and owner == foreground.pid then
        return true
      end
    end
  end
  return false
end
local function refuse_blocked()
  local records, foreground, child = inspect()
  if is_blocked(records, foreground, at_prompt(records, foreground, child)) then
    error("agent_blocked", 0)
  end
end
`;

/**
 * Under a shell at its prompt a blocked record only counts if that shell owns
 * it: an ownerless one is a leftover, and refusing on it would leave the shell
 * unusable, but an owned one can be an agent behind a script the snapshot could
 * not tell from a shell.
 */
export const WRITE_SCRIPT = `
${GUARD}
refuse_blocked()
write(text)
`;

export const INPUT_SCRIPT = `
${GUARD}
refuse_blocked()
paste()
write("\\r")
`;

/**
 * Rex does not refuse prompts to a blocked agent, so the check runs here, on
 * the same connection as the paste, and again before Enter: an agent working
 * when the key was pressed can raise a dialog during the pause, and Enter would
 * answer it. A missing root record only means "not ready" for Claude: during
 * its folder-trust dialog there are no records and the default choice exits,
 * and other agents' reporting is unverified. A root naming another pid is a
 * killed predecessor's, and says nothing about this one.
 */
export const PROMPT_SCRIPT = `
${GUARD}
local function guard()
  local records, foreground, child = inspect()
  if at_prompt(records, foreground, child) then
    error("agent_not_ready", 0)
  end
  local has_root = false
  for _, record in ipairs(records) do
    local owner = owner_pid(record)
    if (record.id or "") == "" and (owner == nil or owner == foreground.pid) then
      has_root = true
    end
  end
  if program(foreground.argv0) == "claude" and not has_root then
    error("agent_not_ready", 0)
  end
  if is_blocked(records, foreground, false) then
    error("agent_blocked", 0)
  end
end
guard()
paste()
rex.sleep(0.3)
guard()
write("\\r")
`;
