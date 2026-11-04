export async function getReturningMemberHistory(db,record) {
  if(String(record.application_action||'').toLowerCase()!=='accepted')return null;
  const account=String(record.applicant_account||'').trim().replace(/^@/,'');
  const acceptedAt=Number(record.application_timestamp);
  if(!account || !Number.isSafeInteger(acceptedAt) || acceptedAt<=0)return null;
  const [history]=await db.execute(`SELECT rank_name,event_timestamp FROM guildsync_roster_events
    WHERE LOWER(TRIM(LEADING '@' FROM account_name)) = LOWER(?) AND event_type IN ('promoted', 'demoted')
      AND CAST(event_timestamp AS UNSIGNED) <= ?
    ORDER BY CAST(event_timestamp AS UNSIGNED) DESC,CAST(event_id AS UNSIGNED) DESC,event_id DESC LIMIT 1`,[account,acceptedAt]);
  if(!history.length)return null;
  const [links]=await db.execute(`SELECT DISTINCT discord_user_id FROM guildsync_member_links
    WHERE LOWER(TRIM(LEADING '@' FROM eso_account_name)) = LOWER(?) AND link_status = 'linked'`,[account]);
  return {actorDiscordId:/^\d{1,32}$/.test(String(record.submitted_by_discord_id||''))?String(record.submitted_by_discord_id):null,rankName:String(history[0].rank_name||'').trim(),rankTimestamp:Number(history[0].event_timestamp),
    discordUserIds:links.map(link=>String(link.discord_user_id)).filter(id=>/^\d+$/.test(id))};
}
