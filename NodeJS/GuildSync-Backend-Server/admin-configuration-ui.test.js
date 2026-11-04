import test from 'node:test';
import assert from 'node:assert/strict';
import {draftSetting,createAccordionState,receiptPreview,formatConfigurationValue,createConfigurationPanel} from './web/src/admin-configuration.js';
import fs from 'node:fs';
test('accordion toggles one section without changing a draft',()=>{const a=createAccordionState();const draft={key:'edited'};a.toggle('bonus');assert.equal(a.open,'bonus');a.toggle('configuration');assert.equal(a.open,'configuration');a.toggle('configuration');assert.equal(a.open,'');assert.deepEqual(draft,{key:'edited'});});
test('default reset displays environment value and remains a deletion in the draft',()=>{const setting={key:'key',value:20,defaultValue:10,source:'GuildSync override'};const changes={key:null};assert.deepEqual(draftSetting(setting,changes),{value:10,override:false,source:'Default'});assert.equal(changes.key,null);assert.equal(draftSetting(setting,{}).value,20);});
test('preview substitutes bonus and common receipt placeholders',()=>{assert.match(receiptPreview('Tickets {ticket_quantity}\n{bonus_block}'),/Tickets 20/);assert.match(receiptPreview('{bonus_block}'),/20%/);assert.doesNotMatch(receiptPreview('{bonus_block}'),/\{/);});
test('desktop and web use the same configuration component',()=>{assert.equal(fs.readFileSync(new URL('./web/src/admin-configuration.js',import.meta.url),'utf8'),fs.readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/admin-configuration.js',import.meta.url),'utf8'));});

test('boolean and mode defaults use the same display labels as selections',()=>{
 assert.equal(formatConfigurationValue({type:'boolean'},true),'Enabled');assert.equal(formatConfigurationValue({type:'boolean'},false),'Disabled');
 assert.equal(formatConfigurationValue({type:'boolean'},'false'),'Disabled');assert.equal(formatConfigurationValue({type:'select'},'private_thread'),'Private thread (public fallback)');
 assert.equal(formatConfigurationValue({type:'number'},24),'24');assert.equal(formatConfigurationValue({type:'id'},''),'Not configured');
});
test('configuration renders Return to default with an aligned human-readable default value',async t=>{
 const original=globalThis.document;globalThis.document={getElementById:()=>null,querySelectorAll:()=>[]};t.after(()=>globalThis.document=original);
 const panel=createConfigurationPanel({canEdit:()=>true});let rendered;const ready=new Promise(resolve=>rendered=resolve);
 panel.wire({request:async()=>({ok:true,configuration:{revision:1,botDefaultsReported:true,settings:[{key:'enabled',group:'Example',label:'Feature enabled',type:'boolean',value:false,defaultValue:true,source:'GuildSync override'},{key:'mode',group:'Example',label:'Delivery',type:'select',options:['private_thread','channel'],value:'channel',defaultValue:'private_thread',source:'.env'},{key:'hours',group:'Example',label:'Hours',type:'number',value:25,defaultValue:24,source:'GuildSync override'}]}}),rerender:()=>rendered()});
 await ready;const html=panel.render();assert.match(html,/Return to default/);assert.match(html,/class="configuration-values"/);assert.match(html,/<output[^>]*>24<\/output>/);
 assert.match(html,/<option value="false" selected>Disabled<\/option>/);assert.match(html,/<option value="channel" selected>Channel or thread<\/option>/);
 assert.doesNotMatch(html,/Default: (?:true|false)|Use \.env default|original \.env default/);
});

// Editing a default must be possible without opting into an override first.
test('configuration inputs are editable and editing derives override/default status before Save',async t=>{
 const original=globalThis.document;t.after(()=>globalThis.document=original);
 const setting={key:'enabled',group:'Example',label:'Feature enabled',type:'boolean',value:true,defaultValue:true,source:'.env'};
 const handlers={};const input={dataset:{configValue:'enabled'},value:'false',addEventListener:(event,fn)=>handlers[event]=fn};
 const source={textContent:''};const form={addEventListener:(event,fn)=>handlers['form-'+event]=fn,querySelectorAll:()=>[]};
 globalThis.document={getElementById:id=>id==='adminConfigurationForm'?form:null,querySelector:selector=>selector.includes("data-config-source")?source:null,querySelectorAll:selector=>selector==='[data-config-value]'?[input]:[]};
 const panel=createConfigurationPanel({canEdit:()=>true});let resolve;const ready=new Promise(r=>resolve=r);const requests=[];
 const request=async(event,payload)=>{requests.push({event,payload});return {ok:true,configuration:{revision:1,botDefaultsReported:true,settings:[setting]}};};
 const wire=()=>panel.wire({request,rerender:()=>resolve()});wire();await ready;wire();
 assert.doesNotMatch(panel.render(),/Use a GuildSync override|data-config-override|id="config-enabled" disabled/);
 handlers.input();assert.equal(source.textContent,'Overridden');assert.match(panel.render(),/<option value="false" selected>Disabled/);assert.equal(requests.length,1);
 input.value='true';handlers.input();assert.equal(source.textContent,'Default');await handlers['form-submit']({preventDefault(){}});assert.deepEqual(requests[1].payload.changes,{enabled:null});
 input.value='false';handlers.input();input.value='true';handlers.input();assert.match(panel.render(),/<option value="true" selected>Enabled/);assert.match(panel.render(),/data-config-source="enabled">Default/);
});
test('typed values equal to defaults derive Default instead of an override',()=>{
 for(const [type,value,defaultValue] of [['boolean','false',false],['number','24',24],['select','channel','channel'],['template','hello','hello']])assert.equal(draftSetting({key:'key',type,defaultValue,value:defaultValue,source:'.env'},{key:value}).source,'Default');
 assert.equal(draftSetting({key:'key',type:'number',defaultValue:24,value:24,source:'.env'},{key:'25'}).source,'Overridden');
});

test('two-choice settings identify only their default option and omit reset controls',async t=>{
 const original=globalThis.document;t.after(()=>globalThis.document=original);globalThis.document={getElementById:()=>null,querySelectorAll:()=>[]};
 const settings=[
  {key:'on',label:'Default on',type:'boolean',value:false,defaultValue:true},
  {key:'off',label:'Default off',type:'boolean',value:true,defaultValue:false},
  {key:'mode',label:'Delivery',type:'select',options:['channel','private_thread'],value:'channel',defaultValue:'private_thread'},
  {key:'count',label:'Count',type:'number',value:25,defaultValue:24}
 ].map(s=>({...s,group:'Example',source:'.env'}));
 const panel=createConfigurationPanel({canEdit:()=>true});let ready;const loaded=new Promise(r=>ready=r);panel.wire({request:async()=>({ok:true,configuration:{revision:1,botDefaultsReported:true,settings}}),rerender:ready});await loaded;
 const html=panel.render();
 assert.match(html,/<option value="true" >Enabled \(Default\)<\/option>/);
 assert.match(html,/<option value="false" >Disabled \(Default\)<\/option>/);
 assert.match(html,/<option value="private_thread" >Private thread \(public fallback\) \(Default\)<\/option>/);
 assert.doesNotMatch(html,/data-config-default="(?:on|off|mode)"|data-config-override/);
 assert.match(html,/data-config-default="count"/);assert.match(html,/<output>24<\/output>/);
 assert.equal((html.match(/ \(Default\)<\/option>/g)||[]).length,3);
});

 test('settings carry useful help and render functional subsections with one labeled card per setting',async t=>{
  const {configurationCatalog}=await import('./admin-configuration.js');
  for(const setting of configurationCatalog) assert.ok(setting.help?.length>20,setting.key+' needs help');
  const original=globalThis.document;t.after(()=>globalThis.document=original);globalThis.document={getElementById:()=>null,querySelectorAll:()=>[]};
  const settings=configurationCatalog.map(s=>({...s,value:s.defaultValue}));
  const panel=createConfigurationPanel({canEdit:()=>true});let ready;const loaded=new Promise(r=>ready=r);panel.wire({request:async()=>({ok:true,configuration:{revision:1,botDefaultsReported:true,settings}}),rerender:ready});await loaded;
  const html=panel.render();assert.match(html,/Access and promotion/);assert.match(html,/Schedule and destination/);assert.match(html,/configuration-setting-header/);assert.match(html,/\.env:/);
  for(const setting of settings){assert.match(html,new RegExp('id="config-help-'+setting.key+'"'));assert.match(html,new RegExp('aria-describedby="config-help-'+setting.key+'"'));}
 });

test('read-only configuration shows effective values and defaults without editing or save controls',async t=>{
 const original=globalThis.document;t.after(()=>globalThis.document=original);globalThis.document={getElementById:()=>null,querySelectorAll:()=>[]};
 const panel=createConfigurationPanel({canEdit:()=>false});let ready;const loaded=new Promise(r=>ready=r);
 panel.wire({request:async()=>({ok:true,configuration:{botDefaultsReported:true,settings:[{key:'count',group:'Example',label:'Count',type:'number',value:36,defaultValue:24,help:'A test setting.'}]}}),rerender:ready});await loaded;
 const html=panel.render();assert.match(html,/Read-only/);assert.match(html,/configuration-readonly-value[^>]*>36<\/output>/);assert.match(html,/<output>24<\/output>/);assert.match(html,/Refresh configuration/);assert.doesNotMatch(html,/data-config-default=|data-config-value=|type="submit"/);
});
