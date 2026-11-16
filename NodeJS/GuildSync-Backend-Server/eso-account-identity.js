import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {canEditGuildSyncRole} from './role-permissions.js';

const locked=Symbol('esoIdentityLocked');
const sourceDB=Symbol('esoIdentitySourceDB');
const afterUnlock=Symbol('esoIdentityAfterUnlock');
export async function afterEsoIdentityUnlock(db,fn){if(db[locked]){db[afterUnlock].push(fn);return;}return fn();}
export const getEsoIdentitySourceDB=db=>db[sourceDB]||db;
export const esoAccountKey=value=>String(value??'').trim().replace(/^@+/,'').toLowerCase();
const bare=value=>String(value??'').trim().replace(/^@+/,'');
const match=column=>`LOWER(TRIM(LEADING '@' FROM ${column})) = ?`;
const references=[
 ['roster','guildsync_roster_members','account_name'],
 ['rankHistory','guildsync_roster_rank_history','account_name'],
 ['events','guildsync_roster_events','account_name','account_name_original'],
 ['notes','guildsync_roster_member_notes','account_name','account_name_original'],
 ['links','guildsync_member_links','eso_account_name'],
 ['banking','guildsync_banking_entries','account_name','account_name_original'],
 ['applications','guildsync_applications','applicant_account','applicant_account_original'],
 ['users','guildsync_users','guild_member_name']
];
const secondary=[['guildsync_roster_events','officer_account_name','officer_account_name_original'],
 ['guildsync_applications','officer_processing','officer_processing_original']];

