import test from 'node:test';
import assert from 'node:assert/strict';
import {createConfigurationService,configurationCatalog} from './admin-configuration.js';

test('purchase announcement switch is grouped, defaults off, and restores configured .env default',async()=>{
 const key='GUILDSYNC_RAFFLE_ANNOUNCE_ON_PURCHASE';
 const catalog=configurationCatalog.find(item=>item.key===key);
 assert.equal(catalog.defaultValue,false);assert.equal(catalog.type,'boolean');
 assert.equal(catalog.section,'Schedule and destination');assert.match(catalog.help,/interval and prize milestone/);
 const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();
 await service.registerBotDefaults({[key]:'true'});
 assert.equal(service.view().settings.find(item=>item.key===key).value,true);
 await service.save({revision:0,changes:{[key]:false}});
 assert.equal(service.view().settings.find(item=>item.key===key).value,false);
 await service.save({revision:1,changes:{[key]:null}});
 assert.equal(service.view().settings.find(item=>item.key===key).value,true);
});

test('voice role overrides accept names and IDs but reject empty list entries',async()=>{
 const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();
 const key='GUILDSYNC_VOICE_MUTE_ALLOWED_ROLE_IDS';
 await service.save({revision:0,changes:{[key]:'Kingpin, Consigliere, 123456789'}});
 assert.equal((await service.botConfiguration()).overrides[key],'Kingpin, Consigliere, 123456789');
 await assert.rejects(service.save({revision:1,changes:{[key]:'Kingpin,,Soldiers'}}),/role names or IDs/);
});

