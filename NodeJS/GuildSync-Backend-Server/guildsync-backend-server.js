import {registerCommunityStatisticsSocket} from './community-statistics.js';
import {startSheetsExportRecovery} from './sheets-export-queue.js';
import {initializeVoiceIdentitySchema,createVoiceIdentityService,registerVoiceIdentityRoutes,registerVoiceOnlyConnection,authorizeVoiceRequester,authenticateVoiceSocket} from './voice-auth.js';
import {esoGuildConfiguration, initializeEsoGuildIdentity, validateEsoGuildImport} from './eso-guild-origin.js';
import {registerDiscordGuildOrigin} from './discord-guild-origin.js';
import {createUserAdministration,registerUserAdministrationSocket} from './user-administration.js';
import {canIngestGuildSyncRole} from './role-permissions.js';
import {registerRolePermissions} from './role-permissions-socket.js';
import {createRoleViews,registerRoleViewSocket,roleViewSessionKey} from './role-view.js';
import {createConfigurationService} from './admin-configuration.js';
import {registerConfigurationSocket} from './admin-configuration-socket.js';
import { createDiscordOnboarding } from './discord-onboarding.js';
import { registerDiscordOnboardingSocket } from './discord-onboarding-socket.js';
import {createVoiceMuteStore} from './voice-mute-store.js';
import {registerVoiceMuteSocket} from './voice-mute-socket.js';
import 'dotenv/config';
import { readReleaseVersion } from './release-version.js';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import fs from 'node:fs';
import { registerRaffleSocket, registerArchiveSocket } from './raffle-socket.js';
import { getActiveRaffleSummary, getRaffleUserTickets, getSheetsRaffleWindows, getRaffleRefreshSelection, selectSheetsCatchupEntries } from './guildsync-database-actions.js';
import { startSheetsRollover } from './sheets-rollover-runtime.js';
import { registerRaffleManagementSocket, registerRaffleRefreshSocket } from './raffle-admin-socket.js';
import { createHistoricalRaffles } from './historical-raffles.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';

import {
  GUILDSYNC_DB_NAME,
  openLoginDB,
  upsertLoginUser,

  openAppDataDB,
  upsertDiscordRoles,
  upsertDiscordMembers,
  upsertDiscordMember,
  deleteDiscordMember,
  upsertDiscordRole,
  deleteDiscordRole,
  updateDiscordMemberLastSeen,
  getDiscordHistoricalScanStatus,
  getDiscordMemberHistoryMatches,
  getDiscordMemberHistoryForMember,
  markDiscordHistoricalScanComplete,
  getDiscordDataDate,
  getDiscordMemberDataJSON,
  getDiscordRoleDataJSON,
  getBankingDataDate,
  getBankingDataJSON,
  getRaffleBonusSettings,
  getRaffleBonusVersions,
  getRaffleBonusChoices,
  saveRaffleBonusOverride,
  saveRaffleBonusSettings,
  getBankingHistoryMatches,
  getBankingHistoryForAccount,
  checkoutDepositMail,
  markDepositMailWrittenToESO,
  markDepositMailSent,
  insertBankingEntries,
  addManualBiweeklyTicketEntry,
  moveBankingEntry,
  getAssociateTicketReport,
  getDiscordRankAuditReport,
  getRosterDataDate,
  getRosterDataJSON,
  getRosterMemberNotes,
  addRosterMemberNote,
  getRosterRankHistoryMatches,
  getRosterStreamHistoryForAccount,
  getMemberLinks,
  getMemberLinkOptions,
  acceptMemberLinkCandidate,
  manualLinkMember,
  manualUnlinkMember,
  unblockMemberAutoLink,
  runMemberAutoLinking,
  processRosterData,
  recordGuildSyncApplications,
  getGuildSyncApplicationsByApplicantSearch,
  getPendingGuildSyncApplicationBroadcasts,
  markGuildSyncApplicationBroadcasted,
  markGuildSyncApplicationRecordBroadcasted,
  parseGuildSyncBankingSavedVarsLua,
  parseGuildSyncRosterSavedVarsLua,
  parseGuildSyncApplicationsSavedVarsLua
} from './guildsync-database-actions.js';

let discordBotConnected = false;
let discordBotSocketId = null;
let discordBotConnectedAt = null;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);

const DISCORD_CLIENT_ID = requiredEnv('DISCORD_CLIENT_ID');
const DISCORD_CLIENT_SECRET = requiredEnv('DISCORD_CLIENT_SECRET');
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://127.0.0.1:53682/callback';
const DISCORD_WEB_REDIRECT_URI = process.env.DISCORD_WEB_REDIRECT_URI || 'https://guildsync.perdues.me/api/auth/discord/web-callback';
const GUILDSYNC_WEB_PUBLIC_URL = process.env.GUILDSYNC_WEB_PUBLIC_URL || 'https://guildsync.perdues.me';
const GUILDSYNC_JWT_SECRET = requiredEnv('GUILDSYNC_JWT_SECRET');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIST_DIR = process.env.GUILDSYNC_WEB_DIST_DIR || path.join(__dirname, 'public');
const GUILDSYNC_DOWNLOADS_DIR = process.env.GUILDSYNC_DOWNLOADS_DIR || path.join(__dirname, 'public', 'downloads');

const GUILDSYNC_BOT_SOCKET_KEY = requiredEnv('GUILDSYNC_BOT_SOCKET_KEY');
const ESO_GUILD_CONFIGURATION = esoGuildConfiguration();
const GUILDSYNC_APPLICATIONS_GUILD_ID = String(ESO_GUILD_CONFIGURATION.guildId || process.env.GUILDSYNC_APPLICATIONS_GUILD_ID || '761817').trim();

const CURRENT_GUILDSYNC_CLIENT_VERSION = readReleaseVersion();
let loginDB;
let applicationDB;
let sheetsRuntime;
let sheetsExportRecovery;
let configurationService;
let voiceIdentityService;

try {
  loginDB = await openLoginDB();
await initializeVoiceIdentitySchema(loginDB);
voiceIdentityService=createVoiceIdentityService(loginDB,{secret:GUILDSYNC_JWT_SECRET});
  applicationDB = await openAppDataDB();
  await initializeEsoGuildIdentity(applicationDB);
  Log(ESO_GUILD_CONFIGURATION.strict ? `ESO imports restricted to guild ${ESO_GUILD_CONFIGURATION.guildId}.` : 'ESO guild isolation: legacy mode; set GUILDSYNC_ESO_GUILD_ID after updating add-ons to enforce guild identity.');
  configurationService = createConfigurationService(applicationDB,{applyAtBoundary:fn=>sheetsRuntime?sheetsRuntime.applyConfiguration(fn):fn()});
  await configurationService.initialize();
  sheetsRuntime = startSheetsRollover(applicationDB, getSheetsRaffleWindows, {
    selectPeriods: getRaffleRefreshSelection,
    loadCatchupEntries: async now => selectSheetsCatchupEntries(await getBankingDataJSON(applicationDB), now)
  });
  sheetsExportRecovery=startSheetsExportRecovery(applicationDB,{
    loadEntries:()=>getBankingDataJSON(applicationDB),
    selectBootstrapEntries:async(entries,time)=>{
      const {raffles}=await getActiveRaffleSummary(applicationDB,time);
      return entries.filter(entry=>Number(entry.time)<=time&&raffles.some(window=>entry.type===window.type&&Number(entry.time)>=window.salesStart&&Number(entry.time)<=window.salesEnd));
    }
  });

  Log(`MariaDB database ready: ${GUILDSYNC_DB_NAME}`);
} catch (error) {
  Log('Failed to initialize MariaDB: '+error.message);
  process.exit(1);
}

const app = express();
const roleViews = createRoleViews(loginDB);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));

registerVoiceIdentityRoutes(app,{service:voiceIdentityService,exchangeCode:exchangeCodeWithDiscord,fetchUser:fetchDiscordUser,redirectURI:DISCORD_REDIRECT_URI,disconnect:id=>{for(const socket of io.sockets.sockets.values())if(socket.guildSyncAuthType==='voice-mute'&&socket.guildSyncSessionId===id)socket.disconnect(true);}});

app.post('/api/auth/discord/desktop-token', async (req, res) => {
  try {
    const { code, redirect_uri: redirectURI } = req.body || {};

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing Discord authorization code.' });
    }

    const effectiveRedirectURI = redirectURI || DISCORD_REDIRECT_URI;

    if (effectiveRedirectURI !== DISCORD_REDIRECT_URI) {
      return res.status(400).json({
        ok: false,
        error: 'Redirect URI mismatch. The desktop app and server must use the same Discord redirect URI.'
      });
    }

    const discordToken = await exchangeCodeWithDiscord(code, effectiveRedirectURI);
    const discordUser = await fetchDiscordUser(discordToken.access_token);
    const dbUser = await upsertLoginUser(loginDB, discordUser);
    void broadcastUserAdministrationCounts();

    if (!dbUser.allowed) {
      return res.status(403).json({
        ok: false,
        allowed: false,
        message: `Discord user ${preferredUserName(dbUser)} is authenticated, but access is pending approval.`,
        user: {
          discord_user_id: dbUser.discord_user_id,
          username: dbUser.username,
          global_name: dbUser.global_name,
          display_name: preferredUserName(dbUser),
          avatar: dbUser.avatar,
          avatar_url: discordAvatarURL(dbUser.discord_user_id, dbUser.avatar),
          email: dbUser.email,
          role: dbUser.role
        }
      });
    }

    const guildSyncUser = {
      discord_user_id: dbUser.discord_user_id,
      username: dbUser.username,
      global_name: dbUser.global_name,
      display_name: preferredUserName(dbUser),
      avatar: dbUser.avatar || '',
      avatar_url: discordAvatarURL(dbUser.discord_user_id, dbUser.avatar),
      email: dbUser.email || '',
      role: dbUser.role || 'user'
    };

    const token = await createGuildSyncJWT(guildSyncUser);

    return res.json({
      ok: true,
      allowed: true,
      token,
      user: guildSyncUser,
      message: `Logged in and authorized as ${guildSyncUser.display_name}.`
    });
  } catch (error) {
    Log('Discord desktop-token error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Discord authentication failed.'
    });
  }
});


