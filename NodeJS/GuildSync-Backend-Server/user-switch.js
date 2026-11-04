import {createHash,randomUUID} from 'node:crypto';
import {isReadOnlyGuildSyncEvent} from './role-permissions.js';

export const USER_SWITCH_EVENTS=new Set(['guildsync:request-user-switch-options','guildsync:set-user-switch']);
const approved=user=>Number(user?.allowed)===1&&!user.revoked_at&&['viewer','user','admin'].includes(user.role);
const name=user=>user.guild_member_name||user.global_name||user.display_name||user.username||user.discord_user_id;
const columns='discord_user_id, username, global_name, guild_member_name, avatar, role, allowed, revoked_at';
const metadata=(actor,state,revision,epoch)=>({active:!!state,can_switch:actor.role==='admin',actor_id:actor.discord_user_id,actor_name:name(actor),target_id:state?.targetId||actor.discord_user_id,target_name:state?.targetName||name(actor),revision,epoch});

export async function initializeUserSwitchSchema(db){
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_user_switch_audit (
  audit_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_discord_id VARCHAR(32) NOT NULL,target_discord_id VARCHAR(32) NOT NULL,
  session_ref CHAR(64) NOT NULL,action VARCHAR(24) NOT NULL,reason VARCHAR(128) NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_switch_actor (actor_discord_id,recorded_at)
 ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export function createUserSwitches(db,{log=()=>{}}={}){
 const epoch=randomUUID();
 const sessions=new Map(),revisions=new Map(),pending=new Map();
 const get=async id=>{const [rows]=await db.execute(`SELECT ${columns} FROM guildsync_users WHERE discord_user_id = ? LIMIT 1`,[id]);return rows[0];};
 const audit=async(actor,target,key,action,reason)=>{
  await db.execute('INSERT INTO guildsync_user_switch_audit (actor_discord_id,target_discord_id,session_ref,action,reason) VALUES (?,?,?,?,?)',[actor,target,createHash('sha256').update(key).digest('hex'),action,String(reason).slice(0,128)]);
  log(`GuildSync user switch ${action}: admin ${actor}, effective user ${target}, ${reason}`);
 };
 const serialize=async(key,fn)=>{
  const previous=pending.get(key)||Promise.resolve(),current=previous.catch(()=>{}).then(fn);pending.set(key,current);
  try{return await current;}finally{if(pending.get(key)===current)pending.delete(key);}
 };
 const bump=key=>{const revision=(revisions.get(key)||0)+1;revisions.set(key,revision);return revision;};
 const clear=async(key,reason='return')=>serialize(key,async()=>{
  const state=sessions.get(key);if(!state)return;
  // Logout/revocation must still clear state even if the audit store is unavailable.
  try{await audit(state.actorId,state.targetId,key,'return',reason);}catch(error){log('User switch audit failed: '+error.message);}
  sessions.delete(key);bump(key);
 });
 const actor=async id=>{const user=await get(id);if(!approved(user)||user.role!=='admin')throw Error('Admin access is required to switch GuildSync users.');return user;};
 return {
  async authorize(actorId){await actor(actorId);return true;},
  async list(actorId,key){
   const owner=await actor(actorId);
   const [users]=await db.execute(`SELECT ${columns} FROM guildsync_users WHERE allowed = 1 AND role IN ('viewer','user','admin') AND revoked_at IS NULL ORDER BY username,discord_user_id`);
   return {users:users.filter(approved).map(user=>({discord_user_id:user.discord_user_id,username:user.username,display_name:name(user),role:user.role})),actor:{discord_user_id:owner.discord_user_id,display_name:name(owner)},active:!!sessions.get(key)};
  },
  async set(actorId,key,targetId){
   if(!key)throw Error('A login session is required to switch users.');
   return serialize(key,async()=>{
    const owner=await get(actorId);
    if(!approved(owner))throw Error('Approved Admin access is required to switch GuildSync users.');
    const previous=sessions.get(key);
    if(targetId===null||String(targetId)===actorId){
     if(owner.role!=='admin'&&!previous)throw Error('Admin access is required to switch GuildSync users.');
     if(previous)await audit(actorId,previous.targetId,key,'return','requested');
     sessions.delete(key);return metadata(owner,null,bump(key),epoch);
    }
    if(owner.role!=='admin')throw Error('Admin access is required to switch GuildSync users.');
    if(typeof targetId!=='string'||!/^\d{1,32}$/.test(targetId))throw Error('Choose an approved GuildSync account.');
    const target=await get(targetId);if(!approved(target))throw Error('Choose an approved GuildSync account.');
    await audit(actorId,targetId,key,'switch','requested');
    const state={actorId,targetId,targetName:name(target)};sessions.set(key,state);return metadata(owner,state,bump(key),epoch);
   });
  },
  async resolve(claims){
   const actorId=String(claims.actor_sub||claims.sub),key=claims.jti||`legacy:${actorId}:${claims.iat}`;
   const owner=await get(actorId);if(!approved(owner))throw Error('Session was logged out.');
   let state=sessions.get(key);
   if(state&&(state.actorId!==actorId||owner.role!=='admin')){await clear(key,'actor no longer admin');state=null;}
   if(state){
    const target=await get(state.targetId);
    if(sessions.get(key)!==state)return this.resolve(claims);
    if(!approved(target)){await clear(key,'target no longer approved');state=null;}
    else {
     if(sessions.get(key)!==state)return this.resolve(claims);
     return {...claims,sub:target.discord_user_id,actor_sub:actorId,username:target.username||'',global_name:target.global_name||'',display_name:name(target),avatar_url:target.avatar?`https://cdn.discordapp.com/avatars/${target.discord_user_id}/${target.avatar}.png`:'',role:target.role,actual_role:target.role,user_switch:metadata(owner,state,revisions.get(key)||0,epoch)};
    }
   }
   const result={...claims,sub:actorId,actor_sub:actorId,role:owner.role,actual_role:owner.role};
   if(owner.role==='admin'||revisions.has(key))result.user_switch=metadata(owner,null,revisions.get(key)||0,epoch);else delete result.user_switch;
   return result;
  },
  clear,
  async clearUser(userId,reason='account changed'){
   const keys=[...sessions].filter(([,s])=>s.actorId===userId||s.targetId===userId).map(([key])=>key);
   await Promise.all(keys.map(key=>clear(key,reason)));return keys;
  },
  async recordOperation(socket,event){
   const state=sessions.get(socket.guildSyncRoleViewId);if(!state)throw Error('The selected identity changed. Reconnect before trying again.');
   if(state.actorId!==socket.guildSyncActorId||state.targetId!==socket.guildSyncUser?.discord_user_id)throw Error('The selected identity changed. Reconnect before trying again.');
   await audit(state.actorId,state.targetId,socket.guildSyncRoleViewId,'operation',event);
   if(sessions.get(socket.guildSyncRoleViewId)!==state)throw Error('The selected identity changed. Reconnect before trying again.');
  }
 };
}

export function registerUserSwitchSocket(socket,service,{afterChange,clearRoleView=()=>{}}){
 const owner=()=>{
  if(!socket.guildSyncAuthenticated||socket.guildSyncAuthType!=='GuildSync user'||!socket.guildSyncActorId||!socket.guildSyncRoleViewId)throw Error('Admin access is required to switch GuildSync users.');
  return socket.guildSyncActorId;
 };
 socket.on('guildsync:request-user-switch-options',async(_payload={},callback)=>{
  if(typeof callback!=='function')return;
  try{callback({ok:true,...await service.list(owner(),socket.guildSyncRoleViewId)});}catch(error){callback({ok:false,message:error.message});}
 });
 socket.on('guildsync:set-user-switch',async(payload={},callback)=>{
  if(typeof callback!=='function')return;
  try{
   const actorId=owner();if(!Object.hasOwn(payload,'discord_user_id'))throw Error('Choose an approved GuildSync account.');
   await service.set(actorId,socket.guildSyncRoleViewId,payload.discord_user_id);
   clearRoleView(socket.guildSyncRoleViewId);
   callback({ok:true,user:await afterChange(socket)});
  }catch(error){callback({ok:false,message:error.message});}
 });
}

export function registerUserSwitchGuard(socket,{verify,onIdentityChange,recordOperation}){
 socket.use(async(packet,next)=>{
  const event=String(packet[0]||'');
  if(!event.startsWith('guildsync:')||!socket.guildSyncAuthenticated||socket.guildSyncAuthType!=='GuildSync user')return next();
  try{
   const claims=await verify();
   if(String(claims.sub)!==socket.guildSyncUser?.discord_user_id||claims.role!==socket.guildSyncUser?.role||(claims.user_switch?.revision||0)!==(socket.guildSyncUser?.user_switch?.revision||0)){
    await onIdentityChange();throw Error('Your selected account changed. Reconnect before trying again.');
   }
   if(claims.user_switch?.active){
    if(event==='guildsync:set-role-view')throw Error('Return to your own account before using role preview.');
    if(event==='guildsync:change-user'&&String(packet[1]?.discord_user_id)===String(socket.guildSyncActorId))throw Error('Return to your own account before changing your own account.');
    if(event==='guildsync:voice-mute-hotkey'||event==='guildsync:voice-mute-access')throw Error('Voice hotkeys are paused while using another account.');
    if(!USER_SWITCH_EVENTS.has(event)&&!isReadOnlyGuildSyncEvent(event))await recordOperation(event);
   }
   return next();
  }catch(error){
   const callback=packet.at(-1),response={ok:false,message:error.message};
   if(typeof callback==='function')callback(response);else socket.emit('guildsync:permission-denied',response);
   if(error.message==='Session was logged out.'){socket.emit('guildsync:account-removed');socket.disconnect(true);}
  }
 });
}