test('bot environment defaults refresh clients and remain defaults under overrides',async()=>{
 const {registerConfigurationSocket}=await import('./admin-configuration-socket.js');
 const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();
 const handlers=new Map(),broadcasts=[];
 registerConfigurationSocket({guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',on:(event,handler)=>handlers.set(event,handler)},service,{broadcast:(...args)=>broadcasts.push(args)});
 const defaults={GUILDSYNC_VOICE_MUTE_ENABLED:'true',GUILDSYNC_VOICE_MUTE_ALLOWED_ROLE_IDS:'Consigliere'};
 let response;await handlers.get('guildsync:register-configuration-defaults')({defaults},r=>response=r);
 assert.equal(response.ok,true);assert.deepEqual(broadcasts[0][1],{changes:defaults});
 await service.save({revision:0,changes:{GUILDSYNC_VOICE_MUTE_ENABLED:false}});
 const setting=service.view().settings.find(s=>s.key==='GUILDSYNC_VOICE_MUTE_ENABLED');
 assert.equal(setting.defaultValue,true);assert.equal(setting.value,false);
 await service.save({revision:1,changes:{GUILDSYNC_VOICE_MUTE_ENABLED:null}});
 assert.equal(service.view().settings.find(s=>s.key===setting.key).value,true);
});
test('voice mute settings are grouped with help, disabled by default and reset to reported defaults',async()=>{
 const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();
 const keys=['GUILDSYNC_VOICE_MUTE_ENABLED','GUILDSYNC_VOICE_MUTE_ALLOWED_ROLE_IDS','GUILDSYNC_VOICE_MUTE_RANK_ROLE_IDS'];
 for(const key of keys){const setting=service.view().settings.find(s=>s.key===key);assert.equal(setting.group,'Voice channel mute');assert.ok(setting.help.length>30);}
 assert.equal(service.view().settings.find(s=>s.key===keys[0]).value,false);
 await service.registerBotDefaults({[keys[0]]:'false',[keys[1]]:'123',[keys[2]]:''});
 await service.save({revision:0,changes:{[keys[0]]:true,[keys[1]]:'456'}});
 assert.equal((await service.botConfiguration()).overrides[keys[1]],'456');
 await service.save({revision:1,changes:{[keys[0]]:null,[keys[1]]:null}});
 assert.equal(service.view().settings.find(s=>s.key===keys[0]).value,false);assert.equal(service.view().settings.find(s=>s.key===keys[1]).value,'123');
});
function memoryDB(){let value=null;return {async getConnection(){return this;},async beginTransaction(){},async commit(){},async rollback(){},release(){},async execute(sql,args){if(sql.startsWith('SELECT'))return [value?[{value}]:[]];if(sql.startsWith('INSERT')){if(args.length===2)value=args[1];else value ||= '{"revision":0,"overrides":{},"botDefaults":{}}';}return [{}];}};}
test('configuration saves overrides, preserves env defaults and deletes resets',async()=>{const env={GUILDSYNC_GOOGLE_SHEETS_ENABLED:'true'};const service=createConfigurationService(memoryDB(),{env});await service.initialize();let view=await service.save({revision:0,changes:{GUILDSYNC_GOOGLE_SHEETS_ENABLED:false}});assert.equal(env.GUILDSYNC_GOOGLE_SHEETS_ENABLED,'false');assert.equal(view.settings.find(s=>s.key==='GUILDSYNC_GOOGLE_SHEETS_ENABLED').defaultValue,true);view=await service.save({revision:1,changes:{GUILDSYNC_GOOGLE_SHEETS_ENABLED:null}});assert.equal(env.GUILDSYNC_GOOGLE_SHEETS_ENABLED,'true');assert.equal(view.settings.find(s=>s.key==='GUILDSYNC_GOOGLE_SHEETS_ENABLED').source,'.env');});
test('rejects unknown secrets, invalid dates, IDs and stale revisions without applying',async()=>{const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();await assert.rejects(service.save({revision:0,changes:{DISCORD_BOT_TOKEN:'secret'}}),/Unknown/);await assert.rejects(service.save({revision:0,changes:{GUILDSYNC_ONBOARDING_CHANNEL_ID:'bad'}}),/Discord ID/);await assert.rejects(service.save({revision:0,changes:{GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS:-1}}),/range/);await service.save({revision:0,changes:{GUILDSYNC_GOOGLE_SHEETS_ENABLED:true}});await assert.rejects(service.save({revision:0,changes:{GUILDSYNC_GOOGLE_SHEETS_ENABLED:false}}),/changed/);});
test('bot defaults report cannot overwrite backend values or stored overrides',async()=>{const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();await assert.rejects(service.registerBotDefaults({GUILDSYNC_GOOGLE_SHEETS_ENABLED:true}),/bot/);await service.registerBotDefaults({GUILDSYNC_RAFFLE_INTERVAL_HOURS:'72'});let view=await service.save({revision:0,changes:{GUILDSYNC_RAFFLE_INTERVAL_HOURS:24}});assert.equal(view.settings.find(s=>s.key==='GUILDSYNC_RAFFLE_INTERVAL_HOURS').defaultValue,72);assert.equal((await service.botConfiguration()).overrides.GUILDSYNC_RAFFLE_INTERVAL_HOURS,24);await service.registerBotDefaults({GUILDSYNC_RAFFLE_INTERVAL_HOURS:'48'});assert.equal((await service.botConfiguration()).overrides.GUILDSYNC_RAFFLE_INTERVAL_HOURS,24);assert.ok(configurationCatalog.every(s=>!s.key.includes('TOKEN')));});
test('enabled onboarding notifications require a channel and templates reject unknown placeholders',async()=>{const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();await assert.rejects(service.save({revision:0,changes:{GUILDSYNC_ONBOARDING_ENABLED:true}}),/channel/);await assert.rejects(service.save({revision:0,changes:{GUILDSYNC_ONBOARDING_PROMOTION_MESSAGE:'{secret}'}}),/placeholder/);});

test('socket authorization rejects callers without viewer approval and invalid bot defaults',async()=>{const {registerConfigurationSocket}=await import('./admin-configuration-socket.js');const handlers=new Map();const socket={on:(k,v)=>handlers.set(k,v),guildSyncAuthenticated:true,guildSyncAuthType:'desktop',guildSyncUser:{discord_user_id:'123'}};let calls=0;registerConfigurationSocket(socket,{view(){calls++;return{};}},{authorizeAdmin:async()=>false});let response;await handlers.get('guildsync:request-admin-configuration')({},r=>response=r);assert.equal(response.ok,false);assert.equal(calls,0);socket.guildSyncAuthType='discord-bot';await handlers.get('guildsync:register-configuration-defaults')({},r=>response=r);assert.equal(response.ok,false);});

test('false bot defaults stay false and blank reminder/template overrides fail before save',async()=>{const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();await service.registerBotDefaults({GUILDSYNC_ONBOARDING_REMINDER_ENABLED:'false'});assert.equal(service.view().settings.find(s=>s.key==='GUILDSYNC_ONBOARDING_REMINDER_ENABLED').value,false);await assert.rejects(service.save({revision:0,changes:{GUILDSYNC_RAFFLE_BONUS_REMINDER_HOURS:''}}),/positive hours/);await assert.rejects(service.save({revision:0,changes:{GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE:''}}),/cannot be blank/);});

test('approved users can view configuration but only admins can save it',async()=>{
 const {registerConfigurationSocket}=await import('./admin-configuration-socket.js');const handlers=new Map();
 const socket={on:(event,handler)=>handlers.set(event,handler),guildSyncAuthenticated:true,guildSyncAuthType:'desktop',guildSyncUser:{discord_user_id:'123',role:'admin'}};
 let approved=true,isAdmin=false,reads=0,saves=0;const service={view(){reads++;return {settings:[]}},async save(){saves++;return{}},async botConfiguration(){return{}}};
 registerConfigurationSocket(socket,service,{authorizeViewer:async()=>approved,authorizeAdmin:async()=>isAdmin});
 const call=async event=>{let result;await handlers.get(event)({},response=>result=response);return result};
 assert.equal((await call('guildsync:request-admin-configuration')).ok,true);assert.equal(reads,1);
 assert.equal((await call('guildsync:save-admin-configuration')).ok,false);assert.equal(saves,0);
 isAdmin=true;assert.equal((await call('guildsync:save-admin-configuration')).ok,true);assert.equal(saves,1);
 approved=false;assert.equal((await call('guildsync:request-admin-configuration')).ok,false);assert.equal(reads,1);
 approved=true;socket.guildSyncAuthType='discord-bot';assert.equal((await call('guildsync:request-admin-configuration')).ok,false);assert.equal(reads,1);
 socket.guildSyncAuthType='desktop';socket.guildSyncAuthenticated=false;assert.equal((await call('guildsync:request-admin-configuration')).ok,false);
});

test('onboarding role defaults and administrator overrides accept a single name or ID',async()=>{
 const service=createConfigurationService(memoryDB(),{env:{}});await service.initialize();
 const key='GUILDSYNC_ONBOARDING_GANGSTER_ROLE_ID';
 await service.registerBotDefaults({[key]:'Gangsters'});await service.save({revision:0,changes:{[key]:'123'}});
 assert.equal((await service.botConfiguration()).overrides[key],'123');
 await assert.rejects(service.save({revision:1,changes:{[key]:'Gangsters,Associates'}}),/one role/);
});