app.get('/api/auth/discord/web-login', (req, res) => {
  const state = Buffer.from(JSON.stringify({
    nonce: Math.random().toString(36).slice(2),
    created_at: Date.now()
  })).toString('base64url');

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_WEB_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email',
    state
  });

  return res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/api/auth/discord/web-callback', async (req, res) => {
  try {
    const code = String(req.query?.code || '').trim();

    if (!code) {
      return res.status(400).send(renderWebAuthResultPage({
        ok: false,
        message: 'Missing Discord authorization code.'
      }));
    }

    const discordToken = await exchangeCodeWithDiscord(code, DISCORD_WEB_REDIRECT_URI);
    const discordUser = await fetchDiscordUser(discordToken.access_token);
    const dbUser = await upsertLoginUser(loginDB, discordUser);
    void broadcastUserAdministrationCounts();

    if (!dbUser.allowed) {
      return res.status(403).send(renderWebAuthResultPage({
        ok: false,
        message: `Discord user ${preferredUserName(dbUser)} is authenticated, but access is pending approval.`
      }));
    }

    const guildSyncUser = buildGuildSyncUserFromDBUser(dbUser);
    const token = await createGuildSyncJWT(guildSyncUser);

    return res.send(renderWebAuthResultPage({
      ok: true,
      token,
      user: guildSyncUser,
      message: `Logged in and authorized as ${guildSyncUser.display_name}.`
    }));
  } catch (error) {
    Log('Discord web-callback error:', error);
    return res.status(500).send(renderWebAuthResultPage({
      ok: false,
      message: error.message || 'Discord web authentication failed.'
    }));
  }
});

app.get('/api/client-download', (req, res) => {
  const platform = normalizeClientPlatform(req.query.platform || req.query.os || req.query.operating_system);

  try {
    const download = getGuildSyncClientDownload(platform);
    if (!download) {
      return res.status(404).json({ ok: false, platform, download_available: false, release_version: CURRENT_GUILDSYNC_CLIENT_VERSION, error: `GuildSync ${CURRENT_GUILDSYNC_CLIENT_VERSION} is not currently available for ${platform}.` });
    }

    return res.json({
      ok: true,
      platform,
      download,
      download_url: download?.url || '',
      download_file_name: download?.file_name || ''
    });
  } catch (error) {
    Log(`Client download lookup failed for ${platform}: ${error.message}`);
    return res.status(404).json({
      ok: false,
      platform,
      error: error.message || `No ${platform} GuildSync client download file was found.`
    });
  }
});

app.get('/api/auth/session', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, message: 'Missing session token.' });
    }

    const claims = await verifyGuildSyncSession(token);

    return res.json({
      ok: true,
      user: {
        discord_user_id: claims.sub,
        username: claims.username || '',
        global_name: claims.global_name || '',
        display_name: claims.display_name || claims.global_name || claims.username || '',
        avatar_url: claims.avatar_url || '',
        role: claims.role || 'user',
        actual_role: claims.actual_role || claims.role
      }
    });
  } catch (error) {
    return res.status(error instanceof jwt.JsonWebTokenError || error.message === 'Session was logged out.' ? 401 : 503)
      .json({ ok: false, message: 'Session could not be verified. Please retry.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const claims = await verifyGuildSyncSession(getBearerToken(req));
    roleViews.clear(roleViewSessionKey(claims));
    if (claims.jti) {
      await loginDB.execute('DELETE FROM guildsync_login_sessions WHERE session_id = ? AND discord_user_id = ?', [claims.jti, claims.sub]);
      for (const socket of io.sockets.sockets.values()) {
        if (socket.guildSyncAuthType!=='voice-mute' && socket.guildSyncSessionId === claims.jti) socket.disconnect(true);
      }
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(error instanceof jwt.JsonWebTokenError || error.message === 'Session was logged out.' ? 401 : 503)
      .json({ ok: false, message: 'Could not log out. Please retry.' });
  }
});

app.post('/api/guildsync/upload-savedvars/:kind', requireGuildSyncWebUser, async (req, res) => {
  try {
    const kind = String(req.params.kind || '').trim().toLowerCase();
    const fileName = String(req.body?.file_name || '').trim();
    const rawLuaText = String(req.body?.raw_lua_text || '').trim();

    if (!rawLuaText) {
      return res.status(400).json({ ok: false, message: 'Missing SavedVariables file content.' });
    }

    if (kind === 'banking') {
      const data = parseGuildSyncBankingSavedVarsLua(rawLuaText);
      validateEsoGuildImport('banking', data);
      const result = await insertBankingEntries(applicationDB, {
        source: data.table_name || 'GuildSyncBanking',
        uploadedBy: req.guildSyncUser.display_name || req.guildSyncUser.username || req.guildSyncUser.sub,
        entries: data.entries || []
      });

      await broadcastBankingDataUpdate();

      return res.json({
        ok: true,
        message: `Banking SavedVariables uploaded and processed. Entries: ${result.banking_entries_received}.`,
        file_name: fileName || null,
        ...result
      });
    }

    if (kind === 'roster') {
      const data = parseGuildSyncRosterSavedVarsLua(rawLuaText);
      const result = await processRosterData(applicationDB, { data });

      await broadcastRosterDataUpdate();
      await broadcastMemberLinksUpdate();

      return res.json({
        ok: true,
        message: `Roster SavedVariables uploaded and processed. Guild list members: ${result.guildlist_members_received}. Stream events: ${result.stream_events_received}.`,
        file_name: fileName || null,
        ...result
      });
    }

    return res.status(400).json({ ok: false, message: 'Upload kind must be banking or roster.' });
  } catch (error) {
    Log('SavedVariables upload failed:', error);
    return res.status(500).json({
      ok: false,
      message: error.message || 'SavedVariables upload failed.'
    });
  }
});

app.use('/downloads', express.static(GUILDSYNC_DOWNLOADS_DIR, {
  fallthrough: false,
  index: false
}));

app.use(express.static(WEB_DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return next();
  }

  return res.sendFile(path.join(WEB_DIST_DIR, 'index.html'));
});

// Authentication Middleware
io.use(async (socket, next) => {
  const auth = socket.handshake.auth || {};
  const token = auth.token;

  socket.guildSyncAuthenticated = false;
  socket.guildSyncAuthType = 'anonymous';
  socket.guildSyncUser = null;
  socket.guildSyncBot = null;

  if (auth.source === 'discord-bot') {
    const botKey = String(auth.botKey || '').trim();

    if (!botKey) {
      return next(new Error('Missing GuildSync bot socket key.'));
    }

    if (botKey !== GUILDSYNC_BOT_SOCKET_KEY) {
      return next(new Error('Invalid GuildSync bot socket key.'));
    }

    socket.guildSyncAuthenticated = true;
    socket.guildSyncAuthType = 'discord-bot';
    socket.guildSyncBot = {
      source: 'discord-bot',
      guild_id: String(auth.guildId || '').trim(),
      connected_at: new Date().toISOString()
    };

    return next();
  }

  if (!token) {
    if(auth.source==='voice-mute')return next(new Error('Discord voice login is required.'));
    socket.guildSyncAuthenticated = false;
    socket.guildSyncAuthType = 'anonymous';
    socket.guildSyncUser = null;
    return next();
  }

  try {
    if(await authenticateVoiceSocket(socket,voiceIdentityService))return next();
    const claims = await verifyGuildSyncSession(token);

    socket.guildSyncAuthenticated = true;
    socket.guildSyncAuthType = 'GuildSync user';
    socket.guildSyncSessionId = claims.jti || null;
    socket.guildSyncRoleViewId = roleViewSessionKey(claims);
    socket.guildSyncUser = {
      discord_user_id: claims.sub,
      username: claims.username,
      display_name: claims.display_name,
      avatar_url: claims.avatar_url || '',
      role: claims.role,
      actual_role: claims.actual_role
    };

    return next();
  } catch (error) {
    return next(new Error('Invalid or expired GuildSync token.'));
  }
});

const onboardingService = createDiscordOnboarding(applicationDB, {log:Log,wake:()=>io.to('GuildSyncDiscordBot').emit('guildsync:onboarding-wake')});
const voiceMuteStore = createVoiceMuteStore(applicationDB);

const userAdministration = createUserAdministration(loginDB, {log:Log,onChange:async change=>{
  Log(`GuildSync user ${change.action} by ${change.actor_id}: ${change.discord_user_id}`);
  if(change.removed || change.user?.role !== 'admin') roleViews.clearUser(change.discord_user_id);
  for(const client of io.sockets.sockets.values()) {
    if(client.guildSyncAuthType==='voice-mute'||client.guildSyncUser?.discord_user_id!==change.discord_user_id)continue;
    if(change.removed){client.emit('guildsync:account-removed');client.disconnect(true);}
    else {client.guildSyncUser.role=change.user.role;client.guildSyncUser.display_name=preferredUserName(change.user);await sendCurrentAccountProfile(client);}
  }
  await broadcastUserAdministrationCounts();
}});

async function broadcastUserAdministrationCounts() {
  try {
    const [admins]=await loginDB.execute("SELECT discord_user_id FROM guildsync_users WHERE allowed = 1 AND role = 'admin'");
    if(!admins.length)return;
    const {pending_count}=await userAdministration.pending(admins[0].discord_user_id);
    const ids=new Set(admins.map(row=>row.discord_user_id));
    for(const client of io.sockets.sockets.values())if(client.guildSyncAuthenticated&&client.guildSyncAuthType!=='discord-bot'&&client.guildSyncAuthType!=='voice-mute'&&ids.has(client.guildSyncUser?.discord_user_id))client.emit('guildsync:users-changed',{pending_count});
  }catch(error){Log('Could not refresh pending GuildSync account counts: '+error.message);}
}

async function sendCurrentAccountProfile(socket) {
  if(!socket.guildSyncAuthenticated||socket.guildSyncAuthType==='discord-bot'||socket.guildSyncAuthType==='voice-mute'||!socket.guildSyncUser?.discord_user_id)return;
  try {
    const [rows]=await loginDB.execute('SELECT discord_user_id, username, global_name, guild_member_name, email, avatar, role FROM guildsync_users WHERE discord_user_id = ? AND allowed = 1 LIMIT 1',[socket.guildSyncUser.discord_user_id]);
    if(rows[0]) {
      const profile=buildGuildSyncUserFromDBUser(rows[0]);
      profile.actual_role=profile.role;
      profile.role=roleViews.effective(socket.guildSyncRoleViewId,profile.actual_role);
      socket.guildSyncUser={...socket.guildSyncUser,...profile};
      socket.emit('guildsync:account-profile',profile);
      return profile;
    }
  }catch(error){Log('Could not load current GuildSync account profile: '+error.message);}
}

