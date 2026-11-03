import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const url=new URL('../../GO/GuildSync-Frontend-Client/frontend/src/desktop-support.js',import.meta.url);

test('unsupported status is terminal for this client process and offers only a safe download target',async()=>{
 const source=fs.readFileSync(url,'utf8');const {createDesktopSupport}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
 let stopped=0;const support=createDesktopSupport({onBlocked:()=>stopped++});
 assert.equal(support.blocked,false);
 support.receive({supported:false,minimum_desktop_version:'1.5.0',download_url:'https://example.test/latest.zip',message:'Unsupported'});
 assert.equal(support.blocked,true);assert.equal(stopped,1);assert.equal(support.info.downloadUrl,'https://example.test/latest.zip');
 support.receive({supported:true});assert.equal(support.blocked,true);
 support.receive({supported:false});assert.equal(stopped,1);
 const bad=createDesktopSupport({onBlocked(){}});bad.receive({supported:false,download_url:'javascript:alert(1)'});
 assert.equal(bad.info.downloadUrl,'');
});

test('rejected desktop never reconnects, never renders cached data, and disables authenticated actions',()=>{
 const source=fs.readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/main.js',import.meta.url),'utf8');
 const pick=name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))[0];
 let created=0,blockedScreen=0;
 const context=vm.createContext({desktopSupport:{blocked:true},io:()=>created++,showUnsupportedDesktopScreen:()=>blockedScreen++,
   guildSyncSession:{logged_in:true,allowed:true,token:'test'},desktopVersionAccepted:true});
 vm.runInContext(['connectSocket','showMainWindow','renderGuildSyncTabLayout','renderGuildSyncTabContent','isAuthenticatedSession'].map(pick).join('\n'),context);
 vm.runInContext('connectSocket();showMainWindow();renderGuildSyncTabLayout();',context);
 assert.equal(created,0);assert.equal(blockedScreen,3);assert.equal(vm.runInContext('isAuthenticatedSession()',context),false);
 assert.equal(vm.runInContext('renderGuildSyncTabContent()',context),'');
});
test('blocking stops timers, native watcher, reconnection and clears cached member/history data',()=>{
 const source=fs.readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/main.js',import.meta.url),'utf8');
 const a=source.indexOf('function stopUnsupportedDesktop()'),b=source.indexOf('function showUnsupportedDesktopScreen()',a);
 const calls=[];
 const context=vm.createContext({
  socket:{io:{reconnection:value=>calls.push(['reconnect',value])}},showUnsupportedDesktopScreen:()=>calls.push('screen'),
  stopVersionCheckTimer:()=>calls.push('version'),stopESOStatusPolling:()=>calls.push('eso'),stopDepositMailAvailabilityPolling:()=>calls.push('mail'),
  window:{clearTimeout(){}},depositMailPendingWriteAutoTimer:1,rosterHistorySearchTimer:2,discordHistorySearchTimer:3,bankingHistorySearchTimer:4,
  disconnectSocket:()=>{calls.push('disconnect');context.socket=null;},StopGuildSyncFileWatcher:()=>{calls.push('watcher');throw Error('Native bridge failed');},
  adminConfigurationPanel:{clear(){}},systemMessages:new Map([['old','data']]),guildSyncSession:{token:'old'},
  discordMembers:[{secret:1}],rosterMembers:[{secret:1}],bankingEntries:[{secret:1}],memberLinks:[{secret:1}]
 });
 vm.runInContext(source.slice(a,b),context);context.stopUnsupportedDesktop();
 assert.equal(calls[0],'screen');assert.ok(calls.includes('watcher'));assert.ok(calls.includes('disconnect'));
 assert.deepEqual(calls.find(value=>Array.isArray(value)),['reconnect',false]);
 for(const name of ['discordMembers','rosterMembers','bankingEntries','memberLinks','bankingHistoryRecords','rosterHistoryEvents'])assert.equal(context[name].length,0);
 assert.equal(context.guildSyncSession.allowed,false);assert.equal(context.systemMessages.size,0);
});
test('a response already in flight cannot repopulate data after the client is blocked',async()=>{
 const source=fs.readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/main.js',import.meta.url),'utf8');
 const a=source.indexOf('function emitSocketWithAck('),b=source.indexOf('function normalizeDiscordMembers(',a);
 let response;
 const context=vm.createContext({desktopSupport:{blocked:false},desktopVersionAccepted:true,
  guildSyncSession:{user:{role:'user'}},canPerformGuildSyncEvent:()=>true,
  socket:{connected:true,emit:(_event,_payload,callback)=>{response=callback;}},window:{setTimeout:()=>1,clearTimeout(){}}});
 vm.runInContext(source.slice(a,b),context);
 const pending=context.emitSocketWithAck('guildsync:request-roster-data');
 context.desktopSupport.blocked=true;
 response({ok:true,members:[{secret:'old data'}]});
 await assert.rejects(pending,/unsupported/);
});
test('desktop identifies itself at handshake and starts normal work only after a supported response',()=>{
 const source=fs.readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/main.js',import.meta.url),'utf8');
 const pick=name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))[0];
 const handlers=new Map();let options,starts=0,checks=0;
 const connection={connected:true,on:(name,handler)=>handlers.set(name,handler)};
 const context=vm.createContext({desktopSupport:{blocked:false,receive:()=>false},desktopVersionAccepted:false,desktopVersionHandshakeTimer:null,
  socket:null,guildSyncSession:{socket_url:'https://example.test',token:'test'},GUILDSYNC_APP_VERSION:'1.5.0',
  io:(_url,opts)=>{options=opts;return connection;},getGuildSyncClientPlatform:()=> 'windows',disconnectSocket(){},updateStatusDot(){},
  window:{setTimeout:()=>1,clearTimeout(){}},sendVersionCheck:()=>checks++,startSupportedDesktopConnection:()=>starts++,
  handleCurrentAccountProfile(){},handleMemberLinksUpdated(){},renderDesktopUpdateArea(){},removeSystemMessage(){}});
 vm.runInContext(pick('connectSocket')+'\n'+pick('handleVersionStatus'),context);context.connectSocket();
 handlers.get('connect')();assert.equal(checks,1);assert.equal(starts,0);
 assert.equal(options.auth.client_type,'wails');assert.equal(options.auth.version,'1.5.0');assert.equal(options.auth.token,'test');
 handlers.get('guildsync:version-status')({supported:true,update_required:false});
 handlers.get('guildsync:version-status')({supported:true,update_required:false});
 assert.equal(starts,1);assert.equal(context.desktopVersionAccepted,true);
});
