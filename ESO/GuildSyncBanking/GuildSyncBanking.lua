GuildSyncBankingState = GuildSyncBankingState or {}
GuildSyncBanking = GuildSyncBanking or {}

local TARGET_GUILD_NAME = "Alphabet Mafia"

local ADDON_NAME = "GuildSyncBanking"
local SAVED_VARS_NAME = "GuildSyncBankingState"
local SAVED_VARS_VERSION = 4

local BANKING_SAVED_VARS_NAME = "GuildSyncBanking"
local BANKING_SAVED_VARS_VERSION = 4

local DEBUG_BANKING = false
local MAIL_SEND_DELAY_MS = 2000
local MAILBOX_OPEN_DELAY_MS = 1000

local BIWEEKLY_TICKET_COST = 500
local BIWEEKLY_TICKET_ENDING_VALUE = 1

local MONTHLY_TICKET_COST = 2500
local MONTHLY_TICKET_ENDING_VALUE = 3

local BANK_HISTORY_TYPE = {
  category = GUILD_HISTORY_EVENT_CATEGORY_BANKED_CURRENCY,
  eventTypeFilter = GUILD_HISTORY_BANKED_CURRENCY_EVENT_DEPOSITED,
  requireCurrencyType = CURT_MONEY
}

local gsbSavedVars = nil
local gsbBankingSavedVars = nil
local gsbLibHistoire = nil
local gsbProcessor = nil
local gsbInitialized = false
local gsbStreamGeneration = 0
local gsbMailQueueProcessing = false

local function GSB_Print(message)
  CHAT_ROUTER:AddSystemMessage("|c88CCFF[GuildSyncBanking]|r " .. tostring(message))
end

local function GSB_TimeString(timestamp)
  if not timestamp or timestamp == 0 then
    return "unknown"
  end

  return os.date("%Y-%m-%d %H:%M:%S", timestamp)
end

local function GSB_UtcTimeString(timestamp)
  if not timestamp or timestamp == 0 then
    return "unknown"
  end

  return os.date("!%Y-%m-%d %H:%M:%S UTC", timestamp)
end

local function GSB_Trim(value)
  value = tostring(value or "")

  if zo_strtrim then
    return zo_strtrim(value)
  end

  return value:match("^%s*(.-)%s*$")
end

local function GSB_GetTargetGuildId()
  local selectedId = gsbSavedVars and gsbSavedVars.targetGuildId
  local selectedName = gsbSavedVars and gsbSavedVars.targetGuildName or TARGET_GUILD_NAME
  for guildIndex = 1, GetNumGuilds() do
    local guildId = GetGuildId(guildIndex)
    local guildName = GetGuildName(guildId)

    if (selectedId and tostring(guildId) == tostring(selectedId))
      or (not selectedId and string.lower(GSB_Trim(guildName)) == string.lower(selectedName)) then
      return guildId, guildIndex, guildName
    end
  end

  GSB_Print("Could not find selected guild: " .. tostring(selectedId or selectedName))
  return nil, nil, nil
end

local function GSB_EnsureSavedVars()
  if not gsbSavedVars then
    return nil
  end

  if gsbSavedVars.lastProcessedId ~= nil then
    local numericId = tonumber(gsbSavedVars.lastProcessedId)

    if numericId then
      gsbSavedVars.lastProcessedId = numericId
    else
      GSB_Print("Saved LastProcessedId was not numeric. Clearing it.")
      gsbSavedVars.lastProcessedId = nil
    end
  end

  if gsbSavedVars.debugBanking ~= true then
    gsbSavedVars.debugBanking = false
  end

  return gsbSavedVars
end

-- Never apply a singleton checkpoint from an unidentified guild to another guild.
local function GSB_GuildCheckpoint(guildId)
  local sv = GSB_EnsureSavedVars()
  local key = tostring(guildId)
  sv.lastProcessedIdsByGuild = sv.lastProcessedIdsByGuild or {}
  if not sv.guildCheckpointMigrationComplete then
    if sv.lastProcessedId ~= nil then
      if tostring(sv.lastProcessedGuildId or "") == key then
        sv.lastProcessedIdsByGuild[key] = sv.lastProcessedIdsByGuild[key] or tonumber(sv.lastProcessedId)
      else
        sv.unboundLegacyLastProcessedId = sv.lastProcessedId
        GSB_Print("Legacy checkpoint has no matching guild identity; replaying available cached history safely.")
      end
    end
    sv.guildCheckpointMigrationComplete = true
  end
  sv.lastProcessedGuildId = key
  sv.lastProcessedId = tonumber(sv.lastProcessedIdsByGuild[key])
  return sv.lastProcessedId