function registerVoiceForSocket(socket){
  registerVoiceMuteSocket(socket,voiceMuteStore,{
    isEnabled:()=>configurationService.view().settings.find(setting=>setting.key==='GUILDSYNC_VOICE_MUTE_ENABLED')?.value===true,
    getBot:async()=>{
      const candidate=io.sockets.sockets.get(discordBotSocketId) || [...io.sockets.sockets.values()].find(s=>s.guildSyncAuthType==='discord-bot');
      const owner=await voiceMuteStore.owner(candidate?.guildSyncBot?.guild_id);
      return io.sockets.sockets.get(owner);
    },
    authorizeUser:current=>authorizeVoiceRequester(current,{service:voiceIdentityService,loginDB,roleViews}),log:Log
  });

}
io.on('connection', (socket) => {
  if(registerVoiceOnlyConnection(socket,registerVoiceForSocket))return;
  registerDiscordGuildOrigin(socket, Log);
  registerCommunityStatisticsSocket(socket,{
    db:applicationDB,loadBanking:getBankingDataJSON,
    loadWindows:async(db,time)=>(await getActiveRaffleSummary(db,time)).raffles,
    authorizeViewer:async current=>{
      const [rows]=await loginDB.execute('SELECT role,allowed FROM guildsync_users WHERE discord_user_id=? LIMIT 1',[current.guildSyncUser.discord_user_id]);
      return Number(rows[0]?.allowed)===1 && ['viewer','user','admin'].includes(roleViews.effective(current.guildSyncRoleViewId,rows[0]?.role)||rows[0]?.role);
    }
  });
  registerRolePermissions(socket,loginDB,roleViews);
  registerRoleViewSocket(socket,roleViews,async()=>{
    let profile;
    for(const client of io.sockets.sockets.values()) if(client.guildSyncRoleViewId === socket.guildSyncRoleViewId) {
      const updated=await sendCurrentAccountProfile(client);if(client === socket)profile=updated;
    }
    return profile;
  });
  registerUserAdministrationSocket(socket,userAdministration);
  void sendCurrentAccountProfile(socket);
  registerConfigurationSocket(socket,configurationService,{
    authorizeViewer: async id => {const [rows]=await loginDB.execute('SELECT discord_user_id FROM guildsync_users WHERE discord_user_id = ? AND allowed = 1 LIMIT 1',[id]);return rows.length>0;},
    authorizeAdmin: async id => {const [rows]=await loginDB.execute('SELECT role FROM guildsync_users WHERE discord_user_id = ? AND allowed = 1 LIMIT 1',[id]);return rows[0]?.role==='admin';},
    broadcast: (configuration,payload) => {io.to('GuildSyncDiscordBot').emit('guildsync:configuration-updated',configuration);if(Object.keys(payload?.changes||{}).some(key=>key.startsWith('GUILDSYNC_VOICE_MUTE_')))io.to('GuildSyncClientAuthenticated').to('GuildSyncVoiceClient').emit('guildsync:voice-mute-access-changed');}
  });
  registerDiscordOnboardingSocket(socket, onboardingService);
  registerVoiceForSocket(socket);
  registerRaffleSocket(socket, applicationDB, getActiveRaffleSummary, getRaffleUserTickets);
  registerArchiveSocket(socket, applicationDB);
  registerRaffleManagementSocket(socket, applicationDB, { sheets: sheetsRuntime });
  registerRaffleRefreshSocket(socket, applicationDB, { getRaffleRefreshSelection, getBankingDataJSON,
    historical:createHistoricalRaffles(applicationDB,{currentSelection:()=>getRaffleRefreshSelection()}) });

  const user = socket.guildSyncUser;

  if (socket.guildSyncAuthType !== 'discord-bot') {
    socket.join('GuildSyncClient');

    if (socket.guildSyncAuthenticated && user) {
      socket.join('GuildSyncClientAuthenticated');

      if (user.discord_user_id) {
        socket.join(String(user.discord_user_id));
      }
    } else {
      socket.join('GuildSyncClientUnauthenticated');
    }
  }

  if (socket.guildSyncAuthType === 'discord-bot') {
    Log(`Connection: ${socket.id} => Discord bot`);
    discordBotConnected = true;
    discordBotSocketId = socket.id;
    discordBotConnectedAt = new Date().toISOString();
    socket.join('GuildSyncDiscordBot');

  } else if (socket.guildSyncAuthenticated && user) {
    Log(`Connection: ${socket.id} => ${user.display_name} (${user.discord_user_id}) GuildSync User`);
  } else {
    Log(`Connection: ${socket.id} => Unauthenticated`);
  }

  socket.on('guildsync:upload-savedvars-raw', async (payload = {}, callback) => {
    try {
      if (!socket.guildSyncAuthenticated || !socket.guildSyncUser || socket.guildSyncAuthType === 'discord-bot') {
        sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
          ok: false,
          message: 'You must be logged in to upload GuildSync SavedVariables files.'
        });
        return;
      }

      const fileName = path.basename(String(payload.file_name || payload.fileName || '').trim());
      const rawLuaText = String(payload.raw_lua_text || payload.rawLuaText || '').trim();
      const source = String(payload.source || 'web-drag-drop').trim() || 'web-drag-drop';
      const allowedFiles = new Set(['GuildSyncBanking.lua', 'GuildSyncRoster.lua', 'GuildSyncApplications.lua']);

      if (!allowedFiles.has(fileName)) {
        sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
          ok: false,
          message: `Unsupported file: ${fileName || 'unknown file'}. Drop only GuildSyncBanking.lua, GuildSyncRoster.lua, or GuildSyncApplications.lua.`
        });
        return;
      }

      if (!rawLuaText) {
        sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
          ok: false,
          message: `${fileName} did not contain any SavedVariables content.`
        });
        return;
      }

      Log(`Raw SavedVariables upload received from web user ${socket.guildSyncUser.display_name || socket.guildSyncUser.discord_user_id}: ${fileName}.`);

      if (fileName === 'GuildSyncBanking.lua') {
        const data = parseGuildSyncBankingSavedVarsLua(rawLuaText);
        validateEsoGuildImport('banking', data);
        const result = await insertBankingEntries(applicationDB, {
          source: data.table_name || 'GuildSyncBanking',
          uploadedBy: socket.guildSyncUser.display_name || socket.guildSyncUser.username || socket.guildSyncUser.discord_user_id,
          entries: data.entries || []
        });

        await broadcastBankingDataUpdate();

        sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
          ok: true,
          kind: 'banking',
          file_name: fileName,
          message: `GuildSyncBanking.lua uploaded and processed. Entries: ${result.banking_entries_received}.`,
          ...result
        });
        return;
      }

      if (fileName === 'GuildSyncRoster.lua') {
        const data = parseGuildSyncRosterSavedVarsLua(rawLuaText);
        const result = await processRosterData(applicationDB, { data });

        await broadcastRosterDataUpdate();
        await broadcastMemberLinksUpdate();

        sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
          ok: true,
          kind: 'roster',
          file_name: fileName,
          message: `GuildSyncRoster.lua uploaded and processed. Guild list members: ${result.guildlist_members_received}. Stream events: ${result.stream_events_received}.`,
          ...result
        });
        return;
      }

      if (fileName === 'GuildSyncApplications.lua') {
        const data = parseGuildSyncApplicationsSavedVarsLua(rawLuaText);
        const incomingRecords = collectGuildSyncApplicationRecords({
          source,
          file_name: fileName,
          records: data.records || []
        });

        validateEsoGuildImport('applications', {records: incomingRecords});
        const recordsForGuild = incomingRecords.filter(record => {
          const guildID = String(record.guildId || record.guild_id || '').trim();
          return guildID === GUILDSYNC_APPLICATIONS_GUILD_ID;
        });

        if (!recordsForGuild.length) {
          sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
            ok: false,
            kind: 'applications',
            file_name: fileName,
            message: `No application records matched guild ID ${GUILDSYNC_APPLICATIONS_GUILD_ID}.`,
            records_received: incomingRecords.length,
            records_skipped: incomingRecords.length
          });
          return;
        }

        const result = await recordGuildSyncApplications(applicationDB, recordsForGuild);
        const broadcastResult = await broadcastPendingGuildSyncApplications();

        sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
          ok: true,
          kind: 'applications',
          file_name: fileName,
          message: `GuildSyncApplications.lua uploaded and processed. Records: ${result.inserted}. Discord broadcasted: ${broadcastResult.sent}.`,
          records_received: incomingRecords.length,
          records_matched_guild: recordsForGuild.length,
          records_recorded: result.inserted,
          records_skipped: result.skipped + (incomingRecords.length - recordsForGuild.length),
          discord_broadcasted: broadcastResult.sent,
          discord_failed: broadcastResult.failed,
          at: new Date().toLocaleString()
        });
      }
    } catch (error) {
      Log(`Raw SavedVariables upload failed: ${error.message}`);
      sendSocketResponse(socket, 'guildsync:upload-savedvars-raw-result', callback, {
        ok: false,
        message: error.message || 'SavedVariables upload failed.'
      });
    }
  });


  socket.on('guildsync:gsa-post-application', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      sendSocketResponse(socket, 'guildsync:gsa-post-application-result', callback, {
        ok: false,
        message: 'Only the authenticated Discord bot can request an application repost.',
        at: new Date().toLocaleString()
      });
      return;
    }

    try {
      const applicantSearch = String(payload?.applicant_account || payload?.applicantAccount || payload?.name || '').trim();

      if (!applicantSearch) {
        throw new Error('Applicant account name is required.');
      }

      const records = await getGuildSyncApplicationsByApplicantSearch(applicationDB, applicantSearch);

      if (!records.length) {
        sendSocketResponse(socket, 'guildsync:gsa-post-application-result', callback, {
          ok: false,
          message: `No GuildSync application records were found matching ${applicantSearch}.`,
          applicant_account: applicantSearch,
          match_count: 0,
          posted: 0,
          failed: 0,
          at: new Date().toLocaleString()
        });
        return;
      }

      const botSocket = discordBotSocketId ? io.sockets.sockets.get(discordBotSocketId) : null;

      if (!botSocket?.connected) {
        discordBotConnected = false;
        discordBotSocketId = null;
        throw new Error('The GuildSync Discord bot is not connected. Applications were not posted.');
      }

      Log(`Manual GSA application repost requested for ${records.length} record(s) matching "${applicantSearch}" by Discord bot command.`);

      let posted = 0;
      let failed = 0;
      const postedAccounts = [];
      const failedAccounts = [];

      for (const record of records) {
        const botResponse = await emitToSocketWithAck(
          botSocket,
          'guildsync:eso-guild-application-message',
          {
            source: 'guildsync-backend-server:gsa-command',
            applicantAccount: record.applicant_account,
            capturedAt: record.application_timestamp,
            officerAccount: record.officer_processing,
            action: record.application_action,
            applicationText: record.application_text,
            declineMessage: record.decline_message,
            blacklistMessage: record.blacklist_message,
            message: buildGuildSyncApplicationDiscordMessage(record)
          },
          30000
        );

        if (botResponse?.ok) {
          await markGuildSyncApplicationRecordBroadcasted(applicationDB, record.applicant_account, record.application_timestamp);
          posted += 1;
          postedAccounts.push(record.applicant_account);
        } else {
          failed += 1;
          failedAccounts.push(record.applicant_account);
          Log(`Manual GSA application repost failed for ${record.applicant_account}: ${botResponse?.message || 'Unknown error'}`);
        }
      }

      sendSocketResponse(socket, 'guildsync:gsa-post-application-result', callback, {
        ok: posted > 0,
        message: failed > 0
          ? `Posted ${posted}/${records.length} GuildSync application record(s) matching ${applicantSearch}. Failed: ${failed}.`
          : `Posted ${posted} GuildSync application record(s) matching ${applicantSearch}.`,
        applicant_account: applicantSearch,
        match_count: records.length,
        posted,
        failed,
        posted_accounts: postedAccounts,
        failed_accounts: failedAccounts,
        discord_broadcast: posted > 0 ? 1 : 0,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log(`Manual GSA application repost failed: ${error.message}`);

      sendSocketResponse(socket, 'guildsync:gsa-post-application-result', callback, {
        ok: false,
        message: error.message || 'Manual GSA application repost failed.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:eso-guild-application-message', async (payload = {}, callback) => {
    try {
      const source = String(payload?.source || 'unknown source').trim() || 'unknown source';
      const fileName = String(payload?.file_name || payload?.fileName || '').trim();
      const recordKey = String(payload?.recordKey || payload?.record_key || '').trim();
      const incomingRecords = collectGuildSyncApplicationRecords(payload);

      Log(
        `ESO guild application payload received from ${source}${fileName ? ` for ${fileName}` : ''}${recordKey ? ` record ${recordKey}` : ''}. Records: ${incomingRecords.length}.`
      );

      validateEsoGuildImport('applications', {records: incomingRecords});
      const recordsForGuild = incomingRecords.filter(record => {
        const guildID = String(record.guildId || record.guild_id || '').trim();
        return guildID === GUILDSYNC_APPLICATIONS_GUILD_ID;
      });

      Log(
        `ESO guild application records matched guild ${GUILDSYNC_APPLICATIONS_GUILD_ID}: ${recordsForGuild.length}/${incomingRecords.length}.`
      );

      if (!recordsForGuild.length) {
        const skipped = incomingRecords.length;
        const response = {
          ok: false,
          message: `No application records matched guild ID ${GUILDSYNC_APPLICATIONS_GUILD_ID}.`,
          records_received: incomingRecords.length,
          records_skipped: skipped,
          at: new Date().toLocaleString()
        };

        Log(
          `ESO guild application payload rejected. No records matched guild ${GUILDSYNC_APPLICATIONS_GUILD_ID}. Skipped: ${skipped}.`
        );

        sendSocketResponse(socket, 'guildsync:eso-guild-application-message-result', callback, response);
        return;
      }

      const result = await recordGuildSyncApplications(applicationDB, recordsForGuild);

      Log(
        `ESO guild application database write complete. Inserted/updated: ${result.inserted}. Skipped: ${result.skipped}.`
      );

      const broadcastResult = await broadcastPendingGuildSyncApplications();

      Log(
        `ESO guild application Discord broadcast pass complete. Broadcasted: ${broadcastResult.sent}. Failed: ${broadcastResult.failed}.`
      );

      const response = {
        ok: true,
        message: 'ESO guild application records processed.',
        records_received: incomingRecords.length,
        records_matched_guild: recordsForGuild.length,
        records_recorded: result.inserted,
        records_skipped: result.skipped + (incomingRecords.length - recordsForGuild.length),
        discord_broadcasted: broadcastResult.sent,
        discord_failed: broadcastResult.failed,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:eso-guild-application-message-result', callback, response);
    } catch (error) {
      Log(`ESO guild application processing failed: ${error.message}`);

      sendSocketResponse(socket, 'guildsync:eso-guild-application-message-result', callback, {
        ok: false,
        message: error.message || 'ESO guild application processing failed.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:sending-discord-roles', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can send Discord roles.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-roles-result', callback, response);
      return;
    }

    try {
      const result = await upsertDiscordRoles(applicationDB, payload);

      Log(
        `Received Discord roles: ${result.roles_processed} role(s) processed.`
      );

      const response = {
        ok: true,
        message: 'Discord roles received and saved.',
        roles_processed: result.roles_processed,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-roles-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:sending-discord-roles payload:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to process Discord roles payload.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-roles-result', callback, response);
    }
  });

  socket.on('guildsync:sending-discord-members', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can send Discord members.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-members-result', callback, response);
      return;
    }

    try {
      const result = await upsertDiscordMembers(applicationDB, {
        ...payload,
        source: payload.source || 'bulk_sync'
      });

      Log(
        `Received Discord members: ${result.members_processed} member(s) processed. ${result.members_removed} member(s) removed.`
      );

      const response = {
        ok: true,
        message: 'Discord members received and saved.',
        members_processed: result.members_processed,
        members_removed: result.members_removed,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-members-result', callback, response);

      await broadcastDiscordMemberDataUpdate();
      await broadcastMemberLinksUpdate();
    } catch (error) {
      Log('Failed to process guildsync:sending-discord-members payload:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to process Discord members payload.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-members-result', callback, response);
    }
  });

  socket.on('guildsync:discord-member-upsert', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can upsert Discord members.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-upsert-result', callback, response);
      return;
    }

    try {
      const result = await upsertDiscordMember(applicationDB, {
        ...(payload.member || payload),
        source: payload.source || 'live_event',
        initiator: payload.initiator || payload.member?.initiator || ''
      });

      Log(
        `Discord member upsert received: ${result.members_processed} member(s) processed.`
      );

      const response = {
        ok: true,
        message: 'Discord member saved.',
        members_processed: result.members_processed,
        member_roles_processed: result.member_roles_processed,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-upsert-result', callback, response);

      await broadcastDiscordMemberDataUpdate();
      await broadcastMemberLinksUpdate();
    } catch (error) {
      Log('Failed to process guildsync:discord-member-upsert payload:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to upsert Discord member.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-upsert-result', callback, response);
    }
  });

  socket.on('guildsync:discord-member-last-seen', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can update Discord member last-seen activity.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-last-seen-result', callback, response);
      return;
    }

    try {
      Log(
        `Discord member activity payload received: discord_id=${payload.discord_id || 'missing'}, username=${payload.username || 'missing'}, timestamp=${payload.timestamp || 'missing'}, action=${payload.action || 'missing'}.`
      );

      const result = await updateDiscordMemberLastSeen(applicationDB, payload);

      Log(
        `Discord member activity received: ${payload.username || payload.discord_id || 'unknown'} ${payload.action || 'unknown'} at ${payload.timestamp || 'unknown'}. Updated ${result.updated} row(s).`
      );

      const response = {
        ok: true,
        message: result.updated > 0 ? 'Discord member last-seen activity saved.' : 'Discord member was not found; no last-seen row updated.',
        updated: result.updated,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-last-seen-result', callback, response);

      if (result.updated > 0) {
        await broadcastDiscordMemberDataUpdate();
      }
    } catch (error) {
      Log('Failed to process guildsync:discord-member-last-seen payload:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to update Discord member last-seen activity.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-last-seen-result', callback, response);
    }
  });

  socket.on('guildsync:discord-historical-scan-status', async (payload = {}, callback) => {
    Log(`Discord historical scan status request received from socket ${socket.id}. Auth type: ${socket.guildSyncAuthType || 'unknown'}.`);

    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can request Discord historical scan status.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-historical-scan-status-result', callback, response);
      return;
    }

    try {
      const status = await getDiscordHistoricalScanStatus(applicationDB);

      Log(
        `Discord historical scan status returned to bot: completed=${status.completed ? 'yes' : 'no'}, completed_at=${status.completed_at || 'not set'}.`
      );

      sendSocketResponse(socket, 'guildsync:discord-historical-scan-status-result', callback, {
        ok: true,
        ...status,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:discord-historical-scan-status:', error);

      sendSocketResponse(socket, 'guildsync:discord-historical-scan-status-result', callback, {
        ok: false,
        message: error.message || 'Failed to get Discord historical scan status.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:discord-historical-scan-complete', async (payload = {}, callback) => {
    Log(
      `Discord historical scan completion received from socket ${socket.id}. Messages checked: ${payload.message_count ?? 'unknown'}. Members updated: ${payload.member_count ?? 'unknown'}.`
    );

    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can mark Discord historical scan complete.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-historical-scan-complete-result', callback, response);
      return;
    }

    try {
      const result = await markDiscordHistoricalScanComplete(applicationDB, payload);

      Log(
        `Discord historical scan marked complete in database. Completed at: ${result.completed_at || 'unknown'}. Messages checked: ${result.message_count ?? payload.message_count ?? 'unknown'}. Members updated: ${result.member_count ?? payload.member_count ?? 'unknown'}.`
      );

      sendSocketResponse(socket, 'guildsync:discord-historical-scan-complete-result', callback, {
        ok: true,
        message: 'Discord historical scan marked complete.',
        ...result,
        at: new Date().toLocaleString()
      });

      await broadcastDiscordMemberDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:discord-historical-scan-complete:', error);

      sendSocketResponse(socket, 'guildsync:discord-historical-scan-complete-result', callback, {
        ok: false,
        message: error.message || 'Failed to mark Discord historical scan complete.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:discord-member-delete', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can delete Discord members.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-delete-result', callback, response);
      return;
    }

    try {
      const result = await deleteDiscordMember(applicationDB, {
        discord_id: payload.discord_id || payload.id,
        source: payload.source || 'live_event'
      });

      Log(
        `Discord member delete received: ${result.members_removed} member(s) removed.`
      );

      const response = {
        ok: true,
        message: 'Discord member deleted.',
        members_removed: result.members_removed,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-delete-result', callback, response);

      await broadcastDiscordMemberDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:discord-member-delete payload:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to delete Discord member.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-delete-result', callback, response);
    }
  });

  socket.on('guildsync:discord-role-upsert', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can upsert Discord roles.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-role-upsert-result', callback, response);
      return;
    }

    try {
      const result = await upsertDiscordRole(applicationDB, payload.role || payload);

      Log(
        `Discord role upsert received: ${result.roles_processed} role(s) processed.`
      );

      const response = {
        ok: true,
        message: 'Discord role saved.',
        roles_processed: result.roles_processed,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-role-upsert-result', callback, response);

      await broadcastDiscordMemberDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:discord-role-upsert payload:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to upsert Discord role.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-role-upsert-result', callback, response);
    }
  });

  socket.on('guildsync:discord-role-delete', async (payload = {}, callback) => {
    if (socket.guildSyncAuthType !== 'discord-bot') {
      const response = {
        ok: false,
        message: 'Only the authenticated Discord bot can delete Discord roles.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-role-delete-result', callback, response);
      return;
    }

    try {
      const result = await deleteDiscordRole(applicationDB, payload.role_id || payload.id);

      Log(
        `Discord role delete received: ${result.roles_removed} role(s) removed.`
      );

      const response = {
        ok: true,
        message: 'Discord role deleted.',
        roles_removed: result.roles_removed,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-role-delete-result', callback, response);

      await broadcastDiscordMemberDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:discord-role-delete payload:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to delete Discord role.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-role-delete-result', callback, response);
    }
  });

  socket.on('guildsync:sending-banking-data', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to send banking data.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-data-result', callback, response);

      await broadcastBankingDataUpdate();
      return;
    }

    try {
      validateEsoGuildImport('banking', payload);
      const authenticatedUsername = String(
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.guild_member_name ||
        socket.guildSyncUser.username ||
        socket.guildSyncUser.discord_user_id ||
        ''
      ).trim();

      const entries = Array.isArray(payload?.data?.entries)
        ? payload.data.entries
        : Array.isArray(payload.entries)
          ? payload.entries
          : Array.isArray(payload.data)
            ? payload.data
            : [];

      const fileName = String(payload.file_name || '').trim();

      const dataSource = String(
        payload?.data?.table_name ||
        payload.source ||
        'GuildSyncBanking'
      ).trim();

      Log(
        `Banking data received from ${authenticatedUsername || 'unknown user'}${fileName ? ` for ${fileName}` : ''}. Entries: ${entries.length}.`
      );

      const applicationDB = await openAppDataDB();

      const result = await insertBankingEntries(applicationDB, {
        source: dataSource,
        uploadedBy: authenticatedUsername,
        entries
      });

      const response = {
        ok: true,
        message: 'Banking data processed by GuildSync backend.',
        received: true,
        received_from: authenticatedUsername,
        file_name: fileName || null,
        data_source: dataSource,
        entries_count: entries.length,
        ...result,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-data-result', callback, response);
    } catch (error) {
      Log(`Banking data processing failed: ${error.message}`);

      const response = {
        ok: false,
        message: error.code === 'ESO_GUILD_ORIGIN' ? error.message : 'Banking data processing failed.',
        error: error.message,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-data-result', callback, response);
    }
  });

  socket.on('guildsync:sending-roster-data', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to send roster data.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-data-result', callback, response);
      return;
    }

    try {
      const authenticatedUsername = String(
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.guild_member_name ||
        socket.guildSyncUser.username ||
        socket.guildSyncUser.discord_user_id ||
        ''
      ).trim();

      let data = payload?.data && typeof payload.data === 'object'
        ? payload.data
        : payload;

      if (payload?.raw_lua_text) {
        data = parseGuildSyncRosterSavedVarsLua(String(payload.raw_lua_text || ''));
      }

      const guildMembers = data?.guildList?.guildListMembers && typeof data.guildList.guildListMembers === 'object'
        ? Object.keys(data.guildList.guildListMembers).length
        : 0;

      const rosterEvents = data?.rosterEvents && typeof data.rosterEvents === 'object'
        ? Object.keys(data.rosterEvents).length
        : 0;

      const fileName = String(payload.file_name || '').trim();

      Log(
        `Roster data received from ${authenticatedUsername || 'unknown user'}${fileName ? ` for ${fileName}` : ''}. Guild list members: ${guildMembers}. Stream events: ${rosterEvents}.`
      );

      const applicationDB = await openAppDataDB();
      const result = await processRosterData(applicationDB, { data });

      const response = {
        ok: true,
        message: 'Roster data processed by GuildSync backend.',
        received: true,
        received_from: authenticatedUsername,
        file_name: fileName || null,
        ...result,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-data-result', callback, response);
      await broadcastRosterDataUpdate();
      await broadcastMemberLinksUpdate();
    } catch (error) {
      Log(`Roster data processing failed: ${error.message}`);

      const response = {
        ok: false,
        message: error.code === 'ESO_GUILD_ORIGIN' ? error.message : 'Roster data processing failed.',
        error: error.message,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-data-result', callback, response);
    }
  });



  socket.on('guildsync:client-version', (payload = {}) => {
    const clientVersion = String(payload.version || '').trim();
    const clientPlatform = normalizeClientPlatform(payload.platform || payload.os || payload.operating_system);
    const download = getGuildSyncClientDownload(clientPlatform);
    const updateRequired = Boolean(download) && isVersionLower(clientVersion, download.version);

    socket.emit('guildsync:version-status', {
      ok: true,
      client_version: clientVersion,
      latest_version: download?.version || null,
      release_version: CURRENT_GUILDSYNC_CLIENT_VERSION,
      download_available: Boolean(download),
      update_required: updateRequired,
      platform: clientPlatform,
      download,
      download_url: download?.url || '',
      download_file_name: download?.file_name || '',
      message: !download
        ? `GuildSync ${CURRENT_GUILDSYNC_CLIENT_VERSION} download is not currently available for ${clientPlatform}.`
        : updateRequired
        ? `GuildSync ${clientVersion || 'unknown'} is out of date. Latest version is ${CURRENT_GUILDSYNC_CLIENT_VERSION}.`
        : `GuildSync ${clientVersion || 'unknown'} is current.`
    });
  });

  socket.on('guildsync:request-discord-data-refresh', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to refresh Discord data.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-data-refresh-result', callback, response);
      return;
    }

    if (!discordBotSocketId) {
      const response = {
        ok: false,
        message: 'The GuildSync Discord bot is not connected, so Discord data cannot be refreshed.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-data-refresh-result', callback, response);
      return;
    }

    const botSocket = io.sockets.sockets.get(discordBotSocketId);

    if (!botSocket?.connected) {
      discordBotConnected = false;
      discordBotSocketId = null;

      const response = {
        ok: false,
        message: 'The GuildSync Discord bot connection is no longer active.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-data-refresh-result', callback, response);
      return;
    }

    try {
      const requestorName = socket.guildSyncUser.display_name || socket.guildSyncUser.username || socket.guildSyncUser.discord_user_id;

      Log(
        `Discord data refresh requested by ${requestorName}. Forwarding request to Discord bot.`
      );

      emitDiscordRefreshStatus(
        `Discord data refresh requested by ${requestorName}. Waiting for the Discord bot to sync roles and members.`
      );

      const botResponse = await emitToSocketWithAck(
        botSocket,
        'guildsync:request-discord-sync',
        {
          requested_by: socket.guildSyncUser.discord_user_id,
          requested_by_name: socket.guildSyncUser.display_name || socket.guildSyncUser.username || '',
          requested_at: new Date().toISOString()
        },
        180000
      );

      if (!botResponse?.ok) {
        throw new Error(botResponse?.message || 'The Discord bot failed to refresh Discord data.');
      }

      emitDiscordRefreshStatus(
        `Discord bot sync completed. Roles: ${botResponse.roles_processed || 0}, Members: ${botResponse.members_processed || 0}, Removed: ${botResponse.members_removed || 0}. Loading updated data.`
      );

      const response = {
        ok: true,
        message: 'Discord data refresh completed.',
        roles_processed: botResponse.roles_processed || 0,
        members_processed: botResponse.members_processed || 0,
        members_removed: botResponse.members_removed || 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-data-refresh-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-discord-data-refresh:', error);

      emitDiscordRefreshStatus(
        error.message || 'Discord data refresh failed.'
      );

      const response = {
        ok: false,
        message: error.message || 'Failed to refresh Discord data.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-data-refresh-result', callback, response);
    }
  });

  socket.on('guildsync:request-discord-data-date', async (payload = {}, callback) => {
    try {
      const result = await getDiscordDataDate(applicationDB);

      const response = {
        ok: true,
        message: 'Discord refresh date retrieved.',
        data: result?.data || 'discord_refresh',
        value: result?.value || null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-data-date-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-discord-data-date:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve Discord refresh date.',
        data: 'discord_refresh',
        value: null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-data-date-result', callback, response);
    }
  });


  socket.on('guildsync:request-banking-data', async (payload = {}, callback) => {
    try {
      const bonusSettings = await getRaffleBonusSettings(applicationDB);
      const bonusVersions = await getRaffleBonusVersions(applicationDB);
      const [entries, refreshDate, bonusRaffles] = await Promise.all([
        getBankingDataJSON(applicationDB, bonusVersions),
        getBankingDataDate(applicationDB),
        getRaffleBonusChoices(applicationDB, bonusVersions)
      ]);

      const response = {
        ok: true,
        message: 'Banking data retrieved.',
        entries,
        bonusSettings,
        bonusRaffles,
        entries_returned: entries.length,
        last_refresh: refreshDate?.value || null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-data-request-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-banking-data:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve banking data.',
        entries: [],
        entries_returned: 0,
        last_refresh: null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-data-request-result', callback, response);
    }
  });

  socket.on('guildsync:save-raffle-bonus-settings', async (payload = {}, callback) => {
    try {
      if (!socket.guildSyncAuthenticated || !socket.guildSyncUser?.discord_user_id ||
          socket.guildSyncAuthType === 'discord-bot') {
        throw new Error('Admin access is required to change raffle bonuses.');
      }
      const [admins] = await loginDB.execute(
        'SELECT role FROM guildsync_users WHERE discord_user_id = ? AND allowed = 1 LIMIT 1',
        [socket.guildSyncUser.discord_user_id]
      );
      if (admins[0]?.role !== 'admin') {
        throw new Error('Admin access is required to change raffle bonuses.');
      }
      if (payload.raffleType) {
        await saveRaffleBonusOverride(applicationDB, payload);
      } else {
        await saveRaffleBonusSettings(applicationDB, payload);
      }
      const bonusSettings = await getRaffleBonusSettings(applicationDB);
      sendSocketResponse(socket, 'guildsync:raffle-bonus-settings-result', callback, { ok: true, bonusSettings });
      await broadcastBankingDataUpdate();
    } catch (error) {
      sendSocketResponse(socket, 'guildsync:raffle-bonus-settings-result', callback,
        { ok: false, message: error.message || 'Could not save raffle bonus settings.' });
    }
  });


  socket.on('guildsync:checkout-deposit-mail', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser || socket.guildSyncAuthType === 'discord-bot') {
      const response = {
        ok: false,
        message: 'You must be logged in from the GuildSync desktop client to check out deposit mail.',
        records: [],
        records_checked_out: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:checkout-deposit-mail-result', callback, response);
      return;
    }

    try {
      const checkedOutBy = String(
        socket.guildSyncUser.discord_user_id ||
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.username ||
        ''
      ).trim();

      const checkedOutByName = String(
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.username ||
        socket.guildSyncUser.discord_user_id ||
        ''
      ).trim();

      Log(`Deposit mail checkout requested by ${checkedOutByName || checkedOutBy || 'unknown user'}.`);

      const result = await checkoutDepositMail(applicationDB, {
        ...payload,
        checked_out_by: checkedOutBy
      });

      const response = {
        ok: true,
        message: result.records_checked_out > 0
          ? `Checked out ${result.records_checked_out} deposit mail record(s).`
          : 'No unsent deposit mail records are available to check out.',
        ...result,
        checked_out_by_name: checkedOutByName || null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:checkout-deposit-mail-result', callback, response);
      await broadcastBankingDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:checkout-deposit-mail:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to check out deposit mail.',
        records: [],
        records_checked_out: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:checkout-deposit-mail-result', callback, response);
    }
  });

  socket.on('guildsync:mark-deposit-mail-written-to-eso', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser || socket.guildSyncAuthType === 'discord-bot') {
      const response = {
        ok: false,
        message: 'You must be logged in from the GuildSync desktop client to mark deposit mail written to ESO.',
        records: [],
        records_written_to_eso: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:mark-deposit-mail-written-to-eso-result', callback, response);
      return;
    }

    try {
      const checkedOutBy = String(
        socket.guildSyncUser.discord_user_id ||
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.username ||
        ''
      ).trim();

      const checkedOutByName = String(
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.username ||
        socket.guildSyncUser.discord_user_id ||
        ''
      ).trim();

      Log(`Deposit mail written-to-ESO confirmation received from ${checkedOutByName || checkedOutBy || 'unknown user'}.`);

      const result = await markDepositMailWrittenToESO(applicationDB, {
        ...payload,
        checked_out_by: checkedOutBy
      });

      const response = {
        ok: true,
        message: result.records_written_to_eso > 0
          ? `Marked ${result.records_written_to_eso} deposit mail record(s) as written to ESO.`
          : 'No checked out deposit mail records were updated.',
        ...result,
        checked_out_by_name: checkedOutByName || null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:mark-deposit-mail-written-to-eso-result', callback, response);
      await broadcastBankingDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:mark-deposit-mail-written-to-eso:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to mark deposit mail written to ESO.',
        records: [],
        records_written_to_eso: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:mark-deposit-mail-written-to-eso-result', callback, response);
    }
  });


  socket.on('guildsync:mark-deposit-mail-sent', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser || socket.guildSyncAuthType === 'discord-bot') {
      const response = {
        ok: false,
        message: 'You must be logged in from the GuildSync desktop client to mark deposit mail sent.',
        records: [],
        records_marked_sent: 0,
        records_confirmed_sent: 0,
        mail_request_ids: [],
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:mark-deposit-mail-sent-result', callback, response);
      return;
    }

    try {
      const checkedOutBy = String(
        socket.guildSyncUser.discord_user_id ||
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.username ||
        ''
      ).trim();

      const checkedOutByName = String(
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.username ||
        socket.guildSyncUser.discord_user_id ||
        ''
      ).trim();

      Log(`Deposit mail sent acknowledgement received from ${checkedOutByName || checkedOutBy || 'unknown user'}.`);

      const result = await markDepositMailSent(applicationDB, {
        ...payload,
        checked_out_by: checkedOutBy
      });

      const response = {
        ok: true,
        message: result.records_confirmed_sent > 0
          ? `Confirmed ${result.records_confirmed_sent} deposit mail acknowledgement(s) as sent.`
          : 'No matching checked_out, written_to_eso, or already sent deposit mail acknowledgements were confirmed.',
        ...result,
        checked_out_by_name: checkedOutByName || null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:mark-deposit-mail-sent-result', callback, response);
      await broadcastBankingDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:mark-deposit-mail-sent:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to mark deposit mail sent.',
        records: [],
        records_marked_sent: 0,
        records_confirmed_sent: 0,
        mail_request_ids: [],
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:mark-deposit-mail-sent-result', callback, response);
    }
  });


  socket.on('guildsync:add-manual-biweekly-ticket-entry', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to add manual ticket entries.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:manual-biweekly-ticket-result', callback, response);
      return;
    }

    try {
      const addedBy = socket.guildSyncUser.display_name
        || socket.guildSyncUser.global_name
        || socket.guildSyncUser.username
        || socket.guildSyncUser.discord_user_id
        || 'Unknown';

      const result = await addManualBiweeklyTicketEntry(applicationDB, {
        ...payload,
        addedBy
      });

      await broadcastBankingDataUpdate();

      const response = {
        ok: true,
        message: 'Manual ticket entry added.',
        ...result,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:manual-biweekly-ticket-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:add-manual-biweekly-ticket-entry:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to add manual ticket entry.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:manual-biweekly-ticket-result', callback, response);
    }
  });


  socket.on('guildsync:move-banking-entry', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to move banking entries.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:move-banking-entry-result', callback, response);
      return;
    }

    try {
      const movedBy = socket.guildSyncUser.display_name
        || socket.guildSyncUser.global_name
        || socket.guildSyncUser.username
        || socket.guildSyncUser.discord_user_id
        || 'Unknown';

      const result = await moveBankingEntry(applicationDB, {
        ...payload,
        movedBy
      });

      await broadcastBankingDataUpdate();

      const response = {
        ok: true,
        message: 'Banking entry moved.',
        ...result,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:move-banking-entry-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:move-banking-entry:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to move banking entry.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:move-banking-entry-result', callback, response);
    }
  });

  socket.on('guildsync:request-associate-ticket-report', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to run this report.',
        rows: [],
        rows_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:associate-ticket-report-result', callback, response);
      return;
    }

    try {
      const rows = await getAssociateTicketReport(applicationDB);
      const response = {
        ok: true,
        message: 'Associates promotion eligible report complete.',
        rows,
        rows_returned: rows.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:associate-ticket-report-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-associate-ticket-report:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to run Associates Promotion Eligible report.',
        rows: [],
        rows_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:associate-ticket-report-result', callback, response);
    }
  });


  socket.on('guildsync:request-discord-rank-audit-report', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to run this report.',
        rows: [],
        rows_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-rank-audit-report-result', callback, response);
      return;
    }

    try {
      const rows = await getDiscordRankAuditReport(applicationDB);
      const response = {
        ok: true,
        message: 'Discord rank audit report complete.',
        rows,
        rows_returned: rows.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-rank-audit-report-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-discord-rank-audit-report:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to run Discord Rank Audit report.',
        rows: [],
        rows_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-rank-audit-report-result', callback, response);
    }
  });


  socket.on('guildsync:request-roster-data', async (payload = {}, callback) => {
    try {
      const [members, refreshDate] = await Promise.all([
        getRosterDataJSON(applicationDB),
        getRosterDataDate(applicationDB)
      ]);

      const response = {
        ok: true,
        message: 'Roster data retrieved.',
        members,
        members_returned: members.length,
        last_refresh: refreshDate?.value || null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-data-request-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-roster-data:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve roster data.',
        members: [],
        members_returned: 0,
        last_refresh: null,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-data-request-result', callback, response);
    }
  });


  socket.on('guildsync:request-roster-member-notes', async (payload = {}, callback) => {
    try {
      const accountName = String(payload.account_name || payload.accountName || '').trim();
      const notes = await getRosterMemberNotes(applicationDB, accountName);

      const response = {
        ok: true,
        message: 'Roster member notes retrieved.',
        account_name: accountName,
        notes,
        notes_returned: notes.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-member-notes-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-roster-member-notes:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve roster member notes.',
        account_name: String(payload.account_name || payload.accountName || '').trim(),
        notes: [],
        notes_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-member-notes-result', callback, response);
    }
  });

  socket.on('guildsync:add-roster-member-note', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to add roster member notes.',
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-member-note-added', callback, response);
      return;
    }

    try {
      const officerName = String(
        socket.guildSyncUser.display_name ||
        socket.guildSyncUser.username ||
        socket.guildSyncUser.discord_user_id ||
        payload.officer_name ||
        payload.officerName ||
        ''
      ).trim();

      const note = await addRosterMemberNote(applicationDB, {
        accountName: payload.account_name || payload.accountName || '',
        officerName,
        note: payload.note || payload.note_text || payload.noteText || ''
      });

      const response = {
        ok: true,
        message: 'Roster member note saved.',
        account_name: note.account_name,
        note,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-member-note-added', callback, response);
      await broadcastRosterDataUpdate();
    } catch (error) {
      Log('Failed to process guildsync:add-roster-member-note:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to save roster member note.',
        account_name: String(payload.account_name || payload.accountName || '').trim(),
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-member-note-added', callback, response);
    }
  });


  socket.on('guildsync:request-banking-history-matches', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to search banking history.',
        matches: [],
        matches_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-history-matches-result', callback, response);
      return;
    }

    try {
      const matches = await getBankingHistoryMatches(applicationDB, payload?.query || '');
      const response = {
        ok: true,
        message: 'Banking history search complete.',
        matches,
        matches_returned: matches.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-history-matches-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-banking-history-matches:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to search banking history.',
        matches: [],
        matches_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-history-matches-result', callback, response);
    }
  });

  socket.on('guildsync:request-banking-history-records', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to retrieve banking history.',
        records: [],
        records_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-history-records-result', callback, response);
      return;
    }

    try {
      const records = await getBankingHistoryForAccount(applicationDB, payload?.account_name || payload?.accountName || '');
      const response = {
        ok: true,
        message: 'Banking history loaded.',
        account_name: payload?.account_name || payload?.accountName || '',
        records,
        records_returned: records.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-history-records-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-banking-history-records:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve banking history.',
        account_name: String(payload?.account_name || payload?.accountName || '').trim(),
        records: [],
        records_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:banking-history-records-result', callback, response);
    }
  });

  socket.on('guildsync:request-roster-rank-history', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to search roster rank history.',
        matches: [],
        matches_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-rank-history-result', callback, response);
      return;
    }

    try {
      const matches = await getRosterRankHistoryMatches(applicationDB, payload?.query || '');
      const response = {
        ok: true,
        message: 'Roster rank history search complete.',
        matches,
        matches_returned: matches.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-rank-history-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-roster-rank-history:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to search roster rank history.',
        matches: [],
        matches_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-rank-history-result', callback, response);
    }
  });

  socket.on('guildsync:request-roster-stream-history', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to retrieve roster stream history.',
        events: [],
        events_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-stream-history-result', callback, response);
      return;
    }

    try {
      const events = await getRosterStreamHistoryForAccount(applicationDB, payload?.account_name || payload?.accountName || '');
      const response = {
        ok: true,
        message: 'Roster stream history retrieved.',
        events,
        events_returned: events.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-stream-history-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-roster-stream-history:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve roster stream history.',
        events: [],
        events_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:roster-stream-history-result', callback, response);
    }
  });



  socket.on('guildsync:request-discord-member-history', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to search Discord member history.',
        matches: [],
        matches_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-history-result', callback, response);
      return;
    }

    try {
      const matches = await getDiscordMemberHistoryMatches(applicationDB, payload?.query || '');
      const response = {
        ok: true,
        message: 'Discord member history search complete.',
        matches,
        matches_returned: matches.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-history-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-discord-member-history:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to search Discord member history.',
        matches: [],
        matches_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-history-result', callback, response);
    }
  });

  socket.on('guildsync:request-discord-member-history-events', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      const response = {
        ok: false,
        message: 'You must be logged in to retrieve Discord member history.',
        events: [],
        events_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-history-events-result', callback, response);
      return;
    }

    try {
      const events = await getDiscordMemberHistoryForMember(applicationDB, payload?.discord_id || payload?.discordID || '');
      const response = {
        ok: true,
        message: 'Discord member history retrieved.',
        events,
        events_returned: events.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-history-events-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-discord-member-history-events:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve Discord member history.',
        events: [],
        events_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-history-events-result', callback, response);
    }
  });


  socket.on('guildsync:request-member-links', async (payload = {}, callback) => {
    try {
      const links = await getMemberLinks(applicationDB);
      sendSocketResponse(socket, 'guildsync:member-links-result', callback, {
        ok: true,
        message: 'Member links retrieved.',
        links,
        links_returned: links.length,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:request-member-links:', error);
      sendSocketResponse(socket, 'guildsync:member-links-result', callback, {
        ok: false,
        message: error.message || 'Failed to retrieve member links.',
        links: [],
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:request-member-link-options', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      sendSocketResponse(socket, 'guildsync:member-link-options-result', callback, {
        ok: false,
        message: 'You must be logged in to retrieve link options.',
        options: [],
        at: new Date().toLocaleString()
      });
      return;
    }

    try {
      const options = await getMemberLinkOptions(applicationDB, payload || {});
      sendSocketResponse(socket, 'guildsync:member-link-options-result', callback, {
        ok: true,
        message: 'Member link options retrieved.',
        options,
        options_returned: options.length,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:request-member-link-options:', error);
      sendSocketResponse(socket, 'guildsync:member-link-options-result', callback, {
        ok: false,
        message: error.message || 'Failed to retrieve member link options.',
        options: [],
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:accept-member-link-candidate', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: 'You must be logged in to accept link candidates.',
        at: new Date().toLocaleString()
      });
      return;
    }

    try {
      await acceptMemberLinkCandidate(applicationDB, payload || {});
      const links = await getMemberLinks(applicationDB);
      await broadcastMemberLinksUpdate(links);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: true,
        message: 'Candidate accepted as an automatic link.',
        links,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:accept-member-link-candidate:', error);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: error.message || 'Failed to accept link candidate.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:manual-link-member', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: 'You must be logged in to link members.',
        at: new Date().toLocaleString()
      });
      return;
    }

    try {
      await manualLinkMember(applicationDB, payload || {});
      const links = await getMemberLinks(applicationDB);
      await broadcastMemberLinksUpdate(links);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: true,
        message: 'Member link saved.',
        links,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:manual-link-member:', error);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: error.message || 'Failed to link members.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:manual-unlink-member', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: 'You must be logged in to unlink members.',
        at: new Date().toLocaleString()
      });
      return;
    }

    try {
      const unlinkResult = await manualUnlinkMember(applicationDB, payload || {});
      const links = await getMemberLinks(applicationDB);
      await broadcastMemberLinksUpdate(links);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: true,
        message: unlinkResult?.blocked
          ? 'Exact automatic link removed and blocked. Manual linking is still available.'
          : 'Member link removed. Automatic/fuzzy matching was refreshed.',
        links,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:manual-unlink-member:', error);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: error.message || 'Failed to unlink members.',
        at: new Date().toLocaleString()
      });
    }
  });


  socket.on('guildsync:unblock-member-auto-link', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: 'You must be logged in to unblock member auto-link matches.',
        at: new Date().toLocaleString()
      });
      return;
    }

    try {
      const unblockResult = await unblockMemberAutoLink(applicationDB, payload || {});
      const autoLinkResult = await runMemberAutoLinking(applicationDB);
      const links = await getMemberLinks(applicationDB);
      await broadcastMemberLinksUpdate(links);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: true,
        message: unblockResult?.removed
          ? 'Auto-link block removed. The blocked record was deleted and auto-linking was refreshed.'
          : 'No blocked auto-link record was found for that ESO/Discord pair.',
        result: { ...unblockResult, autoLink: autoLinkResult },
        links,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:unblock-member-auto-link:', error);
      sendSocketResponse(socket, 'guildsync:member-link-update-result', callback, {
        ok: false,
        message: error.message || 'Failed to remove auto-link block.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:run-member-auto-linking', async (payload = {}, callback) => {
    if (!socket.guildSyncAuthenticated || !socket.guildSyncUser) {
      sendSocketResponse(socket, 'guildsync:member-auto-link-result', callback, {
        ok: false,
        message: 'You must be logged in to run member auto-linking.',
        at: new Date().toLocaleString()
      });
      return;
    }

    try {
      const result = await runMemberAutoLinking(applicationDB);
      const links = await getMemberLinks(applicationDB);
      await broadcastMemberLinksUpdate(links);
      sendSocketResponse(socket, 'guildsync:member-auto-link-result', callback, {
        ok: true,
        message: `Auto-linking complete. Linked ${result.linked || 0}; candidates ${result.candidates || 0}.`,
        result,
        links,
        at: new Date().toLocaleString()
      });
    } catch (error) {
      Log('Failed to process guildsync:run-member-auto-linking:', error);
      sendSocketResponse(socket, 'guildsync:member-auto-link-result', callback, {
        ok: false,
        message: error.message || 'Failed to run member auto-linking.',
        at: new Date().toLocaleString()
      });
    }
  });

  socket.on('guildsync:request-discord-member-dataJSON', async (payload = {}, callback) => {
    try {
      const [members, roles] = await Promise.all([
        getDiscordMemberDataJSON(applicationDB),
        getDiscordRoleDataJSON(applicationDB)
      ]);

      const response = {
        ok: true,
        message: 'Discord member data retrieved.',
        members,
        roles,
        members_returned: members.length,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-data-result', callback, response);
    } catch (error) {
      Log('Failed to process guildsync:request-discord-member-data:', error);

      const response = {
        ok: false,
        message: error.message || 'Failed to retrieve Discord member data.',
        members: [],
        roles: [],
        members_returned: 0,
        at: new Date().toLocaleString()
      };

      sendSocketResponse(socket, 'guildsync:discord-member-data-result', callback, response);
    }
  });


  socket.on('disconnect', (reason) => {
    let name = 'unauthenticated';

    if (socket.guildSyncAuthType === 'discord-bot') {
      name = 'Discord Bot';
      if(discordBotSocketId===socket.id) {
        discordBotConnected = false;
        discordBotSocketId = null;
        discordBotConnectedAt = null;
      }
    } else if (user?.display_name) {
      name = user.display_name + ' GuildSync User';
    }

    Log(`Disconnected: ${socket.id} => ${name} ${reason}`);
  });
});

server.listen(PORT, HOST, () => {
  Log(`GuildSync auth server listening at http://${HOST}:${PORT}`);
  Log(`Discord redirect URI: ${DISCORD_REDIRECT_URI}`);
  Log(`Current GuildSync client version: ${CURRENT_GUILDSYNC_CLIENT_VERSION}`);
});


async function broadcastBankingDataUpdate() {
  try {
    const bonusSettings = await getRaffleBonusSettings(applicationDB);
    const bonusVersions = await getRaffleBonusVersions(applicationDB);
    const [entries, refreshDate, bonusRaffles] = await Promise.all([
      getBankingDataJSON(applicationDB, bonusVersions),
      getBankingDataDate(applicationDB),
      getRaffleBonusChoices(applicationDB, bonusVersions)
    ]);

    io.to('GuildSyncClient').emit('guildsync:banking-data-updated', {
      ok: true,
      message: 'Banking data updated.',
      entries,
      bonusSettings,
      bonusRaffles,
      entries_returned: entries.length,
      last_refresh: refreshDate?.value || null,
      at: new Date().toLocaleString()
    });

    Log(`Broadcast banking data update to GuildSync clients. Entries: ${entries.length}`);
  } catch (error) {
    Log('Failed to broadcast banking data update:', error);
  }
}

function emitDiscordRefreshStatus(message) {
  io.to('GuildSyncClient').emit('guildsync:discord-refresh-status', {
    ok: true,
    message,
    at: new Date().toLocaleString()
  });
}



function collectGuildSyncApplicationRecords(payload = {}) {
  const rawRecords = [];

  if (Array.isArray(payload.records)) {
    rawRecords.push(...payload.records);
  } else if (Array.isArray(payload.applications)) {
    rawRecords.push(...payload.applications);
  } else if (payload.record && typeof payload.record === 'object') {
    rawRecords.push(payload.record);
  } else if (payload && typeof payload === 'object') {
    rawRecords.push(payload);
  }

  return rawRecords.filter(record => record && typeof record === 'object');
}

function buildGuildSyncApplicationDiscordMessage(record = {}) {
  const timestamp = Number(record.application_timestamp || record.capturedAt || Math.floor(Date.now() / 1000));
  const officer = String(record.officer_processing || record.officerAccount || 'Unknown officer').trim() || 'Unknown officer';
  const action = String(record.application_action || record.action || 'processed').trim() || 'processed';
  const applicant = String(record.applicant_account || record.applicantAccount || 'Unknown applicant').trim() || 'Unknown applicant';
  const applicationText = String(record.application_text || record.applicationText || '_No application text captured._').trim() || '_No application text captured._';
  const declineMessage = String(record.decline_message || record.declineMessage || '').trim();
  const blacklistMessage = String(record.blacklist_message || record.blacklistMessage || '').trim();

  const lines = [
    `📝 <t:${timestamp}:F>`,
    `**${officer}** ${action} an application from **${applicant}**.`,
    '',
    '**Application text:**',
    '```',
    applicationText.slice(0, 1500),
    '```'
  ];

  if (declineMessage) {
    lines.push('', '**Decline message:**', '```', declineMessage.slice(0, 1000), '```');
  }

  if (blacklistMessage) {
    lines.push('', '**Blacklist message:**', '```', blacklistMessage.slice(0, 1000), '```');
  }

  return lines.join('\n');
}

async function broadcastPendingGuildSyncApplications() {
  const pending = await getPendingGuildSyncApplicationBroadcasts(applicationDB);

  if (!pending.length) {
    return { sent: 0, failed: 0 };
  }

  const botSocket = discordBotSocketId ? io.sockets.sockets.get(discordBotSocketId) : null;

  if (!botSocket?.connected) {
    discordBotConnected = false;
    discordBotSocketId = null;
    throw new Error('The GuildSync Discord bot is not connected. Applications were recorded but not broadcast.');
  }

  let sent = 0;
  let failed = 0;

  for (const record of pending) {
    const botResponse = await emitToSocketWithAck(
      botSocket,
      'guildsync:eso-guild-application-message',
      {
        source: 'guildsync-backend-server',
        applicantAccount: record.applicant_account,
        capturedAt: record.application_timestamp,
        officerAccount: record.officer_processing,
        action: record.application_action,
        applicationText: record.application_text,
        declineMessage: record.decline_message,
        blacklistMessage: record.blacklist_message,
        message: buildGuildSyncApplicationDiscordMessage(record)
      },
      30000
    );

    if (botResponse?.ok) {
      await markGuildSyncApplicationBroadcasted(applicationDB, record.applicant_account);
      sent += 1;
    } else {
      failed += 1;
      Log(`ESO guild application Discord broadcast failed for ${record.applicant_account}: ${botResponse?.message || 'Unknown error'}`);
    }
  }

  return { sent, failed };
}

async function broadcastMemberLinksUpdate(existingLinks = null) {
  try {
    const links = Array.isArray(existingLinks) ? existingLinks : await getMemberLinks(applicationDB);

    io.to('GuildSyncClient').emit('guildsync:member-links-updated', {
      ok: true,
      message: 'Member links updated.',
      links,
      links_returned: links.length,
      at: new Date().toLocaleString()
    });

    Log(`Broadcast member link update to GuildSync clients. Links: ${links.length}`);
  } catch (error) {
    Log('Failed to broadcast member link update:', error);
  }
}

async function broadcastRosterDataUpdate() {
  try {
    const [members, refreshDate] = await Promise.all([
      getRosterDataJSON(applicationDB),
      getRosterDataDate(applicationDB)
    ]);

    io.to('GuildSyncClient').emit('guildsync:roster-data-updated', {
      ok: true,
      message: 'Roster data updated.',
      members,
      members_returned: members.length,
      last_refresh: refreshDate?.value || null,
      at: new Date().toLocaleString()
    });

    Log(`Broadcast roster data update to GuildSync clients. Members: ${members.length}`);
  } catch (error) {
    Log('Failed to broadcast roster data update:', error);
  }
}

async function broadcastDiscordMemberDataUpdate() {
  try {
    const [members, roles, refreshDate] = await Promise.all([
      getDiscordMemberDataJSON(applicationDB),
      getDiscordRoleDataJSON(applicationDB),
      getDiscordDataDate(applicationDB)
    ]);

    io.to('GuildSyncClient').emit('guildsync:discord-member-data-updated', {
      ok: true,
      message: 'Discord member data updated.',
      members,
      roles,
      members_returned: members.length,
      last_refresh: refreshDate?.value || null,
      at: new Date().toLocaleString()
    });

    Log(`Broadcast Discord member data update to GuildSync clients. Members: ${members.length}`);
  } catch (error) {
    Log('Failed to broadcast Discord member data update:', error);
  }
}

function emitToSocketWithAck(targetSocket, eventName, payload = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!targetSocket?.connected) {
      reject(new Error('Target websocket is not connected.'));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error(`${eventName} did not respond within ${timeoutMs}ms.`));
    }, timeoutMs);

    targetSocket.emit(eventName, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function sendSocketResponse(socket, eventName, callback, response) {
  if (typeof callback === 'function') {
    callback(response);
    return;
  }

  socket.emit(eventName, response);
}


function buildGuildSyncUserFromDBUser(dbUser = {}) {
  return {
    discord_user_id: dbUser.discord_user_id,
    username: dbUser.username || '',
    global_name: dbUser.global_name || '',
    display_name: preferredUserName(dbUser),
    avatar: dbUser.avatar || '',
    avatar_url: discordAvatarURL(dbUser.discord_user_id, dbUser.avatar),
    email: dbUser.email || '',
    guild_member_name: dbUser.guild_member_name || '',
    role: dbUser.role || 'user'
  };
}

async function createGuildSyncJWT(guildSyncUser = {}) {
  const sessionId = randomUUID();
  await loginDB.execute('INSERT INTO guildsync_login_sessions (session_id, discord_user_id) VALUES (?, ?)',
    [sessionId, guildSyncUser.discord_user_id]);
  return jwt.sign(
    {
      sub: guildSyncUser.discord_user_id,
      username: guildSyncUser.username,
      global_name: guildSyncUser.global_name,
      display_name: guildSyncUser.display_name,
      avatar_url: guildSyncUser.avatar_url,
      role: guildSyncUser.role,
      jti: sessionId
    },
    GUILDSYNC_JWT_SECRET,
    {
      issuer: 'guildsync-auth-server',
      audience: 'guildsync-desktop'
    }
  );
}

async function verifyGuildSyncSession(token) {
  const claims = jwt.verify(token, GUILDSYNC_JWT_SECRET, {
    issuer: 'guildsync-auth-server', audience: 'guildsync-desktop'
  });
  const [rows] = claims.jti ? await loginDB.execute(
    `SELECT users.role FROM guildsync_login_sessions AS sessions
     JOIN guildsync_users AS users ON users.discord_user_id = sessions.discord_user_id
     WHERE sessions.session_id = ? AND sessions.discord_user_id = ? AND users.allowed = 1 LIMIT 1`,
    [claims.jti, claims.sub]) : await loginDB.execute('SELECT role, requested_at FROM guildsync_users WHERE discord_user_id = ? AND allowed = 1 LIMIT 1',[claims.sub]);
  // A recreated account must never revive an older legacy token. Persistent sessions use their session ID.
  const recreatedLegacyAccount = !claims.jti && rows.length &&
    (!Number.isFinite(claims.iat) || claims.iat * 1000 < Date.parse(rows[0].requested_at));
  if (!rows.length || recreatedLegacyAccount) {
    for (const socket of io.sockets.sockets.values()) {
      if(socket.guildSyncAuthType==='voice-mute')continue;
      if (claims.jti ? socket.guildSyncSessionId === claims.jti : socket.guildSyncUser?.discord_user_id === claims.sub) socket.disconnect(true);
    }
    throw new Error('Session was logged out.');
  }
  claims.actual_role = rows[0].role || 'viewer';
  claims.role = roleViews.effective(roleViewSessionKey(claims),claims.actual_role);
  return claims;
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || '').trim();
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return authorization.slice(7).trim();
}

async function requireGuildSyncWebUser(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, message: 'You must be logged in to upload SavedVariables files.' });
    }

    const claims = await verifyGuildSyncSession(token);

    req.guildSyncUser = claims;
    if (!canIngestGuildSyncRole(claims.role)) {
      return res.status(403).json({ok:false,message:'Approved GuildSync access is required to upload SavedVariables files.'});
    }
    return next();
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired GuildSync session.' });
  }
}

