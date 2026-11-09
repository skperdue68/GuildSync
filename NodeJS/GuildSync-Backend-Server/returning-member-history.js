const cleanRank=value=>{const rank=String(value||'').trim();return /^unknown$/i.test(rank)?'':rank;};

export async function getReturningMemberHistory(db,record) {
  if(String(record.application_action||'').toLowerCase()!=='accepted')return null;
  const account=String(record.applicant_account||'').trim().replace(/^@/,'');
  const acceptedAt=Number(record.application_timestamp);
  if(!account || !Number.isSafeInteger(acceptedAt) || acceptedAt<=0)return null;
  const [history]=await db.execute(`SELECT rank_name,event_timestamp FROM guildsync_roster_events
    WHERE LOWER(TRIM(LEADING '@' FROM account_name)) = LOWER(?) AND event_type IN ('promoted', 'demoted')
      AND CAST(event_timestamp AS UNSIGNED) <= ?
    ORDER BY CAST(event_timestamp AS UNSIGNED) DESC,CAST(event_id AS UNSIGNED) DESC,event_id DESC LIMIT 1`,[account,acceptedAt]);
  // A former member whose rank was never captured still counts as returning, so fall
  // back to their latest roster activity. The bot then reports their Discord rank.
  const [earlier]=history.length?[[]]:await db.execute(`SELECT rank_name,event_timestamp FROM guildsync_roster_events
    WHERE LOWER(TRIM(LEADING '@' FROM account_name)) = LOWER(?)
      AND CAST(event_timestamp AS UNSIGNED) <= ?
    ORDER BY CAST(event_timestamp AS UNSIGNED) DESC,CAST(event_id AS UNSIGNED) DESC,event_id DESC LIMIT 1`,[account,acceptedAt]);
  const latest=history[0]||earlier[0];
  if(!latest)return null;
  const rankName=cleanRank(latest.rank_name);
  // The roster side can still know the rank when the event history does not, so the bot
  // can tell an equivalent Discord rank from a genuine in-game promotion.
  let rosterRank='';
  if(!rankName) {
    const [rosterRows]=await db.execute(`SELECT rank_name FROM guildsync_roster_rank_history
      WHERE LOWER(TRIM(LEADING '@' FROM account_name)) = LOWER(?) LIMIT 1`,[account]);
    rosterRank=cleanRank(rosterRows[0]?.rank_name);
  }
  const [links]=await db.execute(`SELECT DISTINCT discord_user_id FROM guildsync_member_links
    WHERE LOWER(TRIM(LEADING '@' FROM eso_account_name)) = LOWER(?) AND link_status = 'linked'`,[account]);
  return {actorDiscordId:/^\d{1,32}$/.test(String(record.submitted_by_discord_id||''))?String(record.submitted_by_discord_id):null,
    rankName,rosterRank,rankTimestamp:Number(latest.event_timestamp),
    discordUserIds:links.map(link=>String(link.discord_user_id)).filter(id=>/^\d+$/.test(id))};
}
