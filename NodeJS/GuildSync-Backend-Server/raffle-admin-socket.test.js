import { normalizeRaffleDate } from './raffle-date.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as endpoints from './raffle-admin-socket.js';
const entries = [
  { type: 'biweekly', eventId: 'old', time: 100 },
  { type: 'biweekly', eventId: 'b', time: 101, ticketAmount: 1 },
  { type: 'monthly', eventId: 'm', time: 50, ticketAmount: 0 },
  { type: 'other', eventId: 'other', time: 150 },
  { type: 'biweekly', eventId: 'future', time: 201 }
];

test('historical endpoint routes target and save under the lock without running a ticket refresh for save',async()=>{
 let handler;const calls=[];
 const selection={asOf:200,boundaryTypes:['biweekly'],raffles:[{type:'biweekly',start:101,end:250},{type:'monthly',start:50,end:250}]};
 const socket={guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',on(_event,callback){handler=callback;}};
 endpoints.registerRaffleRefreshSocket(socket,{}, {
  getRaffleRefreshSelection:()=>selection,getBankingDataJSON:async()=>entries,authorize:async(_db,id)=>id==='officer',log:async()=>{},loadTemplates:async()=>({}),
  historical:{prepare:async()=>{calls.push('prepare');return {spreadsheetId:'archive',sheetUrl:'archive-url',historical:true,results:{biweekly:[],monthly:[]}};},
   complete:async()=>calls.push('complete'),save:async()=>{calls.push('save');return {saved:5,sheetUrl:'archive-url'};}},
  coordinate:async operation=>{calls.push('lock');return operation();},
  refreshEntries:async(load,options)=>{calls.push('refresh');assert.equal(options.processRollover,false);const snapshot=await load();assert.equal(snapshot.targetId,'archive');await options.onComplete(snapshot);return {synced:2};}
 });
 const request=payload=>new Promise(resolve=>handler({date:'092626',discordUserId:'officer',requestedBy:'Officer',...payload},resolve));
 assert.equal((await request({action:'export'})).ok,false);
 assert.equal((await request({action:'update'})).ok,false);assert.deepEqual(calls,[]);
 const loaded=await request({action:'export',boundaryChoices:{biweekly:'ends'}});
 assert.equal(loaded.historical,true);assert.equal(loaded.sheetUrl,'archive-url');assert.equal(loaded.workingSheetUrl,undefined);
 assert.deepEqual(calls,['refresh','prepare','complete']);calls.length=0;
 const saved=await request({action:'update',boundaryChoices:{biweekly:'ends'}});
 assert.equal(saved.saved,5);assert.deepEqual(calls,['lock','save']);
 calls.length=0;
 assert.equal((await request({action:'update',date:undefined})).ok,false);
 assert.equal((await request({action:'update',discordUserId:'member'})).ok,false);
 assert.deepEqual(calls,[]);
});

test('refresh endpoint uses both independently selected windows without test enablement', async t => {
  const old = process.env.GUILDSYNC_RAFFLE_TEST_COMMANDS_ENABLED;
  process.env.GUILDSYNC_RAFFLE_TEST_COMMANDS_ENABLED = 'false';
  t.after(() => old === undefined ? delete process.env.GUILDSYNC_RAFFLE_TEST_COMMANDS_ENABLED : process.env.GUILDSYNC_RAFFLE_TEST_COMMANDS_ENABLED = old);
  assert.equal(typeof endpoints.registerRaffleRefreshSocket, 'function');
  const selection = { asOf: 200, raffles: [{ type: 'biweekly', start: 101, end: 250 }, { type: 'monthly', start: 50, end: 250 }] };
  const calls = []; let handler;
  const socket = { guildSyncAuthenticated: true, guildSyncAuthType: 'discord-bot', on(_event, cb) { handler = cb; } };
  endpoints.registerRaffleRefreshSocket(socket, {}, {
    getRaffleRefreshSelection: date => { calls.push(['date', date]); return selection; },
    loadResults: async () => ({}), loadTemplates: async () => ({}),
    getBankingDataJSON: async () => [...entries, { type: 'monthly', time: 250, eventId: 'end' }],
    authorize: async (_db, id) => id === 'officer',
    refreshEntries: async (load, options) => { const snapshot = await load(); assert.deepEqual(snapshot.periods, selection.raffles); calls.push(['rows', snapshot.entries, options]); return { synced: 2 }; }, log: async () => {}
  });
  const request = payload => new Promise(resolve => handler(payload, resolve));
  for (const action of ['plan', 'export']) {
    const result = await request({ action, date: '091526', discordUserId: 'officer', requestedBy: 'Display Name' });
    assert.equal(result.ok, true); assert.deepEqual(result.selection, selection);
  }
  const exported = calls.find(call => call[0] === 'rows');
  assert.deepEqual(exported[1].map(row => row.eventId), ['m', 'b']);
  assert.equal(exported[2].uploadedBy, 'Display Name');
  const count = calls.length;
  assert.equal((await request({ action: 'export', discordUserId: 'member' })).ok, false);
  assert.equal(calls.length, count);
  socket.guildSyncAuthType = 'client';
  assert.equal((await request({ action: 'plan', discordUserId: 'officer' })).ok, false);
});

test('database authorization applies configured names or IDs consistently', async () => {
  assert.equal(typeof endpoints.isConsigliere, 'function');
  for (const role of ['Consigliere', 'consigliere', 'Capo', 'Consigliere ']) {
    const db = { execute: async (sql, args) => { assert.match(sql, /discord_member_roles/); assert.deepEqual(args, ['123']); return [[{ role_name: role }]]; } };
    assert.equal(await endpoints.isConsigliere(db, '123'), role.trim().toLowerCase() === 'consigliere');
    assert.equal(await endpoints.isConsigliere(db, ''), false);
  }
});

test('production clear/archive require bot authentication and exact role without test flags', async t => {
  const before = process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED;
  process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED = 'true';
  const oldId = process.env.GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID;
  process.env.GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID = 'working-sheet';
  t.after(() => oldId === undefined ? delete process.env.GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID : process.env.GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID = oldId);
  t.after(() => before === undefined ? delete process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED : process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED = before);
  let handler; const calls = [];
  const socket = { guildSyncAuthenticated: true, guildSyncAuthType: 'discord-bot', on(event, cb) { assert.equal(event, 'guildsync:raffle-manage'); handler = cb; } };
  endpoints.registerRaffleManagementSocket(socket, {}, { authorize: async (_, id) => id === 'officer', log: async () => {},
    sheets: { clear: async () => calls.push('clear'), archive: async () => { calls.push('archive'); return { archiveId: 'copy', name: '260926 Raffle' }; } } });
  const request = data => new Promise(resolve => handler(data, resolve));
  for (const action of ['clear', 'archive']) {
    assert.equal((await request({ action, discordUserId: 'member', requestedBy: 'Member' })).ok, false);
    const result = await request({ action, discordUserId: 'officer', requestedBy: 'Officer' });
    assert.equal(result.ok, true); if (action === 'clear') {assert.match(result.message, /[Bb]oth/);assert.match(result.message, /Use \/gsr load/);}
    if(action === 'archive') {
      assert.match(result.message, /archived by Officer/);
      assert.match(result.message, /working-sheet\/edit/);
    }
  }
  assert.deepEqual(calls, ['clear', 'archive']);
  socket.guildSyncAuthType = 'client';
  assert.equal((await request({ action: 'clear', discordUserId: 'officer' })).ok, false);
  assert.equal(calls.length, 2);
});

test('unpadded dates can be planned but cannot mutate until submitted in canonical form',async()=>{
 let handler;const calls=[];
 const selection={asOf:200,boundaryTypes:[],raffles:[{type:'biweekly',start:101,end:250},{type:'monthly',start:50,end:250}]};
 const socket={guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',on(_event,callback){handler=callback;}};
 endpoints.registerRaffleRefreshSocket(socket,{}, {
  getRaffleRefreshSelection:date=>({...selection,dateNormalization:normalizeRaffleDate(date)}),authorize:async()=>true,log:async()=>{},
  getBankingDataJSON:async()=>entries,loadResults:async()=>({}),loadTemplates:async()=>({}),
  historical:{prepare:async()=>({spreadsheetId:'archive',historical:true,results:{}}),complete:async()=>{},save:async()=>{calls.push('update');return {saved:1};}},
  coordinate:async operation=>operation(),refreshEntries:async load=>{calls.push('export');await load();return {synced:1};}
 });
 const request=(action,date)=>new Promise(resolve=>handler({action,date,discordUserId:'officer',requestedBy:'Officer'},resolve));
 assert.equal((await request('plan','91526')).selection.dateNormalization.requiresConfirmation,true);
 for(const action of ['export','update']) {
  const unconfirmed=await request(action,'91526');assert.equal(unconfirmed.ok,false);assert.match(unconfirmed.message,/confirm.*MMDDYY/i);
  assert.equal((await request(action,'091526')).ok,true);
 }
 assert.deepEqual(calls,['export','update']);
});


test('backend checks configured role IDs independently using synchronized member roles',async()=>{
 const env={GUILDSYNC_RAFFLE_ADMIN_ROLES:'123456,Officers'};
 const db={execute:async(sql,args)=>{assert.match(sql,/r.role_id, r.role_name/);assert.deepEqual(args,['member']);return [[{role_id:'123456',role_name:'Renamed'}]];}};
 assert.equal(await endpoints.isRaffleAdministrator(db,'member',env),true);
 assert.equal(await endpoints.isRaffleAdministrator(db,'member',{GUILDSYNC_RAFFLE_ADMIN_ROLES:''}),false);
 assert.equal(await endpoints.isRaffleAdministrator(db,'member',{}),false);
});
