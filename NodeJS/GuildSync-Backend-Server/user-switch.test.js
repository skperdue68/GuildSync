import test from 'node:test';
import assert from 'node:assert/strict';
import {createUserSwitches,registerUserSwitchSocket,registerUserSwitchGuard} from './user-switch.js';
const actor={discord_user_id:'1',username:'Admin',guild_member_name:'Officer',role:'admin',allowed:1};
const target={discord_user_id:'2',username:'Target',role:'viewer',allowed:1};
function fixture(){
 const users=new Map([['1',{...actor}],['2',{...target}],['3',{discord_user_id:'3',username:'Pending',role:'pending',allowed:0}]]),audit=[];
 const db={execute:async(sql,args=[])=>{if(sql.startsWith('INSERT INTO guildsync_user_switch_audit')){audit.push(args);return [{}];}if(sql.includes('WHERE discord_user_id = ?'))return [[users.get(args[0])].filter(Boolean)];return [[...users.values()].filter(u=>u.allowed===1&&['viewer','user','admin'].includes(u.role)&&!u.revoked_at)];}};
 return {db,users,audit,service:createUserSwitches(db),claims:{sub:'1',jti:'login-a',actual_role:'admin',role:'admin',username:'Admin'}};
}
test('switch uses target identity/role, preserves actor/session, and does not alter another login',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');const claims=await f.service.resolve(f.claims);
 assert.equal(claims.sub,'2');assert.equal(claims.actor_sub,'1');assert.equal(claims.role,'viewer');assert.equal(claims.actual_role,'viewer');assert.equal(claims.jti,'login-a');assert.equal(claims.user_switch.active,true);
 assert.equal((await f.service.resolve({...f.claims,jti:'login-b'})).sub,'1');assert.equal(f.users.get('1').role,'admin');
 await f.service.set('1','login-a',null);assert.equal((await f.service.resolve(f.claims)).sub,'1');assert.equal(f.audit.length,2);assert.match(f.audit[0][2],/^[a-f0-9]{64}$/);
});
test('only approved admins may select approved targets; blank and pending/revoked targets fail closed',async()=>{
 const f=fixture();await assert.rejects(f.service.set('2','login-a','1'),/Admin/);await assert.rejects(f.service.set('1','','2'),/session/);await assert.rejects(f.service.set('1','login-a','3'),/approved/);
 f.users.get('2').revoked_at='now';await assert.rejects(f.service.set('1','login-a','2'),/approved/);f.users.get('1').allowed=0;await assert.rejects(f.service.list('1','login-a'),/Admin/);
});
test('approved dropdown omits pending records; actor demotion and target revocation return to self',async()=>{
 const f=fixture();assert.deepEqual((await f.service.list('1','login-a')).users.map(u=>u.discord_user_id),['1','2']);
 await f.service.set('1','login-a','2');f.users.get('2').allowed=0;assert.equal((await f.service.resolve(f.claims)).sub,'1');
 f.users.get('2').allowed=1;await f.service.set('1','login-a','2');f.users.get('1').role='user';const out=await f.service.resolve({...f.claims,actual_role:'user',role:'user'});assert.equal(out.sub,'1');assert.equal(out.role,'user');
});
test('logout/restart clear only their switch; audit failure prevents starting a switch',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');await f.service.clear('login-a','logout');assert.equal((await f.service.resolve(f.claims)).sub,'1');
 const denied=createUserSwitches({execute:async(sql)=>{if(sql.startsWith('INSERT'))throw Error('audit unavailable');return [[actor,target]];}});await assert.rejects(denied.set('1','login-a','2'),/audit/);
});
import {registerRolePermissions} from './role-permissions-socket.js';
import {createRosterNoteAccess} from './roster-note-access.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('socket control derives actor and session from authentication, not spoofed payload',async()=>{
 const f=fixture(),handlers=new Map(),socket={guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncActorId:'1',guildSyncRoleViewId:'login-a',guildSyncUser:{discord_user_id:'1'},on:(event,fn)=>handlers.set(event,fn)};
 registerUserSwitchSocket(socket,f.service,{clearRoleView:()=>{},afterChange:async()=>f.service.resolve(f.claims)});
 let result;await handlers.get('guildsync:set-user-switch')({discord_user_id:'2',actor_id:'2',session:'login-b'},value=>result=value);assert.equal(result.ok,true);assert.equal(result.user.sub,'2');assert.equal((await f.service.resolve({...f.claims,jti:'login-b'})).sub,'1');
 socket.guildSyncActorId='2';await handlers.get('guildsync:request-user-switch-options')({},value=>result=value);assert.equal(result.ok,false);
 socket.guildSyncAuthType='discord-bot';await handlers.get('guildsync:set-user-switch')({discord_user_id:null},value=>result=value);assert.equal(result.ok,false);
});
test('actor-only switching remains available while target is Viewer; ordinary edits stay denied',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');let middleware;
 const socket={guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncActorId:'1',guildSyncRoleViewId:'login-a',guildSyncUser:{discord_user_id:'2',role:'viewer'},use:fn=>middleware=fn};
 registerRolePermissions(socket,{execute:async()=>[[target]]},null,{authorizeUserSwitch:current=>f.service.authorize(current.guildSyncActorId)});
 const allowed=async event=>{let result=false;await middleware([event,{},()=>{}],()=>result=true);return result;};
 assert.equal(await allowed('guildsync:set-user-switch'),true);assert.equal(await allowed('guildsync:manual-link-member'),false);assert.equal(await allowed('guildsync:change-user'),false);
 f.users.get('1').role='user';assert.equal(await allowed('guildsync:set-user-switch'),false);
});
test('guard checks revoked actors even on reads and never dispatches stale-identity requests',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');const effective=await f.service.resolve(f.claims);let middleware,changed=0,disconnected=0;const events=[];
 const socket={guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncActorId:'1',guildSyncRoleViewId:'login-a',guildSyncUser:{discord_user_id:'2',role:'viewer',user_switch:effective.user_switch},use:fn=>middleware=fn,emit:event=>events.push(event),disconnect:()=>disconnected++};
 registerUserSwitchGuard(socket,{verify:()=>f.service.resolve(f.claims),onIdentityChange:async()=>changed++,recordOperation:event=>f.service.recordOperation(socket,event)});
 const call=async event=>{let next=false,response;await middleware([event,{},value=>response=value],()=>next=true);return {next,response};};
 assert.equal((await call('guildsync:request-roster-member-notes')).next,true);
 f.users.get('2').allowed=0;assert.equal((await call('guildsync:request-roster-member-notes')).next,false);assert.equal(changed,1);
 f.users.get('1').allowed=0;assert.equal((await call('guildsync:request-roster-member-notes')).next,false);assert.equal(disconnected,1);assert.ok(events.includes('guildsync:account-removed'));
});
test('missing switch audit state cannot authorize an old target operation',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');const socket={guildSyncActorId:'1',guildSyncRoleViewId:'login-a',guildSyncUser:{discord_user_id:'2'}};
 await f.service.recordOperation(socket,'guildsync:manual-link-member');assert.equal(f.audit.at(-1)[3],'operation');
 await f.service.clear('login-a');await assert.rejects(f.service.recordOperation(socket,'guildsync:manual-link-member'),/identity changed/);
});
test('actor demotion retains monotonic revision while removing switch permission',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');const before=await f.service.resolve(f.claims);f.users.get('1').role='user';const after=await f.service.resolve(f.claims);
 assert.equal(after.sub,'1');assert.equal(after.user_switch.active,false);assert.equal(after.user_switch.can_switch,false);assert.ok(after.user_switch.revision>before.user_switch.revision);
});
test('actual Discord ranks and target Viewer role determine note visibility, not admin actor rank',async()=>{
 const f=fixture();const roles=[{role_id:'50',role_name:'Soldiers'},{role_id:'60',role_name:'Consigliere'},{role_id:'70',role_name:'Kingpin'}];
 const noteDB={execute:async(sql,args)=>{if(sql.includes('FROM discord_roles'))return [roles];if(sql.includes('FROM discord_member_roles'))return [[{role_id:args[0]==='1'?'70':'50'}]];return [[{note_id:1,account_name:'Example',officer_name:'Officer',note_text:'Private officer note',note_timestamp:100,minimum_role_id:'60'}]];}};
 const notes=createRosterNoteAccess({db:noteDB,loginDB:f.service?{execute:async(_sql,args)=>[[f.users.get(args[0])]]}:null});
 await f.service.set('1','login-a','2');const switched=await f.service.resolve(f.claims);const socket={guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncUser:{discord_user_id:switched.sub,role:switched.role},emit:()=>{}};
 assert.deepEqual(await notes.read(socket,'Example'),[]);assert.equal((await notes.decorate(socket,[{account_name:'Example'}]))[0].note_count,0);await assert.rejects(notes.add(socket,{accountName:'Example',note:'test'}),/User or Admin/);
 await f.service.set('1','login-a',null);socket.guildSyncUser={discord_user_id:'1',role:'admin'};assert.equal((await notes.read(socket,'Example'))[0].note,'Private officer note');
});
test('actual HTTP logout deletes the actor session and clears switching while acting as another user',async()=>{
 const source=readFileSync(new URL('./guildsync-backend-server.js',import.meta.url),'utf8'),start=source.indexOf("app.post('/api/auth/logout'"),text=source.slice(start,source.indexOf("app.post('/api/guildsync/upload-savedvars",start));
 const f=fixture();await f.service.set('1','login-a','2');const claims=await f.service.resolve(f.claims);let handler,deleted;
 vm.runInNewContext(text,{app:{post:(_path,fn)=>handler=fn},verifyGuildSyncSession:async()=>claims,getBearerToken:()=> 'original-token',roleViews:{clear:()=>{}},userSwitches:f.service,roleViewSessionKey:()=> 'login-a',loginDB:{execute:async(_sql,args)=>deleted=args},io:{sockets:{sockets:new Map()}},jwt:{}});
 const result=await handler({}, {json:body=>body});assert.equal(result.ok,true);assert.equal(deleted[0],'login-a');assert.equal(deleted[1],'1');assert.equal((await f.service.resolve(f.claims)).sub,'1');
});


