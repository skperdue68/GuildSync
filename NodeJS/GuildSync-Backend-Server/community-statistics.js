const positive=n=>Number.isFinite(Number(n))?Math.max(0,Number(n)):0;
const label=r=>r.server_nickname||r.global_name||r.username||r.account_name||r.discord_id||'Unknown';
const typeOf=t=>['monthly','50/50','5050'].includes(String(t).toLowerCase())?'monthly':['biweekly','bi-weekly','bi weekly'].includes(String(t).toLowerCase())?'biweekly':null;
function leaders(rows,key,value){const totals=new Map();for(const r of rows){const id=String(key(r)||'').toLowerCase();if(!id)continue;const previous=totals.get(id)||{name:label(r),value:0,detail:''};previous.value+=value(r);totals.set(id,previous);}return [...totals.values()].filter(r=>r.value>0).sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name)).slice(0,5);}
export async function initializeCommunityStatisticsSchema(db){
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_community_statistics_metadata (metadata_key VARCHAR(64) PRIMARY KEY, metadata_value VARCHAR(64) NOT NULL)`);
 await db.query(`INSERT IGNORE INTO guildsync_community_statistics_metadata (metadata_key,metadata_value) VALUES ('tracking_since', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'))`);
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_discord_interactions (interaction_id VARCHAR(32) PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, discord_id VARCHAR(32) NOT NULL, display_name VARCHAR(255) NOT NULL, interaction_type VARCHAR(16) NOT NULL, interaction_name VARCHAR(100) NOT NULL, recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_community_interactions_actor (discord_id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_discord_activity (guild_id VARCHAR(32) NOT NULL, event_key VARCHAR(64) NOT NULL, discord_id VARCHAR(32) NOT NULL, display_name VARCHAR(255) NOT NULL, activity_type VARCHAR(16) NOT NULL, recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,event_key), INDEX idx_community_activity_actor (discord_id,activity_type)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 await db.query(`INSERT IGNORE INTO guildsync_community_statistics_metadata (metadata_key,metadata_value) VALUES ('discord_activity_since', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'))`);
}
export function buildCommunityStatistics({now=Math.floor(Date.now()/1000),trackingSince=null,roster=[],rosterEvents=[],discordMembers=[],discordHistory=[],activity=[],banking=[],windows=[]}={}){
 const highlights=[];const add=(id,title,description,unit,rows)=>highlights.push({id,title,description,unit,rows});
 for(const [event,suffix] of [['joined','joins'],['left','leaves']])add('guild-'+suffix,'Most recorded guild '+suffix,'Recorded ESO roster events; departures include left and kicked. History may be incomplete.','events',leaders(rosterEvents.filter(r=>r.event_type===event||(event==='left'&&r.event_type==='kicked')),r=>r.account_name,()=>1));
 for(const [event,suffix] of [['joined_server','joins'],['left_server','leaves']])add('discord-'+suffix,'Most recorded Discord '+suffix,'Live history entries only; bulk snapshots excluded. First discovery during an update can be recorded as a join.','events',leaders(discordHistory.filter(r=>r.event_type===event&&r.source==='live_event'),r=>r.discord_id,()=>1));
 // A roster snapshot timestamp can be the import date. Only an actual recorded join establishes tenure.
 const current=roster.filter(r=>Number(r.in_roster)===1);const tenure=current.flatMap(r=>{const joins=rosterEvents.filter(e=>e.account_name.toLowerCase()===r.account_name.toLowerCase()&&e.event_type==='joined').map(e=>Number(e.event_timestamp)).filter(t=>t>0&&t<=now);if(!joins.length)return [];const joined=Math.max(...joins);const departed=rosterEvents.some(e=>String(e.account_name).toLowerCase()===r.account_name.toLowerCase()&&['left','kicked'].includes(e.event_type)&&Number(e.event_timestamp)>=joined&&Number(e.event_timestamp)<=now);if(departed)return [];return [{name:r.account_name,value:Math.floor((now-joined)/86400),detail:'Latest recorded join: '+new Date(joined*1000).toISOString()}];});
 const missingJoins=current.filter(r=>!rosterEvents.some(e=>String(e.account_name).toLowerCase()===String(r.account_name).toLowerCase()&&e.event_type==='joined'&&Number(e.event_timestamp)>0&&Number(e.event_timestamp)<=now)).length;
 const joinCoverage=`${missingJoins} of ${current.length} current members have no recorded join date. Import dates are excluded.`;
 add('longest-member','Longest membership with a known join date','Days since the latest recorded join. '+joinCoverage,'days',[...tenure].sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name)).slice(0,5));
 add('newest-member','Newest recorded current members','Current ESO members with a recorded join. '+joinCoverage,'days',[...tenure].sort((a,b)=>a.value-b.value||b.detail.localeCompare(a.detail)||a.name.localeCompare(b.name)).slice(0,5));
 const recordedActivity=activity.filter(r=>['post','reaction'].includes(r.activity_type));
 add('discord-busiest','Busiest Discord Users','Recorded posts plus emoji reactions given since activity tracking began. Bots excluded; offline or missed events are not backfilled.','actions',leaders(recordedActivity,r=>r.discord_id,r=>positive(r.activity_count)));
 add('discord-posts','Most Posts','New Discord posts recorded since activity tracking began; bots and system messages excluded.','posts',leaders(recordedActivity.filter(r=>r.activity_type==='post'),r=>r.discord_id,r=>positive(r.activity_count)));
 add('discord-reactions','Most Reactions Given','Emoji reactions given, including likes. Each member/message/emoji counts once; removing a reaction does not subtract it.','reactions',leaders(recordedActivity.filter(r=>r.activity_type==='reaction'),r=>r.discord_id,r=>positive(r.activity_count)));
 const purchases=banking.filter(r=>typeOf(r.type)&&positive(r.purchasedTickets)>0&&Number(r.time)>0&&Number(r.time)<=now).map(r=>({...r,account_name:r.displayName}));
 for(const w of windows){const rows=purchases.filter(r=>typeOf(r.type)===w.type&&Number(r.time)>=w.salesStart&&Number(r.time)<=w.salesEnd);add('tickets-'+w.type,'Current '+(w.type==='monthly'?'50/50':'Bi-weekly')+' ticket purchasers','Purchased tickets only; bonus tickets excluded.','tickets',leaders(rows,r=>r.displayName,r=>positive(r.purchasedTickets)));}
 const spending=r=>{const n=positive(r.amount),digit=Math.trunc(n)%10;return [1,3].includes(digit)&&n>digit?n-digit:n;};
 add('raffle-spending','Lifetime recorded raffle spending','Recorded ticket purchases across both raffles, excluding +1/+3 markers; retained banking history only.','gold',leaders(purchases,r=>r.displayName,spending));
 return {
  generatedAt:new Date(now*1000).toISOString(),
  trackingSince,
  notes:['Membership and raffle history may be incomplete; these are recorded totals, not all-time claims.','Imported Discord snapshots are not actual joins. Live first discoveries can also appear as joins. Snapshot-only ESO dates are excluded; missing departures/rejoins can still affect recorded tenure.','Discord activity counts new posts and emoji reactions given in channels the bot can access; bots, DMs, system posts, and historical scans are excluded. Older last-seen values cannot reconstruct these totals.','Only event keys, guild/user IDs, display names, action type and collection time are stored; no message text or attachments. Activity records are retained until explicitly removed.'],
  overview:[
   {label:'Current ESO members',value:current.length},
   {label:'Current Discord members',value:discordMembers.length},
   {label:'Recorded Discord activity',value:recordedActivity.reduce((n,r)=>n+positive(r.activity_count),0)},
   {label:'Recorded raffle spending (gold)',value:purchases.reduce((n,r)=>n+spending(r),0)}
  ],
  highlights
 };
}
export function registerCommunityStatisticsSocket(socket, {
  db, loadBanking, loadWindows = async () => [], authorizeViewer, now = () => Math.floor(Date.now() / 1000)
}) {
  socket.on('guildsync:request-community-statistics', async (payload, callback) => {
    if (typeof payload === 'function') callback = payload;
    const reply = response => typeof callback === 'function'
      ? callback(response) : socket.emit('guildsync:community-statistics', response);
    if (!socket.guildSyncAuthenticated || !['viewer', 'user', 'admin'].includes(socket.guildSyncUser?.role)
      || socket.guildSyncAuthType === 'discord-bot') {
      return reply({ok: false, message: 'Approved GuildSync access is required.'});
    }
    try {
      if (authorizeViewer && !await authorizeViewer(socket)) return reply({ok:false,message:'Approved GuildSync access is required.'});
      const selections = [
        'account_name,in_roster FROM guildsync_roster_members',
        'account_name,event_type,event_timestamp FROM guildsync_roster_events',
        'discord_id FROM discord_members',
        'discord_id,username,event_type,source FROM discord_member_history'
      ];
      const [roster, rosterEvents, discordMembers, discordHistory] = await Promise.all(
        selections.map(async selection => (await db.execute(`SELECT ${selection}`))[0])
      );
      const [activity] = await db.execute(`
        SELECT discord_id, activity_type, MAX(display_name) AS username, COUNT(*) AS activity_count
        FROM guildsync_discord_activity GROUP BY discord_id, activity_type
      `);
      const [meta] = await db.execute(`
        SELECT metadata_value FROM guildsync_community_statistics_metadata WHERE metadata_key = 'discord_activity_since'
      `);
      const time = now();
      const [banking, windows] = await Promise.all([loadBanking(db), loadWindows(db, time)]);
      reply({ok: true, report: buildCommunityStatistics({
        now: time, trackingSince: meta[0]?.metadata_value || null,
        roster, rosterEvents, discordMembers, discordHistory, activity, banking, windows
      })});
    } catch {
      reply({ok: false, message: 'Community statistics could not be loaded.'});
    }
  });

  socket.on('guildsync:record-discord-activity', async (payload = {}, callback) => {
    payload = payload && typeof payload === 'object' ? payload : {};
    const reply = response => { if (typeof callback === 'function') callback(response); };
    if (!socket.guildSyncAuthenticated || socket.guildSyncAuthType !== 'discord-bot'
      || !socket.guildSyncBot?.guild_id || String(payload.guildId) !== String(socket.guildSyncBot.guild_id)) {
      return reply({ok:false,message:'Authenticated guild bot required.'});
    }
    if (!/^[a-f0-9]{64}$/.test(String(payload.eventKey)) || !/^\d{1,32}$/.test(String(payload.userId))
      || !['post','reaction'].includes(payload.type)) {
      return reply({ok:false,message:'Invalid activity metadata.'});
    }
    try {
      await db.execute(`INSERT IGNORE INTO guildsync_discord_activity
        (guild_id,event_key,discord_id,display_name,activity_type) VALUES (?,?,?,?,?)`,
        [String(payload.guildId),payload.eventKey,String(payload.userId),String(payload.displayName || payload.userId).slice(0,255),payload.type]);
      reply({ok:true});
    } catch (error) {
      console.error(`Discord community activity database write failed: ${error.message}`);
      reply({ok:false,message:'Activity could not be recorded; check backend logs.'});
    }
  });

  // Retain the old receiver during upgrades; older command records do not enter activity rankings.
  socket.on('guildsync:record-discord-interaction', async (payload = {}, callback) => {
    payload = payload && typeof payload === 'object' ? payload : {};
    const reply = response => { if (typeof callback === 'function') callback(response); };
    if (!socket.guildSyncAuthenticated || socket.guildSyncAuthType !== 'discord-bot'
      || !socket.guildSyncBot?.guild_id || String(payload.guildId) !== String(socket.guildSyncBot.guild_id)) {
      return reply({ok: false, message: 'Authenticated guild bot required.'});
    }
    if (!/^\d{1,32}$/.test(String(payload.interactionId)) || !/^\d{1,32}$/.test(String(payload.userId))
      || !['slash', 'button', 'select', 'modal'].includes(payload.type)) {
      return reply({ok: false, message: 'Invalid interaction metadata.'});
    }
    try {
      await db.execute(`
        INSERT IGNORE INTO guildsync_discord_interactions
          (interaction_id,guild_id,discord_id,display_name,interaction_type,interaction_name)
        VALUES (?,?,?,?,?,?)
      `, [
        String(payload.interactionId), String(payload.guildId), String(payload.userId),
        String(payload.displayName || payload.userId).slice(0, 255), payload.type,
        payload.type === 'slash' ? String(payload.name || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 100) : payload.type
      ]);
      reply({ok: true});
    } catch {
      reply({ok: false, message: 'Interaction could not be recorded.'});
    }
  });
}
