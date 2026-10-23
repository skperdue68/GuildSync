// An installation/database owns one ESO guild. ESO IDs are not Discord server IDs.
export function esoGuildConfiguration(env = process.env) {
  const guildId = String(env.GUILDSYNC_ESO_GUILD_ID || '').trim();
  if (guildId && !/^[1-9]\d{0,31}$/.test(guildId)) throw Error('GUILDSYNC_ESO_GUILD_ID must be a numeric ESO guild ID, without @.');
  const applicationsId = String(env.GUILDSYNC_APPLICATIONS_GUILD_ID || '').trim();
  if (guildId && applicationsId && guildId !== applicationsId) {
    throw Error('GUILDSYNC_ESO_GUILD_ID and GUILDSYNC_APPLICATIONS_GUILD_ID must identify the same ESO guild.');
  }
  return {guildId, strict: Boolean(guildId)};
}

export async function initializeEsoGuildIdentity(db, env = process.env) {
  const {guildId} = esoGuildConfiguration(env);
  const [rows] = await db.execute('SELECT value FROM guildsync_settings WHERE setting_key = ?', ['eso_guild_id']);
  const bound = String(rows[0]?.value || '');
  if (bound && bound !== guildId) throw Error(`Database belongs to ESO guild ${bound}; configure that guild ID or use a separate database. Guild identity cannot be changed or disabled on this database.`);
  if (!guildId || bound) return;
  await db.execute('INSERT IGNORE INTO guildsync_settings (setting_key, value) VALUES (?, ?)', ['eso_guild_id', guildId]);
  const [confirmed] = await db.execute('SELECT value FROM guildsync_settings WHERE setting_key = ?', ['eso_guild_id']);
  if (String(confirmed[0]?.value || '') !== guildId) throw Error('Could not bind this database to the configured ESO guild.');
}

function importError(message) { return Object.assign(new Error(message), {code: 'ESO_GUILD_ORIGIN'}); }

function validateOrigin(record, label, expected, required = true) {
  const provided = [record?.guildId, record?.guild_id, record?.esoGuildId, record?.eso_guild_id]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
    .map(value => String(value).trim());
  if (!provided.length) {
    if (required) throw importError(`${label} has no ESO guild ID. Update the ESO add-on and re-export/replay; GuildSync kept the upload unacknowledged.`);
    return;
  }
  if (provided.some(id => id !== expected)) throw importError(`${label} belongs to ESO guild ${provided.join('/')}, but this installation accepts only guild ${expected}. Nothing in this upload was processed.`);
}

export function validateEsoGuildImport(kind, payload, env = process.env) {
  const {guildId, strict} = esoGuildConfiguration(env);
  if (!strict) return; // Compatibility for existing single-guild installations until configured.
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  validateOrigin(payload, `${kind} upload`, guildId, false);
  validateOrigin(data, `${kind} data`, guildId, false);
  if (kind === 'roster') {
    if (data?.guildList) {
      validateOrigin(data.guildList, 'Roster snapshot', guildId);
      for (const member of Object.values(data.guildList.guildListMembers || data.guildList.guildMembers || {})) {
        validateOrigin(member, 'Roster snapshot member', guildId, false);
      }
    }
    for (const event of Object.values(data?.rosterEvents || {})) validateOrigin(event, 'Roster event', guildId);
  } else {
    const records = kind === 'banking' ? data?.entries || [] : Array.isArray(data) ? data : data?.records || [];
    for (const record of Object.values(records)) validateOrigin(record, kind === 'banking' ? 'Banking entry' : 'Application record', guildId);
  }
}
