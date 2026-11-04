import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const captureSource=await readFile(new URL('./shortcut-capture.js',import.meta.url),'utf8');
const source = (await readFile(new URL('./voice-hotkey.js', import.meta.url), 'utf8')).replace('./shortcut-capture.js','data:text/javascript;base64,'+Buffer.from(captureSource).toString('base64'));
const {createVoiceHotkeyController} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('native listener failure releases held mute and exposes setup error',async()=>{
 let edge;const states=[],active=[];
 const socket={connected:true,emit(event,payload,ack){if(event==='guildsync:voice-mute-access'){ack({ok:true,enabled:true,allowed:true});return;}states.push(payload.state);ack?.({ok:true})}};
 const control=createVoiceHotkeyController({bridge:{GetVoiceHotkeySettings:async()=>({enabled:true,shortcut:'Ctrl+M',supported:true}),SetVoiceHotkeyActive:async value=>active.push(value)},eventsOn(_,fn){edge=fn},getSocket:()=>socket,authenticated:()=>true});
 await control.connection(true);edge({state:'pressed'});edge({state:'error',message:'Enable Input Monitoring'});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(states,['pressed','released']);assert.equal(active.at(-1),false);
 await control.refreshAccess();assert.deepEqual(active,[true,false],'policy polling must not reopen a failed or cancelled keyboard permission request');
 const status={textContent:''};control.wire({querySelector:selector=>selector==='#voiceHotkeyStatus'?status:null});assert.equal(status.textContent,'Enable Input Monitoring');control.stop();
});

test('disabled settings never request global keyboard access',async()=>{
 const active=[];const socket={connected:true,emit(_,__,ack){ack({ok:true,enabled:true,allowed:true})}};
 const control=createVoiceHotkeyController({bridge:{GetVoiceHotkeySettings:async()=>({enabled:false,shortcut:'Ctrl+M',supported:true}),SetVoiceHotkeyActive:async value=>active.push(value)},eventsOn(){},getSocket:()=>socket,authenticated:()=>true});
 await control.connection(true);assert.deepEqual(active,[]);control.stop();
});

test('menu is hidden unless policy and Discord role access are both confirmed',async()=>{
 let response={ok:true,enabled:false,allowed:false};const active=[];
 const socket={connected:true,emit(event,payload,ack){if(event==='guildsync:voice-mute-access')ack(response)}};
 const bridge={GetVoiceHotkeySettings:async()=>({enabled:true,shortcut:'Ctrl+M',supported:true}),SetVoiceHotkeyActive:async value=>active.push(value)};
 const control=createVoiceHotkeyController({bridge,eventsOn(){},getSocket:()=>socket,authenticated:()=>true});
 assert.equal(control.render(),'');await control.connection(true);assert.equal(control.render(),'');
 response={ok:true,enabled:true,allowed:false};await control.refreshAccess();assert.equal(control.render(),'');
 response={ok:true,enabled:true,allowed:true};await control.refreshAccess();assert.match(control.render(),/Voice Channel Mute/);assert.deepEqual(active,[true]);
 await control.refreshAccess();assert.deepEqual(active,[true],'poll must not restart a permitted listener');
 response={ok:false,enabled:true,allowed:true};await control.refreshAccess();assert.equal(control.render(),'');assert.deepEqual(active,[true,false]);control.stop();
});
test('access loss releases an active hold and hides the controls',async()=>{
 let edge,allowed=true;const sent=[];
 const socket={connected:true,emit(event,payload,ack){if(event==='guildsync:voice-mute-access'){ack({ok:true,enabled:true,allowed});return;}sent.push(payload.state);ack?.({ok:true})}};
 const control=createVoiceHotkeyController({bridge:{GetVoiceHotkeySettings:async()=>({enabled:true,shortcut:'Ctrl+M',supported:true}),SetVoiceHotkeyActive:async()=>{}},eventsOn(_,fn){edge=fn},getSocket:()=>socket,authenticated:()=>true});
 await control.connection(true);edge({state:'pressed'});allowed=false;await control.refreshAccess();assert.deepEqual(sent,['pressed','released']);assert.equal(control.render(),'');control.stop();
});

