export const roleViewSessionKey = claims => claims.jti || `legacy:${claims.actor_sub || claims.sub}:${claims.iat}`;

export function createRoleViews(loginDB) {
  const previews = new Map();
  return {
    effective(sessionId, actualRole) {
      if (actualRole !== 'admin') { previews.delete(sessionId); return actualRole; }
      return previews.get(sessionId)?.role || actualRole;
    },
    clear(sessionId) { previews.delete(sessionId); },
    clearUser(id) { for(const [key,preview] of previews) if(preview.userId === id) previews.delete(key); },
    async set(userId,sessionId,role) {
      if (!['viewer','user','admin'].includes(role)) throw Error('Invalid view role. Choose Viewer, User, or Admin.');
      if (!sessionId) throw Error('A login session is required to change views.');
      const [rows] = await loginDB.execute('SELECT role, allowed FROM guildsync_users WHERE discord_user_id = ? LIMIT 1',[userId]);
      if (rows[0]?.role !== 'admin' || Number(rows[0].allowed) !== 1) throw Error('Admin access is required to change views.');
      if (role === 'admin') previews.delete(sessionId);
      else previews.set(sessionId,{userId,role});
    }
  };
}

export function registerRoleViewSocket(socket,views,afterChange) {
  socket.on('guildsync:set-role-view',async(payload={},callback)=>{
    if(typeof callback !== 'function') return;
    try {
      if(!socket.guildSyncAuthenticated || socket.guildSyncAuthType === 'discord-bot' || !socket.guildSyncUser?.discord_user_id) throw Error('Admin access is required to change views.');
      await views.set(socket.guildSyncUser.discord_user_id,socket.guildSyncRoleViewId,payload.role);
      callback({ok:true,user:await afterChange()});
    } catch(error) { callback({ok:false,message:error.message}); }
  });
}
