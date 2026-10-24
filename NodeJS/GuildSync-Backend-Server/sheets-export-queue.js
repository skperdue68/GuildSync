import {config as sheetsConfig, syncBankingEntriesToGoogleSheets, exportLog} from './google-sheets-banking-sync.js';

export async function initializeSheetsExportQueue(db) {
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_sheets_export_queue (
  spreadsheet_id VARCHAR(191) NOT NULL, event_id VARCHAR(32) NOT NULL,
  uploaded_by VARCHAR(255) NOT NULL DEFAULT '', status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error TEXT NULL, completed_at DATETIME NULL,
  PRIMARY KEY (spreadsheet_id, event_id), INDEX idx_sheets_retry (spreadsheet_id, status, next_attempt_at)
 ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export async function enqueueSheetsExports(db, entries, {spreadsheetId,uploadedBy=''}={}) {
 if(!spreadsheetId)return;
 const ids=[...new Set((entries||[]).filter(e=>['biweekly','monthly'].includes(e.type)&&e.eventId!=null).map(e=>String(e.eventId)))];
 for(let start=0;start<ids.length;start+=250){
  const batch=ids.slice(start,start+250);
  await db.execute(`INSERT IGNORE INTO guildsync_sheets_export_queue (spreadsheet_id,event_id,uploaded_by) VALUES ${batch.map(()=>'(?,?,?)').join(',')}`,
   batch.flatMap(id=>[spreadsheetId,id,String(uploadedBy).slice(0,255)]));
 }
}

export function createSheetsExportStore(db){return {
 enqueue:(entries,settings)=>enqueueSheetsExports(db,entries,settings),
 async pending(spreadsheetId,now){const [rows]=await db.execute(`SELECT event_id,uploaded_by,attempts FROM guildsync_sheets_export_queue WHERE spreadsheet_id=? AND status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,event_id LIMIT 100`,[spreadsheetId,now]);return rows;},
 async attempted(items,spreadsheetId,now){for(const row of items){const wait=Math.min(3600,60*2**Math.min(6,Number(row.attempts)||0));await db.execute(`UPDATE guildsync_sheets_export_queue SET attempts=attempts+1,next_attempt_at=?,last_error=NULL WHERE spreadsheet_id=? AND event_id=? AND status='pending'`,[now+wait,spreadsheetId,String(row.event_id)]);}},
 async completed(ids,spreadsheetId){for(const id of ids)await db.execute(`UPDATE guildsync_sheets_export_queue SET status='synced',completed_at=NOW(),last_error=NULL WHERE spreadsheet_id=? AND event_id=?`,[spreadsheetId,String(id)]);},
 async failed(items,error,spreadsheetId){for(const row of items)await db.execute(`UPDATE guildsync_sheets_export_queue SET last_error=? WHERE spreadsheet_id=? AND event_id=? AND status='pending'`,[String(error.message||error).slice(0,4000),spreadsheetId,String(row.event_id)]);}
};}

// Failed exports are retried independently of file uploads and survive backend restarts.
export function startSheetsExportRecovery(db,{loadEntries,selectBootstrapEntries=e=>e,store=createSheetsExportStore(db),config=sheetsConfig,sync=syncBankingEntriesToGoogleSheets,now=()=>Math.floor(Date.now()/1000),log=exportLog,schedule=true,intervalMs=60000}={}){
 let running,seededFor='',stopped=false;
 const run=async()=>{
  const settings=config();if(stopped||!settings.enabled||!settings.spreadsheetId)return {enabled:false};
  const entries=await loadEntries();const byId=new Map(entries.map(e=>[String(e.eventId),e]));
  if(seededFor!==settings.spreadsheetId){await store.enqueue(await selectBootstrapEntries(entries,now()),{spreadsheetId:settings.spreadsheetId,uploadedBy:'GuildSync automatic recovery'});seededFor=settings.spreadsheetId;}
  const pending=await store.pending(settings.spreadsheetId,now());if(!pending.length)return {pending:0};
  const groups=new Map();for(const row of pending){const key=row.uploaded_by||'GuildSync automation';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  for(const [uploadedBy,items] of groups){
   if(stopped)break;
   await store.attempted(items,settings.spreadsheetId,now());
   const missing=items.filter(row=>!byId.has(String(row.event_id)));
   if(missing.length)await store.failed(missing,Error('Banking transaction no longer exists; export retained for review.'),settings.spreadsheetId);
   const batch=items.filter(row=>byId.has(String(row.event_id))).map(row=>byId.get(String(row.event_id)));if(!batch.length)continue;
   try{
    let completed=0;
    await sync(batch,{uploadedBy,log,onCompleted:async ids=>{await store.completed(ids,settings.spreadsheetId);completed+=ids.length;}});
    if(completed)await log(`Automatic spreadsheet recovery confirmed ${completed} transaction(s).`);
   }catch(error){await store.failed(items,error,settings.spreadsheetId);await log('Automatic spreadsheet export will retry: '+error.message);}
  }
  return {pending:pending.length};
 };
 const tick=()=>{if(running)return running;running=run().finally(()=>{running=null;});return running;};
 const safelyTick=()=>tick().catch(error=>log('Automatic spreadsheet recovery could not run: '+error.message).catch(console.error));
 let timer,initial;if(schedule){timer=setInterval(safelyTick,intervalMs);timer.unref?.();initial=setTimeout(safelyTick,0);initial.unref?.();}
 return {tick,stop(){stopped=true;clearInterval(timer);clearTimeout(initial);}};
}
