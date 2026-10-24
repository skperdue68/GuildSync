import test from 'node:test';
import assert from 'node:assert/strict';
import {recordDiscordInteraction} from './interaction-statistics.js';
test('records safe metadata without private component IDs and never interrupts commands',()=>{
 const events=[];const socket={connected:true,emit:(...args)=>events.push(args)};
 const interaction={id:'123',guildId:'456',user:{id:'789',username:'A'},isButton:()=>true,customId:'secret token'};
 recordDiscordInteraction(socket,interaction,'456');assert.equal(events[0][1].name,'button');assert.ok(!JSON.stringify(events).includes('secret'));
 assert.doesNotThrow(()=>recordDiscordInteraction({connected:true,emit(){throw Error('offline');}},interaction,'456'));
 recordDiscordInteraction(socket,{...interaction,isButton:()=>false,isAutocomplete:()=>true},'456');assert.equal(events.length,1);
 recordDiscordInteraction(socket,interaction,'999');assert.equal(events.length,1);
});
