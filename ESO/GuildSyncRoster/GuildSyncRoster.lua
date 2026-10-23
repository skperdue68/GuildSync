GuildSyncRosterState = GuildSyncRosterState or {}
GuildSyncRoster = GuildSyncRoster or {}

local TARGET_GUILD_NAME = "Alphabet Mafia"

local ADDON_NAME = "GuildSyncRoster"
local SAVED_VARS_NAME = "GuildSyncRosterState"
local SAVED_VARS_VERSION = 6

local ROSTER_SAVED_VARS_NAME = "GuildSyncRoster"
local ROSTER_SAVED_VARS_VERSION = 6

local DEBUG_ROSTER = false

local ROSTER_HISTORY_TYPE = {
    category = GUILD_HISTORY_EVENT_CATEGORY_ROSTER,
    allowedEventTypes = {
        [GUILD_HISTORY_ROSTER_EVENT_JOIN] = true,
        [GUILD_HISTORY_ROSTER_EVENT_LEAVE] = true,
        [GUILD_HISTORY_ROSTER_EVENT_KICKED] = true,
        [GUILD_HISTORY_ROSTER_EVENT_PROMOTE] = true,
        [GUILD_HISTORY_ROSTER_EVENT_DEMOTE] = true,
        [GUILD_HISTORY_ROSTER_EVENT_APPLICATION_ACCEPTED] = true,
        [GUILD_HISTORY_ROSTER_EVENT_APPLICATION_DECLINED] = true,
    }
}

local gsrSavedVars = nil
local gsrRosterSavedVars = nil
local gsrLibHistoire = nil
local gsrProcessor = nil
local gsrInitialized = false
local gsrStreamGeneration = 0

local function GSR_Print(message)
    CHAT_ROUTER:AddSystemMessage("|c88CCFF[GuildSyncRoster]|r " .. tostring(message))
end

local function GSR_TimeString(timestamp)
    if not timestamp or timestamp == 0 then
        return "unknown"
    end

    return os.date("%Y-%m-%d %H:%M:%S", timestamp)
end

local function GSR_UtcTimeString(timestamp)
    if not timestamp or timestamp == 0 then
        return "unknown"
    end

    return os.date("!%Y-%m-%d %H:%M:%S UTC", timestamp)
end

local function GSR_Trim(value)
    value = tostring(value or "")

    if zo_strtrim then
        return zo_strtrim(value)
    end

    return value:match("^%s*(.-)%s*$") or ""
end

local function GSR_EventPassesRosterFilter(event)
    if not event then
        return false
    end

    return ROSTER_HISTORY_TYPE.allowedEventTypes[event:GetEventType()] == true
end

local function GSR_GetTargetGuildId()
    local selectedId = gsrSavedVars and gsrSavedVars.targetGuildId
    local selectedName = gsrSavedVars and gsrSavedVars.targetGuildName or TARGET_GUILD_NAME
    for guildIndex = 1, GetNumGuilds() do
        local guildId = GetGuildId(guildIndex)
        local guildName = GetGuildName(guildId)

        if (selectedId and tostring(guildId) == tostring(selectedId))
            or (not selectedId and string.lower(GSR_Trim(guildName)) == string.lower(selectedName)) then
            return guildId, guildIndex, guildName
        end
    end

    GSR_Print("Could not find selected guild: " .. tostring(selectedId or selectedName))
    return nil, nil, nil
end

local function GSR_EnsureSavedVars()
    if not gsrSavedVars then
        return nil
    end

    if gsrSavedVars.lastProcessedId ~= nil then
        local numericId = tonumber(gsrSavedVars.lastProcessedId)

        if numericId then
            gsrSavedVars.lastProcessedId = numericId
        else
            GSR_Print("Saved LastProcessedId was not numeric. Clearing it.")
            gsrSavedVars.lastProcessedId = nil
        end
    end

    if gsrSavedVars.debugRoster ~= true then
        gsrSavedVars.debugRoster = false
    end

    return gsrSavedVars
end

local function GSR_EnsureRosterSavedVars()
    if not gsrRosterSavedVars then
        return nil
    end

    gsrRosterSavedVars.guildList = gsrRosterSavedVars.guildList or {}
    gsrRosterSavedVars.guildList.guildListMembers = gsrRosterSavedVars.guildList.guildListMembers or {}
    gsrRosterSavedVars.rosterEvents = gsrRosterSavedVars.rosterEvents or {}

    return gsrRosterSavedVars