test('backend restart returns self with a different epoch so lower revisions are authoritative',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');const before=await f.service.resolve(f.claims);
 const after=await createUserSwitches(f.db).resolve(f.claims);assert.equal(after.sub,'1');assert.equal(after.user_switch.revision,0);assert.notEqual(after.user_switch.epoch,before.user_switch.epoch);
});

test('target account revocation returns switched sessions without logging out the actor',async()=>{
 const source=readFileSync(new URL('./guildsync-backend-server.js',import.meta.url),'utf8'),start=source.indexOf('const userAdministration = createUserAdministration('),end=source.indexOf('\nasync function broadcastUserAdministrationCounts',start);
 let changed;const notifications=[],removed=[];
 const switched={guildSyncRoleViewId:'actor-login',guildSyncUser:{discord_user_id:'2'},emit:event=>removed.push(['actor',event]),disconnect:()=>removed.push(['actor','disconnect'])};
 const realTarget={guildSyncRoleViewId:'target-login',guildSyncUser:{discord_user_id:'2'},emit:event=>removed.push(['target',event]),disconnect:()=>removed.push(['target','disconnect'])};
 vm.runInNewContext(source.slice(start,end),{createUserAdministration:(_db,options)=>{changed=options.onChange;return {};},loginDB:{},Log:()=>{},roleViews:{clearUser:()=>{}},userSwitches:{clearUser:async()=>['actor-login']},io:{sockets:{sockets:new Map([['actor',switched],['target',realTarget]])}},notifyUserSwitch:async client=>notifications.push(client),broadcastUserAdministrationCounts:async()=>{}});
 await changed({discord_user_id:'2',removed:true,action:'revoke',actor_id:'3'});
 assert.deepEqual(notifications,[switched]);assert.deepEqual(removed,[['target','guildsync:account-removed'],['target','disconnect']]);
});
test('an operation cannot pass when another connection returns during its audit write',async()=>{
 const f=fixture();await f.service.set('1','login-a','2');let releaseAudit;const original=f.db.execute;
 f.db.execute=async(sql,args)=>{if(args?.[3]==='operation')await new Promise(resolve=>releaseAudit=resolve);return original(sql,args);};
 const pending=f.service.recordOperation({guildSyncActorId:'1',guildSyncRoleViewId:'login-a',guildSyncUser:{discord_user_id:'2'}},'guildsync:manual-link-member');
 await f.service.clear('login-a');releaseAudit();await assert.rejects(pending,/identity changed/);
});


test('identity transition never sends profile data to an unadmitted desktop connection',async()=>{
 const source=readFileSync(new URL('./guildsync-backend-server.js',import.meta.url),'utf8'),start=source.indexOf('async function notifyUserSwitch('),end=source.indexOf('\nfunction registerVoiceForSocket',start);
 let fetched=0,disconnected=0,emitted=0;
 const notify=vm.runInNewContext(source.slice(start,end)+'\nnotifyUserSwitch',{currentUserSwitchProfile:async()=>{fetched++;return {};},setTimeout:()=>{}});
 await notify({guildSyncVersionAdmitted:false,disconnect:()=>disconnected++,emit:()=>emitted++});assert.equal(fetched,0);assert.equal(emitted,0);assert.equal(disconnected,1);
});