function renderWebAuthResultPage(result = {}) {
  const safePayload = JSON.stringify({
    ok: result.ok === true,
    token: result.token || '',
    user: result.user || null,
    message: result.message || ''
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GuildSync Login</title>
</head>
<body>
  <script>
    const result = ${safePayload};
    if (result.ok && result.token) {
      const session = {
        logged_in: true,
        allowed: true,
        token: result.token,
        user: result.user,
        discord_user_id: result.user?.discord_user_id || '',
        username: result.user?.username || '',
        global_name: result.user?.global_name || '',
        display_name: result.user?.display_name || result.user?.global_name || result.user?.username || '',
        avatar_url: result.user?.avatar_url || '',
        role: result.user?.role || 'user',
        status_message: result.message || 'Logged in.'
      };
      localStorage.setItem('guildsync-web-session', JSON.stringify(session));
      localStorage.setItem('guildsync-web-token', result.token);
      window.location.replace('/');
    } else {
      document.body.innerHTML = '<main style="font-family: sans-serif; max-width: 720px; margin: 4rem auto; line-height: 1.5;"><h1>GuildSync Login</h1><p>'
        + (result.message || 'Login failed.')
        + '</p><p><a href="/">Return to GuildSync</a></p></main>';
    }
  </script>
</body>
</html>`;
}

async function exchangeCodeWithDiscord(code, redirectURI) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectURI
  });

  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const text = await response.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Discord token endpoint returned invalid JSON: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Discord token exchange failed: ${JSON.stringify(json)}`);
  }

  if (!json.access_token) {
    throw new Error('Discord did not return an access token.');
  }

  return json;
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const text = await response.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Discord user endpoint returned invalid JSON: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Discord user lookup failed: ${JSON.stringify(json)}`);
  }

  return json;
}

function toGuildSyncUser(discordUser, allowedUser) {
  return {
    discord_user_id: discordUser.id,
    username: discordUser.username,
    global_name: discordUser.global_name,
    avatar: discordUser.avatar || '',
    avatar_url: discordAvatarURL(discordUser.id, discordUser.avatar),
    email: allowedUser ? allowedUser.email || '' : discordUser.email || '',
    guild_member_name: allowedUser?.guild_member_name || '',
    role: allowedUser?.role || 'user'
  };
}

function discordAvatarURL(discordUserID, avatarHash) {
  const userID = String(discordUserID || '').trim();
  const avatar = String(avatarHash || '').trim();

  if (!userID || !avatar) {
    return '';
  }

  if (avatar.startsWith('http://') || avatar.startsWith('https://')) {
    return avatar;
  }

  const extension = avatar.startsWith('a_') ? 'gif' : 'png';

  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(userID)}/${encodeURIComponent(avatar)}.${extension}?size=128`;
}

