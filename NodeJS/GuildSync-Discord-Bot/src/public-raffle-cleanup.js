function isPublicRaffleSummary(message, botId) {
  const content = message?.content;
  return message?.author?.id === botId && /^\d+$/.test(String(message.id))
    && !message.flags?.has?.(64) // Ephemeral responses must never participate.
    && typeof content === 'string'
    && /(?:^|\n)As of <t:\d+:f>\. Based on the latest banking data received by GuildSync\./.test(content)
    && content.includes('**GuildSync active raffle prizes**')
    && /\*\*(?:Bi-Weekly|50\/50): [\d,]+ gold available for the draw\*\*/.test(content)
    && !/\*\*(?:Your|Verified) tickets \(/.test(content);
}

// Always publish first. A scan/delete failure must not turn a successful post into a resend.
export async function cleanupPublicRaffleSummaries(channel, published, botId, log = console.warn) {
  if (!botId || !isPublicRaffleSummary(published, botId) || !channel?.messages?.fetch) return;
  const summaries = new Map([[published.id, published]]);
  try {
    let before;
    while (true) {
      const page = await channel.messages.fetch({limit:100, ...(before ? {before} : {})});
      for (const message of page.values()) {
        if (isPublicRaffleSummary(message, botId)) summaries.set(message.id, message);
      }
      if (page.size < 100) break;
      const oldest = page.last();
      if (!oldest || !/^\d+$/.test(String(oldest.id)) || (before && BigInt(oldest.id) >= BigInt(before))) {
        throw new Error('Channel history pagination did not advance.');
      }
      before = oldest.id;
    }
  } catch (error) {
    log(`Public raffle cleanup could not read channel ${channel.id || 'unknown'}: ${error.message}`);
    return;
  }
  // A retried persisted delivery can contain older data despite a newer message ID.
  // Prefer the freshest snapshot, then the newest message when snapshot times match.
  const snapshotTime = id => BigInt(summaries.get(id).content.match(/As of <t:(\d+):f>/)[1]);
  const newest = [...summaries.keys()].reduce((a,b) => {
    const aTime = snapshotTime(a), bTime = snapshotTime(b);
    return aTime > bTime || (aTime === bTime && BigInt(a) > BigInt(b)) ? a : b;
  });
  let removed = 0;
  for (const [id, message] of summaries) {
    if (id === newest) continue;
    try {
      // Individual deletes also work for summaries too old for bulk deletion.
      await message.delete();
      removed++;
    } catch (error) {
      // Another concurrent cleanup may have removed it already (Unknown Message).
      if (Number(error.code) !== 10008) log(`Public raffle cleanup could not remove message ${id}: ${error.message}`);
    }
  }
  if (removed) log(`Public raffle cleanup removed ${removed} older summary message(s) from channel ${channel.name || channel.id || 'unknown'}; newest summary retained.`);
}
