import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for(const path of ['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js']){
 const source=fs.readFileSync(new URL(path,import.meta.url),'utf8');
 const functions=['captureGuildSyncScrollPosition','renderGuildSyncTabLayout'].map(name=>source.match(new RegExp(`function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0]||'').join('\n');
 test(`${path}: refresh restores scroll after accordion layout and matches containers when nodes change`,()=>{
  let expanded=true,top=480;const makeScroller=()=>({id:'',tagName:'DIV',className:'reports-scroll-area',classList:['reports-scroll-area'],scrollLeft:0,get scrollTop(){return top},set scrollTop(value){top=expanded?value:0}});
  const ancestor={scrollTop:120,scrollLeft:0,parentElement:null};let elements=[makeScroller()];
  const content={id:'guildSyncTabContent',scrollTop:30,scrollLeft:0,parentElement:ancestor,querySelectorAll:()=>elements,set innerHTML(value){expanded=false;top=0;this.scrollTop=0;ancestor.scrollTop=0;elements=[{id:'',tagName:'P',className:'notice',classList:['notice'],scrollTop:0,scrollLeft:0},makeScroller()]}};
  const context={desktopSupport:{blocked:false},document:{querySelector:s=>s==='#guildSyncTabContent'?content:null},window:{scrollX:0,scrollY:60,scrollTo(value){this.scrollY=value.top}},memberLinksReportDialogOpen:false,renderGuildSyncTabContent:()=>'',activeGuildSyncTab:'settings',socket:null,guildSyncSession:null,bankingEntries:[],raffleBonusSettings:{},raffleBonusSettingsRequested:true,memberLinks:[],memberLinksLoading:true};
  const names=[...source.matchAll(/\b(wire\w+|restore\w+|refresh\w+|captureMemberLinksReportScrollPosition)\(/g)].map(m=>m[1]);for(const name of names)context[name]=()=>{};
  context.wireReportsPanel=()=>{expanded=true};vm.createContext(context);vm.runInContext(functions,context);vm.runInContext('renderGuildSyncTabLayout()',context);
  assert.equal(top,480);assert.equal(content.scrollTop,30);assert.equal(ancestor.scrollTop,120);assert.equal(context.window.scrollY,60);
 });
}
