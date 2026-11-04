import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {Server} from 'socket.io';
import jwt from 'jsonwebtoken';
import {createUserSwitches,registerUserSwitchGuard,registerUserSwitchSocket} from './user-switch.js';
import {createRoleViews,roleViewSessionKey} from './role-view.js';
import {registerRolePermissions} from './role-permissions-socket.js';
const requireBot=createRequire(new URL('../GuildSync-Discord-Bot/package.json',import.meta.url));
const {io:connect}=requireBot('socket.io-client');

test('real actor JWT survives switching, selected Viewer cannot write, return works and revocation is checked on reads',async()=>{
 const users=new Map([['1',{discord_user_id:'1',username:'Admin',allowed:1,role:'admin'}],['2',{discord_user_id:'2',username:'Viewer',allowed:1,role:'viewer'}]]);
 const sessions=new Map([['actor-login','1'],['other-login','1']]),audits=[];
 const db={execute:async(sql,args=[])=>{
  if(sql.startsWith('INSERT INTO guildsync_user_switch_audit')){audits.push(args);return [{}];}
  if(sql.includes('JOIN guildsync_users AS users')){const user=users.get(args[1]);return [sessions.get(args[0])===args[1]&&user?.allowed===1?[{role:user.role}]:[]];}
  if(sql.includes('WHERE discord_user_id = ?'))return [[users.get(args[0])].filter(Boolean)];
  return [[...users.values()].filter(u=>u.allowed===1)];
 }};
 const http=createServer(),io=new Server(http),secret='test-user-switch-secret',userSwitches=createUserSwitches(db),roleViews=createRoleViews(db);
 const source=readFileSync(new URL('./guildsync-backend-server.js',import.meta.url),'utf8'),start=source.indexOf('async function verifyGuildSyncSession('),end=source.indexOf('\nfunction getBearerToken',start);
 const context=vm.createContext({jwt,GUILDSYNC_JWT_SECRET:secret,loginDB:db,io,roleViews,roleViewSessionKey,userSwitches});vm.runInContext(source.slice(start,end),context);
 const profile=claims=>({discord_user_id:claims.sub,role:claims.role,actual_role:claims.actual_role,user_switch:claims.user_switch});
 io.use(async(socket,next)=>{try{const c=await context.verifyGuildSyncSession(socket.handshake.auth.token);Object.assign(socket,{guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncActorId:c.actor_sub,guildSyncSessionId:c.jti,guildSyncRoleViewId:roleViewSessionKey(c),guildSyncUser:profile(c)});next();}catch(error){next(error);}});
 io.on('connection',socket=>{
  registerUserSwitchGuard(socket,{verify:()=>context.verifyGuildSyncSession(socket.handshake.auth.token),onIdentityChange:async()=>socket.emit('guildsync:user-switch-changed',{user:profile(await context.verifyGuildSyncSession(socket.handshake.auth.token))}),recordOperation:event=>userSwitches.recordOperation(socket,event)});
  registerRolePermissions(socket,db,roleViews,{authorizeUserSwitch:current=>userSwitches.authorize(current.guildSyncActorId)});
  registerUserSwitchSocket(socket,userSwitches,{clearRoleView:key=>roleViews.clear(key),afterChange:async()=>profile(await context.verifyGuildSyncSession(socket.handshake.auth.token))});
  socket.on('guildsync:request-roster-data',(_payload,ack)=>ack({ok:true,user:socket.guildSyncUser}));
  socket.on('guildsync:manual-link-member',(_payload,ack)=>ack({ok:true}));
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 const token=id=>jwt.sign({sub:'1',jti:id,username:'Admin'},secret,{issuer:'guildsync-auth-server',audience:'guildsync-desktop'});
 const actualToken=token('actor-login'),client=connect(`http://127.0.0.1:${http.address().port}`,{auth:{token:actualToken},autoConnect:false,reconnection:false}),other=connect(`http://127.0.0.1:${http.address().port}`,{auth:{token:token('other-login')},autoConnect:false,reconnection:false});
 const ready=client=>new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);client.connect();});
 const request=(client,event,payload={})=>new Promise((resolve,reject)=>client.timeout(3000).emit(event,payload,(error,response)=>error?reject(error):resolve(response)));
 const reconnect=async()=>{client.disconnect();await ready(client);};
 try{
  await ready(client);await ready(other);
  const choices=await request(client,'guildsync:request-user-switch-options');assert.equal(choices.ok,true);assert.equal(choices.users.length,2);
  const switched=await request(client,'guildsync:set-user-switch',{discord_user_id:'2',actor_id:'2'});assert.equal(switched.user.discord_user_id,'2');assert.equal(switched.user.role,'viewer');assert.equal(client.auth.token,actualToken);
  assert.equal((await request(client,'guildsync:request-roster-data')).ok,false,'old socket must reconnect before dispatching data');
  await reconnect();assert.equal((await request(client,'guildsync:request-roster-data')).user.discord_user_id,'2');assert.equal((await request(client,'guildsync:manual-link-member')).ok,false);
  assert.equal((await request(other,'guildsync:request-roster-data')).user.discord_user_id,'1','separate login remains self');
  assert.equal((await request(client,'guildsync:set-user-switch',{discord_user_id:null})).ok,true);await reconnect();assert.equal((await request(client,'guildsync:request-roster-data')).user.discord_user_id,'1');
  await request(client,'guildsync:set-user-switch',{discord_user_id:'2'});await reconnect();users.get('2').allowed=0;
  assert.equal((await request(client,'guildsync:request-roster-data')).ok,false);await reconnect();assert.equal((await request(client,'guildsync:request-roster-data')).user.discord_user_id,'1');
  assert.equal(sessions.get('actor-login'),'1');assert.ok(audits.length>=4);
 }finally{client.disconnect();other.disconnect();await io.close();if(http.listening)await new Promise(resolve=>http.close(resolve));}
});