end

-- Never apply a singleton checkpoint from an unidentified guild to another guild.
local function GSR_GuildCheckpoint(guildId)
  local sv = GSR_EnsureSavedVars()
  local key = tostring(guildId)
  sv.lastProcessedIdsByGuild = sv.lastProcessedIdsByGuild or {}
  if not sv.guildCheckpointMigrationComplete then
    if sv.lastProcessedId ~= nil then
      if tostring(sv.lastProcessedGuildId or "") == key then
        sv.lastProcessedIdsByGuild[key] = sv.lastProcessedIdsByGuild[key] or tonumber(sv.lastProcessedId)
      else
        sv.unboundLegacyLastProcessedId = sv.lastProcessedId
        GSR_Print("Legacy checkpoint has no matching guild identity; replaying available cached history safely.")
      end
    end
    sv.guildCheckpointMigrationComplete = true
  end
  sv.lastProcessedGuildId = key
  sv.lastProcessedId = tonumber(sv.lastProcessedIdsByGuild[key])
  return sv.lastProcessedId
end

local function GSR_AdvanceGuildCheckpoint(guildId, eventId)
  local sv = GSR_EnsureSavedVars()
  local previous = GSR_GuildCheckpoint(guildId)
  eventId = tonumber(eventId)
  if eventId and (not previous or eventId > previous) then
    sv.lastProcessedIdsByGuild[tostring(guildId)] = eventId
    sv.lastProcessedId = eventId
  end
end

local function GSR_IsDebugEnabled()
    local sv = GSR_EnsureSavedVars()

    if not sv then
        return DEBUG_ROSTER
    end

    return sv.debugRoster == true
end

local function GSR_Debug(message)
    if GSR_IsDebugEnabled() then
        GSR_Print(message)
    end
end

local function GSR_GetRankName(guildId, rankId)
    rankId = tonumber(rankId)

    if not guildId or not rankId then
        return ""
    end

    if GetGuildRankCustomName then
        local customName = GSR_Trim(GetGuildRankCustomName(guildId, rankId))
        if customName ~= "" then
            return customName
        end
    end

    if GetGuildRankName then
        local rankName = GSR_Trim(GetGuildRankName(guildId, rankId))
        if rankName ~= "" then
            return rankName
        end
    end

    return "Rank " .. tostring(rankId)
end

local function GSR_GetRosterEventName(eventType)
    if eventType == GUILD_HISTORY_ROSTER_EVENT_JOIN then
        return "joined"
    elseif eventType == GUILD_HISTORY_ROSTER_EVENT_LEAVE then
        return "left"
    elseif eventType == GUILD_HISTORY_ROSTER_EVENT_KICKED then
        return "kicked"
    elseif eventType == GUILD_HISTORY_ROSTER_EVENT_PROMOTE then
        return "promoted"
    elseif eventType == GUILD_HISTORY_ROSTER_EVENT_DEMOTE then
        return "demoted"
    elseif eventType == GUILD_HISTORY_ROSTER_EVENT_APPLICATION_ACCEPTED then
        return "application accepted"
    elseif eventType == GUILD_HISTORY_ROSTER_EVENT_APPLICATION_DECLINED then
        return "application declined"
    end

    return "unknown"
end

local function GSR_GetInfoValue(info, ...)
    if type(info) ~= "table" then
        return nil
    end

    local names = { ... }

    for _, name in ipairs(names) do
        if info[name] ~= nil then
            return info[name]
        end
    end

    return nil
end

local function GSR_BuildRosterRecord(guildId, event)
    local eventId = tonumber(event:GetEventId())
    local rawEventType = event:GetEventType()
    local info = event:GetEventInfo() or {}

    local timestampS = GSR_GetInfoValue(info, "timestampS", "timestamp", "time")
    timestampS = tonumber(timestampS) or tonumber(event:GetEventTimestampS())

    local rankName = GSR_GetInfoValue(info, "rankName", "newRankName")

    if not rankName or GSR_Trim(rankName) == "" then
        local rankId = GSR_GetInfoValue(info, "rankId", "rank", "newRankId")
        rankName = GSR_GetRankName(guildId, rankId)
    end

    return {
        eventId = eventId,
        guildId = tostring(guildId),
        guildName = GetGuildName(guildId),
        targetDisplayName = GSR_Trim(GSR_GetInfoValue(info, "targetDisplayName", "displayName", "memberDisplayName",
            "accountName")),
        actingDisplayName = GSR_Trim(GSR_GetInfoValue(info, "actingDisplayName", "actorDisplayName", "sourceDisplayName")),
        eventType = GSR_GetRosterEventName(rawEventType),
        rankName = GSR_Trim(rankName),
        timestampS = timestampS,
    }
