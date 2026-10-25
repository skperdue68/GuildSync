-- Keep the addon runtime table separate from the SavedVariables global.
-- GuildSyncApplications is reserved by ## SavedVariables and must only contain persisted data.
local GSA = {}

GSA.name = "GuildSyncApplications"
GSA.version = "1.4.2"

local WELCOME_GUILD_NAME = "Alphabet Mafia"


local DEFAULT_WELCOME_MESSAGES = {
  {
    title = "Classic Godfather",
    message = "The Family has made {name} an offer they couldn't refuse! Please welcome our newest member to the Alphabet Mafia.  Check out our Discord, listed on the guild's \"G\" tab by default, for events, guild info, and all the queer organized crime you can handle.",
  },
  {
    title = "Getting made",
    message = "{name} just got MADE! Please welcome the newest member of the Alphabet Mafia Family. Your first assignment: check out our Discord, listed on the guild's \"G\" tab by default, for upcoming events, guild info, and to meet your fellow queer partners in crime.",
  },
  {
    title = "Maximum Camp",
    message = "Someone alert the authorities: the Alphabet Mafia is recruiting again! Please welcome our newest fabulous accomplice, {name}! Check out our Discord on the guild's \"G\" tab by default for events, information, questionable associates, and further instructions from the Family.",
  },
  {
    title = "The Family Business",
    message = "Family business! Please welcome {name}, our newest associate in the Alphabet Mafia.  You'll find our Discord listed on the guild's \"G\" tab by default. Stop by for events, guild information, and to meet the rest of your new queer crime Family. Remember: no talking to the guards!",
  },
  {
    title = "Queer Mafi",
    message = "The Alphabet Mafia grows stronger! Everyone welcome our newest partner in queer organized crime, {name}. Your initiation begins with our Discord, listed on the guild's \"G\" tab by default. You'll find upcoming events, guild information, and the rest of your new chosen Family waiting inside.",
  },
}
local DEFAULT_WELCOME_EMAILS = {
  {
    title = "Classic Godfather",
    subject = "Welcome to the Family {name}",
    body = "Dear {name},\n\nWe've been watching you. Don't worry, it's less threatening than it sounds.\n\nYou've been made an offer you couldn't refuse, so welcome to the Alphabet Mafia! Our slightly disorganized organized-crime Family specializes in dungeons, trials, questionable fashion and queer shenanigans across Tamriel.\n\nYour initiation is simple: have fun, be kind, and remember that snitches get stitches. Unless you're snitching about an adorable pet. Then pictures are required.\n\nWelcome to the Family!\n\n--The Alphabet Mafia Consiglieri\n\nP.S. Join us: discord.gg/alphabetmafia\nPlease set your server name to your ESO Account name. Pet pictures are \"technically\" optional.",
  },
  {
    title = "You've been made",
    subject = "Congratulations - You've Been Made {name}",
    body = "Dear {name},\n\nCongratulations. You've been MADE.\n\nYou are officially a member of the Alphabet Mafia Family! Your duties may include dungeons, trials, antiquities, fashion crimes, decorating empty houses, and other queer mischief across Tamriel.\n\nFamily rules are simple: be kind, help when you can, ask when you need it, and join the fun. Mention a pet and photographic evidence may be demanded.\n\nMay your loot be plentiful, your wipes hilarious, and your fashion crimes fabulous!\n\n--The Alphabet Mafia Consiglieri\n\nP.S. Report to headquarters: discord.gg/alphabetmafia\nPlease set your server name to match your ESO Account name. It helps us identify our accomplices.",
  },
  {
    title = "Maximum Camp",
    subject = "Welcome to the Alphabet Mafia {name}",
    body = "Dear {name},\n\nDarling, you're in.\n\nThe votes were counted, the wigs secured, somebody dramatically kissed a ring, and the Family has spoken. Welcome to the Alphabet Mafia!\n\nWe specialize in being queer, fabulous, occasionally competent, and causing trouble across Tamriel. Expect dungeons, trials, housing, questionable jokes, helpful advice, and far too much time discussing outfits.\n\nJoin the fun, ask for help, and remember: mention a pet and pictures are required. We don't make the rules. Actually, we do.\n\n--The Alphabet Mafia Consiglieri\n\nP.S. Join us: discord.gg/alphabetmafia\nPlease set your server name to your ESO Account name so we can identify our accomplices.",
  },
  {
    title = "The Initiation",
    subject = "Your Alphabet Mafia Initiation {name}",
    body = "Dear {name},\n\nYour application has been reviewed by several shadowy figures in an undisclosed back room. After intense deliberation, dramatic lighting, and at least one completely unnecessary monologue, a decision has been reached.\n\nYou're in.\n\nWelcome to the Alphabet Mafia!\n\nYou are now part of a proud criminal tradition of being queer, causing trouble across Tamriel, collecting entirely too many furnishings, standing around talking when we were supposed to start the dungeon ten minutes ago, and looking fabulous while doing it.\n\nYour initiation is relatively painless. Say hello. Join some events. Ask for help when you need it. Help another Family member when you can. Be yourself. Have fun.\n\nThere is no blood oath.\n\nWe considered one, but the paperwork was ridiculous.\n\nThere is, however, a pet tax. If you have pets, we expect pictures. Failure to comply may result in someone asking you again.\n\nWelcome to the Family, {name}. Your alibi starts now.\n\n--The Alphabet Mafia Consiglieri\n\nP.S. Join the rest of the Family at discord.gg/alphabetmafia and please change your server name to match your ESO Account name. We run a respectable criminal organization and need to know who everyone is.",
  },
  {
    title = "The Family Handbook",
    subject = "A Message From the Family",
    body = "Dear {name},\n\nWelcome to the Alphabet Mafia. By opening this letter, you've accepted an offer you couldn't refuse. Don't worry, the benefits are excellent.\n\nOur queer criminal network specializes in dungeons, trials, housing, terrible jokes, fabulous outfits, and helping Family survive Tamriel.\n\nThe rules: be kind, ask for help, help others when you can, and have fun. Mention an adorable pet and you've surrendered your right to withhold pictures.\n\n--The Alphabet Mafia Consiglieri\n\nP.S. Join us: discord.gg/alphabetmafia\nPlease set your server name to your ESO Account name.\n\nP.P.S. Seriously. We weren't joking about the pet pictures.",
  },
}
local DEFAULT_WELCOME_CHAT_MESSAGE = DEFAULT_WELCOME_MESSAGES[1].message
local DEFAULT_WELCOME_MAIL_SUBJECT = DEFAULT_WELCOME_EMAILS[1].subject
local DEFAULT_WELCOME_MAIL_BODY = DEFAULT_WELCOME_EMAILS[1].body
local WELCOME_MESSAGE_MAX_LENGTH = 335
local LAM_MAX_VISIBLE_CUSTOM_ENTRIES = 200

GSA.pendingRestoreState = nil
GSA.restoreWatcherEventName = GSA.name .. "_RestoreWatcher"
GSA.restoreWatcherTimeoutName = GSA.name .. "_RestoreWatcherTimeout"
GSA.hookRetryName = GSA.name .. "_HookRetry"
GSA.hookAttempts = 0
GSA.maxHookAttempts = 20

local function Chat(message)
  if CHAT_ROUTER and CHAT_ROUTER.AddSystemMessage then
    CHAT_ROUTER:AddSystemMessage(message)
  elseif d then
    d(message)
  end
end

local function SafeText(value)
  if value == nil then return "" end
  return tostring(value)
end

local function Trim(value)
  value = SafeText(value)
  return value:match("^%s*(.-)%s*$") or ""
end

local function Lower(value)
  if zo_strlower then
    return zo_strlower(SafeText(value))
  end

  return string.lower(SafeText(value))
end

local function Now()
  return GetTimeStamp()
end

local function DateTimeFromTimestamp(timestamp)
  if not timestamp or timestamp <= 0 then
    return ""
  end

  return os.date("%Y-%m-%d %H:%M:%S", timestamp)
end

local function GetOfficerName()
  return GetDisplayName() or ""
end

local function GetGuildNameSafe(guildId)
  if guildId and GetGuildName then
    return GetGuildName(guildId) or ""
  end

  return ""
end

local function GetGuildIndexByName(guildName)
  if not GetNumGuilds or not GetGuildId then
    return nil, nil
  end

  for guildIndex = 1, GetNumGuilds() do
    local guildId = GetGuildId(guildIndex)

    if GetGuildNameSafe(guildId) == guildName then
      return guildIndex, guildId
    end
  end

  return nil, nil
end

local function GetOfficerChannelForGuildIndex(guildIndex)
  if guildIndex == 1 then return CHAT_CHANNEL_OFFICER_1 end
  if guildIndex == 2 then return CHAT_CHANNEL_OFFICER_2 end
  if guildIndex == 3 then return CHAT_CHANNEL_OFFICER_3 end
  if guildIndex == 4 then return CHAT_CHANNEL_OFFICER_4 end
  if guildIndex == 5 then return CHAT_CHANNEL_OFFICER_5 end

  return nil
end

