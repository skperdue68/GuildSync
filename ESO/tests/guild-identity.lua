-- Run from the repository root: fengari ESO/tests/guild-identity.lua
local function equal(actual, expected, message)
  assert(actual == expected, message .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
end

local function collector(kind)
  local prefix = kind == 'Roster' and 'gsr' or 'gsb'
  local addon = 'GuildSync' .. kind
  local saved = {}
  local callbacks = {}
  local processors = {}
  local selectedId = 101
  local names = {[101] = 'Alphabet Mafia', [202] = 'Other Guild'}
  CHAT_ROUTER = {AddSystemMessage = function() end}
  SLASH_COMMANDS = {}
  EVENT_ADD_ON_LOADED = 1
  EVENT_MANAGER = {
    RegisterForEvent = function(_, _, _, callback) callbacks.loaded = callback end,
    UnregisterForEvent = function() end,
    RegisterForUpdate = function() end,
    UnregisterForUpdate = function() end,
  }
  ZO_SavedVars = {NewAccountWide = function(_, name, _, _, defaults)
    saved[name] = saved[name] or defaults
    return saved[name]
  end}
  GetNumGuilds = function() return 1 end
  GetGuildId = function() return selectedId end
  GetGuildName = function(id) return names[id] end
  GetTimeStamp = function() return 1700000000 end
  GetNumGuildMembers = function() return 1 end
  GetGuildMemberInfo = function() return '@member', '', 1 end
  GetGuildRankCustomName = function() return 'Member' end
  RequestOpenMailbox = function() end
  zo_callLater = function() end
  GUILD_HISTORY_EVENT_CATEGORY_ROSTER = 1
  GUILD_HISTORY_EVENT_CATEGORY_BANKED_CURRENCY = 2
  GUILD_HISTORY_ROSTER_EVENT_JOIN = 10
  GUILD_HISTORY_ROSTER_EVENT_LEAVE = 11
  GUILD_HISTORY_ROSTER_EVENT_KICKED = 12
  GUILD_HISTORY_ROSTER_EVENT_PROMOTE = 13
  GUILD_HISTORY_ROSTER_EVENT_DEMOTE = 14
  GUILD_HISTORY_ROSTER_EVENT_APPLICATION_ACCEPTED = 15
  GUILD_HISTORY_ROSTER_EVENT_APPLICATION_DECLINED = 16
  GUILD_HISTORY_BANKED_CURRENCY_EVENT_DEPOSITED = 20
  CURT_MONEY = 1
  LibHistoire = {OnReady = function(_, callback) callback(LibHistoire) end}
  function LibHistoire:CreateGuildHistoryProcessor(id)
    local p = {guildId = id}
    function p:GetKey() return 'mock' end
    function p:IsRunning() return self.running end
    function p:Stop() self.running = false; return true end
    function p:StartStreaming(cursor, callback)
      self.cursor, self.callback, self.running = cursor, callback, true
      return true
    end
    processors[#processors + 1] = p
    return p
  end
  saved[addon .. 'State'] = {lastProcessedId = 900, lastProcessedIdsByGuild = {['202'] = 77}}
  local pending = {eventId = 1, guildId = '202', guildName = 'Other Guild'}
  if kind == 'Roster' then
    saved[addon] = {rosterEvents = {pending = pending}, guildList = {guildListMembers = {}}}
  else
    saved[addon] = {other = {pending}, mailQueue = {{mailRequestId = 'keep'}}}
  end
  dofile('ESO/' .. addon .. '/' .. addon .. '.lua')
  callbacks.loaded(nil, addon)
  local state, data = saved[addon .. 'State'], saved[addon]
  local function event(id, filtered)
    return {
      GetEventId = function() return id end,
      GetEventType = function() return filtered and 999 or (kind == 'Roster' and 10 or 20) end,
      GetEventTimestampS = function() return 1700000000 end,
      GetEventInfo = function() return {displayName = '@member', amount = 100, currencyType = 1} end,
    }
  end
  local first = processors[#processors]
  equal(first.cursor, nil, kind .. ' unbound legacy cursor must replay')
  equal(state.unboundLegacyLastProcessedId, 900, 'retain migration evidence')
  first.callback(event(5))
  local record = kind == 'Roster' and data.rosterEvents.guild_101_event_5 or data.other[2]
  equal(record.guildId, '101', 'record guild id')
  equal(record.guildName, 'Alphabet Mafia', 'record guild name')
  equal(data.guildId, '101', 'export guild id')
  equal(state.lastProcessedIdsByGuild['101'], 5, 'guild checkpoint')
  first.callback(event(4, true))
  equal(state.lastProcessedIdsByGuild['101'], 5, 'checkpoint never regresses')
  SLASH_COMMANDS['/' .. prefix]('reset')
  local second = processors[#processors]
  equal(first.running, false, 'reset stops old processor')
  equal(second.cursor, nil, 'reset replays available cache')
  equal(state.lastProcessedIdsByGuild['202'], 77, 'reset preserves other guild checkpoint')
  equal(pending.guildId, '202', 'reset preserves pending export identity')
  first.callback(event(500))
  equal(state.lastProcessedIdsByGuild['101'], nil, 'stale callback ignored')
  second.callback(event(6, true))
  equal(state.lastProcessedIdsByGuild['101'], 6, 'filtered event advances checkpoint')
  if kind == 'Roster' then
    SLASH_COMMANDS['/gsr']('guildlist')
    equal(data.guildList.guildId, '101', 'snapshot guild id')
    equal(data.guildList.guildListMembers['@member'].guildId, '101', 'member guild id')
    equal(data.rosterEvents.pending, pending, 'pending roster event retained')
  else
    equal(data.other[1], pending, 'pending bank transaction retained')
    equal(data.mailQueue[1].mailRequestId, 'keep', 'mail queue retained')
  end
  SLASH_COMMANDS['/' .. prefix]('stop')
  selectedId = 202
  names[202] = 'Alphabet Mafia'
  SLASH_COMMANDS['/' .. prefix]('stream')
  local third = processors[#processors]
  equal(third.cursor, 77, 'new guild uses own checkpoint')
  second.callback(event(600))
  equal(state.lastProcessedIdsByGuild['101'], 6, 'stale guild callback cannot advance checkpoint')
  equal(state.lastProcessedIdsByGuild['202'], 77, 'stale callback cannot advance selected guild')
  third.callback(event(78))
  equal(state.lastProcessedIdsByGuild['202'], 78, 'new guild checkpoint advances')
  SLASH_COMMANDS['/' .. prefix]('guild 202')
  equal(state.targetGuildId, nil, 'pending exports prevent guild selection')
  if kind == 'Roster' then
    data.rosterEvents = {}
    data.guildList.guildListMembers = {}
  else
    data.biweekly, data.monthly, data.other, data.mailQueue, data.mailAck = {}, {}, {}, {}, {}
  end
  SLASH_COMMANDS['/' .. prefix]('guild 202')
  equal(state.targetGuildId, '202', 'guild selection persists actual ID')
  equal(processors[#processors].cursor, 78, 'selected guild resumes own cursor')
  print(kind .. ': guild identity, safe migration, reset, and callback isolation passed')
end

local function applications()
  local saved, loaded, reject
  SLASH_COMMANDS = {}
  EVENT_MANAGER = {
    RegisterForEvent = function(_, _, _, callback) loaded = callback end,
    UnregisterForEvent = function() end,
  }
  ZO_SavedVars = {NewAccountWide = function(_, _, _, _, defaults) saved = defaults; return saved end}
  GetNumGuilds = function() return 2 end
  GetGuildId = function(index) return index == 1 and 101 or 202 end
  GetGuildName = function(id) return id == 101 and 'First Guild' or 'Second Guild' end
  GetDisplayName = function() return '@officer' end
  GetGuildFinderGuildApplicationInfoAt = function() return 50, 100, 1, 1, '@applicant', 'Character', 0, 'Hello' end
  DeclineGuildApplication = function() end
  ZO_PreHook = function(name, callback) if name == 'DeclineGuildApplication' then reject = callback end end
  dofile('ESO/GuildSyncApplications/GuildSyncApplications.lua')
  loaded(nil, 'GuildSyncApplications')
  SLASH_COMMANDS['/gsa']('guild First Guild')
  equal(saved.settings.captureGuildId, '101', 'application guild selection persists')
  reject(202, 1)
  equal(next(saved.records), nil, 'foreign guild decision ignored')
  reject(101, 1)
  local _, record = next(saved.records)
  equal(tostring(record.guildId), '101', 'application actual guild retained')
  SLASH_COMMANDS['/gsa']('guild 202')
  equal(saved.settings.captureGuildId, '101', 'pending application prevents switch')
  saved.records = {}
  SLASH_COMMANDS['/gsa']('guild 202')
  reject(101, 1)
  equal(next(saved.records), nil, 'old guild ignored after switch')
  reject(202, 1)
  _, record = next(saved.records)
  equal(tostring(record.guildId), '202', 'selected second guild captured')
  print('Applications: guild selection, pending record guard, and capture isolation passed')
end

local ok, problem = pcall(function()
  collector('Roster')
  collector('Banking')
  applications()
end)
if not ok then
  io.stderr:write(tostring(problem) .. '\n')
  os.exit(1)
end
