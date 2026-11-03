import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {Server} from 'socket.io';
import {createDesktopVersionPolicy} from './desktop-version-policy.js';
const require=createRequire(new URL('../GuildSync-Discord-Bot/package.json',import.meta.url));
const {io:connect}=require('socket.io-client');

test('real sockets receive upgrade notice before disconnect, and never obtain application data',async t=>{
 const httpServer=http.createServer(),server=new Server(httpServer);let admitted=0;
 const policy=createDesktopVersionPolicy({minimum:'1.5.0',latest:'1.6.0',fallbackUrl:'https://example.test/releases',timeoutMs:100});
 server.on('connection',socket=>{
  socket.guildSyncAuthType='GuildSync user';
  policy.admit(socket,()=>{admitted++;socket.join('data');socket.on('get-data',callback=>callback('private roster'));});
 });
 await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
 t.after(()=>server.close());
 const url=`http://127.0.0.1:${httpServer.address().port}`;
 for(const auth of [{client_type:'wails',version:'1.4.9'},{},{no_report:true}]) {
  const client=connect(url,{auth,transports:['websocket'],autoConnect:false,reconnection:true});t.after(()=>client.close());
  let data=false;client.on('roster',()=>data=true);
  const status=once(client,'guildsync:version-status',{signal:AbortSignal.timeout(5000)});
  const disconnected=once(client,'disconnect',{signal:AbortSignal.timeout(5000)});
  client.on('connect',()=>{client.emit('get-data',()=>data=true);if(!auth.version&&!auth.no_report)client.emit('guildsync:client-version',{client_type:'wails',version:'1.4.9'});});
  client.connect();const [reported]=await Promise.all([status,disconnected]);assert.equal(reported[0].supported,false);
  assert.equal(data,false);assert.equal(client.active,false);assert.equal(admitted,0);
 }
 const supported=connect(url,{auth:{client_type:'wails',version:'1.5.0'},transports:['websocket'],autoConnect:false});t.after(()=>supported.close());
 const ready=once(supported,'connect',{signal:AbortSignal.timeout(5000)});supported.connect();await ready;
 assert.equal(await supported.timeout(2000).emitWithAck('get-data'),'private roster');assert.equal(admitted,1);
});
