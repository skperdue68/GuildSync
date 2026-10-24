const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const list=value=>Array.isArray(value)?value:[];
const number=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString():String(value ?? '—');
const date=value=>{const parsed=new Date(value);return value&&!Number.isNaN(parsed.getTime())?parsed.toLocaleString():'';};

export function renderCommunityStatistics(report){
 if(!report)return '<p>Open this section to load community highlights.</p>';
 const overview=list(report.overview),highlights=list(report.highlights);
 return `${overview.length?`<dl class="community-overview">${overview.map(item=>`<div><dt>${escape(item.label)}</dt><dd>${escape(number(item.value))}</dd></div>`).join('')}</dl>`:''}
 ${!overview.length&&!highlights.length?'<p>No community statistics are available yet.</p>':''}
 <div class="community-highlights">${highlights.map(item=>`<section class="community-highlight"><h4>${escape(item.title)}</h4><p>${escape(item.description)}</p>${list(item.rows).length?`<ol>${list(item.rows).slice(0,5).map(row=>`<li><div><span>${escape(row.name || 'Unknown member')}</span>${row.detail?`<small>${escape(row.detail)}</small>`:''}</div><strong>${escape(number(row.value))}${item.unit?` <small>${escape(item.unit)}</small>`:''}</strong></li>`).join('')}</ol>`:'<p class="community-empty">No records yet.</p>'}</section>`).join('')}</div>
 <div class="community-coverage">${date(report.generatedAt)?`<p>Updated ${escape(date(report.generatedAt))}</p>`:''}${date(report.trackingSince)?`<p>Discord activity tracking since ${escape(date(report.trackingSince))}</p>`:''}${list(report.notes).length?`<ul>${report.notes.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>`:''}</div>`;
}

export function createCommunityStatisticsPanel({request,getSessionKey=()=>'default'}){
 let report=null,loading=false,error='',loaded=false,sessionKey=getSessionKey(),generation=0;
 const ensureSession=()=>{const key=getSessionKey();if(key!==sessionKey){sessionKey=key;generation++;report=null;loading=false;error='';loaded=false;}return key;};
 const wired=new WeakSet();
 const message=()=>loading?'Loading community highlights…':error;
 const render=()=>{ensureSession();return `<article class="report-option-card community-statistics-card" data-community-card><div class="report-option-copy">
 <h3><button type="button" class="report-section-toggle" data-report-toggle="community" data-community-toggle aria-expanded="false" aria-controls="communityStatisticsContent">Community highlights <span aria-hidden="true">▾</span></button></h3>
 <div id="communityStatisticsContent" class="report-section-content" inert><div class="report-section-inner">
 <div class="community-toolbar"><p>Guild milestones, raffle regulars, and Discord activity. Read-only for all approved roles.</p><button type="button" class="refresh-discord-button" data-community-refresh ${loading?'disabled':''}>Refresh</button></div>
 <p class="community-status" role="status" aria-live="polite" data-community-status>${escape(message())}</p>
 <div data-community-results aria-busy="${loading}">${renderCommunityStatistics(report)}</div>
 </div></div></div></article>`;};
 const update=root=>{
  const card=root?.querySelector('[data-community-card]');if(!card)return;
  const scroll=card.closest('.reports-scroll-area'),top=scroll?.scrollTop,left=scroll?.scrollLeft;
  const results=card.querySelector('[data-community-results]');results.innerHTML=renderCommunityStatistics(report);results.setAttribute?.('aria-busy',String(loading));
  card.querySelector('[data-community-status]').textContent=message();card.querySelector('[data-community-refresh]').disabled=loading;
  if(scroll){scroll.scrollTop=top;scroll.scrollLeft=left;}
 };
 const load=async(root)=>{
  if(!ensureSession()||loading)return;
  const requestGeneration=generation;loading=true;error='';update(root);
  try{
   const response=await request('guildsync:request-community-statistics',{});
   ensureSession();if(requestGeneration!==generation)return;
   if(!response?.ok||!response.report)throw new Error(response?.message || 'Could not load community highlights. Please refresh to retry.');
   report=response.report;loaded=true;
  }catch(cause){ensureSession();if(requestGeneration===generation)error=cause?.message || 'Could not load community highlights. Please refresh to retry.';}
  finally{ensureSession();if(requestGeneration===generation){loading=false;update(root);}}
 };
 const wire=(root=document)=>{
  ensureSession();
  const card=root.querySelector('[data-community-card]');if(!card||wired.has(card))return;wired.add(card);
  card.querySelector('[data-community-toggle]').addEventListener('click',()=>{if(card.querySelector('[data-community-toggle]').getAttribute('aria-expanded')==='true'&&!loaded)return load(root);});
  card.querySelector('[data-community-refresh]').addEventListener('click',()=>load(root));
 };
 return {render,wire,load};
}
