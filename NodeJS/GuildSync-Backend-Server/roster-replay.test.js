import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness({snapshot=0,members=[],events=[]}={}) {
  const roster=new Map(members.map(name=>[name,{account_name:name,rank:'Soldier',in_roster:1}]));
  const history=new Map(events.map(event=>[event.id,event]));let watermark=snapshot,id=0;
  const execute=async(raw,args=[])=>{
    const sql=raw.replace(/\s+/g,' ').trim();
    if(sql.startsWith('SELECT value'))return [[{value:watermark}]];
    if(sql.includes('MAX(CAST(event_timestamp')) {
      const rows=[...history.values()].filter(e=>!sql.includes('account_name = ?') || e.name===args[0]);
      return [[{latest:Math.max(0,...rows.map(e=>e.time))}]];
    }
    if(sql.startsWith('INSERT IGNORE INTO guildsync_settings'))return [{affectedRows:0}];
    if(sql.startsWith('INSERT INTO guildsync_settings')){if(args[0]==='lastGuildList')watermark=Number(args[1]);return [{affectedRows:1}];}
    if(sql.startsWith('INSERT IGNORE INTO guildsync_roster_events')){
      if(history.has(args[0]))return [{affectedRows:0}];
      history.set(args[0],{id:args[0],name:args[1],type:args[2],time:Number(args[4])});return [{affectedRows:1}];
    }
    if(sql.startsWith('UPDATE guildsync_roster_members SET in_roster = 0')){for(const row of roster.values())row.in_roster=0;return [{}];}
    if(sql.startsWith('INSERT INTO guildsync_roster_members')){roster.set(args[0],{account_name:args[0],rank:args[1],in_roster:1});return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE guildsync_roster_members SET rank_name')){if(roster.has(args[1]))roster.get(args[1]).rank=args[0];return [{affectedRows:1}];}
    if(sql.startsWith('SELECT') && sql.includes('FROM guildsync_roster_members WHERE in_roster = 0'))return [[...roster.values()].filter(row=>!row.in_roster)];
    if(sql.startsWith('SELECT rank_name AS rank'))return [[roster.get(args[0])].filter(Boolean)];
    if(sql.startsWith('DELETE FROM guildsync_roster_members WHERE in_roster = 0')){for(const [name,row] of roster)if(!row.in_roster)roster.delete(name);return [{}];}
    if(sql.startsWith('DELETE FROM guildsync_roster_members')){roster.delete(args[0]);return [{}];}
    if(sql.includes('guildsync_roster_rank_history'))return [{}];
    throw Error('Unhandled SQL: '+sql);
  };
  const connection={execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){}};
  const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
  const start=source.indexOf('export async function processRosterData('),end=source.indexOf('function normalizeGuildListMembers(',start);
  const ctx=vm.createContext({validateEsoGuildImport(){},normalizeRosterEvents:v=>Array.isArray(v)?v:Object.values(v||{}),
    normalizeRosterTimestamp:v=>Number(v)||0,normalizeRosterAccountName:v=>String(v||''),normalizeRosterRank:v=>String(v||''),normalizeRosterEventType:v=>v,
    normalizeGuildListMembers:v=>Array.isArray(v)?v:Object.values(v||{}),createAutomaticRosterEventId:()=>`auto-${++id}`,
    safeRollback:async()=>{},runMemberAutoLinking:async()=>{},getRosterDataJSON:async()=>[...roster.values()]
  });
  vm.runInContext(source.slice(start,end).replace('export async','async'),ctx);
  return {roster,history,run:data=>ctx.processRosterData({getConnection:async()=>connection},{data}),watermark:()=>watermark};
}
const event=(id,type,time,name='Alice')=>({eventId:id,eventType:type,timestampS:time,targetDisplayName:name,rankName:'Capo'});

test('replayed joins and promotions do not resurrect a member removed by a newer guild list',async()=>{
  const h=harness({snapshot:200,events:[{id:'old',name:'Alice',type:'joined',time:100}]});
  await h.run({rosterEvents:[event('old','joined',100),event('old-promotion','promoted',150)]});
  assert.equal(h.roster.has('Alice'),false);assert.equal(h.history.has('old-promotion'),true);
});
test('late, previously unseen old joins do not undo a departure; a genuine newer join restores membership',async()=>{
  const h=harness({events:[{id:'left',name:'Alice',type:'left',time:300}]});
  await h.run({rosterEvents:[event('late','joined',100),event('promote','promoted',400)]});
  assert.equal(h.roster.has('Alice'),false);
  await h.run({rosterEvents:[event('new','joined',500)]});assert.equal(h.roster.has('Alice'),true);
});
test('equal and stale snapshots cannot restore a member; newer authoritative snapshots may',async()=>{
  const h=harness({snapshot:200});
  await h.run({guildList:{listTimestamp:200,guildListMembers:[{accountName:'Alice',rankName:'Soldier'}]}});
  assert.equal(h.roster.has('Alice'),false);
  await h.run({guildList:{listTimestamp:250,guildListMembers:[{accountName:'Alice',rankName:'Soldier'}]}});
  assert.equal(h.roster.has('Alice'),true);
});
test('out-of-order streamed events end in the latest state and duplicate imports do not change it',async()=>{
  const h=harness();
  const payload={rosterEvents:[event('left','left',300),event('join','joined',100),event('rank','promoted',200)]};
  await h.run(payload);assert.equal(h.roster.has('Alice'),false);
  await h.run(payload);assert.equal(h.roster.has('Alice'),false);
});
test('snapshots older than already applied stream history cannot rewind membership',async()=>{
  const h=harness({snapshot:100,events:[{id:'left',name:'Alice',type:'left',time:300}]});
  await h.run({guildList:{listTimestamp:200,guildListMembers:[{accountName:'Alice',rankName:'Soldier'}]}});
  assert.equal(h.roster.has('Alice'),false);
});
test('fresh snapshot removal survives the old history shipped in the very same SavedVariables upload',async()=>{
  const h=harness({members:['Alice','Bob']});
  await h.run({guildList:{listTimestamp:300,guildListMembers:[{accountName:'Bob',rankName:'Capo'}]},
    rosterEvents:[event('oldjoin','joined',100),event('oldrank','promoted',200)]});
  assert.equal(h.roster.has('Alice'),false);assert.equal(h.roster.has('Bob'),true);
  assert.equal(h.history.has('oldjoin'),true);
});
test('an older departure cannot remove a genuinely rejoined member',async()=>{
  const h=harness();
  await h.run({rosterEvents:[event('join','joined',400)]});
  await h.run({rosterEvents:[event('oldleft','left',300)]});
  assert.equal(h.roster.has('Alice'),true);
});