end

local function GSR_PrintRosterEventEntry(source, record)
    if not record then
        return
    end

    local line =
        "[" .. tostring(source) .. "] "
        .. "EventId=" .. tostring(record.eventId)
        .. " Time=" .. GSR_TimeString(record.timestampS)
        .. " UTC=" .. GSR_UtcTimeString(record.timestampS)
        .. " EventType=" .. tostring(record.eventType)
        .. " Target=" .. tostring(record.targetDisplayName)
        .. " Actor=" .. tostring(record.actingDisplayName)
        .. " Rank=" .. tostring(record.rankName)

    GSR_Print(line)
end

local function GSR_GetRosterEventChatMessage(record)
    local target = GSR_Trim(record.targetDisplayName)
    local actor = GSR_Trim(record.actingDisplayName)

    if target == "" then
        target = "(unknown member)"
    end

    if record.eventType == "joined" then
        return "Roster joined: " .. target
    elseif record.eventType == "left" then
        return "Roster left: " .. target
    elseif record.eventType == "kicked" then
        if actor ~= "" then
            return "Roster kicked: " .. target .. " by " .. actor
        end
        return "Roster kicked: " .. target
    elseif record.eventType == "promoted" then
        return "Roster promoted: " .. target .. " -> " .. tostring(record.rankName or "")
    elseif record.eventType == "demoted" then
        return "Roster demoted: " .. target .. " -> " .. tostring(record.rankName or "")
    elseif record.eventType == "application accepted" then
        if actor ~= "" then
            return "Roster application accepted: " .. target .. " by " .. actor
        end
        return "Roster application accepted: " .. target
    elseif record.eventType == "application declined" then
        if actor ~= "" then
            return "Roster application declined: " .. target .. " by " .. actor
        end
        return "Roster application declined: " .. target
    end

    return "Roster event: Type=" .. tostring(record.eventType) .. " Target=" .. tostring(target)
end

local function GSR_SaveRosterEvent(guildId, guildName, event)
    local stateSv = GSR_EnsureSavedVars()
    local rosterSv = GSR_EnsureRosterSavedVars()

    if not stateSv then
        GSR_Print("State SavedVars not ready. Could not save roster event.")
        return
    end

    if not rosterSv then
        GSR_Print("Roster SavedVars not ready. Could not save roster event.")
        return
    end

    local eventId = tonumber(event:GetEventId())

    if not eventId then
        GSR_Print("Roster event had no numeric EventId. Not saving.")
        return
    end

    local lastProcessedId = GSR_GuildCheckpoint(guildId)

    if lastProcessedId and eventId <= lastProcessedId then
        return
    end

    local record = GSR_BuildRosterRecord(guildId, event)

    GSR_AdvanceGuildCheckpoint(guildId, eventId)

    if GSR_Trim(record.eventType) == "unknown" then
        GSR_Debug("Skipped unknown roster event. EventId=" .. tostring(eventId))
        return
    end

    rosterSv.guildId = tostring(guildId)
    rosterSv.guildName = guildName
    rosterSv.rosterEvents["guild_" .. tostring(guildId) .. "_event_" .. tostring(eventId)] = record
    GSR_Debug(GSR_GetRosterEventChatMessage(record))
end

local function GSR_UpdateStreamProgressForSkippedEvent(guildId, guildName, event)
    local stateSv = GSR_EnsureSavedVars()

    if not stateSv or not event then
        return
    end

    local eventId = tonumber(event:GetEventId())

    if not eventId then
        return
    end

    GSR_AdvanceGuildCheckpoint(guildId, eventId)
end