local function PlayGuildSyncAlertSound()
  if PlaySound and SOUNDS then
    if SOUNDS.NEW_NOTIFICATION then
      PlaySound(SOUNDS.NEW_NOTIFICATION)
    elseif SOUNDS.CHAT_ALERT then
      PlaySound(SOUNDS.CHAT_ALERT)
    elseif SOUNDS.POSITIVE_CLICK then
      PlaySound(SOUNDS.POSITIVE_CLICK)
    elseif SOUNDS.DEFAULT_CLICK then
      PlaySound(SOUNDS.DEFAULT_CLICK)
    end
  end
end

function GSA:GetPreciseChatChannelInfo()
  if not CHAT_SYSTEM or not CHAT_SYSTEM.GetCurrentChannelData then
    return nil
  end

  local channelData, target = CHAT_SYSTEM:GetCurrentChannelData()
  if not channelData then
    return nil
  end

  local channelId = channelData.id
  local info = {
    id = channelId,
    target = target,
    kind = "unknown",
    index = nil,
    short = "unknown",
  }

  if channelId == CHAT_CHANNEL_ZONE then
    info.kind = "zone"
    info.short = "zone"
  elseif channelId == CHAT_CHANNEL_PARTY then
    info.kind = "group"
    info.short = "group"
  elseif channelId == CHAT_CHANNEL_SAY then
    info.kind = "say"
    info.short = "say"
  elseif channelId == CHAT_CHANNEL_YELL then
    info.kind = "yell"
    info.short = "yell"
  elseif channelId == CHAT_CHANNEL_EMOTE then
    info.kind = "emote"
    info.short = "emote"
  elseif channelId == CHAT_CHANNEL_WHISPER or channelId == CHAT_CHANNEL_WHISPER_SENT then
    info.kind = "tell"
    info.short = "tell"
  elseif channelId >= CHAT_CHANNEL_GUILD_1 and channelId <= CHAT_CHANNEL_GUILD_5 then
    local index = channelId - CHAT_CHANNEL_GUILD_1 + 1
    info.kind = "guild"
    info.index = index
    info.short = "g" .. index
  elseif channelId >= CHAT_CHANNEL_OFFICER_1 and channelId <= CHAT_CHANNEL_OFFICER_5 then
    local index = channelId - CHAT_CHANNEL_OFFICER_1 + 1
    info.kind = "officer"
    info.index = index
    info.short = "o" .. index
  end

  return info
end

function GSA:RestoreChatChannel(channelInfo)
  if not channelInfo or not CHAT_SYSTEM or not channelInfo.id then
    return false
  end

  if CHAT_SYSTEM.SetChannel then
    CHAT_SYSTEM:SetChannel(channelInfo.id, channelInfo.target)
    return true
  end

  return false
end

function GSA:ClearPendingChatBuffer()
  local cleared = false

  if CHAT_SYSTEM and CHAT_SYSTEM.textEntry and CHAT_SYSTEM.textEntry.EditControl then
    local editControl = CHAT_SYSTEM.textEntry.EditControl

    if editControl.SetText then
      editControl:SetText("")
      cleared = true
    end

    if editControl.LoseFocus then
      editControl:LoseFocus()
    end
  end

  if CHAT_SYSTEM and CHAT_SYSTEM.textEntry then
    if CHAT_SYSTEM.textEntry.SetText then
      CHAT_SYSTEM.textEntry:SetText("")
      cleared = true
    end

    if CHAT_SYSTEM.textEntry.LoseFocus then
      CHAT_SYSTEM.textEntry:LoseFocus()
    end
  end

  if ZO_ChatWindowTextEntryEditBox then
    if ZO_ChatWindowTextEntryEditBox.SetText then
      ZO_ChatWindowTextEntryEditBox:SetText("")
      cleared = true
    end

    if ZO_ChatWindowTextEntryEditBox.LoseFocus then
      ZO_ChatWindowTextEntryEditBox:LoseFocus()
    end
  end

  if CHAT_SYSTEM and CHAT_SYSTEM.Maximize then
    CHAT_SYSTEM:Maximize()
  end

  if CHAT_SYSTEM and CHAT_SYSTEM.Minimize then
    CHAT_SYSTEM:Minimize()
  end

  return cleared
end

function GSA:NormalizeChatText(text)
  local value = Trim(text or "")
  value = Lower(value)
  value = value:gsub("|c%x%x%x%x%x%x", "")
  value = value:gsub("|r", "")
  value = value:gsub("[%c]", " ")
  value = value:gsub("[%p]", " ")
  value = value:gsub("%s+", " ")
  return Trim(value)
end

function GSA:IsOutgoingChatMessageType(messageType)
  if type(messageType) ~= "number" then
    return false
  end

  if messageType == CHAT_CHANNEL_SAY
      or messageType == CHAT_CHANNEL_YELL
      or messageType == CHAT_CHANNEL_EMOTE
      or messageType == CHAT_CHANNEL_PARTY
      or messageType == CHAT_CHANNEL_ZONE
      or messageType == CHAT_CHANNEL_WHISPER
      or messageType == CHAT_CHANNEL_WHISPER_SENT
      or (messageType >= CHAT_CHANNEL_GUILD_1 and messageType <= CHAT_CHANNEL_GUILD_5)
      or (messageType >= CHAT_CHANNEL_OFFICER_1 and messageType <= CHAT_CHANNEL_OFFICER_5) then
    return true
  end

  if messageType == CHAT_CATEGORY_SAY
      or messageType == CHAT_CATEGORY_YELL
      or messageType == CHAT_CATEGORY_EMOTE
      or messageType == CHAT_CATEGORY_PARTY
      or messageType == CHAT_CATEGORY_ZONE
      or messageType == CHAT_CATEGORY_WHISPER_SENT
      or messageType == CHAT_CATEGORY_WHISPER
      or messageType == CHAT_CATEGORY_GUILD_1
      or messageType == CHAT_CATEGORY_GUILD_2
      or messageType == CHAT_CATEGORY_GUILD_3
      or messageType == CHAT_CATEGORY_GUILD_4
      or messageType == CHAT_CATEGORY_GUILD_5
      or messageType == CHAT_CATEGORY_OFFICER_1
      or messageType == CHAT_CATEGORY_OFFICER_2
      or messageType == CHAT_CATEGORY_OFFICER_3
      or messageType == CHAT_CATEGORY_OFFICER_4
      or messageType == CHAT_CATEGORY_OFFICER_5 then
    return true
  end

  return false
end

function GSA:ClearPendingRestoreState(reason)
  self.pendingRestoreState = nil
  EVENT_MANAGER:UnregisterForEvent(self.restoreWatcherEventName, EVENT_CHAT_MESSAGE_CHANNEL)
  EVENT_MANAGER:UnregisterForUpdate(self.restoreWatcherTimeoutName)
end

function GSA:HandleRestoreWatcherChatMessage(eventCode, messageType, fromName, text, isCustomerService)
  local state = self.pendingRestoreState
  if not state then
    return
  end

  if not self:IsOutgoingChatMessageType(messageType) then
    return
  end

  local expected = SafeText(state.expectedText)
  local actual = self:NormalizeChatText(text or "")

  if expected == "" or actual == "" then
    return
  end

  if expected ~= actual then
    return
  end

  self:RestoreChatChannel(state.previousChannel)
  self:ClearPendingRestoreState("watcher matched outgoing message")
end

function GSA:ArmPendingRestoreState(previousChannelInfo, expectedText, timeoutSeconds)
  self:ClearPendingRestoreState("arming new restore state")

  if not previousChannelInfo or not previousChannelInfo.id then
    return false
  end

  local normalizedExpected = self:NormalizeChatText(expectedText)
  if normalizedExpected == "" then
    return false
  end

  timeoutSeconds = tonumber(timeoutSeconds) or 60

  self.pendingRestoreState = {
    previousChannel = previousChannelInfo,
    expectedText = normalizedExpected,
    timeoutSeconds = timeoutSeconds,
    armedAt = GetFrameTimeMilliseconds and GetFrameTimeMilliseconds() or nil,
  }

  EVENT_MANAGER:RegisterForEvent(
    self.restoreWatcherEventName,
    EVENT_CHAT_MESSAGE_CHANNEL,
    function(...)
      GSA:HandleRestoreWatcherChatMessage(...)
    end
  )

  EVENT_MANAGER:RegisterForUpdate(self.restoreWatcherTimeoutName, timeoutSeconds * 1000, function()
    local pendingState = GSA.pendingRestoreState

    if pendingState and pendingState.previousChannel then
      GSA:RestoreChatChannel(pendingState.previousChannel)
    end

    GSA:ClearPendingChatBuffer()
    GSA:ClearPendingRestoreState("restore timeout")
  end)

  return true
end

function GSA:GetDefaultSettings()
  return {
    welcomeMessages = {},
    welcomeEmails = {},
    nextWelcomeMessageId = 1,
    nextWelcomeEmailId = 1,
    welcomeMessagePickSequence = 0,
    welcomeEmailPickSequence = 0,
  }
end