test('an obsolete access response cannot re-enable the listener after disconnect',async()=>{
 let reply;const active=[];const socket={connected:true,emit(event,payload,ack){reply=ack}};
 const control=createVoiceHotkeyController({bridge:{GetVoiceHotkeySettings:async()=>({enabled:true,shortcut:'Ctrl+M',supported:true}),SetVoiceHotkeyActive:async value=>active.push(value)},eventsOn(){},getSocket:()=>socket,authenticated:()=>true});
 const connecting=control.connection(true);await new Promise(resolve=>setImmediate(resolve));socket.connected=false;await control.connection(false);reply({ok:true,enabled:true,allowed:true});await connecting;
 assert.equal(control.render(),'');assert.deepEqual(active,[]);control.stop();
});
test('disconnect releases owner, blocks held replay, fresh press gets a new nonce', async () => {
  globalThis.crypto ??= (await import('node:crypto')).webcrypto;
  let edge; const calls = []; let connected = true;
  const socket = {get connected() {return connected;}, emit(event,payload,ack) {if(event==="guildsync:voice-mute-access"){ack?.({ok:true,enabled:true,allowed:true});return;} calls.push({event,...payload}); ack?.({ok:true});}};
  const bridge = {GetVoiceHotkeySettings:async()=>({enabled:true,shortcut:'Ctrl+M',supported:true}),SetVoiceHotkeyActive:async()=>{}};
  const control = createVoiceHotkeyController({bridge,eventsOn:(_,fn)=>edge=fn,getSocket:()=>socket,authenticated:()=>true});
  await control.connection(true);
  edge({state:'pressed'}); edge({state:'pressed'});
  assert.equal(calls.length,1); const first = calls[0].sessionId;
  await control.connection(false);
  assert.equal(calls[1].state,'released'); assert.equal(calls[1].sessionId,first);
  connected = false; edge({state:'pressed'}); connected = true;
  await control.connection(true); edge({state:'pressed'});
  assert.equal(calls.length,2);
  edge({state:'released'}); edge({state:'pressed'});
  assert.equal(calls.length,3); assert.notEqual(calls[2].sessionId,first);
  control.stop(); assert.equal(calls[3].state,'released');
});
test('rejected press never retries until release', async () => {
  let edge; let presses=0;
  const bridge = {GetVoiceHotkeySettings:async()=>({enabled:true,shortcut:'Ctrl+M',supported:true}),SetVoiceHotkeyActive:async()=>{}};
  const socket={connected:true,emit(event,payload,ack){if(event==='guildsync:voice-mute-access'){ack?.({ok:true,enabled:true,allowed:true});return;} if(payload.state==='pressed')presses++; ack?.({ok:false,message:'Forbidden'});}};
  const control = createVoiceHotkeyController({bridge,eventsOn:(_,fn)=>edge=fn,getSocket:()=>socket,authenticated:()=>true});
  await control.connection(true); edge({state:'pressed'}); edge({state:'pressed'});
  assert.equal(presses,1); control.stop();
});


test('saving preserves an asynchronous native setup failure and suppresses polling retries',async()=>{
 let edge,onchange;const active=[];
 const settings={enabled:true,shortcut:'Ctrl+M',supported:true};
 const socket={connected:true,emit(_,__,ack){ack({ok:true,enabled:true,allowed:true})}};
 const control=createVoiceHotkeyController({bridge:{GetVoiceHotkeySettings:async()=>settings,SetVoiceHotkeyActive:async value=>active.push(value),SetVoiceHotkeySettings:async()=>{edge({state:'error',message:'Linux Global Shortcuts API unavailable'});return settings;}},eventsOn(_,fn){edge=fn},getSocket:()=>socket,authenticated:()=>true});
 await control.connection(true);
 control.wire({querySelector:selector=>selector==='#voiceHotkeyEnabled'?{addEventListener(_,fn){onchange=fn}}:null});
 onchange({target:{checked:true}});await new Promise(resolve=>setImmediate(resolve));
 await control.refreshAccess();assert.deepEqual(active,[true,false]);assert.match(control.render(),/Voice mute is unavailable/);
 const status={textContent:''};control.wire({querySelector:selector=>selector==='#voiceHotkeyStatus'?status:null});assert.equal(status.textContent,'Linux Global Shortcuts API unavailable');control.stop();
});

test('account switching waits for an outstanding voice release acknowledgement',async()=>{
 let edge,releaseAck,finished=false;
 const socket={connected:true,emit(event,payload,ack){if(event==='guildsync:voice-mute-access')return ack({ok:true,enabled:true,allowed:true});if(payload.state==='released')releaseAck=ack;else ack?.({ok:true});}};
 const control=createVoiceHotkeyController({bridge:{GetVoiceHotkeySettings:async()=>({enabled:true,supported:true,shortcut:'Ctrl+M'}),SetVoiceHotkeyActive:async()=>{}},eventsOn(_,fn){edge=fn;},getSocket:()=>socket,authenticated:()=>true});
 await control.connection(true);edge({state:'pressed'});edge({state:'released'});
 const pending=control.connection(false,{waitForRelease:true}).then(()=>finished=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);releaseAck({ok:true});await pending;assert.equal(finished,true);control.stop();
});
test('an unconfirmed voice release blocks switching rather than dropping cleanup',async()=>{
 let edge;const socket={connected:true,emit(event,payload,ack){if(event==='guildsync:voice-mute-access')return ack({ok:true,enabled:true,allowed:true});ack?.(payload.state==='released'?{ok:false,message:'Recovery pending'}:{ok:true});}};
 const control=createVoiceHotkeyController({bridge:{GetVoiceHotkeySettings:async()=>({enabled:true,supported:true,shortcut:'Ctrl+M'}),SetVoiceHotkeyActive:async()=>{}},eventsOn(_,fn){edge=fn;},getSocket:()=>socket,authenticated:()=>true});
 await control.connection(true);edge({state:'pressed'});await assert.rejects(control.connection(false,{waitForRelease:true}),/Recovery pending/);control.stop();
});
