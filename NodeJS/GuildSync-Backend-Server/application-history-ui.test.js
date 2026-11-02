import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const clients=['web/src','../../GO/GuildSync-Frontend-Client/frontend/src'];
for(const client of clients) {
  const source=readFileSync(new URL(`./${client}/application-history.js`,import.meta.url),'utf8');
  const ui=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  test(`${client} matches each application to its nearest join without reuse`,()=>{
    const events=[{event_type:'joined',timestamp:2000000},{event_type:'joined',timestamp:1000000},{event_type:'promoted',timestamp:2000010}];
    const apps=[{application_timestamp:1000010,application_text:'First'},{application_timestamp:1999990,application_text:'Rejoin'},
      {application_timestamp:5000000,application_text:'Unrelated'}];
    const matches=ui.matchApplicationsToJoins(events,apps);
    assert.equal(matches.get(0).application_text,'Rejoin');assert.equal(matches.get(1).application_text,'First');
    assert.equal(matches.has(2),false);
    assert.equal(ui.matchApplicationsToJoins([{event_type:'joined',timestamp:2000000},{event_type:'joined',timestamp:2000001}],[apps[1]]).size,1);
    assert.equal(ui.matchApplicationsToJoins(events,[apps[2]]).size,0);
  });
  test(`${client} inline text is escaped, dated, and distinguishes missing text from failed loading`,()=>{
    const html=ui.renderJoinApplication({application_timestamp:'1793548800',application_text:'<script>bad</script>\nHello'});
    assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
    assert.match(html,/Hello/);assert.doesNotMatch(html,/1793548800/);
    assert.match(ui.renderJoinApplication(null),/No application text/);
    assert.match(ui.renderJoinApplication({application_text:''}),/No application text/);
    assert.match(ui.renderJoinApplication(null,false),/could not be loaded/);
  });
}
test('both clients show application text inside history joined rows, without roster buttons',()=>{
  assert.equal(readFileSync(new URL('./web/src/application-history.js',import.meta.url),'utf8'),readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/application-history.js',import.meta.url),'utf8'));
  for(const client of clients) {
    const main=readFileSync(new URL(`./${client}/main.js`,import.meta.url),'utf8');
    assert.doesNotMatch(main,/applicationHistoryPanel|data-application-history|renderApplicationHistoryLink/);
    assert.match(main,/renderJoinApplication\(applicationMatches.get\(index\), rosterHistoryApplicationsLoaded\)/);
  }
});

for(const client of clients) {
  test(`${client} renders matched and absent applications beneath joined rows`,async()=>{
    const main=readFileSync(new URL(`./${client}/main.js`,import.meta.url),'utf8');
    const source=readFileSync(new URL(`./${client}/application-history.js`,import.meta.url),'utf8');
    const ui=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const start=main.indexOf('function renderRosterHistoryEvents()'),end=main.indexOf('\nfunction ',start+1);
    const context=vm.createContext({
      ...ui,rosterHistorySelectedAccount:'Alice',rosterHistoryLoading:false,
      rosterHistoryEvents:[{event_type:'joined',timestamp:2000000,rank:'Associate'},{event_type:'joined',timestamp:1000000,rank:'Associate'}],
      rosterHistoryApplications:[{application_timestamp:2000010,application_text:'My actual application'}],rosterHistoryApplicationsLoaded:true,
      escapeHtml:value=>String(value||''),formatRosterHistoryTimestamp:()=> 'Local join date',renderRosterHistoryRank:value=>value
    });
    vm.runInContext(main.slice(start,end),context);
    const html=vm.runInContext('renderRosterHistoryEvents()',context);
    assert.match(html,/My actual application/);assert.match(html,/No application text recorded near this join/);
    assert.equal((html.match(/class="join-application-row"/g)||[]).length,2);
    assert.doesNotMatch(html,/<button|data-application-history/);
  });
}
