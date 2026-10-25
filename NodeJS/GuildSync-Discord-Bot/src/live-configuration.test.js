import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveConfiguration} from './live-configuration.js';
test('live configuration drains old workers before starting new ones and restores baseline',async()=>{const actions=[];let release;const controller=createLiveConfiguration({env:{GUILDSYNC_RAFFLE_CHANNEL_ID:'123'},start:env=>{actions.push('start:'+env.GUILDSYNC_RAFFLE_CHANNEL_ID);return [async()=>{actions.push('stop');await new Promise(r=>release=r);actions.push('drained');}];}});const first={revision:1,keys:[{key:'GUILDSYNC_RAFFLE_CHANNEL_ID',defaultValue:''}],overrides:{GUILDSYNC_RAFFLE_CHANNEL_ID:'456'}};await controller.apply(first);const update=controller.apply({...first,revision:2,overrides:{}});await new Promise(r=>setImmediate(r));assert.deepEqual(actions,['start:456','stop']);release();await update;assert.deepEqual(actions,['start:456','stop','drained','start:123']);assert.equal(controller.defaults(first.keys).GUILDSYNC_RAFFLE_CHANNEL_ID,'123');});

test('disconnect immediately stops stale listeners and reconnect reload resumes even unchanged defaults',async()=>{const {EventEmitter}=await import('node:events');const socket=new EventEmitter();let emitted=0;const controller=createLiveConfiguration({start:()=>{const tick=()=>emitted++;socket.on('connect',tick);return [()=>socket.off('connect',tick)];}});const config={revision:0,keys:[],overrides:{}};await controller.apply(config);await controller.pause();socket.emit('connect');assert.equal(emitted,0);await controller.apply(config,{resume:true});socket.emit('connect');assert.equal(emitted,1);});
test('disconnect during a slow start prevents stale generation from running',async()=>{let complete,stopped=0;const controller=createLiveConfiguration({start:async()=>{await new Promise(r=>complete=r);return [()=>stopped++];}});const starting=controller.apply({keys:[],overrides:{}});await new Promise(r=>setImmediate(r));const paused=controller.pause();complete();await Promise.all([starting,paused]);assert.equal(stopped,1);});

test('updates received while reconnect is paused supersede an older refresh response',async()=>{const seen=[];const controller=createLiveConfiguration({start:env=>{seen.push(env.GUILDSYNC_RAFFLE_CHANNEL_ID);return[];}});await controller.pause();const keys=[{key:'GUILDSYNC_RAFFLE_CHANNEL_ID',defaultValue:''}];await controller.apply({revision:2,keys,overrides:{GUILDSYNC_RAFFLE_CHANNEL_ID:'new'}});await controller.apply({revision:1,keys,overrides:{GUILDSYNC_RAFFLE_CHANNEL_ID:'old'}},{resume:true});assert.deepEqual(seen,['new']);});


test('sales reminder live override supersedes baseline and deletion restores baseline', async () => {
  const {parseReminderHours} = await import('./raffle.js');
  const key='GUILDSYNC_RAFFLE_SALES_CLOSE_REMINDER_HOURS', seen=[];
  const controller=createLiveConfiguration({env:{[key]:'2'},start:env=>{seen.push(parseReminderHours(env[key],[2]));return [];}});
  const keys=[{key,defaultValue:'2'}];
  await controller.apply({revision:1,keys,overrides:{}});
  await controller.apply({revision:2,keys,overrides:{[key]:'1'}});
  await controller.apply({revision:3,keys,overrides:{}});
  assert.deepEqual(seen,[[2],[1],[2]]);
});
