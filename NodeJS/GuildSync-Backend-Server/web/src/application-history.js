const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const APPLICATION_JOIN_MATCH_SECONDS=7*24*60*60;
const timestamp=value=>{
  const raw=String(value??'').trim();
  if(!raw)return NaN;
  return /^\d+$/.test(raw)?Number(raw):Date.parse(raw)/1000;
};

// The import has no join-event foreign key. Match nearby captures once, nearest first.
export function matchApplicationsToJoins(events,records) {
  const candidates=[];
  events.forEach((event,eventIndex)=>{
    if(event.event_type!=='joined')return;
    const joined=timestamp(event.timestamp);
    if(!Number.isFinite(joined)||joined<=0)return;
    records.forEach((record,recordIndex)=>{
      const captured=timestamp(record.application_timestamp),distance=Math.abs(joined-captured);
      if(captured>0 && distance<=APPLICATION_JOIN_MATCH_SECONDS)candidates.push({eventIndex,recordIndex,distance});
    });
  });
  candidates.sort((a,b)=>a.distance-b.distance || a.eventIndex-b.eventIndex || a.recordIndex-b.recordIndex);
  const matches=new Map(),used=new Set();
  for(const pair of candidates) {
    if(matches.has(pair.eventIndex)||used.has(pair.recordIndex))continue;
    matches.set(pair.eventIndex,records[pair.recordIndex]);used.add(pair.recordIndex);
  }
  return matches;
}

export function renderJoinApplication(record,loaded=true) {
  if(!loaded)return '<div class="join-application-text roster-history-muted">Application history could not be loaded.</div>';
  const text=String(record?.application_text??'').trim();
  if(!text)return '<div class="join-application-text roster-history-muted">No application text recorded near this join.</div>';
  const captured=timestamp(record.application_timestamp),date=new Date(captured*1000);
  const label=Number.isNaN(date.getTime())?'Date not recorded':date.toLocaleString();
  return `<div class="join-application-text"><strong>Application:</strong> ${escape(text)}<small>Application recorded: ${escape(label)} (nearest recorded application within 7 days of joining)</small></div>`;
}
