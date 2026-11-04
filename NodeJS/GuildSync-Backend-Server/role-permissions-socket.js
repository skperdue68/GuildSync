import {USER_SWITCH_EVENTS} from './user-switch.js';
import {canPerformGuildSyncEvent, isReadOnlyGuildSyncEvent} from './role-permissions.js';

export function registerRolePermissions(socket, loginDB, views, {authorizeUserSwitch=async()=>false}={}) {
  socket.use(async (packet, next) => {
    const event = String(packet[0] || '');
    if (!event.startsWith('guildsync:') || socket.guildSyncAuthType === 'discord-bot' || isReadOnlyGuildSyncEvent(event)) return next();
    try {
      if(USER_SWITCH_EVENTS.has(event)) {
        if(await authorizeUserSwitch(socket,event))return next();
        throw Error('Admin access is required to switch users.');
      }
      if (socket.guildSyncAuthenticated && socket.guildSyncUser?.discord_user_id) {
        const [rows] = await loginDB.execute(
          'SELECT role, allowed FROM guildsync_users WHERE discord_user_id = ? LIMIT 1',
          [socket.guildSyncUser.discord_user_id]
        );
        const actualRole=rows[0]?.role,role=views?.effective(socket.guildSyncRoleViewId,actualRole) || actualRole;
        if (Number(rows[0]?.allowed) === 1 && (event === 'guildsync:set-role-view' ? actualRole === 'admin' : canPerformGuildSyncEvent(role,event))) return next();
      }
    } catch {
      // Fail closed if current permissions cannot be verified.
    }
    const response = {ok:false, message:'Your current role or view does not have permission to perform this action.'};
    const callback = packet.at(-1);
    if (typeof callback === 'function') callback(response);
    else socket.emit('guildsync:permission-denied', response);
  });
}