local function GSR_CreateProcessor(guildId, processorNameSuffix)
    if not gsrLibHistoire then
        GSR_Print("LibHistoire is not ready yet.")
        return nil
    end

    local processor = gsrLibHistoire:CreateGuildHistoryProcessor(
        guildId,
        ROSTER_HISTORY_TYPE.category,
        ADDON_NAME .. "-" .. tostring(processorNameSuffix or "roster")
    )

    if not processor then
        GSR_Print("Could not create LibHistoire roster processor.")
        GSR_Print("LibHistoire may not have a cache for this guild/category yet.")
        return nil
    end

    if processor.GetKey then
        GSR_Debug("Roster processor key: " .. tostring(processor:GetKey()))
    end

    return processor
end

local function GSR_StartRosterStream()
    local stateSv = GSR_EnsureSavedVars()

    if not stateSv then
        GSR_Print("SavedVars not ready.")
        return
    end

    if not gsrLibHistoire then
        GSR_Print("LibHistoire is not initialized yet.")
        return
    end

    if gsrProcessor and gsrProcessor.IsRunning and gsrProcessor:IsRunning() then
        GSR_Debug("Roster stream is already running.")
        return
    end

    local guildId, guildIndex, guildName = GSR_GetTargetGuildId()

    if not guildId then
        return
    end

    GSR_Debug("Using guild: " ..
        tostring(guildName) .. " index=" .. tostring(guildIndex) .. " guildId=" .. tostring(guildId))

    local processor = GSR_CreateProcessor(guildId, "stream")

    if not processor then
        return
    end

    gsrProcessor = processor

    if not processor.StartStreaming then
        GSR_Print("This LibHistoire processor does not have StartStreaming().")
        return
    end

    local lastProcessedId = GSR_GuildCheckpoint(guildId)
    gsrStreamGeneration = gsrStreamGeneration + 1
    local generation = gsrStreamGeneration

    if lastProcessedId then
        GSR_Print("Starting roster stream after saved LastProcessedId=" .. tostring(lastProcessedId))
    else
        GSR_Print("Starting roster stream from the beginning because LastProcessedId is not set.")
    end

    local started = processor:StartStreaming(lastProcessedId, function(event)
        if generation ~= gsrStreamGeneration or gsrProcessor ~= processor then return end
        if GSR_EventPassesRosterFilter(event) then
            GSR_SaveRosterEvent(guildId, guildName, event)
        else
            GSR_UpdateStreamProgressForSkippedEvent(guildId, guildName, event)
        end
    end)

    if not started then
        gsrProcessor = nil
        gsrStreamGeneration = gsrStreamGeneration + 1
        GSR_Print("Roster stream could not be started.")
    else
        GSR_Print("Roster stream started.")
    end
end

local function GSR_StopRosterStream()
    gsrStreamGeneration = gsrStreamGeneration + 1
    if not gsrProcessor then
        GSR_Debug("No roster processor has been created.")
        return true
    end

    if not gsrProcessor.Stop then
        GSR_Print("Roster processor does not expose Stop().")
        return false
    end

    local stopped = gsrProcessor:Stop()
    gsrProcessor = nil

    GSR_Print("Roster processor stopped: " .. tostring(stopped))
    return true
end

local function GSR_ResetRosterStream()
    local guildId = GSR_GetTargetGuildId()
    if not guildId then return end
    if not GSR_StopRosterStream() then return end
    GSR_GuildCheckpoint(guildId)
    local state = GSR_EnsureSavedVars()
    state.lastProcessedIdsByGuild[tostring(guildId)] = nil
    state.lastProcessedId = nil
    GSR_Print("Resetting this guild's roster checkpoint; pending exports are retained. Replaying available cached history.")
    GSR_StartRosterStream()
end

local function GSR_Status()
    local guildId, _, guildName = GSR_GetTargetGuildId()
    if not guildId then return end
    local checkpoint = GSR_GuildCheckpoint(guildId)
    GSR_Print("Guild: " .. tostring(guildName) .. " / ESO guild ID: " .. tostring(guildId))
    GSR_Print("Roster stream running: " .. tostring(gsrProcessor and gsrProcessor.IsRunning and gsrProcessor:IsRunning() or false)
        .. "; LastProcessedId=" .. tostring(checkpoint))
end

