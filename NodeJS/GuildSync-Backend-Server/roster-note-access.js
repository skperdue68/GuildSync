const aliases=[['gangster','gangsters'],['associate','associates'],['soldier','soldiers'],['capo','capos'],
  ['caporegime','caporegimes','caporegieme','caporegiemes'],['consigliere','consiglieri','consiglieres'],['kingpin','kingpins']];
const normalize=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
const canonical=value=>aliases.find(group=>group.includes(normalize(value)))?.[0] || normalize(value);

export function resolveNoteRanks(roles,configured='') {
  const refs=String(configured||'').split(',').map(value=>value.trim()).filter(Boolean),byId=new Map();
  for(const role of roles) {
    const index=refs.length?refs.findIndex(ref=>/^\d+$/.test(ref)?ref===String(role.role_id):canonical(ref)===canonical(role.role_name))
      :aliases.findIndex(group=>group.includes(normalize(role.role_name)));
    if(index>=0)byId.set(String(role.role_id),index);
  }
  return {byId,topRank:refs.length?refs.length-1:aliases.length-1};
}

export function canReadRosterNote(note,context) {
  if(context.rank<0)return false;
  // Old notes have no reliably captured author rank. Preserve them at the highest guild rank.
  if(!note.minimum_role_id)return context.rank>=context.topRank;
  const required=context.byId.get(String(note.minimum_role_id));
  return required!==undefined && context.rank>=required;
}

export async function initializeRosterNoteAccess(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_roster_member_notes (
    note_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,account_name VARCHAR(64) NOT NULL,
    officer_name VARCHAR(255) NOT NULL,note_text TEXT NOT NULL,note_timestamp VARCHAR(32) NOT NULL,
    author_discord_id VARCHAR(32) DEFAULT NULL,minimum_role_id VARCHAR(32) DEFAULT NULL,
    minimum_role_name VARCHAR(255) DEFAULT NULL,
    INDEX idx_guildsync_roster_member_notes_account_name (account_name)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await db.query(`ALTER TABLE guildsync_roster_member_notes
    ADD COLUMN IF NOT EXISTS author_discord_id VARCHAR(32) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS minimum_role_id VARCHAR(32) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS minimum_role_name VARCHAR(255) DEFAULT NULL`);
}

export function createRosterNoteAccess({db,loginDB,getRankRefs=()=>'',effectiveRole=(_socket,role)=>role}) {
  async function context(socket,write=false) {
    const userId=socket.guildSyncUser?.discord_user_id;
    if(!socket.guildSyncAuthenticated || !userId || socket.guildSyncAuthType==='discord-bot')throw Error('Approved GuildSync access is required.');
    const [users]=await loginDB.execute('SELECT role,allowed FROM guildsync_users WHERE discord_user_id=? LIMIT 1',[userId]);
    const role=effectiveRole(socket,users[0]?.role);
    if(Number(users[0]?.allowed)!==1 || !['viewer','user','admin'].includes(role))throw Error('Approved GuildSync access is required.');
    if(write && !['user','admin'].includes(role))throw Error('User or Admin access is required to add notes.');
    const [roles]=await db.execute('SELECT role_id,role_name FROM discord_roles');
    const mapping=resolveNoteRanks(roles,getRankRefs());
    const [memberRoles]=await db.execute('SELECT role_id FROM discord_member_roles WHERE discord_id = ?',[userId]);
    let rank=-1,rankRole=null;
    for(const memberRole of memberRoles) {
      const index=mapping.byId.get(String(memberRole.role_id));
      if(index!==undefined && index>rank){rank=index;rankRole=roles.find(r=>String(r.role_id)===String(memberRole.role_id));}
    }
    const signature=JSON.stringify([rank,[...mapping.byId],mapping.topRank]);
    const changed=socket.guildSyncNoteAccessSignature!==undefined && socket.guildSyncNoteAccessSignature!==signature;
    socket.guildSyncNoteAccessSignature=signature;
    if(changed)socket.emit?.('guildsync:roster-notes-access-changed');
    return {...mapping,rank,rankRole,userId};
  }
  return {
    async read(socket,account) {
      const access=await context(socket);
      const [notes]=await db.execute(`SELECT note_id,account_name,officer_name,note_text,note_timestamp,minimum_role_id
        FROM guildsync_roster_member_notes WHERE LOWER(account_name)=LOWER(?) ORDER BY CAST(note_timestamp AS UNSIGNED),note_id`,[String(account||'').trim()]);
      return notes.filter(note=>canReadRosterNote(note,access)).map(note=>({note_id:note.note_id,account_name:note.account_name,
        officer:note.officer_name,note:note.note_text,timestamp:Number(note.note_timestamp)}));
    },
    async decorate(socket,members) {
      // Failure returns no indicators; never fall back to shared/unfiltered counts.
      let access;
      try{access=await context(socket);}catch{return members.map(member=>({...member,note_count:0}));}
      const [notes]=await db.execute('SELECT account_name,minimum_role_id FROM guildsync_roster_member_notes');
      const counts=new Map();
      for(const note of notes)if(canReadRosterNote(note,access)){
        const key=String(note.account_name).toLowerCase();counts.set(key,(counts.get(key)||0)+1);
      }
      return members.map(member=>({...member,note_count:counts.get(String(member.account_name).toLowerCase())||0}));
    },
    async add(socket,{accountName,note}) {
      const access=await context(socket,true);
      if(access.rank<0)throw Error('A recognized Discord guild rank is required to add a note.');
      const account=String(accountName||'').trim(),text=String(note||'').trim();
      if(!account || account.length>64 || !text)throw Error('An ESO account and note text are required.');
      const officer=String(socket.guildSyncUser.display_name || socket.guildSyncUser.username || access.userId);
      const timestamp=Math.floor(Date.now()/1000);
      const [result]=await db.execute(`INSERT INTO guildsync_roster_member_notes
        (account_name,officer_name,note_text,note_timestamp,author_discord_id,minimum_role_id,minimum_role_name)
        VALUES (?,?,?,?,?,?,?)`,[account,officer,text,timestamp,access.userId,String(access.rankRole.role_id),access.rankRole.role_name]);
      return {note_id:result.insertId,account_name:account,officer,note:text,timestamp};
    }
  };
}
