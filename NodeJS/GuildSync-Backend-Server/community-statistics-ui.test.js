import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createCommunityStatisticsPanel,renderCommunityStatistics} from './web/src/community-statistics.js';

test('highlights handle empty results and escape every server-provided text field',()=>{
 assert.match(renderCommunityStatistics({overview:[],highlights:[],notes:[]}),/No community statistics/);
 const html=renderCommunityStatistics({overview:[{label:'<total>',value:1200}],highlights:[{title:'<leaders>',description:'<coverage>',unit:'<days>',rows:[{name:'<Alice>',value:10,detail:'<tie>'},{name:'Bob',value:10}]}],notes:['<note>']});
 assert.match(html,/1,200/);assert.match(html,/&lt;Alice&gt;/);assert.match(html,/Bob/);assert.match(html,/&lt;note&gt;/);assert.doesNotMatch(html,/<Alice>|<leaders>|<days>|<coverage>|<tie>/);
});

test('loads only on opening, deduplicates in-flight refresh and replaces only local content preserving scroll',async()=>{
 const listeners={};let resolveRequest,calls=0;
 const scroll={scrollTop:287,scrollLeft:3};
 const body={set innerHTML(value){this.html=value;scroll.scrollTop=0;},html:''};
 const status={textContent:''},refresh={disabled:false,addEventListener:(event,fn)=>listeners.refresh=fn};
 const toggle={getAttribute:()=> 'true',addEventListener:(event,fn)=>listeners.open=fn};
 const card={querySelector:selector=>selector==='[data-community-toggle]'?toggle:selector==='[data-community-refresh]'?refresh:selector==='[data-community-status]'?status:body,closest:()=>scroll};
 const root={querySelector:()=>card};
 const panel=createCommunityStatisticsPanel({request:()=>{calls++;return new Promise(resolve=>resolveRequest=resolve);}});
 panel.wire(root);assert.equal(calls,0);const pending=listeners.open();listeners.refresh();assert.equal(calls,1);assert.equal(scroll.scrollTop,287);assert.match(status.textContent,/Loading/);
 resolveRequest({ok:true,report:{overview:[{label:'Members',value:2}],highlights:[],notes:['History is partial.']}});await pending;
 assert.equal(scroll.scrollTop,287);assert.equal(scroll.scrollLeft,3);assert.match(body.html,/History is partial/);assert.equal(refresh.disabled,false);
 await listeners.open();assert.equal(calls,1);
});

test('failed requests show retryable errors without clearing previously loaded results',async()=>{
 let first=true;
 const panel=createCommunityStatisticsPanel({request:async()=>{if(first){first=false;return {ok:true,report:{overview:[{label:'Members',value:23}],highlights:[],notes:[]}};}return {ok:false,message:'Unavailable <now>'};}});
 await panel.load();assert.match(panel.render(),/<dd>23<\/dd>/);
 await panel.load();const html=panel.render();assert.match(html,/Unavailable &lt;now&gt;/);assert.match(html,/Refresh/);assert.doesNotMatch(html,/type="submit"|data-config-value/);
 assert.match(html,/<dd>23<\/dd>/);
});

test('desktop and web share the same statistics component',()=>{
 assert.equal(fs.readFileSync(new URL('./web/src/community-statistics.js',import.meta.url),'utf8'),fs.readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/community-statistics.js',import.meta.url),'utf8'));
});

test('session changes clear cached results and discard requests completing after logout or another login',async()=>{
 let session='first',resolveFirst;
 const panel=createCommunityStatisticsPanel({getSessionKey:()=>session,request:()=>new Promise(resolve=>resolveFirst=resolve)});
 const pending=panel.load();session='';assert.doesNotMatch(panel.render(),/Loading community/);
 resolveFirst({ok:true,report:{overview:[{label:'Private first session',value:99}]}});await pending;
 assert.doesNotMatch(panel.render(),/Private first session/);
 session='second';const second=panel.load();resolveFirst({ok:true,report:{overview:[{label:'Second session',value:2}]}});await second;
 assert.match(panel.render(),/Second session/);session='third';assert.doesNotMatch(panel.render(),/Second session/);
 const third=panel.load();session='fourth';panel.render();const fourth=panel.load();const resolveFourth=resolveFirst;
 // Only the fourth session's request can set its loaded state.
 resolveFourth({ok:true,report:{overview:[{label:'Fourth session',value:4}]}});await fourth;
 assert.match(panel.render(),/Fourth session/);
});

test('logout and account changes discard cached and in-flight statistics',async()=>{
 let session='first',resolveFirst,calls=0;
 const panel=createCommunityStatisticsPanel({getSessionKey:()=>session,request:()=>{calls++;return calls===1?new Promise(resolve=>resolveFirst=resolve):Promise.resolve({ok:true,report:{overview:[{label:'New account',value:2}],highlights:[],notes:[]}});}});
 const pending=panel.load();session='second';panel.render();resolveFirst({ok:true,report:{overview:[{label:'Old account',value:1}],highlights:[],notes:[]}});await pending;
 assert.doesNotMatch(panel.render(),/Old account/);await panel.load();assert.match(panel.render(),/New account/);
 session='';assert.doesNotMatch(panel.render(),/New account/);await panel.load();assert.equal(calls,2);
});