local function GSR_SelectGuild(query)
    query = string.lower(GSR_Trim(query))
    if query == "" then GSR_Status(); GSR_Print("Usage: /gsr guild <guild name or ESO guild ID>"); return end
    local state, roster = GSR_EnsureSavedVars(), GSR_EnsureRosterSavedVars()
    for index = 1, GetNumGuilds() do
        local id = GetGuildId(index)
        local name = GetGuildName(id)
        if query == tostring(id) or query == string.lower(GSR_Trim(name)) then
            if next(roster.rosterEvents) or next(roster.guildList.guildListMembers) then
                GSR_Print("Upload pending roster events and the guild list before changing guilds. Nothing was changed.")
                return
            end
            if not GSR_StopRosterStream() then return end
            state.targetGuildId, state.targetGuildName = tostring(id), name
            roster.guildId, roster.guildName = tostring(id), name
            roster.guildList = {guildId = tostring(id), guildName = name, guildListMembers = {}}
            GSR_Print("Selected guild " .. name .. " / ESO guild ID: " .. tostring(id))
            GSR_StartRosterStream()
            return
        end
    end
    GSR_Print("No joined guild matches that name or ESO guild ID. Nothing was changed.")
end

local function GSR_DumpRosterEvents()
    if not gsrLibHistoire then
        GSR_Print("LibHistoire is not ready yet.")
        return
    end

    local guildId, guildIndex, guildName = GSR_GetTargetGuildId()

    if not guildId then
        return
    end

    GSR_Print("Using guild: " ..
        tostring(guildName) .. " index=" .. tostring(guildIndex) .. " guildId=" .. tostring(guildId))

    local processor = GSR_CreateProcessor(guildId, "dump")

    if not processor then
        return
    end

    if processor.SetStopOnLastCachedEvent then
        processor:SetStopOnLastCachedEvent(true)
    end

    local startTime = 0
    local endTime = GetTimeStamp()

    GSR_Print("Starting review-only dump of all cached matching roster events.")
    GSR_Print("Dump does not save roster events and does not update LastProcessedId.")
    GSR_Print("Start: " .. GSR_TimeString(startTime) .. " / " .. GSR_UtcTimeString(startTime))
    GSR_Print("End: " .. GSR_TimeString(endTime) .. " / " .. GSR_UtcTimeString(endTime))

    local started = processor:StartIteratingTimeRange(
        startTime,
        endTime,
        function(event)
            if GSR_EventPassesRosterFilter(event) then
                local record = GSR_BuildRosterRecord(guildId, event)

                if GSR_Trim(record.eventType) ~= "unknown" then
                    GSR_PrintRosterEventEntry("dump", record)
                end
            end
        end,
        function(reason)
            GSR_Print("Roster event dump stopped. Reason=" .. tostring(reason))
        end
    )

    if not started then
        GSR_Print("Roster event dump could not be started.")
    else
        GSR_Print("Roster event dump started.")
    end
end

local function GSR_SaveGuildList()
    local guildId, guildIndex, guildName = GSR_GetTargetGuildId()

    if not guildId then
        return
    end

    local rosterSv = GSR_EnsureRosterSavedVars()

    if not rosterSv then
        GSR_Print("Roster SavedVars not ready.")
        return
    end

    local memberCount = GetNumGuildMembers(guildId) or 0
    local members = {}

    for memberIndex = 1, memberCount do
        local displayName, note, rankIndex, playerStatus, secsSinceLogoff = GetGuildMemberInfo(guildId, memberIndex)
        local accountName = GSR_Trim(displayName)

        members[accountName] = {
            accountName = accountName,
            guildId = tostring(guildId),
            guildName = guildName,
            rankName = GSR_GetRankName(guildId, rankIndex),
        }
    end

    rosterSv.guildList = {
        guildId = tostring(guildId),
        guildName = guildName,
        listTimestamp = GetTimeStamp(),
        guildListMembers = members,
    }
    rosterSv.guildId = tostring(guildId)
    rosterSv.guildName = guildName

    GSR_Print("Saved " .. tostring(memberCount) .. " guild member(s) to GuildSyncRoster.guildList.guildListMembers.")
end

local function GSR_SetDebugRoster(enabled)
    local stateSv = GSR_EnsureSavedVars()

    if not stateSv then
        GSR_Print("SavedVars not ready.")
        return
    end

    stateSv.debugRoster = enabled == true

    if stateSv.debugRoster then
        GSR_Print("Roster debug output is ON.")
    else
        GSR_Print("Roster debug output is OFF.")
    end
