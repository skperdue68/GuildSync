import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRoleViews,registerRoleViewSocket,roleViewSessionKey} from './role-view.js';
import {registerRolePermissions} from './role-permissions-socket.js';

test('Admin preview changes only effective permissions, remains session-scoped, and resets on logout',async()=>{
 let row={role:'admin',allowed:1};const db={execute:async()=>[[row]]},views=createRoleViews(db);
 await views.set('1','session-a','viewer');assert.equal(row.role,'admin');assert.equal(views.effective('session-a','admin'),'viewer');assert.equal(views.effective('session-b','admin'),'admin');
 await views.set('1','session-a','user');assert.equal(views.effective('session-a','admin'),'user');
 views.clear('session-a');assert.equal(views.effective('session-a','admin'),'admin');
 await views.set('1','session-a','viewer');row={role:'user',allowed:1};await assert.rejects(views.set('1','session-a','admin'),/Admin/);assert.equal(views.effective('session-a','user'),'user');
});
test('only actual approved Admin accounts can select or leave preview mode',async()=>{
 const views=createRoleViews({execute:async()=>[[{role:'viewer',allowed:1}]]});await assert.rejects(views.set('1','session','admin'),/Admin/);
 await assert.rejects(createRoleViews({execute:async()=>[[{role:'admin',allowed:0}]]}).set('1','session','viewer'),/Admin/);
 const admin=createRoleViews({execute:async()=>[[{role:'admin',allowed:1}]]});await assert.rejects(admin.set('1','session','owner'),/role/i);await assert.rejects(admin.set('1','', 'viewer'),/session/i);
 assert.equal(roleViewSessionKey({jti:'session'}),'session');assert.equal(roleViewSessionKey({sub:'1',iat:100}),'legacy:1:100');
});
test('socket preview handler derives administrator/session from authentication and rejects bots',async()=>{
 const handlers=new Map(),calls=[],socket={guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncUser:{discord_user_id:'1'},guildSyncRoleViewId:'session',on:(event,fn)=>handlers.set(event,fn)};
 registerRoleViewSocket(socket,{set:async(...args)=>calls.push(args)},async()=>({role:'viewer',actual_role:'admin'}));
 let response;await handlers.get('guildsync:set-role-view')({role:'viewer',discord_user_id:'2',session:'other'},r=>response=r);assert.deepEqual(calls[0],['1','session','viewer']);assert.equal(response.user.actual_role,'admin');
 socket.guildSyncAuthType='discord-bot';await handlers.get('guildsync:set-role-view')({role:'admin'},r=>response=r);assert.equal(response.ok,false);assert.equal(calls.length,1);
});
test('preview enforces backend restrictions but permits ingestion and returning to Admin',async()=>{
 const db={execute:async()=>[[{role:'admin',allowed:1}]]},views=createRoleViews(db);
 await views.set('1','session','viewer');let middleware;const socket={guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncUser:{discord_user_id:'1',role:'admin'},guildSyncRoleViewId:'session',use:fn=>middleware=fn};registerRolePermissions(socket,db,views);
 const allowed=async event=>{let result=false;await middleware([event,{},()=>{}],()=>result=true);return result};
 assert.equal(await allowed('guildsync:change-user'),false);assert.equal(await allowed('guildsync:manual-link-member'),false);assert.equal(await allowed('guildsync:checkout-deposit-mail'),false);assert.equal(await allowed('guildsync:sending-roster-data'),true);assert.equal(await allowed('guildsync:set-role-view'),true);
 await views.set('1','session','user');assert.equal(await allowed('guildsync:move-banking-entry'),true);assert.equal(await allowed('guildsync:manual-link-member'),true);assert.equal(await allowed('guildsync:change-user'),false);
 await views.set('1','session','admin');assert.equal(await allowed('guildsync:change-user'),true);
});

test('actual logout handler clears preview and removes the login session',async()=>{
 const source=readFileSync(new URL('./guildsync-backend-server.js',import.meta.url),'utf8'),start=source.indexOf("app.post('/api/auth/logout'");
 const text=source.slice(start,source.indexOf("app.post('/api/guildsync/upload-savedvars",start));
 const views=createRoleViews({execute:async()=>[[{role:'admin',allowed:1}]]});await views.set('1','session','viewer');
 let handler,deleted=false,disconnected=false;
 vm.runInNewContext(text,{app:{post:(path,fn)=>handler=fn},verifyGuildSyncSession:async()=>({sub:'1',jti:'session',role:'viewer',actual_role:'admin'}),getBearerToken:()=> 'token',roleViews:views,userSwitches:{clear:async()=>{}},roleViewSessionKey,loginDB:{execute:async()=>deleted=true},io:{sockets:{sockets:new Map([['socket',{guildSyncSessionId:'session',disconnect:()=>disconnected=true}]])}},jwt:{}});
 const result=await handler({}, {json:body=>body});assert.equal(result.ok,true);assert.equal(deleted,true);assert.equal(disconnected,true);assert.equal(views.effective('session','admin'),'admin');
});
