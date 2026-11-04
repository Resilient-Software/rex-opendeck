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

export const WRITE_SCRIPT = `
${PASTE_TEXT}
write(text)
`;

export const INPUT_SCRIPT = `
${PASTE_TEXT}
paste()
write("\\r")
`;

/**
 * Rex does not refuse prompts to a blocked agent, so the check runs here, on
 * the same connection as the paste. A missing root record only means "not
 * ready" for Claude: during its folder-trust dialog there are no records and
 * the default choice exits, and other agents' reporting is unverified.
 */
export const PROMPT_SCRIPT = `
${PASTE_TEXT}
local SHELLS = { ${SHELLS.map((shell) => `${shell} = true`).join(", ")} }
local function program(path)
  return ((path or ""):match("([^/]*)$"):gsub("^%-", ""))
end
local status = call("block.method", { session_id = session_id, block_id = block_id, method = "program_status" })
local process = call("block.method", { session_id = session_id, block_id = block_id, method = "process" })
local foreground = process.foreground
if foreground == nil or SHELLS[program(foreground.argv0 or foreground.name)] then
  error("agent_not_ready", 0)
end
local has_root, blocked = false, false
for _, record in ipairs(status.records or {}) do
  local id = record.id or ""
  if id == "" then
    has_root = true
  end
  if id:sub(1, 6) ~= "rsact/" and record.state == "blocked" then
    blocked = true
  end
end
if program(foreground.argv0) == "claude" and not has_root then
  error("agent_not_ready", 0)
end
if blocked then
  error("agent_blocked", 0)
end
paste()
rex.sleep(0.3)
write("\\r")
`;