end

local function GSR_InitLibHistoire()
    if gsrInitialized then
        GSR_Debug("LibHistoire already initialized.")
        return
    end

    if not LibHistoire then
        GSR_Print("LibHistoire global not found. Is LibHistoire enabled and listed as a dependency?")
        return
    end

    gsrInitialized = true
    GSR_Print("Waiting for LibHistoire OnReady...")

    LibHistoire:OnReady(function(lib)
        gsrLibHistoire = lib

        GSR_Print("LibHistoire is ready.")
        GSR_StartRosterStream()
    end)
end

local function GSR_ShowHelp()
    GSR_Print("Commands:")
    GSR_Print("/gsr dump - Review all cached matching roster history events. Does not save or update LastProcessedId.")
    GSR_Print("/gsr guildlist - Save the current guild member list to GuildSyncRoster.guildList.")
    GSR_Print(
        "/gsr stream - Start roster LibHistoire stream after saved LastProcessedId, or from the beginning if not set.")
    GSR_Print("/gsr stop - Stop roster stream.")
    GSR_Print("/gsr reset - Reset this guild's checkpoint and replay available history; pending exports are retained.")
    GSR_Print("/gsr status - Show selected guild, ESO guild ID, stream status and checkpoint.")
    GSR_Print("/gsr guild <name or ESO guild ID> - Select the guild; pending exports must be uploaded first.")
    GSR_Print("/gsr debug on - Enable roster debug output.")
    GSR_Print("/gsr debug off - Disable roster debug output.")
end

local function GSR_HandleCommand(args)
    args = GSR_Trim(args)

    local command, rest = args:match("^(%S+)%s*(.-)$")
    command = string.lower(GSR_Trim(command or ""))
    rest = GSR_Trim(rest or "")

    if command == "" or command == "help" then
        GSR_ShowHelp()
        return
    end

    if command == "dump" then
        GSR_DumpRosterEvents()
        return
    end

    if command == "guildlist" then
        GSR_SaveGuildList()
        return
    end

    if command == "stream" then
        GSR_StartRosterStream()
        return
    end

    if command == "stop" then
        GSR_StopRosterStream()
        return
    end

    if command == "reset" then GSR_ResetRosterStream(); return end
    if command == "status" then GSR_Status(); return end
    if command == "guild" then GSR_SelectGuild(rest); return end

    if command == "debug" then
        local lowerRest = string.lower(rest)

        if lowerRest == "on" then
            GSR_SetDebugRoster(true)
            return
        end

        if lowerRest == "off" then
            GSR_SetDebugRoster(false)
            return
        end

        GSR_Print("Usage: /gsr debug on")
        GSR_Print("Usage: /gsr debug off")
        return
    end

    GSR_ShowHelp()
end

local function OnAddonLoaded(eventCode, addonName)
    if addonName ~= ADDON_NAME then
        return
    end

    EVENT_MANAGER:UnregisterForEvent(ADDON_NAME, EVENT_ADD_ON_LOADED)

    gsrSavedVars = ZO_SavedVars:NewAccountWide(
        SAVED_VARS_NAME,
        SAVED_VARS_VERSION,
        nil,
        {
            lastProcessedId = nil,
            debugRoster = false,
        }
    )

    gsrRosterSavedVars = ZO_SavedVars:NewAccountWide(
        ROSTER_SAVED_VARS_NAME,
        ROSTER_SAVED_VARS_VERSION,
        nil,
        {
            guildList = {
                listTimestamp = nil,
                guildListMembers = {},
            },
            rosterEvents = {},
        }
    )

    GSR_EnsureSavedVars()
    GSR_EnsureRosterSavedVars()

    SLASH_COMMANDS["/gsr"] = GSR_HandleCommand

    GSR_Print("GuildSyncRoster loaded. LibHistoire will initialize automatically.")
    GSR_Print("Manual commands: /gsr dump, /gsr guildlist, /gsr stream, /gsr stop, /gsr debug on")
    GSR_Print("SavedVars: GuildSyncRosterState.lua and GuildSyncRoster.lua")

    GSR_InitLibHistoire()
end

EVENT_MANAGER:RegisterForEvent(
    ADDON_NAME,
    EVENT_ADD_ON_LOADED,
    OnAddonLoaded
)