function preferredUserName(user) {
  const guild_member_name = String(user.guild_member_name || '').trim();
  if (guild_member_name) {
    return guild_member_name;
  }

  const global_name = String(user.global_name || '').trim();
  if (global_name) {
    return global_name;
  }

  const username = String(user.username || '').trim();
  if (username) {
    return username;
  }

  return 'Unknown User';
}

function normalizeClientPlatform(value) {
  const platform = String(value || '').trim().toLowerCase();

  if (platform.includes('mac') || platform.includes('darwin') || platform.includes('osx')) {
    return 'macos';
  }

  if (platform.includes('linux')) {
    return 'linux';
  }

  if (platform.includes('win')) {
    return 'windows';
  }

  return 'windows';
}

function getGuildSyncClientDownload(platform) {
  const normalizedPlatform = normalizeClientPlatform(platform);
  const fileName = findLatestGuildSyncClientDownloadFile(normalizedPlatform);

  if (!fileName) {
    return null;
  }

  const labelMap = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux'
  };

  return {
    platform: normalizedPlatform,
    label: labelMap[normalizedPlatform] || 'Windows',
    version: CURRENT_GUILDSYNC_CLIENT_VERSION,
    file_name: fileName,
    url: buildPublicDownloadUrl(`/downloads/${fileName}`)
  };
}

