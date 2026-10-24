export const GUILDSYNC_ROLES = ['viewer', 'user', 'admin'];
export const canEditGuildSyncRole = role => role === 'user' || role === 'admin';
export const canIngestGuildSyncRole = role => GUILDSYNC_ROLES.includes(role);
export const canManageGuildSyncLinksRole = canEditGuildSyncRole;

const adminEvents = new Set([
  'guildsync:request-users','guildsync:request-pending-users','guildsync:change-user',
  'guildsync:save-admin-configuration','guildsync:save-raffle-bonus-settings'
]);
const ingestionEvents = new Set([
  'guildsync:upload-savedvars-raw','guildsync:sending-banking-data','guildsync:sending-roster-data',
  'guildsync:gsa-post-application','guildsync:eso-guild-application-message',
  'guildsync:run-member-auto-linking','guildsync:request-discord-data-refresh'
]);
export function canPerformGuildSyncEvent(role,event) {
  if (!GUILDSYNC_ROLES.includes(role)) return false;
  if (isReadOnlyGuildSyncEvent(event) || ingestionEvents.has(event)) return true;
  if (adminEvents.has(event)) return role === 'admin';
  return canEditGuildSyncRole(role);
}

// Explicit read allowlist: new operations are never implicitly available to viewers.
const readEvents = new Set([
  'guildsync:client-version',
  'guildsync:request-discord-data-date',
  'guildsync:request-discord-member-dataJSON',
  'guildsync:request-banking-data',
  'guildsync:request-roster-data',
  'guildsync:request-roster-member-notes',
  'guildsync:request-banking-history-matches',
  'guildsync:request-banking-history-records',
  'guildsync:request-roster-rank-history',
  'guildsync:request-roster-stream-history',
  'guildsync:request-discord-member-history',
  'guildsync:request-discord-member-history-events',
  'guildsync:request-community-statistics',
  'guildsync:request-associate-ticket-report',
  'guildsync:request-discord-rank-audit-report',
  'guildsync:request-member-links',
  'guildsync:request-member-link-options',
  'guildsync:request-admin-configuration',
  'guildsync:request-active-raffles',
  'guildsync:request-raffle-archives'
]);
export const isReadOnlyGuildSyncEvent = event => readEvents.has(event);