end

local function GSB_AdvanceGuildCheckpoint(guildId, eventId)
  local sv = GSB_EnsureSavedVars()
  local previous = GSB_GuildCheckpoint(guildId)
  eventId = tonumber(eventId)
  if eventId and (not previous or eventId > previous) then
    sv.lastProcessedIdsByGuild[tostring(guildId)] = eventId
    sv.lastProcessedId = eventId
  end
end

local function GSB_IsDebugEnabled()
  local sv = GSB_EnsureSavedVars()

  if not sv then
    return DEBUG_BANKING
  end

  return sv.debugBanking == true
end

local function GSB_Debug(message)
  if GSB_IsDebugEnabled() then
    GSB_Print(message)
  end
end

local function GSB_EnsureBankingSavedVars()
  if not gsbBankingSavedVars then
    return nil
  end

  gsbBankingSavedVars.biweekly = gsbBankingSavedVars.biweekly or {}
  gsbBankingSavedVars.monthly = gsbBankingSavedVars.monthly or {}
  gsbBankingSavedVars.other = gsbBankingSavedVars.other or {}

  -- Desktop-created outbound mail queue.
  -- These tables are intentionally separate from ESO-controlled banking exports.
  gsbBankingSavedVars.mailQueue = gsbBankingSavedVars.mailQueue or {}
  gsbBankingSavedVars.mailAck = gsbBankingSavedVars.mailAck or {}
  gsbBankingSavedVars.sentMailIds = gsbBankingSavedVars.sentMailIds or {}

  return gsbBankingSavedVars
end

local function GSB_TableCount(tbl)
  local count = 0

  if type(tbl) ~= "table" then
    return count
  end

  for _ in pairs(tbl) do
    count = count + 1
  end

  return count
end

local function GSB_MailRequestWasSent(sentMailIds, mailRequestId)
  if type(sentMailIds) ~= "table" or not mailRequestId or mailRequestId == "" then
    return false
  end

  return sentMailIds[mailRequestId] == true or sentMailIds[mailRequestId] ~= nil
end

local function GSB_MarkMailRequestSent(sentMailIds, mailRequestId)
  if type(sentMailIds) ~= "table" or not mailRequestId or mailRequestId == "" then
    return
  end

  sentMailIds[mailRequestId] = true
end

local function GSB_CopyMailQueueItem(item)
  item = item or {}

  return {
    mail_request_id = tostring(item.mail_request_id or ""),
    event_id = tostring(item.event_id or ""),
    recipient = tostring(item.recipient or ""),
    subject = tostring(item.subject or ""),
    body = tostring(item.body or ""),
    amount = tonumber(item.amount) or 0,
    created_at = tostring(item.created_at or ""),
    batch_id = tostring(item.batch_id or ""),
    acknowledged_at = GSB_UtcTimeString(GetTimeStamp()),
  }
end

