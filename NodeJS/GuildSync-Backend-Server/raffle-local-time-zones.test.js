import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const files=['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js'];
const unix=value=>Date.parse(value)/1000;
const periods={
 fall:{salesStart:unix('2026-10-24T23:00:01Z'),salesEnd:unix('2026-11-08T00:00:00Z'),raffleTime:unix('2026-11-08T01:00:00Z')},
 spring:{salesStart:unix('2027-03-14T00:00:01Z'),salesEnd:unix('2027-03-27T23:00:00Z'),raffleTime:unix('2027-03-28T00:00:00Z')}
};
for(const file of files){
 const source=readFileSync(new URL(file,import.meta.url),'utf8');
 const functions=['formatBankingTimestamp','renderBankingRafflePeriodControls'].map(name=>{
  const match=source.match(new RegExp(`function ${name}\\([\\s\\S]*?(?=\\n(?:async )?function |$)`));assert.ok(match,name);return match[0];
 }).join('\n');
 for(const [zone,daylight,standard,drawHour] of [['America/New_York','EDT','EST',8],['America/Chicago','CDT','CST',7],['America/Los_Angeles','PDT','PST',5]]){
  test(`${file}: both raffle headers label each boundary in ${zone} across both DST directions`,()=>{
   class ViewerDate extends Date {
    toLocaleString(locales,options){
     assert.ok(!Object.hasOwn(options,'timeZone'),'display must use viewer zone, not a fixed zone');
     return super.toLocaleString('en-US',{...options,timeZone:zone});
    }
   }
   let period=periods.fall;
   const context=vm.createContext({Date:ViewerDate,escapeHtml:String,escapeAttribute:String,getBankingRaffleWindow:()=>period,getBankingRafflePeriodOffset:()=>0,getBankingSectionLabel:type=>type==='monthly'?'50/50':'Bi-Weekly'});
   vm.runInContext(functions,context);
   for(const season of ['fall','spring']){
    period=periods[season];
    for(const section of ['biweekly','monthly']){
     const html=context.renderBankingRafflePeriodControls(section);
     const sales=html.match(/Sales: ([^<]+)/)[1],draw=html.match(/Raffle Time: ([^<]+)/)[1];
     const [start,end]=sales.split(' through ');
     assert.match(start,new RegExp(season==='fall'?daylight:standard));
     assert.match(end,new RegExp(season==='fall'?standard:daylight));
     assert.match(draw,new RegExp(`${drawHour}:00 PM (?:${daylight}|${standard})`));
    }
   }
   assert.equal(context.formatBankingTimestamp(0,true),'Unknown');
   assert.equal(context.formatBankingTimestamp('invalid',true),'Unknown');
   assert.doesNotMatch(context.formatBankingTimestamp(period.raffleTime),new RegExp(`${daylight}|${standard}`),'other banking rows retain their existing display');
  });
 }
}
