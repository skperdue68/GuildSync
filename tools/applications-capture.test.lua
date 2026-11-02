-- Run from the repository root with Lua 5.1 or newer.
EVENT_MANAGER = { RegisterForEvent = function() end }
SLASH_COMMANDS = {}
local file = assert(io.open('ESO/GuildSyncApplications/GuildSyncApplications.lua', 'r'))
local source = file:read('*a')
file:close()
local addon = assert((loadstring or load)(source .. '\nreturn GSA'))()
GetTimeStamp = function() return 1700000000 end
GetDisplayName = function() return '@officer' end
GetGuildName = function() return 'Test Guild' end
GetGuildFinderGuildApplicationInfoAt = function()
  return 50, 100, 1, 2, '@applicant', 'Character', 200, 'Please invite me'
end
local rosterMember = true
GetNumGuildMembers = function() return rosterMember and 1 or 0 end
GetGuildMemberInfo = function() return '@applicant' end
local pending = {}
zo_callLater = function(callback) pending[#pending + 1] = callback end
local function drain()
  while #pending > 0 do table.remove(pending, 1)() end
end
local mail, chat = 0, 0
RequestOpenMailbox = function() end
CloseMailbox = function() end
SendMail = function(recipient, subject, body)
  assert(recipient == '@applicant' and subject ~= '' and body ~= '')
  mail = mail + 1
end
-- Officer chat itself needs ESO UI; observe the real decision path reaching it.
addon.PopulateOfficerWelcomeMessage = function(_, account)
  assert(account == '@applicant')
  chat = chat + 1
end
local function check(name, fn)
  local ok, err = pcall(fn)
  if not ok then error(name .. ': ' .. tostring(err)) end
  print('PASS ' .. name)
end
check('new defaults enable capture', function()
  assert(addon:GetDefaultSettings().captureApplicationData == true)
end)
check('missing flag captures for existing users', function()
  addon.saved = {settings = {}}
  addon:SaveApplicationDecision('rejected', 1, 1)
  assert(addon.saved.records['@applicant'].applicationText == 'Please invite me')
  assert(addon:EnsureSettings().captureApplicationData == true)
end)
check('enabled captures confirmed acceptance and sends welcomes', function()
  addon.saved = {settings = {captureApplicationData = true}}
  addon:SaveApplicationDecision('accepted', 1, 1)
  drain()
  assert(addon.saved.records['@applicant'].action == 'accepted')
  assert(mail == 1 and chat == 1)
end)
check('disabled preserves existing records across all decisions and welcomes', function()
  local existing = {action = 'old'}
  local records = {['@applicant'] = existing}
  addon.saved = {settings = {captureApplicationData = false}, records = records}
  addon:SaveApplicationDecision('rejected', 1, 1)
  addon:SaveApplicationDecision('accepted', 1, 1)
  drain()
  assert(addon.saved.records == records and records['@applicant'] == existing)
  assert(mail == 2 and chat == 2)
  rosterMember = false
  addon:SaveApplicationDecision('accepted', 1, 1)
  drain()
  assert(records['@applicant'] == existing, 'failed acceptance preserves old record')
  assert(mail == 2 and chat == 2, 'unconfirmed acceptance skips welcomes')
  rosterMember = true
  addon:SaveApplicationRecord({action = 'rejected'}, '@other')
  assert(records['@other'] == nil)
  assert(addon:EnsureSettings().captureApplicationData == false)
end)
check('disabled does not create a records table', function()
  addon.saved = {settings = {captureApplicationData = false}}
  addon:SaveApplicationDecision('rejected', 1, 1)
  assert(addon.saved.records == nil)
end)
check('settings toggle updates saved capture flag', function()
  addon.saved = {settings = {}}
  local toggle
  for _, option in ipairs(addon:BuildSettingsOptions()) do
    if option.type == 'checkbox' and option.name == 'Capture application data' then toggle = option end
  end
  assert(toggle, 'capture checkbox exists')
  assert(toggle.getFunc() == true)
  toggle.setFunc(false)
  assert(addon.saved.settings.captureApplicationData == false)
  toggle.setFunc(true)
  assert(addon.saved.settings.captureApplicationData == true)
end)
print('Application capture checks passed')