local function GSB_ProcessMailQueue()
  local bankingSv = GSB_EnsureBankingSavedVars()

  if not bankingSv then
    GSB_Print("Banking SavedVars not ready. Could not process mail queue.")
    return
  end

  local mailQueue = bankingSv.mailQueue or {}
  local mailAck = bankingSv.mailAck or {}
  local sentMailIds = bankingSv.sentMailIds or {}

  bankingSv.mailQueue = mailQueue
  bankingSv.mailAck = mailAck
  bankingSv.sentMailIds = sentMailIds

  local queuedCount = GSB_TableCount(mailQueue)

  if queuedCount == 0 then
    GSB_Print("Deposit mail queue: 0 queued, 0 sent, 0 acknowledged.")
    return
  end

  if gsbMailQueueProcessing then
    GSB_Print("Deposit mail queue is already processing.")
    return
  end

  gsbMailQueueProcessing = true

  local queueKeys = {}

  for queueKey in pairs(mailQueue) do
    table.insert(queueKeys, queueKey)
  end

  table.sort(queueKeys, function(a, b)
    return tostring(a) < tostring(b)
  end)

  local sentCount = 0
  local acknowledgedCount = 0
  local skippedAlreadySentCount = 0
  local failedCount = 0
  local mailboxWasOpenedForQueue = false

  GSB_Print(
    "Deposit mail queue: "
    .. tostring(queuedCount)
    .. " queued. Opening mailbox, waiting "
    .. tostring(MAILBOX_OPEN_DELAY_MS / 1000)
    .. " second, then sending one mail every "
    .. tostring(MAIL_SEND_DELAY_MS / 1000)
    .. " seconds."
  )

  local function finishProcessing()
    if mailboxWasOpenedForQueue then
      CloseMailbox()
      mailboxWasOpenedForQueue = false
      GSB_Print("Deposit mail queue: mailbox closed.")
    end

    gsbMailQueueProcessing = false

    GSB_Print(
      "Deposit mail queue: "
      .. tostring(queuedCount) .. " queued, "
      .. tostring(sentCount) .. " sent, "
      .. tostring(acknowledgedCount) .. " acknowledged."
    )

    if skippedAlreadySentCount > 0 then
      GSB_Print("Deposit mail duplicates skipped: " .. tostring(skippedAlreadySentCount))
    end

    if failedCount > 0 then
      GSB_Print("Deposit mail items left for review/skipped: " .. tostring(failedCount))
    end
  end

  local function processNextMail(index)
    local queueKey = queueKeys[index]

    if queueKey == nil then
      finishProcessing()
      return
    end

    local item = mailQueue[queueKey]
    local shouldDelayBeforeNextSend = false

    if type(item) ~= "table" then
      mailQueue[queueKey] = nil
    else
      local mailRequestId = tostring(item.mail_request_id or queueKey or "")
      local recipient = tostring(item.recipient or "")
      local subject = tostring(item.subject or "")
      local body = tostring(item.body or "")

      if mailRequestId == "" then
        failedCount = failedCount + 1
        GSB_Print("Skipped deposit mail with missing mail_request_id.")
      elseif GSB_MailRequestWasSent(sentMailIds, mailRequestId) then
        skippedAlreadySentCount = skippedAlreadySentCount + 1
        GSB_Print("Deposit mail already sent, acknowledging without resending: " ..
        tostring(mailRequestId) .. " -> " .. tostring(recipient))
        local ackItem = GSB_CopyMailQueueItem(item)
        ackItem.mail_request_id = mailRequestId
        ackItem.status = "already_sent"
        mailAck[mailRequestId] = ackItem
        mailQueue[queueKey] = nil
        acknowledgedCount = acknowledgedCount + 1
      elseif recipient == "" or subject == "" or body == "" then
        failedCount = failedCount + 1
        GSB_Print("Skipped deposit mail " .. tostring(mailRequestId) .. " because recipient, subject, or body was empty.")
      else
        GSB_Print("Sending deposit mail " ..
        tostring(mailRequestId) .. " to " .. tostring(recipient) .. ": " .. tostring(subject))
        SendMail(recipient, subject, body)
        GSB_MarkMailRequestSent(sentMailIds, mailRequestId)

        local ackItem = GSB_CopyMailQueueItem(item)
        ackItem.mail_request_id = mailRequestId
        ackItem.status = "sent"
        ackItem.sent_at = GSB_UtcTimeString(GetTimeStamp())
        mailAck[mailRequestId] = ackItem
        mailQueue[queueKey] = nil

        sentCount = sentCount + 1
        acknowledgedCount = acknowledgedCount + 1
        GSB_Print("Processed deposit mail " ..
        tostring(mailRequestId) ..
        " to " .. tostring(recipient) .. " (" .. tostring(sentCount) .. " of " .. tostring(queuedCount) .. ")")
        shouldDelayBeforeNextSend = true
      end
    end

    if shouldDelayBeforeNextSend then
      zo_callLater(function()
        processNextMail(index + 1)
      end, MAIL_SEND_DELAY_MS)
    else
      processNextMail(index + 1)
    end
  end

  RequestOpenMailbox()
  mailboxWasOpenedForQueue = true
  GSB_Print("Deposit mail queue: mailbox requested. Waiting before sending.")

  zo_callLater(function()
    processNextMail(1)
  end, MAILBOX_OPEN_DELAY_MS)
