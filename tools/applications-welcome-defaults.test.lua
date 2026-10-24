-- Run from the repository root with Lua 5.1 or newer.
EVENT_MANAGER = { RegisterForEvent = function() end }
SLASH_COMMANDS = {}
local file = assert(io.open('ESO/GuildSyncApplications/GuildSyncApplications.lua', 'r'))
local source = file:read('*a')
file:close()
local compile = loadstring or load
local addon = assert(compile(source .. '\nreturn GSA'))()

addon.saved = {}
local settings = addon:EnsureSettings()
assert(#settings.welcomeMessages == 5, 'seed five welcome messages')
assert(#settings.welcomeEmails == 5, 'seed five welcome emails')
assert(settings.welcomeMessages[1].title == 'Classic Godfather')
assert(settings.welcomeEmails[4].title == 'The Initiation')
assert(settings.welcomeEmails[5].body:find('pet pictures.', 1, true))
assert(settings.welcomeEmails[1].body:find('\n\n', 1, true))
assert(settings.nextWelcomeMessageId == 6 and settings.nextWelcomeEmailId == 6)
for _, list in ipairs({settings.welcomeMessages, settings.welcomeEmails}) do
  for _, entry in ipairs(list) do
    assert(entry.enabled and entry.createdByUser)
    assert(entry.useCount == 0 and entry.lastUsed == 0 and entry.lastPickedSequence == 0)
    assert(entry.__gsaWeight == nil)
    if entry.message then assert(#entry.message <= 335) end
  end
end
settings.welcomeMessages[1].message = 'Edited {name}'
addon:EnsureSettings()
assert(settings.welcomeMessages[1].message == 'Edited {name}', 'preserve edits')
settings.welcomeMessages = {}
settings.welcomeEmails = {}
addon:EnsureSettings()
assert(#settings.welcomeMessages == 0 and #settings.welcomeEmails == 0, 'do not resurrect deleted templates')

addon.saved = {settings = {welcomeMessages = {{id = 17, title = 'Mine', message = 'Hello {name}', enabled = false}}, welcomeEmails = {}}}
settings = addon:EnsureSettings()
assert(#settings.welcomeMessages == 1 and settings.welcomeMessages[1].id == 17)
assert(settings.welcomeMessages[1].enabled == false, 'preserve disabled custom template')
assert(#settings.welcomeEmails == 5, 'seed only the empty template category')
assert(settings.nextWelcomeMessageId == 18)
print('Applications welcome defaults checks passed')
