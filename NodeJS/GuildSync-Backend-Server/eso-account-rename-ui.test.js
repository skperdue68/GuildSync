import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for(const client of ['web/src','../../GO/GuildSync-Frontend-Client/frontend/src']) {
 const source=readFileSync(new URL(`./${client}/eso-account-rename.js`,import.meta.url),'utf8');
 const {createEsoAccountRename}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
 function setup(){
  let target={accountName:'@Old',allowed:true,key:'session:old'},resolve,renamed;
  const calls=[],handlers={};
  const ui=createEsoAccountRename({context:()=>target,request:(...args)=>{calls.push(args);return new Promise(r=>resolve=r);},render(){},renamed:async value=>{renamed=value;}});
  ui.wire({querySelector:id=>({addEventListener:(type,fn)=>{handlers[id+type]=fn;},focus(){}})});
  return {ui,calls,handlers,setTarget:value=>target=value,resolve:value=>resolve(value),renamed:()=>renamed};
 }
 test(`${client}: permissions and confirmation require a successful preview`,async()=>{
  const s=setup();s.setTarget({accountName:'@Old',allowed:false,key:'session:old'});
  assert.equal(s.ui.html(),'');await s.ui.submit();assert.equal(s.calls.length,0);
  s.setTarget({accountName:'@Old',allowed:true,key:'session:old'});await s.ui.submit(true);assert.equal(s.calls.length,0);
  s.handlers['#openEsoAccountRenameclick']();s.handlers['#esoAccountRenameInputinput']({target:{value:'@<New>'}});
  const preview=s.ui.submit();assert.equal(s.calls[0][0],'guildsync:preview-eso-account-rename');
  s.resolve({ok:true,preview:{accountName:'@Old',newAccountName:'@<New>',token:'proof',counts:{roster:1},aliases:['@<Alias>']}});await preview;
  assert.match(s.ui.html(),/Confirm name change/);assert.match(s.ui.html(),/@&lt;New&gt;/);assert.doesNotMatch(s.ui.html(),/<Alias>/);
  const commit=s.ui.submit(true);assert.deepEqual(s.calls[1][1],{accountName:'@Old',newAccountName:'@<New>',token:'proof'});
  s.resolve({ok:true,newAccountName:'@<New>'});await commit;assert.equal(s.renamed(),'@<New>');
 });
 test(`${client}: conflicts cannot commit and errors are inline`,async()=>{
  const s=setup();s.handlers['#openEsoAccountRenameclick']();
  const preview=s.ui.submit();s.resolve({ok:true,preview:{conflict:true,token:'proof'}});await preview;
  await s.ui.submit(true);assert.equal(s.calls.length,1);assert.match(s.ui.html(),/cannot be confirmed/);
  s.ui.reset();s.handlers['#openEsoAccountRenameclick']();const fail=s.ui.submit();s.resolve({ok:false,message:'<failure>'});await fail;assert.match(s.ui.html(),/&lt;failure&gt;/);
 });
 test(`${client}: target, session and reset invalidate pending replies`,async()=>{
  for(const mode of ['selection','session','cancel']){
   const s=setup();s.handlers['#openEsoAccountRenameclick']();const pending=s.ui.submit();
   if(mode==='cancel')s.ui.reset();else s.setTarget({accountName:mode==='selection'?'@Other':'@Old',allowed:true,key:mode});
   s.resolve({ok:true,preview:{token:'stale',newAccountName:'@Stale'}});await pending;
   assert.doesNotMatch(s.ui.html(),/Confirm name change|@Stale/);assert.equal(s.renamed(),undefined);
  }
 });
}
