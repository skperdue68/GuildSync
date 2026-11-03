import test from 'node:test';
import assert from 'node:assert/strict';
import {compareDesktopVersions,createDesktopVersionPolicy} from './desktop-version-policy.js';

test('numeric versions and prereleases compare correctly; bad minimum config fails startup',()=>{
 assert.equal(compareDesktopVersions('1.10.0','1.9.9'),1);
 assert.equal(compareDesktopVersions('1.4.5-beta.2','1.4.5'),-1);
 assert.equal(compareDesktopVersions('1.4.5+build.2','1.4.5'),0);
 assert.throws(()=>createDesktopVersionPolicy({minimum:'banana'}),/GUILDSYNC_MIN_DESKTOP_VERSION/);
});
function socket(auth={}) {
 const handlers=new Map(),emitted=[];
 return {handshake:{auth},guildSyncAuthType:'GuildSync user',emitted,
   on:(e,h)=>handlers.set(e,h),once:(e,h)=>handlers.set(e,h),off:e=>handlers.delete(e),
   emit:(e,p)=>emitted.push([e,p]),disconnect(){this.disconnected=true;handlers.get('disconnect')?.();},
   receive:(e,p)=>handlers.get(e)?.(p)};
}
const make=minimum=>createDesktopVersionPolicy({minimum,latest:'1.5.0',download:()=>({version:'1.5.0',url:'https://example.test/latest.zip'}),fallbackUrl:'https://example.test/releases'});
test('unsupported desktop never reaches application registration; response carries update link then disconnects',()=>{
 const s=socket({client_type:'wails',version:'1.4.4'});let registered=0;
 make('1.4.5').admit(s,()=>registered++);
 assert.equal(registered,0);assert.equal(s.disconnected,true);
 const result=s.emitted[0][1];assert.equal(result.supported,false);assert.equal(result.update_required,true);
 assert.equal(result.download_url,'https://example.test/latest.zip');
});
test('legacy sockets are quarantined until version reporting, including requests before the report',()=>{
 const s=socket();let registered=0;make('1.4.5').admit(s,()=>registered++);
 s.receive('guildsync:request-roster-data',{});assert.equal(registered,0);
 s.receive('guildsync:client-version',{client_type:'wails',version:'1.4.4'});
 assert.equal(registered,0);assert.equal(s.disconnected,true);
});
test('supported desktop, web, authenticated bot/voice, and disabled policy preserve access',()=>{
 for(const [minimum,auth,type] of [['1.4.5',{client_type:'wails',version:'1.4.5'},'GuildSync user'],['1.4.5',{client_type:'web'},'GuildSync user'],
  ['1.4.5',{},'discord-bot'],['1.4.5',{},'voice-mute'],['',{},'GuildSync user']]) {
  const s=socket(auth);s.guildSyncAuthType=type;let registered=0;make(minimum).admit(s,()=>registered++);assert.equal(registered,1);
 }
});
test('a download below the minimum is never offered as the upgrade target',()=>{
 const policy=createDesktopVersionPolicy({minimum:'2.0.0',latest:'1.5.0',download:()=>({version:'1.5.0',url:'https://example.test/old.zip'}),fallbackUrl:'https://example.test/releases'});
 const result=policy.status({client_type:'wails',version:'1.4.4'});
 assert.equal(result.download_url,'https://example.test/releases');assert.equal(result.latest_version,'2.0.0');
});
