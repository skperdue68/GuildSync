import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {resolveNoteRanks,canReadRosterNote,createRosterNoteAccess,initializeRosterNoteAccess} from './roster-note-access.js';
const roles=[{role_id:'1',role_name:'Associates'},{role_id:'2',role_name:'Capo'},{role_id:'3',role_name:'Consigliere'},{role_id:'4',role_name:'Kingpin'},{role_id:'5',role_name:'Decorative'}];
test('guild ranks use singular/plural names or configured IDs, not decorative roles',()=>{
 const ranks=resolveNoteRanks(roles,'');
 assert.equal(ranks.byId.get('1'),1);assert.equal(ranks.byId.get('2'),3);assert.equal(ranks.byId.has('5'),false);
 const custom=resolveNoteRanks(roles,'1,Capo,3,Kingpin');assert.equal(custom.byId.get('2'),1);
});
test('startup migration preserves historical notes and adds nullable access metadata',async()=>{
 const sql=[];await initializeRosterNoteAccess({query:async value=>sql.push(value)});
 assert.match(sql[0],/CREATE TABLE IF NOT EXISTS/);assert.match(sql[1],/ADD COLUMN IF NOT EXISTS minimum_role_id/);
 assert.doesNotMatch(sql.join(' '),/DELETE|DROP|UPDATE /);
});
test('shared roster payloads contain no unfiltered counts, including importer responses',async()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 const a=source.indexOf('export async function getRosterDataJSON('),b=source.indexOf('export async function getRosterMemberNotes(',a);
 const ctx=vm.createContext({});vm.runInContext(source.slice(a,b).replace('export async','async'),ctx);
 const rows=await ctx.getRosterDataJSON({execute:async()=>[[{roster_json:JSON.stringify([{account_name:'Alice',note_count:123}])}]]});
 assert.equal(rows[0].note_count,0);
});
test('rank changes notify the client to discard previously loaded note text',async()=>{
 let role='3';const emitted=[];
 const service=createRosterNoteAccess({db:{execute:async sql=>sql.includes('FROM discord_roles')?[roles]:sql.includes('FROM discord_member_roles')?[[{role_id:role}]]:[[]]},
   loginDB:{execute:async()=>[[{allowed:1,role:'viewer'}]]}});
 const socket={guildSyncAuthenticated:true,guildSyncUser:{discord_user_id:'99'},emit:event=>emitted.push(event)};
 await service.read(socket,'Alice');role='2';await service.read(socket,'Alice');
 assert.deepEqual(emitted,['guildsync:roster-notes-access-changed']);
 await assert.rejects(()=>service.add(socket,{accountName:'Alice',note:'Not allowed'}),/User or Admin/);
});
test('same/higher ranks read notes, lower and unknown ranks get no note, legacy notes stay restricted',()=>{
 const ranks=resolveNoteRanks(roles,''),note={minimum_role_id:'3'};
 assert.equal(canReadRosterNote(note,{...ranks,rank:5}),true);assert.equal(canReadRosterNote(note,{...ranks,rank:6}),true);
 assert.equal(canReadRosterNote(note,{...ranks,rank:3}),false);assert.equal(canReadRosterNote(note,{...ranks,rank:-1}),false);
 assert.equal(canReadRosterNote({}, {...ranks,rank:5}),false);assert.equal(canReadRosterNote({}, {...ranks,rank:6}),true);
 assert.equal(canReadRosterNote({minimum_role_id:'deleted'}, {...ranks,rank:6}),false);
});
test('notes and counts are filtered before leaving backend; authorship is captured from authenticated user',async()=>{
 let rankId='2',allowed=1;const writes=[];
 const notes=[{note_id:1,account_name:'Alice',minimum_role_id:'3',note_text:'Secret',officer_name:'Boss',note_timestamp:'100'},
   {note_id:2,account_name:'Alice',minimum_role_id:'1',note_text:'Visible',officer_name:'Other',note_timestamp:'101'}];
 const db={execute:async(sql,args)=>{
   if(sql.includes('FROM discord_roles'))return [roles];
   if(sql.includes('FROM discord_member_roles'))return [[{role_id:rankId}]];
   if(sql.startsWith('INSERT INTO guildsync_roster_member_notes')){writes.push(args);return [{insertId:3}];}
   return [notes];
 }};
 const service=createRosterNoteAccess({db,loginDB:{execute:async()=>[[{allowed,role:'admin'}]]}});
 const socket={guildSyncAuthenticated:true,guildSyncUser:{discord_user_id:'99',display_name:'Author'}};
 assert.deepEqual((await service.read(socket,'Alice')).map(n=>n.note),['Visible']);
 assert.equal((await service.decorate(socket,[{account_name:'Alice',note_count:999}]))[0].note_count,1);
 await service.add(socket,{accountName:'Alice',note:'New',minimum_role_id:'4',officerName:'Spoof'});
 assert.ok(writes[0].includes('99'));assert.ok(writes[0].includes('2'));assert.ok(writes[0].includes('Author'));assert.ok(!writes[0].includes('Spoof'));
 rankId='5';assert.deepEqual(await service.read(socket,'Alice'),[]);
 await assert.rejects(()=>service.add(socket,{accountName:'Alice',note:'New'}),/rank/);
 allowed=0;await assert.rejects(()=>service.read(socket,'Alice'),/Approved/);
});

for(const client of ['web/src','../../GO/GuildSync-Frontend-Client/frontend/src']) {
 test(`${client} ignores a late note response after access changed`,async()=>{
  const source=fs.readFileSync(new URL(`./${client}/main.js`,import.meta.url),'utf8');
  const a=source.indexOf('async function openRosterNotesDialog('),b=source.indexOf('function closeRosterNotesDialog(',a);
  const pending=[];
  const ctx=vm.createContext({rosterNotesLoadGeneration:0,rosterNotesDialogNotes:[],renderGuildSyncTabLayout(){},formatError:String,
    emitSocketWithAck:()=>new Promise(resolve=>pending.push(resolve))});
  vm.runInContext(source.slice(a,b),ctx);
  const first=ctx.openRosterNotesDialog('Alice');
  const second=ctx.openRosterNotesDialog('Alice');
  pending[1]({ok:true,notes:[]});await second;
  pending[0]({ok:true,notes:[{note:'Previously authorized secret'}]});await first;
  assert.equal(ctx.rosterNotesDialogNotes.length,0);
 });
}