end

local function GSB_BankingEventAlreadySavedAnywhere(eventId, guildId)
  local bankingSv = GSB_EnsureBankingSavedVars()

  if not bankingSv then
    return false
  end

  eventId = tonumber(eventId)

  if not eventId then
    return false
  end

  local sections = {
    "biweekly",
    "monthly",
    "other",
  }

  for _, sectionName in ipairs(sections) do
    local list = bankingSv[sectionName] or {}

    for _, entry in ipairs(list) do
      if tonumber(entry.eventId) == eventId and (entry.guildId == nil or tostring(entry.guildId) == tostring(guildId)) then
        return true
      end
    end
  end

  return false
end

local function GSB_GetBankTicketKindAndAmount(amount)
  amount = tonumber(amount)

  if not amount then
    return "other", nil
  end

  local biweeklyBaseAmount = amount - BIWEEKLY_TICKET_ENDING_VALUE

  if amount >= BIWEEKLY_TICKET_COST
      and amount % 10 == BIWEEKLY_TICKET_ENDING_VALUE
      and biweeklyBaseAmount > 0
      and biweeklyBaseAmount % BIWEEKLY_TICKET_COST == 0 then
    return "biweekly", biweeklyBaseAmount / BIWEEKLY_TICKET_COST
  end

  local monthlyBaseAmount = amount - MONTHLY_TICKET_ENDING_VALUE

  if amount >= MONTHLY_TICKET_COST
      and amount % 10 == MONTHLY_TICKET_ENDING_VALUE
      and monthlyBaseAmount > 0
      and monthlyBaseAmount % MONTHLY_TICKET_COST == 0 then
    return "monthly", monthlyBaseAmount / MONTHLY_TICKET_COST
  end

  return "other", nil
end

local function GSB_SaveBankingEntry(kind, entry)
  local bankingSv = GSB_EnsureBankingSavedVars()

  if not bankingSv then
    GSB_Print("Banking SavedVars not ready. Could not save banking entry.")
    return false
  end

  if kind ~= "biweekly" and kind ~= "monthly" and kind ~= "other" then
    GSB_Print("Invalid banking section: " .. tostring(kind))
    return false
  end

  if not entry then
    return false
  end

  local eventId = tonumber(entry.eventId)

  if not eventId then
    GSB_Print("Banking entry has no numeric EventId. Not saving.")
    return false
  end

  if GSB_BankingEventAlreadySavedAnywhere(eventId, entry.guildId) then
    return false
  end

  local savedEntry = {
    eventId = eventId,
    guildId = entry.guildId,
    guildName = entry.guildName,
    time = tonumber(entry.time),
    displayName = tostring(entry.displayName or ""),
    amount = tonumber(entry.amount) or 0,
    ticketAmount = tonumber(entry.ticketAmount) or 0,
  }

  table.insert(bankingSv[kind], savedEntry)
  bankingSv.guildId = entry.guildId
  bankingSv.guildName = entry.guildName

  return true
end

local function GSB_EventPassesBankFilter(event)
  if BANK_HISTORY_TYPE.eventTypeFilter and event:GetEventType() ~= BANK_HISTORY_TYPE.eventTypeFilter then
    return false
  end

  if BANK_HISTORY_TYPE.requireCurrencyType then
    local info = event:GetEventInfo()
    local currencyType = info and info.currencyType or nil

    if currencyType ~= BANK_HISTORY_TYPE.requireCurrencyType then
      return false
    end
  end

  return true
end

local function GSB_BuildBankEntry(event)
  local info = event:GetEventInfo()

  if not info then
    return nil, nil
  end

  local amount = tonumber(info.amount) or 0
  local kind, ticketAmount = GSB_GetBankTicketKindAndAmount(amount)

  if not kind then
    return nil, nil
  end

  local entry = {
    eventId = tonumber(event:GetEventId()),
    time = tonumber(event:GetEventTimestampS()),
    displayName = tostring(info.displayName or ""),
    amount = amount,
    ticketAmount = ticketAmount,
  }

  return kind, entry
end