function GSA:EnsureSettings()
  self.saved = self.saved or {}
  self.saved.settings = self.saved.settings or self:GetDefaultSettings()

  local settings = self.saved.settings
  settings.welcomeMessages = self:NormalizeWelcomeSettingsList(settings.welcomeMessages or {}, "message")
  settings.welcomeEmails = self:NormalizeWelcomeSettingsList(settings.welcomeEmails or {}, "email")
  -- Seed each empty category once; never overwrite custom text or restore deleted entries.
  if not settings.welcomeDefaultsInitialized then
    local function SeedDefaults(list, defaults)
      if #list > 0 then return end
      for index, template in ipairs(defaults) do
        local entry = {
          id = index, enabled = true, createdByUser = true,
          useCount = 0, lastUsed = 0, lastPickedSequence = 0,
        }
        for key, value in pairs(template) do entry[key] = value end
        table.insert(list, entry)
      end
    end
    SeedDefaults(settings.welcomeMessages, DEFAULT_WELCOME_MESSAGES)
    SeedDefaults(settings.welcomeEmails, DEFAULT_WELCOME_EMAILS)
    settings.welcomeDefaultsInitialized = true
  end
  settings.nextWelcomeMessageId = tonumber(settings.nextWelcomeMessageId) or 1
  settings.nextWelcomeEmailId = tonumber(settings.nextWelcomeEmailId) or 1
  settings.welcomeMessagePickSequence = tonumber(settings.welcomeMessagePickSequence) or 0
  settings.welcomeEmailPickSequence = tonumber(settings.welcomeEmailPickSequence) or 0

  for _, entry in ipairs(settings.welcomeMessages) do
    if tonumber(entry.id) and tonumber(entry.id) >= settings.nextWelcomeMessageId then
      settings.nextWelcomeMessageId = tonumber(entry.id) + 1
    end
  end

  for _, entry in ipairs(settings.welcomeEmails) do
    if tonumber(entry.id) and tonumber(entry.id) >= settings.nextWelcomeEmailId then
      settings.nextWelcomeEmailId = tonumber(entry.id) + 1
    end
  end

  return settings
end

function GSA:CountItems(items)
  local count = 0

  if type(items) ~= "table" then
    return count
  end

  for _, _ in pairs(items) do
    count = count + 1
  end

  return count
end