export async function initializeEsoAccountIdentity(db){
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_eso_members (
  member_id CHAR(36) NOT NULL PRIMARY KEY,current_name VARCHAR(64) NOT NULL,name_key VARCHAR(64) NOT NULL UNIQUE
 ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_eso_account_aliases (
  alias_key VARCHAR(64) NOT NULL PRIMARY KEY,account_name VARCHAR(64) NOT NULL,member_id CHAR(36) NOT NULL,
  INDEX idx_eso_alias_member(member_id),FOREIGN KEY(member_id) REFERENCES guildsync_eso_members(member_id)
 ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_eso_account_renames (
  rename_id CHAR(36) NOT NULL PRIMARY KEY,member_id CHAR(36) NOT NULL,old_name VARCHAR(64) NOT NULL,new_name VARCHAR(64) NOT NULL,
  operator_discord_id VARCHAR(32) NOT NULL,operator_name VARCHAR(255) NOT NULL,actor_discord_id VARCHAR(32) NOT NULL,
  renamed_at BIGINT UNSIGNED NOT NULL,INDEX idx_eso_rename_member(member_id,renamed_at),
  FOREIGN KEY(member_id) REFERENCES guildsync_eso_members(member_id)
 ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 for(const [,table,,original] of references)if(original)await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${original} VARCHAR(255) DEFAULT NULL`);
 for(const [table,,original] of secondary)await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${original} VARCHAR(255) DEFAULT NULL`);
 // Existing accounts receive stable IDs once. Old alias rows are deliberately never
 // reassigned on startup; a rename/restart cannot create a second identity.
 await withEsoIdentityLock(db,async connection=>{
  const union=references.map(([,table,column])=>`SELECT TRIM(LEADING '@' FROM TRIM(${column})) AS name FROM ${table} WHERE ${column} IS NOT NULL`).join(' UNION ');
  const [names]=await connection.execute(`SELECT DISTINCT name FROM (${union}) names WHERE name <> '' AND CHAR_LENGTH(name)<=64`);
  await connection.beginTransaction();
  try{
   for(const {name} of names){
    const key=esoAccountKey(name);
    const [existing]=await connection.execute('SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key=?',[key]);
    if(existing.length)continue;
    await connection.execute('INSERT IGNORE INTO guildsync_eso_members(member_id,current_name,name_key) VALUES(?,?,?)',[randomUUID(),bare(name),key]);
    const [members]=await connection.execute('SELECT member_id FROM guildsync_eso_members WHERE name_key=?',[key]);
    await connection.execute('INSERT IGNORE INTO guildsync_eso_account_aliases(alias_key,account_name,member_id) VALUES(?,?,?)',[key,bare(name),members[0].member_id]);
   }
   await connection.commit();
  }catch(error){await connection.rollback();throw error;}
 });
}

export async function withEsoIdentityLock(db,fn){
 if(db[locked])return fn(db);
 const connection=await db.getConnection();let acquired=false;const deferred=[];let result;
 try{
  const [rows]=await connection.execute("SELECT GET_LOCK(CONCAT('gs-eso:',MD5(DATABASE())),10) AS acquired");
  if(Number(rows[0]?.acquired)!==1)throw Error('Member names are being updated. Please try again.');
  acquired=true;
  const facade=new Proxy(connection,{get(target,key){
   if(key===locked)return true;
   if(key===sourceDB)return getEsoIdentitySourceDB(db);
   if(key===afterUnlock)return deferred;
   if(key==='getConnection')return async()=>facade;
   if(key==='release')return ()=>{};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  result=await fn(facade);
 }finally{
  try{if(acquired)await connection.execute("SELECT RELEASE_LOCK(CONCAT('gs-eso:',MD5(DATABASE()))) AS released");}
  finally{connection.release();}
 }
 for(const notification of deferred)await notification();
 return result;
}

export async function resolveEsoAccountName(db,value){
 const input=String(value??'').trim();if(!input)return input;
 const [rows]=await db.execute(`SELECT m.current_name FROM guildsync_eso_account_aliases a
  JOIN guildsync_eso_members m ON m.member_id=a.member_id WHERE a.alias_key=? LIMIT 1`,[esoAccountKey(input)]);
 return rows[0]?.current_name ? (input.startsWith('@')?'@':'')+rows[0].current_name : input;
}
export async function loadEsoAccountAliases(db,value){
 const [rows]=await db.execute(`SELECT a.account_name FROM guildsync_eso_account_aliases a
  WHERE a.member_id IN (SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key=?) ORDER BY a.alias_key`,[esoAccountKey(value)]);
 return rows.length?rows.map(row=>bare(row.account_name)):[bare(value)];
}
export async function searchEsoAccountNames(db,value){
 const query=esoAccountKey(value);if(!query)return [];
 const [rows]=await db.execute(`SELECT DISTINCT m.current_name FROM guildsync_eso_account_aliases a
  JOIN guildsync_eso_members m ON m.member_id=a.member_id WHERE LOCATE(?,a.alias_key)>0 ORDER BY m.current_name LIMIT 50`,[query]);
 return rows.map(row=>row.current_name);
}
export async function getEsoAccountRenameHistory(db,value){
 const [rows]=await db.execute(`SELECT r.old_name,r.new_name,r.operator_name,r.renamed_at FROM guildsync_eso_account_renames r
  JOIN guildsync_eso_account_aliases a ON a.member_id=r.member_id WHERE a.alias_key=? ORDER BY r.renamed_at DESC,r.rename_id DESC`,[esoAccountKey(value)]);
 return rows.map(row=>({event_type:'account renamed',rank:'',timestamp:Number(row.renamed_at),officer:row.operator_name,
  details:`ESO account name changed from @${row.old_name} to @${row.new_name} by ${row.operator_name}.`}));
}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateNames(input){
 const oldName=bare(input.accountName),newName=bare(input.newAccountName);
 if(!oldName || oldName.length>64)throw Error('Select a valid ESO account.');
 if(!newName || newName.length>32 || /[\s@\x00-\x1f\x7f<>]/.test(newName) || /^@@/.test(String(input.newAccountName).trim()))throw Error('Enter an ESO account name of 1–32 characters, without spaces or additional @ signs.');
 if(esoAccountKey(oldName)===esoAccountKey(newName))throw Error('The new name must be different from the current name.');
 return {oldName,newName};
}
async function countReferences(db,key){
 const counts={};for(const [label,table,column] of references){
  const [rows]=await db.execute(`SELECT COUNT(*) AS total FROM ${table} WHERE ${match(column)}`,[key]);counts[label]=Number(rows[0].total);
 }
 return counts;
}
async function buildPreview(db,input){
 const {oldName,newName}=validateNames(input);
 const current=bare(await resolveEsoAccountName(db,oldName));
 if(esoAccountKey(current)!==esoAccountKey(oldName))throw Error(`This account is now @${current}. Select it and preview again.`);
 const counts=await countReferences(db,esoAccountKey(current));
 if(!counts.roster && !counts.rankHistory && !counts.events)throw Error('The selected ESO account has no roster history.');
 const [members]=await db.execute('SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key=?',[esoAccountKey(current)]);
 const [target]=await db.execute('SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key=?',[esoAccountKey(newName)]);
 const sameIdentity=members.length && target[0]?.member_id===members[0].member_id;
 const targetCounts=await countReferences(db,esoAccountKey(newName));
 const [mail]=await db.execute(`SELECT COUNT(*) AS total FROM guildsync_banking_entries
  WHERE ${match('account_name')} AND mail_status IN ('checked_out','written_to_eso')`,[esoAccountKey(current)]);
 const activeMail=Number(mail[0].total)>0;
 const conflict=Boolean(activeMail || target.length&&!sameIdentity || Object.values(targetCounts).some(count=>count>0));
 const aliases=await loadEsoAccountAliases(db,current);
 return {accountName:current,newAccountName:newName,counts,aliases,conflict,
  message:activeMail?'Finish or release this member’s checked-out deposit receipts before renaming the account.':conflict?'The new name already belongs to an identity or has records. Review those records first; accounts will not be merged automatically.':'Existing history and links will stay with this member.',
  memberId:members[0]?.member_id??null};
}

export function createEsoAccountRenames(db,{now=()=>Math.floor(Date.now()/1000),secret=randomBytes(32)}={}){
 const sign=body=>createHmac('sha256',secret).update(body).digest('base64url');
 const binding=actor=>[String(actor.userId||''),String(actor.actorId||actor.userId||''),String(actor.sessionId||'')];
 const fingerprint=preview=>digest([preview.memberId,preview.accountName,preview.newAccountName,preview.counts,preview.aliases]);
 return {
  async preview(input,actor){
   return withEsoIdentityLock(db,async connection=>{
    await actor.authorize?.(connection);
    const p=await buildPreview(connection,input);
    if(!p.conflict){
     const body=Buffer.from(JSON.stringify({binding:binding(actor),fingerprint:fingerprint(p),expires:now()+300})).toString('base64url');
     p.token=body+'.'+sign(body);
    }
    // Do not reveal existence/counts of rank-restricted notes through a rename preview.
    const visible={...p,counts:{...p.counts}};delete visible.counts.notes;
    return visible;
   });
  },
  async rename(input,actor){
   const [body,signature,...extra]=String(input.token||'').split('.');
   if(!body||!signature||extra.length)throw Error('Preview this account change before confirming it.');
   const expected=Buffer.from(sign(body)),actual=Buffer.from(signature);
   if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw Error('Invalid confirmation; preview again.');
   let confirmation;try{confirmation=JSON.parse(Buffer.from(body,'base64url').toString());}catch{throw Error('Invalid confirmation; preview again.');}
   if(confirmation.expires<=now() || digest(confirmation.binding)!==digest(binding(actor)))throw Error('Confirmation expired or belongs to another session; preview again.');
   return withEsoIdentityLock(db,async connection=>{
    await connection.beginTransaction();
    try{
     await actor.authorize?.(connection);
     const p=await buildPreview(connection,input);
     if(p.conflict || confirmation.fingerprint!==fingerprint(p))throw Error('Member data changed since the preview. Review a new preview before confirming.');
     const memberId=p.memberId||randomUUID(),oldKey=esoAccountKey(p.accountName),newKey=esoAccountKey(p.newAccountName);
     if(!p.memberId){
      await connection.execute('INSERT INTO guildsync_eso_members(member_id,current_name,name_key) VALUES(?,?,?)',[memberId,p.accountName,oldKey]);
      await connection.execute('INSERT INTO guildsync_eso_account_aliases(alias_key,account_name,member_id) VALUES(?,?,?)',[oldKey,p.accountName,memberId]);
     }
     const [already]=await connection.execute('SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key=?',[newKey]);
     if(!already.length)await connection.execute('INSERT INTO guildsync_eso_account_aliases(alias_key,account_name,member_id) VALUES(?,?,?)',[newKey,p.newAccountName,memberId]);
     for(const [,table,column,original] of references){
      const assignments=[...(original?[`${original}=COALESCE(${original},${column})`]:[]),`${column}=CASE WHEN LEFT(${column},1)='@' THEN CONCAT('@',?) ELSE ? END`];
      await connection.execute(`UPDATE ${table} SET ${assignments.join(',')} WHERE ${match(column)}`,[p.newAccountName,p.newAccountName,oldKey]);
     }
     for(const [table,column,original] of secondary)await connection.execute(`UPDATE ${table} SET ${original}=COALESCE(${original},${column}),${column}=CASE WHEN LEFT(${column},1)='@' THEN CONCAT('@',?) ELSE ? END WHERE ${match(column)}`,[p.newAccountName,p.newAccountName,oldKey]);
     await connection.execute('UPDATE guildsync_eso_members SET current_name=?,name_key=? WHERE member_id=?',[p.newAccountName,newKey,memberId]);
     await connection.execute(`INSERT INTO guildsync_eso_account_renames(rename_id,member_id,old_name,new_name,operator_discord_id,operator_name,actor_discord_id,renamed_at)
      VALUES(?,?,?,?,?,?,?,?)`,[randomUUID(),memberId,p.accountName,p.newAccountName,String(actor.userId),String(actor.name||actor.userId).slice(0,255),String(actor.actorId||actor.userId),now()]);
     await connection.commit();
     return {accountName:p.accountName,newAccountName:p.newAccountName,message:`ESO account name changed from @${p.accountName} to @${p.newAccountName}.`};
    }catch(error){await connection.rollback();throw error;}
   });
  }
 };
}

export function registerEsoAccountRenameSocket(socket,{service,loginDB,effectiveRole=(_socket,role)=>role,onRenamed=async()=>{}}){
 for(const [event,method] of [['guildsync:preview-eso-account-rename','preview'],['guildsync:rename-eso-account','rename']])socket.on(event,async(input={},callback)=>{
  const reply=value=>{if(typeof callback==='function')callback(value);};
  try{
   if(!socket.guildSyncAuthenticated || socket.guildSyncAuthType==='discord-bot' || !socket.guildSyncUser?.discord_user_id)throw Error('Approved User or Admin access is required.');
   const id=String(socket.guildSyncUser.discord_user_id);
   const [users]=await loginDB.execute('SELECT role,allowed FROM guildsync_users WHERE discord_user_id=? LIMIT 1',[id]);
   if(Number(users[0]?.allowed)!==1 || !canEditGuildSyncRole(effectiveRole(socket,users[0]?.role)))throw Error('User or Admin access is required to rename ESO accounts.');
   const actor={authorize:async connection=>{
    const [current]=await (connection||loginDB).execute('SELECT role,allowed FROM guildsync_users WHERE discord_user_id=? LIMIT 1',[id]);
    if(!socket.guildSyncAuthenticated || String(socket.guildSyncUser?.discord_user_id)!==id || Number(current[0]?.allowed)!==1 || !canEditGuildSyncRole(effectiveRole(socket,current[0]?.role)))throw Error('User or Admin access is required to rename ESO accounts.');
   },userId:id,actorId:socket.guildSyncActorId||id,sessionId:socket.guildSyncRoleViewId||socket.id,
    name:socket.guildSyncUser.display_name||socket.guildSyncUser.username||id};
   const result=await service[method](input,actor);
   reply(method==='preview'?{ok:true,preview:result}:{ok:true,...result});
   // Once committed, a refresh failure must not claim the rename failed.
   if(method==='rename')await onRenamed(result).catch(error=>console.error('ESO rename refresh failed:',error.message));
  }catch(error){reply({ok:false,message:error.message||'ESO account name could not be changed.'});}
 });
}
