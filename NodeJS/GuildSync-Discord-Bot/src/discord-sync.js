import { Log } from './helper.js';

async function fetchAllMembersInBatches(guild, batchSize = 300) {
  const allMembers = [];
  let after = '0';

  while (true) {
    const batch = await guild.members.list({
      limit: batchSize,
      after
    });

    const members = [...batch.values()];

    if (members.length === 0) {
      break;
    }

    const nonBotMembers = members.filter((member) => !member.user.bot);

    allMembers.push(...nonBotMembers);

    after = members[members.length - 1].id;

    Log(
      `Fetched ${members.length} member(s), kept ${nonBotMembers.length} non-bot member(s). Total so far: ${allMembers.length}`
    );

    if (members.length < batchSize) {
      break;
    }
  }

  return allMembers;
}

function emitWithAck(socket, eventName, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('GuildSync websocket is not connected.'));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error(`${eventName} did not respond within ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.emit(eventName, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

export async function syncDiscordRolesAndMembers(guild, guildSyncSocket) {
  if (!guild) {
    throw new Error('Missing Discord guild.');
  }

  if (!guildSyncSocket?.connected) {
    throw new Error('GuildSync websocket is not connected.');
  }

  Log(`Starting Discord sync for guild ${guild.name} (${guild.id}).`);

  const fetchedRoles = await guild.roles.fetch();

  const roles = [...fetchedRoles.values()]
    .filter((role) => role.id !== guild.id) // removes @everyone
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      role_id: role.id,
      role_name: role.name,
      role_color: role.color,
      role_position: role.position
    }));

  const rolesPayload = {
    guild_id: guild.id,
    guild_name: guild.name,
    role_count: roles.length,
    roles
  };

  Log(`Sending ${roles.length} Discord role(s) to GuildSync.`);

  const rolesResults = await emitWithAck(
    guildSyncSocket,
    'guildsync:sending-discord-roles',
    rolesPayload
  );

  if (!rolesResults?.ok) {
    throw new Error(
      rolesResults?.message || 'GuildSync failed to process Discord roles.'
    );
  }

  Log(`GuildSync processed ${rolesResults.roles_processed} Discord role(s).`);

  const members = await fetchAllMembersInBatches(guild, 300);

  const memberRows = members
    .sort((a, b) => {
      const nameA = a.displayName?.toLowerCase() ?? '';
      const nameB = b.displayName?.toLowerCase() ?? '';
      return nameA.localeCompare(nameB);
    })
    .map((member) => {
      const roles = [];

      for (const role of member.roles.cache.values()) {
        if (role.id === guild.id) {
          continue; // removes @everyone
        }

        roles.push(role.id);
      }

      return {
        discord_id: member.user.id,
        avatar: member.user.avatar ?? '',
        username: member.user.username,
        global_name: member.user.globalName ?? '',
        server_nickname: member.nickname ?? '',
        joined_at: member.joinedAt?.toISOString?.() ?? '',
        roles
      };
    });

  const membersPayload = {
    guild_id: guild.id,
    guild_name: guild.name,
    member_count: memberRows.length,
    source: 'bulk_sync',
    members: memberRows
  };

  Log(`Sending ${memberRows.length} Discord member record(s) to GuildSync.`);

  const memberResults = await emitWithAck(
    guildSyncSocket,
    'guildsync:sending-discord-members',
    membersPayload
  );

  if (!memberResults?.ok) {
    throw new Error(
      memberResults?.message || 'GuildSync failed to process Discord members.'
    );
  }

  Log(
    `GuildSync processed ${memberResults.members_processed} member record(s). Removed ${memberResults.members_removed} member record(s).`
  );

  return {
    roles_processed: rolesResults.roles_processed,
    members_processed: memberResults.members_processed,
    members_removed: memberResults.members_removed
  };
}

export function discordRoleToPayload(role) {
  return {
    role_id: role.id,
    role_name: role.name,
    role_color: role.color,
    role_position: role.position
  };
}

export function discordMemberToPayload(member) {
  const roles = [];

  for (const role of member.roles.cache.values()) {
    if (role.id === member.guild.id) {
      continue; // removes @everyone
    }

    roles.push(role.id);
  }

  return {
    discord_id: member.user.id,
    avatar: member.user.avatar ?? '',
    username: member.user.username,
    global_name: member.user.globalName ?? '',
    server_nickname: member.nickname ?? '',
    joined_at: member.joinedAt?.toISOString?.() ?? '',
    roles
  };
}

export async function sendDiscordRoleUpsert(role, guildSyncSocket) {
  if (!role || role.id === role.guild.id) {
    return null;
  }

  return await emitWithAck(
    guildSyncSocket,
    'guildsync:discord-role-upsert',
    {
      guild_id: role.guild.id,
      guild_name: role.guild.name,
      role: discordRoleToPayload(role)
    }
  );
}

export async function sendDiscordRoleDelete(role, guildSyncSocket) {
  if (!role || role.id === role.guild.id) {
    return null;
  }

  return await emitWithAck(
    guildSyncSocket,
    'guildsync:discord-role-delete',
    {
      guild_id: role.guild.id,
      guild_name: role.guild.name,
      role_id: role.id
    }
  );
}

export async function sendDiscordMemberUpsert(member, guildSyncSocket, options = {}) {
  if (!member || member.user?.bot) {
    return null;
  }

  return await emitWithAck(
    guildSyncSocket,
    'guildsync:discord-member-upsert',
    {
      guild_id: member.guild.id,
      guild_name: member.guild.name,
      source: 'live_event',
      initiator: options.initiator || null,
      member: {
        ...discordMemberToPayload(member),
        initiator: options.initiator || null
      }
    }
  );
}

export async function sendDiscordMemberDelete(member, guildSyncSocket) {
  if (!member || member.user?.bot) {
    return null;
  }

  return await emitWithAck(
    guildSyncSocket,
    'guildsync:discord-member-delete',
    {
      guild_id: member.guild.id,
      guild_name: member.guild.name,
      discord_id: member.user.id,
      source: 'live_event'
    }
  );
}

export async function sendDiscordMemberLastSeen(guildSyncSocket, payload = {}) {
  return await emitWithAck(
    guildSyncSocket,
    'guildsync:discord-member-last-seen',
    payload
  );
}

export async function getDiscordHistoricalScanStatus(guildSyncSocket) {
  return await emitWithAck(
    guildSyncSocket,
    'guildsync:discord-historical-scan-status',
    {}
  );
}

export async function markDiscordHistoricalScanComplete(guildSyncSocket, payload = {}) {
  return await emitWithAck(
    guildSyncSocket,
    'guildsync:discord-historical-scan-complete',
    payload
  );
}

