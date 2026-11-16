-- Run from the repository root with Lua 5.1 or newer; no ESO runtime needed.
EVENT_MANAGER = { RegisterForEvent = function() end }
SLASH_COMMANDS = {}
local file = assert(io.open('ESO/GuildSyncApplications/GuildSyncApplications.lua', 'r'))
local source = file:read('*a')
file:close()
local addon = assert((loadstring or load)(source .. '\nreturn GSA'))()
-- Byte escapes keep these Unicode fixtures portable across Lua 5.1 source encodings.
local accented = '\195\169'
local emoji = '\240\159\152\128'
for _, character in ipairs({accented, emoji}) do
  local boundary = string.rep(character, 335)
  assert(addon:ClampWelcomeMessage(boundary) == boundary, '335 Unicode characters must survive')
  assert(addon:ClampWelcomeMessage(boundary .. character) == boundary, 'truncate at 335 whole characters')
  local mixed = string.rep('a', 334) .. character
  assert(addon:ClampWelcomeMessage(mixed .. 'b') == mixed, 'mixed ASCII/Unicode boundary must stay whole')
end
assert(addon:ClampWelcomeMessage(string.rep('a', 335)) == string.rep('a', 335))
assert(addon:ClampWelcomeMessage(string.rep('a', 336)) == string.rep('a', 335))
assert(addon:ClampWelcomeMessage('a\r\nb\rc\nd') == 'a\nb\nc\nd', 'normalize CRLF and CR to LF')
local lines = string.rep('a', 333) .. '\r\n' .. accented
assert(addon:ClampWelcomeMessage(lines .. 'x') == string.rep('a', 333) .. '\n' .. accented,
  'normalized newline counts as one character')
assert(addon:ClampWelcomeMessage(nil) == '')
print('Welcome character limit checks passed')