local function GSB_PrintBankEntry(source, kind, entry)
  if not entry then
    return
  end

  local line =
      "[" .. tostring(source) .. "/" .. tostring(kind) .. "] "
      .. "EventId=" .. tostring(entry.eventId)
      .. " Time=" .. GSB_TimeString(entry.time)
      .. " UTC=" .. GSB_UtcTimeString(entry.time)
      .. " DisplayName=" .. tostring(entry.displayName)
      .. " Amount=" .. tostring(entry.amount)

  if kind ~= "other" then
    line = line .. " TicketAmount=" .. tostring(entry.ticketAmount)
  end

  GSB_Print(line)
end

local function GSB_ProcessBankEvent(event, shouldSave, guildId, guildName)
  if not GSB_EventPassesBankFilter(event) then
    return
  end

  local kind, entry = GSB_BuildBankEntry(event)

  if not kind or not entry then
    return
  end

  if GSB_IsDebugEnabled() or not shouldSave then
    GSB_PrintBankEntry(shouldSave and "stream" or "dump", kind, entry)
  end

  if shouldSave then
    entry.guildId = tostring(guildId)
    entry.guildName = guildName
    local saved = GSB_SaveBankingEntry(kind, entry)

    if saved then
      GSB_Debug("Saved banking entry EventId=" .. tostring(entry.eventId) .. " to " .. tostring(kind) .. ".")
    else
      GSB_Debug("Banking entry EventId=" .. tostring(entry.eventId) .. " was already saved or could not be saved.")
    end
  end
end

local function GSB_CreateProcessor()
  if not gsbLibHistoire then
    GSB_Print("LibHistoire is not ready yet.")
    return nil
  end

  local guildId, guildIndex, guildName = GSB_GetTargetGuildId()

  if not guildId then
    return nil
  end

  GSB_Debug("Using guild: " ..
    tostring(guildName) .. " index=" .. tostring(guildIndex) .. " guildId=" .. tostring(guildId))

  local processor = gsbLibHistoire:CreateGuildHistoryProcessor(
    guildId,
    BANK_HISTORY_TYPE.category,
    ADDON_NAME .. "-bank"
  )

  if not processor then
    GSB_Print("Processor could not be created for banking.")
    GSB_Print("LibHistoire may not have a cache for this guild/category yet.")
    return nil
  end

  GSB_Debug("Processor key: " .. tostring(processor:GetKey()))

  return processor, guildId, guildName
end

local function GSB_StopStream()
  gsbStreamGeneration = gsbStreamGeneration + 1
  if not gsbProcessor then
    return true
  end

  if not gsbProcessor.Stop then
    GSB_Print("Bank processor does not expose Stop().")
    return false
  end
  gsbProcessor:Stop()

  gsbProcessor = nil
  return true
end

local function GSB_DumpBankHistory()
  if not gsbLibHistoire then
    GSB_Print("LibHistoire is not ready yet.")
    return
  end

  local processor, guildId, guildName = GSB_CreateProcessor()

  if not processor then
    return
  end

  if processor.SetStopOnLastCachedEvent then
    processor:SetStopOnLastCachedEvent(true)
  end

  local startTime = 0
  local endTime = GetTimeStamp()

  GSB_Print("Starting review-only dump of all cached banking data.")
  GSB_Print("Dump does not save banking rows and does not update LastProcessedId.")
  GSB_Print("Start: " .. GSB_TimeString(startTime) .. " / " .. GSB_UtcTimeString(startTime))
  GSB_Print("End: " .. GSB_TimeString(endTime) .. " / " .. GSB_UtcTimeString(endTime))

  local started = processor:StartIteratingTimeRange(
    startTime,
    endTime,
    function(event)
      GSB_ProcessBankEvent(event, false)
    end,
    function(reason)
      GSB_Print("Banking dump stopped. Reason=" .. tostring(reason))
    end
  )

  if not started then
    GSB_Print("Banking dump could not be started.")
  else
    GSB_Print("Banking dump started.")
  end
end

