import {canIngestGuildSyncRole} from './role-permissions.js';

export async function getApplicationHistory(db, accountName) {
  const account=String(accountName || '').trim().replace(/^@/,'');
  if (!account || account.length>50) throw new Error('A valid account name is required.');
  const [rows]=await db.execute(`SELECT applicant_account,application_text,application_timestamp,
      officer_processing,application_action,decline_message,blacklist_message
    FROM guildsync_applications
    WHERE LOWER(TRIM(LEADING '@' FROM applicant_account)) = LOWER(?)
    ORDER BY CAST(application_timestamp AS UNSIGNED) DESC`,[account]);
  return rows;
}

export function registerApplicationHistorySocket(socket,{db,loginDB}) {
  socket.on('guildsync:request-application-history',async(payload={},callback)=>{
    const reply=response=>{if(typeof callback==='function')callback(response);};
    try {
      if (!socket.guildSyncAuthenticated || !socket.guildSyncUser?.discord_user_id
        || socket.guildSyncAuthType==='discord-bot') {
        return reply({ok:false,message:'Approved GuildSync access is required.',records:[]});
      }
      const [users]=await loginDB.execute('SELECT role,allowed FROM guildsync_users WHERE discord_user_id=? LIMIT 1',
        [socket.guildSyncUser.discord_user_id]);
      if (Number(users[0]?.allowed)!==1 || !canIngestGuildSyncRole(users[0]?.role)) {
        return reply({ok:false,message:'Approved GuildSync access is required.',records:[]});
      }
      const records=await getApplicationHistory(db,payload?.account_name);
      reply({ok:true,records});
    } catch {
      reply({ok:false,message:'Application history could not be loaded.',records:[]});
    }
  });
}