function GSA:NormalizeWelcomeSettingsList(items, kind)
  if type(items) ~= "table" then
    return {}
  end

  local normalized = {}

  for _, entry in ipairs(items) do
    if type(entry) == "table" then
      local hasContent = false

      if kind == "message" then
        entry.message = self:ClampWelcomeMessage(entry.message or "")
        hasContent = Trim(entry.message) ~= ""
      else
        entry.subject = SafeText(entry.subject or "")
        entry.body = SafeText(entry.body or "")
        hasContent = Trim(entry.subject) ~= "" or Trim(entry.body) ~= ""
      end

      -- Only saved/custom entries with actual content should be shown.
      -- Older patch builds could create blank placeholder sections; strip those out here.
      if hasContent then
        entry.createdByUser = true
        entry.enabled = entry.enabled ~= false
        entry.title = SafeText(entry.title or "")
        entry.id = tonumber(entry.id) or (#normalized + 1)
        entry.lastUsed = tonumber(entry.lastUsed) or 0
        entry.useCount = tonumber(entry.useCount) or 0
        entry.lastPickedSequence = tonumber(entry.lastPickedSequence) or 0
        table.insert(normalized, entry)
      end
    end
  end

  return normalized
end

function GSA:ClampWelcomeMessage(value)
  value = SafeText(value)

  if string.len(value) > WELCOME_MESSAGE_MAX_LENGTH then
    value = string.sub(value, 1, WELCOME_MESSAGE_MAX_LENGTH)
  end

  return value
end

function GSA:GetDraftBucket(kind)
  self.settingsDrafts = self.settingsDrafts or {}
  self.settingsDrafts[kind] = self.settingsDrafts[kind] or {}
  return self.settingsDrafts[kind]
end

function GSA:CopyWelcomeEntry(entry, kind)
  local copy = {}

  copy.enabled = (not entry) or entry.enabled ~= false

  if kind == "message" then
    copy.title = SafeText(entry and entry.title or "")
    copy.message = self:ClampWelcomeMessage(entry and entry.message or "")
  else
    copy.title = SafeText(entry and entry.title or "")
    copy.subject = SafeText(entry and entry.subject or "")
    copy.body = SafeText(entry and entry.body or "")
  end

  return copy
end

function GSA:GetDraftForEntry(kind, entry)
  if not entry or not entry.id then
    return nil
  end

  local bucket = self:GetDraftBucket(kind)
  local draft = bucket[entry.id]

  if not draft then
    draft = self:CopyWelcomeEntry(entry, kind)
    draft.dirty = false
    bucket[entry.id] = draft
  end

  return draft
end

function GSA:MarkDraftDirty(kind, entry)
  local draft = self:GetDraftForEntry(kind, entry)

  if draft then
    draft.dirty = true
  end
end

function GSA:ClearDraft(kind, entry)
  if not entry or not entry.id then
    return
  end

  local bucket = self:GetDraftBucket(kind)
  bucket[entry.id] = nil
end

function GSA:GetPendingNewDrafts(kind)
  self.pendingNewDrafts = self.pendingNewDrafts or {}
  self.pendingNewDrafts[kind] = self.pendingNewDrafts[kind] or {}
  return self.pendingNewDrafts[kind]
end

function GSA:AddPendingNewDraft(kind, draft)
  local drafts = self:GetPendingNewDrafts(kind)
  draft.tempId = self.nextDraftTempId or 1
  self.nextDraftTempId = draft.tempId + 1
  table.insert(drafts, draft)
  return draft
end

function GSA:GetPendingNewDraft(kind, index)
  local drafts = self:GetPendingNewDrafts(kind)
  return drafts[index]
end

function GSA:RemovePendingNewDraft(kind, index)
  local drafts = self:GetPendingNewDrafts(kind)
  if drafts[index] then
    table.remove(drafts, index)
  end
end

function GSA:CountPendingNewDrafts(kind)
  return self:CountItems(self:GetPendingNewDrafts(kind))
end

function GSA:RefreshSettingsPanel()
  if self.settingsControls then
    if self.settingsControls.messageEditorHolder and self.settingsControls.messageEditorHolder.RefreshEditor then
      self.settingsControls.messageEditorHolder:RefreshEditor()
    end
    if self.settingsControls.emailEditorHolder and self.settingsControls.emailEditorHolder.RefreshEditor then
      self.settingsControls.emailEditorHolder:RefreshEditor()
    end
  end

  local LAM = LibAddonMenu2 or LibStub and LibStub("LibAddonMenu-2.0", true)

  if LAM and LAM.util and LAM.util.RequestRefreshIfNeeded then
    LAM.util.RequestRefreshIfNeeded(_G[self.name .. "Settings"])
  end
end

function GSA:SetEditorSelection(kind, mode, index)
  self.settingsEditorSelection = self.settingsEditorSelection or {}
  self.settingsEditorSelection[kind] = { mode = mode, index = index }
end

function GSA:GetEditorSelection(kind)
  self.settingsEditorSelection = self.settingsEditorSelection or {}
  local selection = self.settingsEditorSelection[kind]
  local settings = self:EnsureSettings()
  local savedList = kind == "message" and settings.welcomeMessages or settings.welcomeEmails
  local draftList = self:GetPendingNewDrafts(kind)

  if selection then
    if selection.mode == "draft" and draftList[selection.index] then
      return selection
    end

    if selection.mode == "saved" and savedList[selection.index] then
      return selection
    end
  end

  if #draftList > 0 then
    selection = { mode = "draft", index = 1 }
  elseif #savedList > 0 then
    selection = { mode = "saved", index = 1 }
  else
    selection = { mode = "none", index = 0 }
  end

  self.settingsEditorSelection[kind] = selection
  return selection
end

function GSA:GetActiveEditorEntry(kind)
  local selection = self:GetEditorSelection(kind)
  local settings = self:EnsureSettings()

  if selection.mode == "draft" then
    return self:GetPendingNewDraft(kind, selection.index), selection
  elseif selection.mode == "saved" then
    local list = kind == "message" and settings.welcomeMessages or settings.welcomeEmails
    return list[selection.index], selection
  end

  return nil, selection
end

function GSA:GetActiveEditorDraft(kind)
  local entry, selection = self:GetActiveEditorEntry(kind)
  if not entry then return nil, selection end

  if selection.mode == "saved" then
    return self:GetDraftForEntry(kind, entry), selection, entry
  end

  return entry, selection, nil
end

function GSA:SelectNextEditorEntry(kind, delta)
  local settings = self:EnsureSettings()
  local items = {}

  for index, _ in ipairs(self:GetPendingNewDrafts(kind)) do
    table.insert(items, { mode = "draft", index = index })
  end

  local savedList = kind == "message" and settings.welcomeMessages or settings.welcomeEmails
  for index, _ in ipairs(savedList) do
    table.insert(items, { mode = "saved", index = index })
  end

  if #items == 0 then
    self:SetEditorSelection(kind, "none", 0)
    self:RefreshSettingsPanel()
    return
  end

  local current = self:GetEditorSelection(kind)
  local position = 1
  for i, item in ipairs(items) do
    if item.mode == current.mode and item.index == current.index then
      position = i
      break
    end
  end

  position = position + delta
  if position < 1 then position = #items end
  if position > #items then position = 1 end

  self:SetEditorSelection(kind, items[position].mode, items[position].index)
  self:RefreshSettingsPanel()
end

function GSA:CreateWelcomeMessage()
  local settings = self:EnsureSettings()
  local draftNumber = (settings.nextWelcomeMessageId or 1) + self:CountPendingNewDrafts("message")

  self:AddPendingNewDraft("message", {
    title = "Welcome Message " .. SafeText(draftNumber),
    message = "",
    enabled = true,
    dirty = false,
  })

  self:SetEditorSelection("message", "draft", self:CountPendingNewDrafts("message"))
  self:RefreshSettingsPanel()
  Chat("|c66ff66GuildSyncApplications:|r new welcome message editor opened. Enter a name and message, then click Save.")
end

function GSA:CreateWelcomeEmail()
  local settings = self:EnsureSettings()
  local draftNumber = (settings.nextWelcomeEmailId or 1) + self:CountPendingNewDrafts("email")

  self:AddPendingNewDraft("email", {
    title = "Welcome Email " .. SafeText(draftNumber),
    subject = "",
    body = "",
    enabled = true,
    dirty = false,
  })

  self:SetEditorSelection("email", "draft", self:CountPendingNewDrafts("email"))
  self:RefreshSettingsPanel()
  Chat(
    "|c66ff66GuildSyncApplications:|r new welcome email editor opened. Enter a name, subject, and body, then click Save.")
end

function GSA:SaveNewWelcomeMessage(draftIndex)
  local settings = self:EnsureSettings()
  local draft = self:GetPendingNewDraft("message", draftIndex)

  if not draft then return end

  local message = self:ClampWelcomeMessage(draft.message)

  if Trim(message) == "" then
    Chat("|cffff66GuildSyncApplications:|r welcome message text is required before saving.")
    return
  end

  local id = settings.nextWelcomeMessageId
  settings.nextWelcomeMessageId = id + 1

  local title = Trim(draft.title)
  if title == "" then
    title = "Welcome Message " .. SafeText(id)
  end

  local entry = {
    id = id,
    enabled = draft.enabled ~= false,
    createdByUser = true,
    title = title,
    message = message,
    lastUsed = 0,
    useCount = 0,
    lastPickedSequence = 0,
  }

  table.insert(settings.welcomeMessages, entry)
  self:RemovePendingNewDraft("message", draftIndex)
  self:SetEditorSelection("message", "saved", #settings.welcomeMessages)
  self:RefreshSettingsPanel()
  Chat("|c66ff66GuildSyncApplications:|r welcome message saved.")
end

function GSA:SaveNewWelcomeEmail(draftIndex)
  local settings = self:EnsureSettings()
  local draft = self:GetPendingNewDraft("email", draftIndex)

  if not draft then return end

  local subject = SafeText(draft.subject)
  local body = SafeText(draft.body)

  if Trim(subject) == "" or Trim(body) == "" then
    Chat("|cffff66GuildSyncApplications:|r welcome email subject and body are both required before saving.")
    return
  end

  local id = settings.nextWelcomeEmailId
  settings.nextWelcomeEmailId = id + 1

  local title = Trim(draft.title)
  if title == "" then
    title = "Welcome Email " .. SafeText(id)
  end

  local entry = {
    id = id,
    enabled = draft.enabled ~= false,
    createdByUser = true,
    title = title,
    subject = subject,
    body = body,
    lastUsed = 0,
    useCount = 0,
    lastPickedSequence = 0,
  }

  table.insert(settings.welcomeEmails, entry)
  self:RemovePendingNewDraft("email", draftIndex)
  self:SetEditorSelection("email", "saved", #settings.welcomeEmails)
  self:RefreshSettingsPanel()
  Chat("|c66ff66GuildSyncApplications:|r welcome email saved.")
end

function GSA:CancelNewWelcomeMessage(draftIndex)
  self:RemovePendingNewDraft("message", draftIndex)
  self:SetEditorSelection("message", nil, nil)
  self:RefreshSettingsPanel()
end

function GSA:CancelNewWelcomeEmail(draftIndex)
  self:RemovePendingNewDraft("email", draftIndex)
  self:SetEditorSelection("email", nil, nil)
  self:RefreshSettingsPanel()
end

function GSA:SaveActiveWelcomeMessage()
  local _, selection = self:GetActiveEditorEntry("message")
  if selection.mode == "draft" then
    self:SaveNewWelcomeMessage(selection.index)
  elseif selection.mode == "saved" then
    self:SaveWelcomeMessage(selection.index)
  else
    Chat("|cffff66GuildSyncApplications:|r no welcome message is selected.")
  end
end

function GSA:SaveActiveWelcomeEmail()
  local _, selection = self:GetActiveEditorEntry("email")
  if selection.mode == "draft" then
    self:SaveNewWelcomeEmail(selection.index)
  elseif selection.mode == "saved" then
    self:SaveWelcomeEmail(selection.index)
  else
    Chat("|cffff66GuildSyncApplications:|r no welcome email is selected.")
  end
end

function GSA:DeleteOrCancelActiveWelcomeMessage()
  local _, selection = self:GetActiveEditorEntry("message")
  if selection.mode == "draft" then
    self:CancelNewWelcomeMessage(selection.index)
  elseif selection.mode == "saved" then
    self:DeleteWelcomeMessage(selection.index)
    self:SetEditorSelection("message", nil, nil)
  end
end

function GSA:DeleteOrCancelActiveWelcomeEmail()
  local _, selection = self:GetActiveEditorEntry("email")
  if selection.mode == "draft" then
    self:CancelNewWelcomeEmail(selection.index)
  elseif selection.mode == "saved" then
    self:DeleteWelcomeEmail(selection.index)
    self:SetEditorSelection("email", nil, nil)
  end
end

function GSA:SaveWelcomeMessage(index)
  local settings = self:EnsureSettings()
  local entry = settings.welcomeMessages[index]

  if not entry then return end

  local draft = self:GetDraftForEntry("message", entry)
  local title = Trim(draft.title)
  local message = self:ClampWelcomeMessage(draft.message)

  if title == "" then
    title = "Welcome Message " .. SafeText(entry.id or index)
  end

  if Trim(message) == "" then
    Chat("|cffff66GuildSyncApplications:|r welcome message text is required before saving.")
    return
  end

  entry.createdByUser = true
  entry.enabled = draft.enabled ~= false
  entry.title = title
  entry.message = message
  draft.title = title
  draft.message = message
  draft.dirty = false

  self:RefreshSettingsPanel()
  Chat("|c66ff66GuildSyncApplications:|r welcome message saved.")
end

function GSA:SaveWelcomeEmail(index)
  local settings = self:EnsureSettings()
  local entry = settings.welcomeEmails[index]

  if not entry then return end

  local draft = self:GetDraftForEntry("email", entry)
  local title = Trim(draft.title)
  local subject = SafeText(draft.subject)
  local body = SafeText(draft.body)

  if title == "" then
    title = "Welcome Email " .. SafeText(entry.id or index)
  end

  if Trim(subject) == "" or Trim(body) == "" then
    Chat("|cffff66GuildSyncApplications:|r welcome email subject and body are both required before saving.")
    return
  end

  entry.createdByUser = true
  entry.enabled = draft.enabled ~= false
  entry.title = title
  entry.subject = subject
  entry.body = body
  draft.title = title
  draft.subject = subject
  draft.body = body
  draft.dirty = false

  self:RefreshSettingsPanel()
  Chat("|c66ff66GuildSyncApplications:|r welcome email saved.")
end

function GSA:SetWelcomeMessageEnabled(index, enabled)
  local settings = self:EnsureSettings()
  local entry = settings.welcomeMessages[index]

  if entry then
    entry.enabled = enabled == true
    self:RefreshSettingsPanel()
  end
end

function GSA:SetWelcomeEmailEnabled(index, enabled)
  local settings = self:EnsureSettings()
  local entry = settings.welcomeEmails[index]

  if entry then
    entry.enabled = enabled == true
    self:RefreshSettingsPanel()
  end
end

function GSA:DeleteWelcomeMessage(index)
  local settings = self:EnsureSettings()
  local entry = settings.welcomeMessages[index]

  if entry then
    self:ClearDraft("message", entry)
    table.remove(settings.welcomeMessages, index)
    self:RefreshSettingsPanel()
    Chat("|c66ff66GuildSyncApplications:|r custom welcome message deleted.")
  end
end

function GSA:DeleteWelcomeEmail(index)
  local settings = self:EnsureSettings()
  local entry = settings.welcomeEmails[index]

  if entry then
    self:ClearDraft("email", entry)
    table.remove(settings.welcomeEmails, index)
    self:RefreshSettingsPanel()
    Chat("|c66ff66GuildSyncApplications:|r custom welcome email deleted.")
  end
end

function GSA:ApplyApplicantPlaceholder(template, applicantAccount)
  local value = SafeText(template)
  local name = SafeText(applicantAccount)

  value = value:gsub("{name}", name)
  return value
end

function GSA:IncrementPickSequence(kind)
  local settings = self:EnsureSettings()

  if kind == "message" then
    settings.welcomeMessagePickSequence = (tonumber(settings.welcomeMessagePickSequence) or 0) + 1
    return settings.welcomeMessagePickSequence
  end

  settings.welcomeEmailPickSequence = (tonumber(settings.welcomeEmailPickSequence) or 0) + 1
  return settings.welcomeEmailPickSequence
end

function GSA:CalculateWeightedSelectionValue(item, newestSequence, highestUseCount)
  -- SmartChat-style rotation: keep selection random, but heavily favor entries
  -- that have not been picked recently and lightly favor entries used fewer times.
  local lastSequence = tonumber(item.lastPickedSequence) or 0
  local useCount = tonumber(item.useCount) or 0
  local sequenceAge

  if lastSequence <= 0 then
    sequenceAge = newestSequence + 1
  else
    sequenceAge = math.max(1, newestSequence - lastSequence + 1)
  end

  local usageBonus = math.max(0, highestUseCount - useCount) + 1

  -- Squaring the sequence age makes the most-recently-used item much less likely
  -- without completely banning it when there are only a few enabled entries.
  return math.max(1, (sequenceAge * sequenceAge) + usageBonus)
end

function GSA:PickWeightedItem(items, validator, kind)
  local enabled = {}
  local newestSequence = 0
  local highestUseCount = 0

  if type(items) ~= "table" then
    return nil
  end

  for _, item in ipairs(items) do
    if item and item.enabled ~= false and (not validator or validator(item)) then
      item.lastPickedSequence = tonumber(item.lastPickedSequence) or 0
      item.useCount = tonumber(item.useCount) or 0
      item.lastUsed = tonumber(item.lastUsed) or 0

      if item.lastPickedSequence > newestSequence then
        newestSequence = item.lastPickedSequence
      end

      if item.useCount > highestUseCount then
        highestUseCount = item.useCount
      end

      table.insert(enabled, item)
    end
  end

  if #enabled == 0 then
    return nil
  end

  local totalWeight = 0

  for _, item in ipairs(enabled) do
    item.__gsaWeight = self:CalculateWeightedSelectionValue(item, newestSequence, highestUseCount)
    totalWeight = totalWeight + item.__gsaWeight
  end

  local roll = math.random() * totalWeight
  local running = 0

  for _, item in ipairs(enabled) do
    running = running + item.__gsaWeight

    if roll <= running then
      item.__gsaWeight = nil
      item.lastUsed = Now()
      item.useCount = (tonumber(item.useCount) or 0) + 1
      item.lastPickedSequence = self:IncrementPickSequence(kind)
      return item
    end

    item.__gsaWeight = nil
  end

  local fallback = enabled[#enabled]
  fallback.__gsaWeight = nil
  fallback.lastUsed = Now()
  fallback.useCount = (tonumber(fallback.useCount) or 0) + 1
  fallback.lastPickedSequence = self:IncrementPickSequence(kind)
  return fallback
end

function GSA:GetWelcomeChatMessage(applicantAccount)
  local settings = self:EnsureSettings()
  local item = self:PickWeightedItem(settings.welcomeMessages, function(candidate)
    return Trim(candidate.message) ~= ""
  end, "message")

  if item then
    return self:ApplyApplicantPlaceholder(item.message, applicantAccount)
  end

  return self:ApplyApplicantPlaceholder(DEFAULT_WELCOME_CHAT_MESSAGE, applicantAccount)
end

function GSA:GetWelcomeEmail(applicantAccount)
  local settings = self:EnsureSettings()
  local item = self:PickWeightedItem(settings.welcomeEmails, function(candidate)
    return Trim(candidate.subject) ~= "" and Trim(candidate.body) ~= ""
  end, "email")

  if item then
    return self:ApplyApplicantPlaceholder(item.subject, applicantAccount),
        self:ApplyApplicantPlaceholder(item.body, applicantAccount)
  end

  return self:ApplyApplicantPlaceholder(DEFAULT_WELCOME_MAIL_SUBJECT, applicantAccount),
      self:ApplyApplicantPlaceholder(DEFAULT_WELCOME_MAIL_BODY, applicantAccount)
end

local function CreateGSASettingsLabel(parent, name, font)
  local label = WINDOW_MANAGER:CreateControl(name, parent, CT_LABEL)
  label:SetFont(font or "ZoFontWinH4")
  label:SetWrapMode(TEXT_WRAP_MODE_ELLIPSIS)
  return label
end

local function CreateGSASettingsButton(parent, name, text)
  local button
  if WINDOW_MANAGER.CreateControlFromVirtual then
    button = WINDOW_MANAGER:CreateControlFromVirtual(name, parent, "ZO_DefaultButton")
  end

  if not button then
    button = WINDOW_MANAGER:CreateControl(name, parent, CT_BUTTON)
    if button.SetFont then button:SetFont("ZoFontWinH4") end
  end

  button:SetText(text or "")
  button:SetDimensions(190, 28)
  return button
end

local function CreateGSASettingsEditBox(parent, name, multiline, maxChars)
  local container = WINDOW_MANAGER:CreateControl(name .. "Container", parent, CT_CONTROL)

  local backdrop = WINDOW_MANAGER:CreateControlFromVirtual(name .. "Backdrop", container, "ZO_EditBackdrop")
  backdrop:SetAnchorFill(container)

  local editTemplate = multiline == true and "ZO_DefaultEditMultiLineForBackdrop" or "ZO_DefaultEditForBackdrop"
  local edit = WINDOW_MANAGER:CreateControlFromVirtual(name, backdrop, editTemplate)
  edit:SetAnchorFill(backdrop)
  edit:SetFont(multiline == true and "ZoFontChat" or "ZoFontWinH4")
  edit:SetMaxInputChars(maxChars or 3000)
  edit:SetMouseEnabled(true)

  if edit.SetEditEnabled then
    edit:SetEditEnabled(true)
  end

  if edit.SetTextType then
    edit:SetTextType(TEXT_TYPE_ALL)
  end

  container.backdrop = backdrop
  container.edit = edit
  return container, edit
end

local function SetEditBoxTextWithoutCallback(edit, value)
  if not edit then return end
  value = SafeText(value)
  edit.gsaSuppressChange = true
  if edit:GetText() ~= value then
    edit:SetText(value)
  end
  edit.gsaSuppressChange = false
end

local function RefreshWelcomeEditorStatusOnly(control, kind)
  if control and control.status and GSA and GSA.GetWelcomeEditorStatusText then
    control.status:SetText(GSA:GetWelcomeEditorStatusText(kind))
  end
end

function GSA:GetWelcomeEditorTotalCount(kind)
  local settings = self:EnsureSettings()
  local savedList = kind == "message" and settings.welcomeMessages or settings.welcomeEmails
  return #self:GetPendingNewDrafts(kind) + #savedList
end

function GSA:GetWelcomeEditorStatusText(kind)
  local draft, selection, entry = self:GetActiveEditorDraft(kind)
  local settings = self:EnsureSettings()
  local savedCount = kind == "message" and #settings.welcomeMessages or #settings.welcomeEmails
  local draftCount = #self:GetPendingNewDrafts(kind)

  if not draft then
    if kind == "message" then
      return
      "No custom welcome messages have been saved yet. Click Add Welcome Message to create one. The built-in default is hidden and used only as fallback. Custom chat messages are limited to 335 characters."
    end

    return
    "No custom welcome emails have been saved yet. Click Add Welcome Email to create one. The built-in default is hidden and used only as fallback. Subject and body are both required before a custom email can be saved."
  end

  local label = selection.mode == "draft" and "Unsaved draft" or "Saved entry"
  local enabledText = draft.enabled == false and
      "|c999999Disabled: this entry will not be used until enabled and saved.|r" or
      "Enabled: this entry can be used once saved."
  local dirtyText = draft.dirty and " | |cffff66Unsaved changes|r" or ""
  return label ..
      " " .. SafeText(selection.index) .. " of " .. SafeText(draftCount + savedCount) .. dirtyText .. "\n" .. enabledText
end

function GSA:GetWelcomeEditorActiveTitle(kind)
  local draft, selection = self:GetActiveEditorDraft(kind)
  if not draft then return "No entry selected" end

  local prefix = kind == "message" and "Welcome Message" or "Welcome Email"
  local title = Trim(draft.title)
  if title == "" then title = prefix .. " " .. SafeText(selection.index) end

  if selection.mode == "draft" then
    return title .. " (Unsaved)"
  end

  if draft.enabled == false then
    return title .. " (Disabled)"
  end

  return title
end

function GSA:BuildWelcomeEditorCustomControl(parent, kind)
  local container = WINDOW_MANAGER:CreateControl(
    self.name .. "Welcome" .. (kind == "message" and "Message" or "Email") .. "CustomContainer", parent, CT_CONTROL)
  container:SetDimensions(700, 90)

  container.gsaKind = kind
  local control = container
  local prefix = kind == "message" and "Message" or "Email"
  local baseName = self.name .. "Welcome" .. prefix .. "Custom"

  control.status = CreateGSASettingsLabel(control, baseName .. "Status", "ZoFontGame")
  control.addButton = CreateGSASettingsButton(control, baseName .. "AddButton",
    kind == "message" and "Add Welcome Message" or "Add Welcome Email")
  control.selectedTitle = CreateGSASettingsLabel(control, baseName .. "SelectedTitle", "ZoFontWinH3")
  control.previousButton = CreateGSASettingsButton(control, baseName .. "PreviousButton",
    kind == "message" and "Previous Message" or "Previous Email")
  control.nextButton = CreateGSASettingsButton(control, baseName .. "NextButton",
    kind == "message" and "Next Message" or "Next Email")
  control.enabledButton = CreateGSASettingsButton(control, baseName .. "EnabledButton", "Enabled: ON")
  control.nameLabel = CreateGSASettingsLabel(control, baseName .. "NameLabel", "ZoFontWinH4")
  control.nameBox, control.nameEdit = CreateGSASettingsEditBox(control, baseName .. "NameEdit", false, 80)
  control.primaryLabel = CreateGSASettingsLabel(control, baseName .. "PrimaryLabel", "ZoFontWinH4")
  control.primaryBox, control.primaryEdit = CreateGSASettingsEditBox(control, baseName .. "PrimaryEdit",
    kind == "message", kind == "message" and WELCOME_MESSAGE_MAX_LENGTH or 200)

  if kind == "email" then
    control.bodyLabel = CreateGSASettingsLabel(control, baseName .. "BodyLabel", "ZoFontWinH4")
    control.bodyBox, control.bodyEdit = CreateGSASettingsEditBox(control, baseName .. "BodyEdit", true, 3000)
  end

  control.saveButton = CreateGSASettingsButton(control, baseName .. "SaveButton",
    kind == "message" and "Save Message" or "Save Email")
  control.deleteButton = CreateGSASettingsButton(control, baseName .. "DeleteButton",
    kind == "message" and "Delete Message" or "Delete Email")

  control.addButton:SetHandler("OnClicked", function()
    if kind == "message" then GSA:CreateWelcomeMessage() else GSA:CreateWelcomeEmail() end
  end)
  control.previousButton:SetHandler("OnClicked", function() GSA:SelectNextEditorEntry(kind, -1) end)
  control.nextButton:SetHandler("OnClicked", function() GSA:SelectNextEditorEntry(kind, 1) end)
  control.enabledButton:SetHandler("OnClicked", function()
    local draft, selection, entry = GSA:GetActiveEditorDraft(kind)
    if not draft then return end

    local newEnabled = not (draft.enabled ~= false)

    -- Enable/Disable is intentionally immediate and independent from the Save button.
    -- For saved entries, persist only the enabled flag right away while preserving
    -- any unsaved text/name edits already in the draft. Toggling this flag by
    -- itself must not create an Unsaved Changes warning.
    draft.enabled = newEnabled

    if selection and selection.mode == "saved" and entry then
      entry.enabled = newEnabled
      Chat("|c66ff66GuildSyncApplications:|r " ..
        (kind == "message" and "welcome message" or "welcome email") .. " " .. (newEnabled and "enabled." or "disabled."))
    end

    GSA:RefreshSettingsPanel()
  end)
  control.saveButton:SetHandler("OnClicked", function()
    if kind == "message" then GSA:SaveActiveWelcomeMessage() else GSA:SaveActiveWelcomeEmail() end
  end)
  control.deleteButton:SetHandler("OnClicked", function()
    if kind == "message" then GSA:DeleteOrCancelActiveWelcomeMessage() else GSA:DeleteOrCancelActiveWelcomeEmail() end
  end)

  control.nameEdit:SetHandler("OnTextChanged", function(edit)
    if edit.gsaSuppressChange then return end
    local draft = GSA:GetActiveEditorDraft(kind)
    if draft then
      draft.title = SafeText(edit:GetText())
      draft.dirty = true
      RefreshWelcomeEditorStatusOnly(control, kind)
    end
  end)

  control.primaryEdit:SetHandler("OnTextChanged", function(edit)
    if edit.gsaSuppressChange then return end
    local draft = GSA:GetActiveEditorDraft(kind)
    if draft then
      if kind == "message" then
        draft.message = GSA:ClampWelcomeMessage(edit:GetText())
      else
        draft.subject = SafeText(edit:GetText())
      end
      draft.dirty = true
      RefreshWelcomeEditorStatusOnly(control, kind)
    end
  end)

  if kind == "email" and control.bodyEdit then
    control.bodyEdit:SetHandler("OnTextChanged", function(edit)
      if edit.gsaSuppressChange then return end
      local draft = GSA:GetActiveEditorDraft("email")
      if draft then
        draft.body = SafeText(edit:GetText())
        draft.dirty = true
        RefreshWelcomeEditorStatusOnly(control, "email")
      end
    end)
  end

  control.RefreshEditor = function()
    GSA:RefreshWelcomeEditorCustomControl(control, kind)
  end

  control:RefreshEditor()
  return control
end

function GSA:RefreshWelcomeEditorCustomControl(control, kind)
  if not control then return end

  local width = control:GetWidth() or 700
  if width < 400 then width = 700 end
  local x = 0
  local y = 0
  local gap = 8
  local lineHeight = 26
  local fieldWidth = 592 -- approximately 74 visible characters, kept inside the LAM panel border
  if fieldWidth > width - 42 then fieldWidth = width - 42 end
  local buttonWidth = 175
  local navButtonWidth = 142
  local buttonGap = 8
  local draft, selection = self:GetActiveEditorDraft(kind)
  local hasEditor = draft ~= nil
  local totalCount = self:GetWelcomeEditorTotalCount(kind)

  local function Place(c, cx, cy, cw, ch)
    if not c then return end
    c:ClearAnchors()
    c:SetAnchor(TOPLEFT, control, TOPLEFT, cx, cy)
    c:SetDimensions(cw, ch)
    c:SetHidden(false)
  end

  local function Hide(c)
    if c then c:SetHidden(true) end
  end

  control.status:SetText(self:GetWelcomeEditorStatusText(kind))
  Place(control.status, x, y, fieldWidth, 70)
  y = y + 74

  -- Add stays visible for the section, but is now left aligned directly under the enabled/disabled status line.
  Place(control.addButton, x, y, buttonWidth, 28)
  y = y + 38

  if not hasEditor then
    Hide(control.selectedTitle)
    Hide(control.previousButton)
    Hide(control.nextButton)
    Hide(control.enabledButton)
    Hide(control.nameLabel)
    Hide(control.nameBox)
    Hide(control.primaryLabel)
    Hide(control.primaryBox)
    Hide(control.bodyLabel)
    Hide(control.bodyBox)
    Hide(control.saveButton)
    Hide(control.deleteButton)
    control:SetHeight(y)
    return
  end

  control.selectedTitle:SetText((kind == "message" and "Selected Message: " or "Selected Email: ") ..
    self:GetWelcomeEditorActiveTitle(kind))
  Place(control.selectedTitle, x, y, fieldWidth, lineHeight)
  y = y + lineHeight + 6

  if totalCount > 1 then
    -- Previous / Next are on one left-aligned row under Selected Message/Email.
    Place(control.previousButton, x, y, navButtonWidth, 28)
    Place(control.nextButton, x + navButtonWidth + buttonGap, y, navButtonWidth, 28)
    y = y + 28 + 18
  else
    Hide(control.previousButton)
    Hide(control.nextButton)
    y = y + 18
  end

  control.nameLabel:SetText("Name")
  Place(control.nameLabel, x, y, fieldWidth - buttonWidth - 12, lineHeight)
  control.enabledButton:SetText(draft.enabled == false and "Enable" or "Disable")
  Place(control.enabledButton, fieldWidth - buttonWidth, y, buttonWidth, 28)
  y = y + lineHeight
  Place(control.nameBox, x, y, fieldWidth, 34)
  SetEditBoxTextWithoutCallback(control.nameEdit, draft.title)
  y = y + 34 + gap

  if kind == "message" then
    control.primaryLabel:SetText("Welcome Message ({name} may be used; 335 character max)")
    Place(control.primaryLabel, x, y, fieldWidth, lineHeight)
    y = y + lineHeight
    Place(control.primaryBox, x, y, fieldWidth, 150)
    SetEditBoxTextWithoutCallback(control.primaryEdit, draft.message)
    Hide(control.bodyLabel)
    Hide(control.bodyBox)
    y = y + 150 + gap
  else
    control.primaryLabel:SetText("Subject ({name} may be used)")
    Place(control.primaryLabel, x, y, fieldWidth, lineHeight)
    y = y + lineHeight
    Place(control.primaryBox, x, y, fieldWidth, 34)
    SetEditBoxTextWithoutCallback(control.primaryEdit, draft.subject)
    y = y + 34 + gap

    control.bodyLabel:SetText("Email Body ({name} may be used)")
    Place(control.bodyLabel, x, y, fieldWidth, lineHeight)
    y = y + lineHeight
    Place(control.bodyBox, x, y, fieldWidth, 250)
    SetEditBoxTextWithoutCallback(control.bodyEdit, draft.body)
    y = y + 250 + gap
  end

  -- Save and Delete/Cancel are on the same left-aligned row.
  Place(control.saveButton, x, y, buttonWidth, 28)
  control.deleteButton:SetText(selection.mode == "draft" and "Cancel Draft" or
    (kind == "message" and "Delete Message" or "Delete Email"))
  Place(control.deleteButton, x + buttonWidth + buttonGap, y, buttonWidth, 28)
  y = y + 38

  control:SetHeight(y)
end

function GSA:BuildSettingsOptions()
  return {
    {
      type = "description",
      text =
      "Create custom welcome chat messages and welcome emails. Use {name} anywhere you want the applicant account name inserted. Built-in defaults are hidden and used only when no enabled saved custom entry exists.",
    },
    {
      type = "submenu",
      name = "Welcome Messages",
      controls = {
        {
          type = "custom",
          reference = self.name .. "WelcomeMessagesCustomEditor",
          width = "full",
          createFunc = function(control)
            control:SetHeight(90)
            GSA.settingsControls = GSA.settingsControls or {}
            GSA.settingsControls.messageEditorHolder = GSA:BuildWelcomeEditorCustomControl(control, "message")
            GSA.settingsControls.messageEditorHolder:SetAnchor(TOPLEFT, control, TOPLEFT, 0, 0)
            control:SetHeight(GSA.settingsControls.messageEditorHolder:GetHeight())
          end,
          refreshFunc = function(control)
            local holder = GSA.settingsControls and GSA.settingsControls.messageEditorHolder
            if holder and holder.RefreshEditor then
              holder:RefreshEditor()
              control:SetHeight(holder:GetHeight())
            end
          end,
        },
      },
    },
    {
      type = "submenu",
      name = "Welcome Emails",
      controls = {
        {
          type = "custom",
          reference = self.name .. "WelcomeEmailsCustomEditor",
          width = "full",
          createFunc = function(control)
            control:SetHeight(90)
            GSA.settingsControls = GSA.settingsControls or {}
            GSA.settingsControls.emailEditorHolder = GSA:BuildWelcomeEditorCustomControl(control, "email")
            GSA.settingsControls.emailEditorHolder:SetAnchor(TOPLEFT, control, TOPLEFT, 0, 0)
            control:SetHeight(GSA.settingsControls.emailEditorHolder:GetHeight())
          end,
          refreshFunc = function(control)
            local holder = GSA.settingsControls and GSA.settingsControls.emailEditorHolder
            if holder and holder.RefreshEditor then
              holder:RefreshEditor()
              control:SetHeight(holder:GetHeight())
            end
          end,
        },
      },
    },
  }
end

function GSA:RebuildSettingsPanel()
  local LAM = LibAddonMenu2 or LibStub and LibStub("LibAddonMenu-2.0", true)

  if not LAM then return end

  -- Re-register only the controls that should exist right now.
  -- This avoids LibAddonMenu submenu hidden-state quirks that displayed placeholder rows.
  LAM:RegisterOptionControls(self.name .. "Settings", self:BuildSettingsOptions())

  if LAM.util and LAM.util.RequestRefreshIfNeeded then
    LAM.util.RequestRefreshIfNeeded(_G[self.name .. "Settings"])
  end
end

function GSA:RegisterSettingsPanel()
  local LAM = LibAddonMenu2 or LibStub and LibStub("LibAddonMenu-2.0", true)

  if not LAM then
    Chat("|cffff66GuildSyncApplications:|r LibAddonMenu-2.0 is required for settings.")
    return
  end

  local panelData = {
    type = "panel",
    name = "GuildSync Applications",
    displayName = "GuildSync Applications",
    author = "Stephanie",
    version = self.version,
    registerForRefresh = true,
    registerForDefaults = false,
  }

  self.settingsPanel = LAM:RegisterAddonPanel(self.name .. "Settings", panelData)
  self.settingsPanelRegistered = true
  self:RebuildSettingsPanel()
end

function GSA:OpenSettings()
  local LAM = LibAddonMenu2 or LibStub and LibStub("LibAddonMenu-2.0", true)

  if not LAM then
    Chat("|cffff66GuildSyncApplications:|r LibAddonMenu-2.0 is required for settings.")
    return
  end

  if not self.settingsPanelRegistered or not self.settingsPanel then
    self:RegisterSettingsPanel()
  end

  if self.settingsPanel and LAM.OpenToPanel then
    LAM:OpenToPanel(self.settingsPanel)
    self:RefreshSettingsPanel()
  else
    Chat("|cffff66GuildSyncApplications:|r settings panel is not available yet.")
  end
end

local function IsAccountOnlineInGuild(guildId, accountName)
  accountName = SafeText(accountName)

  if accountName == "" then
    return false
  end

  if not guildId or not GetNumGuildMembers or not GetGuildMemberInfo then
    return false
  end

  for memberIndex = 1, GetNumGuildMembers(guildId) do
    local displayName, _, _, status = GetGuildMemberInfo(guildId, memberIndex)

    if SafeText(displayName) == accountName then
      return status ~= PLAYER_STATUS_OFFLINE
    end
  end

  return false
end

local function IsAccountMemberInGuild(guildId, accountName)
  accountName = SafeText(accountName)

  if accountName == "" then
    return false
  end

  if not guildId or not GetNumGuildMembers or not GetGuildMemberInfo then
    return false
  end

  for memberIndex = 1, GetNumGuildMembers(guildId) do
    local displayName = GetGuildMemberInfo(guildId, memberIndex)

    if SafeText(displayName) == accountName then
      return true
    end
  end

  return false
end

function GSA:PopulateOfficerWelcomeMessage(applicantAccount)
  local captureGuildId = GSA.saved and GSA.saved.settings and GSA.saved.settings.captureGuildId
  local welcomeGuildName = captureGuildId and GetGuildName(tonumber(captureGuildId)) or WELCOME_GUILD_NAME
  local guildIndex, guildId = GetGuildIndexByName(welcomeGuildName)

  if not guildIndex or not guildId then
    Chat("|cffff66GuildSyncApplications:|r could not find guild " ..
      welcomeGuildName .. " for officer welcome message.")
    return false
  end

  if not IsAccountOnlineInGuild(guildId, applicantAccount) then
    Chat("|cffff66GuildSyncApplications:|r " ..
      SafeText(applicantAccount) ..
      " is not showing online in " .. welcomeGuildName .. ". Officer message was not queued.")
    return false
  end

  local officerChannel = GetOfficerChannelForGuildIndex(guildIndex)

  if not officerChannel then
    Chat("|cffff66GuildSyncApplications:|r could not determine officer chat channel for guild slot " ..
      SafeText(guildIndex) .. ".")
    return false
  end

  local message = self:GetWelcomeChatMessage(applicantAccount)

  local previousChannelInfo = self:GetPreciseChatChannelInfo()
  self:ArmPendingRestoreState(previousChannelInfo, message, 60)

  StartChatInput(message, officerChannel)
  PlayGuildSyncAlertSound()

  Chat("|c66ff66GuildSyncApplications:|r officer welcome message populated in chat buffer. Press Enter to send it.")
  return true
end

local function QueueOfficerWelcomeMessage(applicantAccount)
  zo_callLater(function()
    GSA:PopulateOfficerWelcomeMessage(applicantAccount)
  end, 1000)
end

local function SendWelcomeMail(applicantAccount)
  local recipient = SafeText(applicantAccount)

  if recipient == "" then
    Chat("|cffff66GuildSyncApplications:|r could not send welcome mail because applicant account was blank.")
    return
  end

  local subject, body = GSA:GetWelcomeEmail(recipient)

  zo_callLater(function()
    RequestOpenMailbox()

    zo_callLater(function()
      SendMail(recipient, subject, body)

      zo_callLater(function()
        CloseMailbox()
      end, 1000)
    end, 1500)
  end, 1000)
end

function GSA:GetApplicationDataFromArgs(guildId, index)
  local data = {
    guildId = guildId,
    index = index,
    guildName = GetGuildNameSafe(guildId),
  }

  if guildId and index and GetGuildFinderGuildApplicationInfoAt then
    local level,
    championPoints,
    alliance,
    classId,
    accountName,
    characterName,
    achievementPoints,
    applicationMessage = GetGuildFinderGuildApplicationInfoAt(guildId, index)

    data.level = level
    data.championPoints = championPoints
    data.alliance = alliance
    data.classId = classId
    data.applicantAccount = accountName
    data.characterName = characterName
    data.achievementPoints = achievementPoints
    data.applicationText = applicationMessage
  end

  if guildId and index and GetGuildFinderGuildApplicationDuration then
    data.durationRemainingSeconds = GetGuildFinderGuildApplicationDuration(guildId, index)
  end

  return data
end

function GSA:SaveApplicationRecord(record, applicantKey)
  self.saved.records = self.saved.records or {}

  self.saved.records[applicantKey] = record

  Chat(string.format(
    "|c66ff66GuildSyncApplications:|r captured %s application for %s",
    record.action,
    record.applicantAccount ~= "" and record.applicantAccount or "unknown applicant"
  ))
end

function GSA:RemoveApplicationRecord(applicantKey)
  if self.saved and self.saved.records and applicantKey and applicantKey ~= "" then
    self.saved.records[applicantKey] = nil
  end
end

function GSA:SaveApplicationDecision(action, guildId, index, declineMessage, blacklistApplicant, blacklistMessage)
  local captureGuildId = self.saved and self.saved.settings and self.saved.settings.captureGuildId
  if captureGuildId and tostring(guildId) ~= tostring(captureGuildId) then return end
  self.saved.records = self.saved.records or {}

  local capturedAt = Now()
  local applicationData = self:GetApplicationDataFromArgs(guildId, index)

  local record = {
    capturedAt = capturedAt,
    capturedDateTime = DateTimeFromTimestamp(capturedAt),

    action = action,
    officerAccount = GetOfficerName(),

    guildId = applicationData.guildId,
    guildName = SafeText(applicationData.guildName),
    applicationIndex = applicationData.index,

    applicantAccount = SafeText(applicationData.applicantAccount),
    characterName = SafeText(applicationData.characterName),
    applicationText = SafeText(applicationData.applicationText),

    level = applicationData.level,
    championPoints = applicationData.championPoints,
    alliance = applicationData.alliance,
    classId = applicationData.classId,
    achievementPoints = applicationData.achievementPoints,

    durationRemainingSeconds = applicationData.durationRemainingSeconds,

    declineMessage = SafeText(declineMessage),
    blacklistApplicant = blacklistApplicant == true,
    blacklistMessage = SafeText(blacklistMessage),
  }

  local applicantKey = record.applicantAccount

  if applicantKey == "" then
    applicantKey = "unknown_" .. SafeText(capturedAt)
  end

  if action ~= "accepted" then
    self:SaveApplicationRecord(record, applicantKey)
    return
  end

  -- Accept hooks run before ESO completes the accept action. Wait briefly, then
  -- confirm the applicant actually became a guild member before persisting the
  -- application record or triggering welcome chat/mail side effects.
  zo_callLater(function()
    if not IsAccountMemberInGuild(record.guildId, record.applicantAccount) then
      GSA:RemoveApplicationRecord(applicantKey)
      Chat("|cffff66GuildSyncApplications:|r accepted application for " ..
        (record.applicantAccount ~= "" and record.applicantAccount or "unknown applicant") ..
        " was not confirmed in the guild roster after 2 seconds. Record removed and welcome actions skipped.")
      return
    end

    GSA:SaveApplicationRecord(record, applicantKey)
    SendWelcomeMail(record.applicantAccount)
    QueueOfficerWelcomeMessage(record.applicantAccount)
  end, 2000)
end

function GSA:HookGlobalFunction(functionName, action)
  if type(_G[functionName]) ~= "function" then
    return false
  end

  if self.hookedFunctions and self.hookedFunctions[functionName] then
    return true
  end

  self.hookedFunctions = self.hookedFunctions or {}

  ZO_PreHook(functionName, function(guildId, index, declineMessage, blacklistApplicant, blacklistMessage)
    GSA:SaveApplicationDecision(action, guildId, index, declineMessage, blacklistApplicant, blacklistMessage)
    return false
  end)

  self.hookedFunctions[functionName] = true
  Chat("|c66ff66GuildSyncApplications:|r hooked " .. functionName)
  return true
end

function GSA:TryHookApplicationFunctions()
  local hooked = false

  hooked = self:HookGlobalFunction("AcceptGuildApplication", "accepted") or hooked
  hooked = self:HookGlobalFunction("DeclineGuildApplication", "rejected") or hooked
  hooked = self:HookGlobalFunction("RejectGuildApplication", "rejected") or hooked

  return hooked
end

function GSA:StartHookRetry()
  EVENT_MANAGER:UnregisterForUpdate(self.hookRetryName)

  EVENT_MANAGER:RegisterForUpdate(self.hookRetryName, 1000, function()
    GSA.hookAttempts = GSA.hookAttempts + 1

    if GSA:TryHookApplicationFunctions() then
      EVENT_MANAGER:UnregisterForUpdate(GSA.hookRetryName)
      Chat("|c66ff66GuildSyncApplications:|r application hook ready.")
      return
    end

    if GSA.hookAttempts >= GSA.maxHookAttempts then
      EVENT_MANAGER:UnregisterForUpdate(GSA.hookRetryName)
      Chat("|cffff66GuildSyncApplications:|r loaded, but no accept/reject functions were found after retrying.")
    end
  end)
end

function GSA:CleanSavedVariablesRoot()
  if not self.saved then
    return
  end

  -- Older patched builds accidentally used the SavedVariables global as the addon
  -- runtime table, which caused runtime fields/functions to be written to disk.
  -- Keep only the persisted data branches that belong in GuildSyncApplications.lua.
  local records = self.saved.records
  local settings = self.saved.settings

  for key in pairs(self.saved) do
    if key ~= "records" and key ~= "settings" and key ~= "Default" then
      self.saved[key] = nil
    end
  end

  self.saved.records = records or {}
  self.saved.settings = settings or self:GetDefaultSettings()
end

function GSA:Initialize()
  self.saved = ZO_SavedVars:NewAccountWide(
    "GuildSyncApplications",
    1,
    nil,
    {
      records = {},
      settings = self:GetDefaultSettings(),
    }
  )

  self:CleanSavedVariablesRoot()
  self:EnsureSettings()

  if math.randomseed then
    math.randomseed((GetTimeStamp and GetTimeStamp() or os.time()) +
      (GetFrameTimeMilliseconds and GetFrameTimeMilliseconds() or 0))
    math.random()
    math.random()
    math.random()
  end

  self:RegisterSettingsPanel()

  self.hookedFunctions = self.hookedFunctions or {}
  self.hookAttempts = 0

  if self:TryHookApplicationFunctions() then
    Chat("|c66ff66GuildSyncApplications:|r loaded.")
  else
    Chat("|cffff66GuildSyncApplications:|r loaded. Waiting for ESO application functions to become available...")
    self:StartHookRetry()
  end
end

local function OnAddonLoaded(_, addonName)
  if addonName ~= GSA.name then return end

  EVENT_MANAGER:UnregisterForEvent(GSA.name, EVENT_ADD_ON_LOADED)
  GSA:Initialize()
end

EVENT_MANAGER:RegisterForEvent(GSA.name, EVENT_ADD_ON_LOADED, OnAddonLoaded)

function GSA:SelectCaptureGuild(query)
  local settings = self:EnsureSettings()
  query = Lower(Trim(SafeText(query)))
  if query == "" then
    Chat("Application capture ESO guild ID: " .. SafeText(settings.captureGuildId or "not selected (legacy behavior)"))
    Chat("Usage: /gsa guild <guild name or ESO guild ID>")
    return
  end
  for index = 1, GetNumGuilds() do
    local guildId = GetGuildId(index)
    local guildName = GetGuildName(guildId)
    if query == tostring(guildId) or query == Lower(Trim(guildName)) then
      if next(self.saved.records or {}) then
        Chat("Upload pending application records before changing guilds. Nothing was changed.")
        return
      end
      settings.captureGuildId, settings.captureGuildName = tostring(guildId), guildName
      Chat("Application capture selected: " .. guildName .. " / ESO guild ID: " .. tostring(guildId))
      return
    end
  end
  Chat("No joined guild matches that name or ESO guild ID. Nothing was changed.")
end

SLASH_COMMANDS["/gsa"] = function(args)
  args = Lower(Trim(SafeText(args)))

  if args == "guild" or args:match("^guild%s+") then
    GSA:SelectCaptureGuild(args:match("^guild%s+(.*)$") or "")
    return
  end

  if args == "settings" then
    GSA:OpenSettings()
    return
  end

  if args ~= "list" then
    Chat("GuildSyncApplications commands:")
    Chat("/gsa guild <name or ESO guild ID> - select application capture guild")
    Chat("/gsa settings - open GuildSync Applications settings")
    Chat("/gsa list - list captured application records")
    return
  end

  if not GSA.saved or not GSA.saved.records then
    Chat("GuildSyncApplications: no records captured.")
    return
  end

  local count = 0

  local function ChatField(label, value)
    value = SafeText(value)

    if value ~= "" then
      Chat(label .. ": " .. value)
    end
  end

  for applicantKey, record in pairs(GSA.saved.records) do
    count = count + 1

    Chat("|c66ccff========== GuildSync Application START ==========|r")

    ChatField("Action", record.action)
    ChatField("Captured", record.capturedDateTime)
    ChatField("Officer", record.officerAccount)
    ChatField("Guild", record.guildName)
    ChatField("Applicant", record.applicantAccount)
    ChatField("Character", record.characterName)
    ChatField("Decline Message", record.declineMessage)

    if record.blacklistApplicant == true then
      Chat("Blacklisted: true")
    end

    ChatField("Blacklist Message", record.blacklistMessage)
    ChatField("Application Text", record.applicationText)

    Chat("|c66ccff=========== GuildSync Application END ===========|r")
  end

  if count == 0 then
    Chat("GuildSyncApplications: no records captured.")
    return
  end

  Chat("GuildSyncApplications displayed records: " .. count)
end