local function GSB_StartStream()
  if not gsbLibHistoire then
    GSB_Print("LibHistoire is not ready yet.")
    return
  end

  if gsbProcessor and gsbProcessor:IsRunning() then
    GSB_Debug("Bank stream is already running.")
    return
  end

  local sv = GSB_EnsureSavedVars()

  if not sv then
    GSB_Print("SavedVars not ready.")
    return
  end

  local processor, guildId, guildName = GSB_CreateProcessor()

  if not processor then
    return
  end

  if not processor.StartStreaming then
    GSB_Print("This processor does not have StartStreaming(). Your LibHistoire version may be outdated.")
    return
  end

  local lastProcessedId = GSB_GuildCheckpoint(guildId)
  gsbStreamGeneration = gsbStreamGeneration + 1
  local generation = gsbStreamGeneration
  gsbProcessor = processor

  if lastProcessedId ~= nil then
    lastProcessedId = tonumber(lastProcessedId)

    if not lastProcessedId then
      GSB_Print("Saved LastProcessedId was not numeric. Clearing it.")
      sv.lastProcessedId = nil
      lastProcessedId = nil
    end
  end

  if lastProcessedId then
    GSB_Print("Starting bank stream after saved LastProcessedId=" .. tostring(lastProcessedId))
  else
    GSB_Print("Starting bank stream from the beginning because LastProcessedId is not set.")
  end

  local started = processor:StartStreaming(lastProcessedId, function(event)
    if generation ~= gsbStreamGeneration or gsbProcessor ~= processor then return end
    local eventId = tonumber(event:GetEventId())

    if eventId then
      GSB_AdvanceGuildCheckpoint(guildId, eventId)
    end

    GSB_ProcessBankEvent(event, true, guildId, guildName)
  end)

  if not started then
    gsbProcessor = nil
    gsbStreamGeneration = gsbStreamGeneration + 1
    GSB_Print("Bank stream could not be started. It may already be running.")
    return
  end

  gsbProcessor = processor

  GSB_Print("Bank stream started.")
end

local function GSB_ResetStream()
  local guildId = GSB_GetTargetGuildId()
  if not guildId then return end
  GSB_Print("Reset requested. Stopping stream, clearing LastProcessedId, and starting again from the beginning.")

  if not GSB_StopStream() then return end

  local sv = GSB_EnsureSavedVars()

  if sv then
    GSB_GuildCheckpoint(guildId)
    sv.lastProcessedIdsByGuild[tostring(guildId)] = nil
    sv.lastProcessedId = nil
  end

  GSB_StartStream()
end

local function GSB_Status()
  local guildId, _, guildName = GSB_GetTargetGuildId()
  if guildId then
    GSB_GuildCheckpoint(guildId)
    GSB_Print("Guild: " .. tostring(guildName) .. " / ESO guild ID: " .. tostring(guildId))
  end
  local sv = GSB_EnsureSavedVars()
  local lastProcessedId = sv and sv.lastProcessedId or nil

  if gsbProcessor then
    GSB_Print("Bank stream running: " .. tostring(gsbProcessor:IsRunning()))
  else
    GSB_Print("Bank stream running: false")
  end

  GSB_Print("LastProcessedId=" .. tostring(lastProcessedId))
  GSB_Print("Debug banking output: " .. tostring(GSB_IsDebugEnabled()))
end

local function GSB_SetDebug(value)
  local sv = GSB_EnsureSavedVars()

  if not sv then
    GSB_Print("SavedVars not ready.")
    return
  end

  sv.debugBanking = value == true

  if sv.debugBanking then
    GSB_Print("Debug banking output enabled.")
  else
    GSB_Print("Debug banking output disabled.")
  end
end

local function GSB_SelectGuild(query)
  query = string.lower(GSB_Trim(query))
  if query == "" then GSB_Status(); GSB_Print("Usage: /gsb guild <guild name or ESO guild ID>"); return end
  local state, banking = GSB_EnsureSavedVars(), GSB_EnsureBankingSavedVars()
  for index = 1, GetNumGuilds() do
    local id = GetGuildId(index)
    local name = GetGuildName(id)
    if query == tostring(id) or query == string.lower(GSB_Trim(name)) then
      if next(banking.biweekly) or next(banking.monthly) or next(banking.other)
        or next(banking.mailQueue) or next(banking.mailAck) then
        GSB_Print("Upload pending deposits and finish queued receipt acknowledgements before changing guilds. Nothing was changed.")
        return
      end
      if not GSB_StopStream() then return end
      state.targetGuildId, state.targetGuildName = tostring(id), name
      banking.guildId, banking.guildName = tostring(id), name
      GSB_Print("Selected guild " .. name .. " / ESO guild ID: " .. tostring(id))
      GSB_StartStream()
      return
    end
  end
  GSB_Print("No joined guild matches that name or ESO guild ID. Nothing was changed.")