function findLatestGuildSyncClientDownloadFile(platform) {
  const normalizedPlatform = normalizeClientPlatform(platform);
  const suffixes = { windows: 'Windows', macos: 'macOS', linux: 'Linux-x86_64' };
  const expected = `GuildSync-Setup-${CURRENT_GUILDSYNC_CLIENT_VERSION}-${suffixes[normalizedPlatform]}.zip`;
  try {
    const entries = fs.readdirSync(GUILDSYNC_DOWNLOADS_DIR, { withFileTypes: true });
    return entries.find(entry => entry.isFile() && entry.name === expected)?.name || null;
  } catch (error) {
    Log(`Download directory unavailable: ${error.message}`);
    return null;
  }
}

function compareVersionStrings(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const leftPart = left[i] || 0;
    const rightPart = right[i] || 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function buildPublicDownloadUrl(downloadPath) {
  const base = String(GUILDSYNC_WEB_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const cleanPath = String(downloadPath || '').trim().replace(/^\/+/, '');

  if (!base) {
    return `/${cleanPath}`;
  }

  return `${base}/${cleanPath}`;
}

function isVersionLower(clientVersion, serverVersion) {
  const client = parseVersion(clientVersion);
  const server = parseVersion(serverVersion);

  for (let i = 0; i < Math.max(client.length, server.length); i += 1) {
    const clientPart = client[i] || 0;
    const serverPart = server[i] || 0;

    if (clientPart < serverPart) {
      return true;
    }

    if (clientPart > serverPart) {
      return false;
    }
  }

  return false;
}

function parseVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => {
      const match = part.match(/\d+/);
      return match ? Number(match[0]) : 0;
    });
}

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    Log(`Missing required environment variable: ${name}`);
    Log('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }

  return value;
}

export function Log(message) {
  const timestamp = new Date().toLocaleString();
  console.log(`${timestamp} [GUILDSYNC-NODE] ${message}`);
}