end

local function GSB_PrintHelp()
  GSB_Print("Commands:")
  GSB_Print("/gsb dump - Review all cached banking deposits. Does not save or update LastProcessedId.")
  GSB_Print("/gsb stream - Stream banking deposits after saved LastProcessedId, or from the beginning if not set.")
  GSB_Print("/gsb stop - Stop the active banking stream.")
  GSB_Print("/gsb reset - Stop stream, clear LastProcessedId, and start stream from the beginning.")
  GSB_Print("/gsb status - Show stream status and LastProcessedId.")
  GSB_Print("/gsb guild <name or ESO guild ID> - Select the guild after pending deposits and mail acknowledgements are uploaded.")
  GSB_Print("/gsb debug on - Enable detailed banking event chat output.")
  GSB_Print("/gsb debug off - Disable detailed banking event chat output.")
end

local function GSB_HandleCommand(args)
  args = GSB_Trim(args)

  local command, rest = args:match("^(%S+)%s*(.-)$")
  command = string.lower(GSB_Trim(command or ""))
  rest = string.lower(GSB_Trim(rest or ""))

  if command == "" or command == "help" then
    GSB_PrintHelp()
    return
  end

  if command == "dump" then
    GSB_DumpBankHistory()
    return
  end

  if command == "stream" then
    GSB_StartStream()
    return
  end

  if command == "stop" then
    local stopped = GSB_StopStream()
    GSB_Print("Bank stream stopped: " .. tostring(stopped))
    return
  end

  if command == "reset" then
    GSB_ResetStream()
    return
  end

  if command == "status" then
    GSB_Status()
    return
  end

  if command == "guild" then GSB_SelectGuild(rest); return end

  if command == "debug" then
    if rest == "on" then
      GSB_SetDebug(true)
      return
    end

    if rest == "off" then
      GSB_SetDebug(false)
      return
    end

    GSB_Print("Usage: /gsb debug on")
    GSB_Print("Usage: /gsb debug off")
    return
  end

  GSB_Print("Unknown command: " .. tostring(command))
  GSB_PrintHelp()
end

local function GSB_InitLibHistoire()
  if gsbInitialized then
    return
  end

  if not LibHistoire then
    GSB_Print("LibHistoire global not found. Is LibHistoire enabled and listed as a dependency?")
    return
  end

  gsbInitialized = true
  GSB_Print("Waiting for LibHistoire OnReady...")

  LibHistoire:OnReady(function(lib)
    gsbLibHistoire = lib

    GSB_Print("LibHistoire is ready.")
    GSB_StartStream()
  end)
end

local function OnAddonLoaded(eventCode, addonName)
  if addonName ~= ADDON_NAME then
    return
  end

  EVENT_MANAGER:UnregisterForEvent(ADDON_NAME, EVENT_ADD_ON_LOADED)

  gsbSavedVars = ZO_SavedVars:NewAccountWide(
    SAVED_VARS_NAME,
    SAVED_VARS_VERSION,
    nil,
    {
      lastProcessedId = nil,
      debugBanking = false,
    }
  )

  gsbBankingSavedVars = ZO_SavedVars:NewAccountWide(
    BANKING_SAVED_VARS_NAME,
    BANKING_SAVED_VARS_VERSION,
    nil,
    {
      biweekly = {},
      monthly = {},
      other = {},
      mailQueue = {},
      mailAck = {},
      sentMailIds = {},
    }
  )

  GSB_EnsureSavedVars()
  GSB_EnsureBankingSavedVars()
  GSB_ProcessMailQueue()

  SLASH_COMMANDS["/gsb"] = GSB_HandleCommand

  GSB_Print("GuildSyncBanking loaded.")
  GSB_Print("Bank stream will start automatically when LibHistoire is ready.")
  GSB_Print("Use /gsb help for commands.")

  GSB_InitLibHistoire()
end

EVENT_MANAGER:RegisterForEvent(
  ADDON_NAME,
  EVENT_ADD_ON_LOADED,
  OnAddonLoaded
)
