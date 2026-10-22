import { notifyDiscordConfirmedLink } from './discord-onboarding.js';
import { normalizeRaffleDate } from './raffle-date.js';
import { initializeDiscordOnboardingSchema } from './discord-onboarding-schema.js';
import { initializeVoiceMuteSchema } from './voice-mute-schema.js';
import { ARCHIVE_CELLS_SCHEMA } from './raffle-archive-cells.js';
import { RAFFLE_RESULTS_SCHEMA, RAFFLE_FORMULAS_SCHEMA } from './raffle-results.js';
import mysql from 'mysql2/promise';
import { bankingSource } from './banking-source.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BONUS_TIERS, parseBonusTiers, calculateRaffleBonus, selectRaffleBonusSettings } from './raffle-bonus.js';
import { syncBankingEntriesToGoogleSheets, googleSheetsBankingConfig } from './google-sheets-banking-sync.js';


const DEFAULT_DEPOSIT_MAIL_SUBJECT_TEMPLATE = 'Raffle ticket deposit received';
const DEFAULT_DEPOSIT_MAIL_BODY_TEMPLATE = [
  'Hi {recipient},',
  '',
  'Thank you for supporting Alphabet Mafia!',
  '',
  'We received your guild bank deposit of {amount} gold.',
  'Ticket Credit Earned: {ticket_quantity}',
  '{bonus_block}',
  '{note_block}',
  '',
  'Transaction ID: {event_id}',
  '',
  '-- Alphabet Mafia'
].join('\n');

function getDepositMailSubjectTemplate() {
  return String(process.env.GUILDSYNC_DEPOSIT_MAIL_SUBJECT_TEMPLATE || DEFAULT_DEPOSIT_MAIL_SUBJECT_TEMPLATE);
}

function getDepositMailBodyTemplate() {
  return String(process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE || DEFAULT_DEPOSIT_MAIL_BODY_TEMPLATE);
}


function normalizeDepositMailRecipient(value) {
  const recipient = String(value || '').trim();
  if (!recipient) return '';
  return recipient.startsWith('@') ? recipient : `@${recipient}`;
}

function getForcedDepositMailRecipient() {
  return normalizeDepositMailRecipient(process.env.GUILDSYNC_DEPOSIT_MAIL_FORCE_RECIPIENT || '');
}

function formatDepositMailAmount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return Math.trunc(number).toLocaleString('en-US');
}


const BANKING_BIWEEKLY_SALES_END_ANCHOR_UTC = 1780786800;
const BANKING_MONTHLY_SALES_END_ANCHOR_UTC = 1781996400;
const BANKING_BIWEEKLY_INTERVAL_SECONDS = 14 * 24 * 60 * 60;
const BANKING_MONTHLY_INTERVAL_SECONDS = 28 * 24 * 60 * 60;
const BANKING_RAFFLE_AFTER_SALES_SECONDS = 60 * 60;

function normalizeDepositMailTicketType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'monthly' || type === '50/50' || type === '5050') return 'monthly';
  if (type === 'biweekly' || type === 'bi-weekly' || type === 'bi weekly') return 'biweekly';
  return type || '';
}

function getDepositMailTicketTypeLabel(value) {
  const type = normalizeDepositMailTicketType(value);
  if (type === 'monthly') return '50/50';
  if (type === 'biweekly') return 'Bi-Weekly';
  return value ? String(value) : '';
}

function getDepositMailTicketGoldCost(row = {}) {
  const amount = Number(row.deposit_amount ?? row.amount ?? 0);
  if (!Number.isFinite(amount)) return 0;

  // Mail receipts should show the actual ESO deposit/ticket price.
  // The +1/+3 raffle marker is only removed from raffle summary totals,
  // not from queued mail content or rendered mail placeholders.
  return Math.max(0, Math.trunc(amount));
}

function getDepositMailPurchaseDate(row = {}) {
  const timestamp = Number(row.event_timestamp || row.time || 0);
  const date = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000)
    : row.event_datetime
      ? new Date(row.event_datetime)
      : null;

  if (!date || Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

function getDepositMailNoteBlock(row = {}) {
  const note = String(row.note || '').trim();
  return note ? `Note: ${note}` : '';
}

function getDepositMailRaffleTimestamp(row = {}) {
  const type = normalizeDepositMailTicketType(row.transaction_type || row.ticket_type || row.type);
  if (type !== 'monthly' && type !== 'biweekly') return null;

  const eventTimestamp = Number(row.event_timestamp || row.time || 0);
  const referenceTime = Number.isFinite(eventTimestamp) && eventTimestamp > 0
    ? eventTimestamp
    : Math.floor(Date.now() / 1000);

  const salesEnd = type === 'monthly'
    ? getDepositMailMonthlySalesEndAtOrAfter(referenceTime)
    : getDepositMailBiweeklySalesEndAtOrAfter(referenceTime);

  return salesEnd + BANKING_RAFFLE_AFTER_SALES_SECONDS;
}

function getDepositMailBiweeklySalesEndAtOrAfter(referenceTime) {
  let salesEnd = BANKING_BIWEEKLY_SALES_END_ANCHOR_UTC;

  while (salesEnd - BANKING_BIWEEKLY_INTERVAL_SECONDS > referenceTime) {
    salesEnd -= BANKING_BIWEEKLY_INTERVAL_SECONDS;
  }

  while (salesEnd < referenceTime) {
    salesEnd += BANKING_BIWEEKLY_INTERVAL_SECONDS;
  }

  return salesEnd;
}

function getDepositMailMonthlySalesEndAtOrAfter(referenceTime) {
  let salesEnd = getDepositMailBiweeklySalesEndAtOrAfter(referenceTime);

  while (!isDepositMailLastRaffleSalesEndInEasternMonth(salesEnd)) {
    salesEnd += BANKING_BIWEEKLY_INTERVAL_SECONDS;
  }

  return salesEnd;
}

function isDepositMailLastRaffleSalesEndInEasternMonth(salesEnd) {
  const raffleTimestamp = salesEnd + BANKING_RAFFLE_AFTER_SALES_SECONDS;
  const nextRaffleTimestamp = salesEnd + BANKING_BIWEEKLY_INTERVAL_SECONDS + BANKING_RAFFLE_AFTER_SALES_SECONDS;
  return getDepositMailEasternMonthKey(raffleTimestamp) !== getDepositMailEasternMonthKey(nextRaffleTimestamp);
}

function getDepositMailEasternMonthKey(timestamp) {
  const date = new Date(Number(timestamp || 0) * 1000);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '';
  const month = parts.find((part) => part.type === 'month')?.value || '';
  return `${year}-${month}`;
}

function getDepositMailRaffleDateTimeEastern(row = {}) {
  const timestamp = getDepositMailRaffleTimestamp(row);
  if (!timestamp) return '';

  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

function renderDepositMailTemplate(template, row = {}) {
  const recipient = normalizeDepositMailRecipient(row.recipient || row.account_name || row.display_name || '');
  const ticketTypeRaw = normalizeDepositMailTicketType(row.transaction_type || row.ticket_type || row.type);
  const ticketTypeLabel = getDepositMailTicketTypeLabel(ticketTypeRaw);
  const ticketGoldCost = getDepositMailTicketGoldCost(row);
  const purchaseDate = getDepositMailPurchaseDate(row);
  const noteBlock = getDepositMailNoteBlock(row);
  const raffleDateTimeEastern = getDepositMailRaffleDateTimeEastern(row);

  const values = {
    event_id: row.event_id || '',
    transaction_type: row.transaction_type || '',
    ticket_type: ticketTypeLabel,
    ticket_type_raw: ticketTypeRaw,
    recipient,
    account_name: recipient,
    display_name: recipient,
    amount: formatDepositMailAmount(row.deposit_amount),
    deposit_amount: formatDepositMailAmount(row.deposit_amount),
    raw_amount: row.deposit_amount == null ? '' : String(row.deposit_amount),
    raw_deposit_amount: row.deposit_amount == null ? '' : String(row.deposit_amount),
    ticket_quantity: row.ticket_quantity == null ? '0' : String(row.ticket_quantity),
    tickets: row.ticket_quantity == null ? '0' : String(row.ticket_quantity),
    purchased_tickets: formatDepositMailAmount(row.purchasedTickets ?? row.ticket_quantity),
    bonus_percent: String(row.bonusPercent || 0),
    bonus_tickets: formatDepositMailAmount(row.bonusTickets),
    total_tickets: formatDepositMailAmount(row.totalTickets ?? row.ticket_quantity),
    bonus_deadline: row.bonusDeadline || '',
    bonus_block: row.bonusBlock || '',
    ticket_gold_cost: formatDepositMailAmount(ticketGoldCost),
    gold_cost: formatDepositMailAmount(ticketGoldCost),
    raw_ticket_gold_cost: String(ticketGoldCost),
    raw_gold_cost: String(ticketGoldCost),
    purchase_date: purchaseDate,
    data_source: row.data_source || '',
    note: row.note || '',
    note_block: noteBlock,
    event_datetime: row.event_datetime || '',
    event_timestamp: row.event_timestamp == null ? '' : String(row.event_timestamp),
    raffle_datetime_eastern: raffleDateTimeEastern,
    raffle_date_time_eastern: raffleDateTimeEastern,
    raffle_datetime: raffleDateTimeEastern,
    mail_request_id: row.mail_request_id || '',
    mail_batch_id: row.mail_batch_id || ''
  };

  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key] == null ? '' : String(values[key]);
    }
    return match;
  }).trim();
}

function addRenderedDepositMailContent(row = {}, versions = [], overrides = []) {
  const normalized = normalizeDepositMailRow(row);
  const bonus = calculateBankingEntryBonus(normalized, versions, overrides);
  const bonusDeadline = bonus.bonusPercent > 0 ? new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(new Date(bonus.bonusExpiresAt * 1000)) + ' ET' : '';
  const bonusBlock = bonus.bonusPercent > 0 ? [
    `Early Purchase Bonus: ${bonus.bonusPercent}% for buying before ${bonusDeadline}.`,
    `Bonus Tickets: ${formatDepositMailAmount(bonus.bonusTickets)}`,
    `Total Tickets: ${formatDepositMailAmount(bonus.totalTickets)}`
  ].join('\n') : '';
  const recipient = getForcedDepositMailRecipient() || normalizeDepositMailRecipient(row.account_name || row.display_name || row.recipient || '');
  const templateRow = {
    ...row,
    ...bonus,
    bonusDeadline,
    bonusBlock,
    recipient,
    account_name: recipient,
    display_name: recipient
  };
  const subject = renderDepositMailTemplate(getDepositMailSubjectTemplate(), templateRow);
  const bodyTemplate = getDepositMailBodyTemplate();
  const renderedBody = renderDepositMailTemplate(bodyTemplate, templateRow);
  // Existing customized templates also receive the new receipt information.
  const body = bonusBlock && !bodyTemplate.includes('{bonus_block}')
    ? renderedBody + '\n\n' + bonusBlock : renderedBody;
  return {
    ...normalized,
    ...bonus,
    recipient,
    subject,
    body,
    mailSubject: subject,
    mailBody: body
  };
}

export const MARIADB_HOST = process.env.MARIADB_HOST || '127.0.0.1';
export const MARIADB_PORT = Number(process.env.MARIADB_PORT || 3306);
export const MARIADB_USER = requiredDatabaseEnv('MARIADB_USER');
export const MARIADB_PASSWORD = requiredDatabaseEnv('MARIADB_PASSWORD');
export const GUILDSYNC_DB_NAME = process.env.MARIADB_DATABASE || 'guildsync';
export const MARIADB_CONNECTION_LIMIT = Number(
  process.env.MARIADB_CONNECTION_LIMIT || 10
);

let guildSyncPoolPromise = null;

export async function openGuildSyncDB() {
  if (!guildSyncPoolPromise) {
    guildSyncPoolPromise = createAndInitializePool();
  }

  return guildSyncPoolPromise;
}

export async function openLoginDB() {
  return openGuildSyncDB();
}

export async function openAppDataDB() {
  return openGuildSyncDB();
}

async function createAndInitializePool() {
  const adminConnection = await mysql.createConnection({
    host: MARIADB_HOST,
    port: MARIADB_PORT,
    user: MARIADB_USER,
    password: MARIADB_PASSWORD,
    multipleStatements: false
  });

  try {
    await adminConnection.query(`
      CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(GUILDSYNC_DB_NAME)}
      CHARACTER SET utf8mb4
      COLLATE utf8mb4_unicode_ci
    `);
  } finally {
    await adminConnection.end();
  }

  const pool = mysql.createPool({
    host: MARIADB_HOST,
    port: MARIADB_PORT,
    user: MARIADB_USER,
    password: MARIADB_PASSWORD,
    database: GUILDSYNC_DB_NAME,
    waitForConnections: true,
    connectionLimit: MARIADB_CONNECTION_LIMIT,
    queueLimit: 0,
    charset: 'utf8mb4'
  });

  await initializeSchema(pool);

  return pool;
}

async function initializeSchema(db) {
  await initializeDiscordOnboardingSchema(db);
  await initializeVoiceMuteSchema(db);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_login_sessions (
      session_id CHAR(36) PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_login_sessions_user (discord_user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_users (
      discord_user_id VARCHAR(32) PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      global_name VARCHAR(255),
      guild_member_name VARCHAR(255),
      email VARCHAR(255),
      avatar TEXT,
      allowed TINYINT(1) NOT NULL DEFAULT 0,
      role VARCHAR(50) NOT NULL DEFAULT 'viewer',
      requested_at VARCHAR(32) NOT NULL,
      approved_at VARCHAR(32),
      last_login_at VARCHAR(32),
      revoked_at VARCHAR(32)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  // Change only the insertion default; existing account roles remain untouched.
  await db.query("ALTER TABLE guildsync_users ALTER COLUMN role SET DEFAULT 'viewer'");
  // Preserve referenced login records when access is revoked; existing accounts remain unchanged.
  await addColumnIfMissing(db, 'guildsync_users', 'revoked_at', 'VARCHAR(32) DEFAULT NULL');

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_applications (
      applicant_account VARCHAR(50) NOT NULL,
      application_text TEXT DEFAULT NULL,
      application_timestamp VARCHAR(25) NOT NULL,
      officer_processing VARCHAR(50) NOT NULL,
      application_action VARCHAR(50) NOT NULL,
      decline_message TEXT DEFAULT NULL,
      blacklist_message TEXT DEFAULT NULL,
      discord_broadcast TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (applicant_account, application_timestamp)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);



  await addColumnIfMissing(db, 'guildsync_applications', 'discord_broadcast', 'TINYINT(1) NOT NULL DEFAULT 0');

  await db.query(`
    CREATE TABLE IF NOT EXISTS discord_roles (
      role_id VARCHAR(32) PRIMARY KEY,
      role_name VARCHAR(255) NOT NULL,
      role_color VARCHAR(32)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS discord_members (
      discord_id VARCHAR(32) PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      global_name VARCHAR(255),
      server_nickname VARCHAR(255),
      last_seen VARCHAR(25),
      last_seen_action VARCHAR(64),
      avatar TEXT NULL,
      import_current BOOLEAN NOT NULL DEFAULT FALSE
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS discord_member_roles (
      discord_id VARCHAR(32),
      role_id VARCHAR(32),
      PRIMARY KEY (discord_id, role_id),
      CONSTRAINT discord_members_to_discord_member_roles FOREIGN KEY (discord_id) REFERENCES discord_members (discord_id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT discord_roles_to_discord_member_roles FOREIGN KEY (role_id) REFERENCES discord_roles (role_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS discord_member_history (
      history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      discord_id VARCHAR(32) NOT NULL,
      username VARCHAR(255),
      global_name VARCHAR(255),
      server_nickname VARCHAR(255),
      event_type VARCHAR(64) NOT NULL,
      field_name VARCHAR(64),
      old_value TEXT,
      new_value TEXT,
      event_timestamp VARCHAR(25) NOT NULL,
      event_datetime DATETIME NOT NULL,
      source VARCHAR(64) NOT NULL DEFAULT 'unknown',
      initiator VARCHAR(50) DEFAULT NULL,
      INDEX idx_discord_member_history_discord_id (discord_id),
      INDEX idx_discord_member_history_event_type (event_type),
      INDEX idx_discord_member_history_event_datetime (event_datetime),
      INDEX idx_discord_member_history_username (username)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(ARCHIVE_CELLS_SCHEMA);
  await db.query(RAFFLE_RESULTS_SCHEMA);
  await db.query(RAFFLE_FORMULAS_SCHEMA);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_settings (
      setting_key VARCHAR(255) PRIMARY KEY,
      value TEXT
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_raffle_bonus_versions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      raffle_type VARCHAR(16) NOT NULL,
      effective_from BIGINT UNSIGNED NOT NULL,
      enabled TINYINT(1) NOT NULL,
      tiers_json TEXT NOT NULL,
      INDEX idx_raffle_bonus_type_time (raffle_type, effective_from, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_raffle_bonus_overrides (
      raffle_type VARCHAR(16) NOT NULL,
      sales_end BIGINT UNSIGNED NOT NULL,
      enabled TINYINT(1) NOT NULL,
      tiers_json TEXT NOT NULL,
      PRIMARY KEY (raffle_type, sales_end)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await initializeRaffleBonusVersions(db);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_roles
    ON discord_roles (role_name)
  `);

  await ensureColumn(db, 'discord_members', 'last_seen', 'VARCHAR(25) NULL', 'server_nickname');
  await ensureColumn(db, 'discord_members', 'last_seen_action', 'VARCHAR(64) NULL', 'last_seen');
  await ensureColumn(db, 'discord_member_history', 'initiator', 'VARCHAR(50) NULL', 'source');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_discord_members
    ON discord_members (username)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_banking_entries (
      event_id varchar(32) NOT NULL,
      transaction_type varchar(32) NOT NULL,
      account_name varchar(255) NOT NULL,
      event_timestamp varchar(32) NOT NULL,
      event_datetime datetime NOT NULL,
      deposit_amount int(10) unsigned NOT NULL,
      ticket_quantity int(10) unsigned DEFAULT NULL,
      data_source varchar(255) NOT NULL,
      note varchar(255) DEFAULT NULL,
      mail_status varchar(32) NOT NULL DEFAULT 'unsent',
      mail_request_id varchar(64) DEFAULT NULL,
      mail_batch_id varchar(64) DEFAULT NULL,
      checked_out_by varchar(255) DEFAULT NULL,
      checked_out_at datetime DEFAULT NULL,
      checkout_expires_at datetime DEFAULT NULL,
      written_to_eso_at datetime DEFAULT NULL,
      sent_at datetime DEFAULT NULL,
      failed_reason text DEFAULT NULL,
      PRIMARY KEY (event_id),
      INDEX idx_guildsync_banking_mail_status (mail_status),
      INDEX idx_guildsync_banking_mail_batch_id (mail_batch_id),
      INDEX idx_guildsync_banking_checked_out_by (checked_out_by),
      INDEX idx_guildsync_banking_checkout_expires_at (checkout_expires_at)
    )
    CHARSET=utf8mb4
    COLLATE=utf8mb4_unicode_ci
  `);

  await addColumnIfMissing(db, 'guildsync_banking_entries', 'mail_status', "varchar(32) NOT NULL DEFAULT 'unsent'");
  const [sourceColumns] = await db.query(`SELECT CHARACTER_MAXIMUM_LENGTH AS capacity
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'guildsync_banking_entries' AND COLUMN_NAME = 'data_source'`);
  if (Number(sourceColumns[0]?.capacity) < 255) {
    await db.query('ALTER TABLE guildsync_banking_entries MODIFY COLUMN data_source VARCHAR(255) NOT NULL');
  }
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'mail_request_id', 'varchar(64) DEFAULT NULL');
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'mail_batch_id', 'varchar(64) DEFAULT NULL');
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'checked_out_by', 'varchar(255) DEFAULT NULL');
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'checked_out_at', 'datetime DEFAULT NULL');
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'checkout_expires_at', 'datetime DEFAULT NULL');
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'written_to_eso_at', 'datetime DEFAULT NULL');
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'sent_at', 'datetime DEFAULT NULL');
  await addColumnIfMissing(db, 'guildsync_banking_entries', 'failed_reason', 'text DEFAULT NULL');
  await dropColumnIfExists(db, 'guildsync_banking_entries', 'email_requested');

  await addIndexIfMissing(db, 'guildsync_banking_entries', 'idx_guildsync_banking_mail_status', 'mail_status');
  await addIndexIfMissing(db, 'guildsync_banking_entries', 'idx_guildsync_banking_mail_batch_id', 'mail_batch_id');
  await addIndexIfMissing(db, 'guildsync_banking_entries', 'idx_guildsync_banking_checked_out_by', 'checked_out_by');
  await addIndexIfMissing(db, 'guildsync_banking_entries', 'idx_guildsync_banking_checkout_expires_at', 'checkout_expires_at');

  await db.query(`
    UPDATE guildsync_banking_entries
    SET mail_status = 'N/A',
        mail_request_id = 'N/A',
        mail_batch_id = 'N/A',
        checked_out_by = '000000000000000000',
        checked_out_at = COALESCE(checked_out_at, NOW()),
        checkout_expires_at = NULL,
        written_to_eso_at = COALESCE(written_to_eso_at, NOW()),
        sent_at = COALESCE(sent_at, NOW()),
        failed_reason = 'No deposit mail required for other category'
    WHERE LOWER(transaction_type) = 'other'
      AND mail_status <> 'N/A'
  `);


  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_roster_events (
      event_id VARCHAR(32) PRIMARY KEY NOT NULL,
      account_name VARCHAR(64) NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      rank_name VARCHAR(20),
      event_timestamp VARCHAR(32) NOT NULL,
      officer_account_name VARCHAR(64)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_roster_rank_history (
      account_name VARCHAR(64) PRIMARY KEY NOT NULL,
      rank_name VARCHAR(20)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_roster_members (
      account_name VARCHAR(32) PRIMARY KEY NOT NULL,
      rank_name VARCHAR(20),
      joined_timestamp VARCHAR(32),
      in_roster TINYINT(1) NOT NULL DEFAULT 1
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_roster_member_notes (
      note_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      account_name VARCHAR(64) NOT NULL,
      officer_name VARCHAR(255) NOT NULL,
      note_text TEXT NOT NULL,
      note_timestamp VARCHAR(32) NOT NULL,
      PRIMARY KEY (note_id),
      INDEX idx_guildsync_roster_member_notes_account_name (account_name),
      INDEX idx_guildsync_roster_member_notes_timestamp (note_timestamp)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);



  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_member_links (
      eso_account_name VARCHAR(64) NOT NULL,
      discord_user_id VARCHAR(32) NOT NULL,
      discord_username VARCHAR(255),
      discord_display_name VARCHAR(255),
      discord_server_nickname VARCHAR(255),
      link_status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      link_method VARCHAR(20) NOT NULL DEFAULT 'none',
      match_confidence DECIMAL(5,2) NOT NULL DEFAULT 0,
      match_reason VARCHAR(255),
      match_field VARCHAR(64),
      auto_link_blocked TINYINT(1) NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (eso_account_name, discord_user_id),
      INDEX idx_guildsync_member_links_eso_account_name (eso_account_name),
      INDEX idx_guildsync_member_links_discord_user_id (discord_user_id),
      INDEX idx_guildsync_member_links_status (link_status),
      INDEX idx_guildsync_member_links_method (link_method),
      INDEX idx_guildsync_member_links_auto_link_blocked (auto_link_blocked)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

}


async function addColumnIfMissing(db, tableName, columnName, columnDefinition) {
  const [rows] = await db.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [GUILDSYNC_DB_NAME, tableName, columnName]
  );

  if (Array.isArray(rows) && rows.length > 0) {
    return;
  }

  await db.query(
    `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDefinition}`
  );
}

async function dropColumnIfExists(db, tableName, columnName) {
  const [rows] = await db.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [GUILDSYNC_DB_NAME, tableName, columnName]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }

  await db.query(
    `ALTER TABLE ${quoteIdentifier(tableName)} DROP COLUMN ${quoteIdentifier(columnName)}`
  );
}

async function addIndexIfMissing(db, tableName, indexName, columnList) {
  const [rows] = await db.query(
    `
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [GUILDSYNC_DB_NAME, tableName, indexName]
  );

  if (Array.isArray(rows) && rows.length > 0) {
    return;
  }

  await db.query(
    `CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)} (${columnList})`
  );
}

function normalizeApplicationRecord(record = {}) {
  const applicantAccount = String(record.applicantAccount || record.applicant_account || '').trim();
  const applicationTimestamp = String(record.capturedAt || record.applicationTimestamp || record.application_timestamp || '').trim();

  if (!applicantAccount || !applicationTimestamp) {
    return null;
  }

  return {
    applicant_account: applicantAccount,
    application_text: String(record.applicationText || record.application_text || ''),
    application_timestamp: applicationTimestamp,
    officer_processing: String(record.officerAccount || record.officer_processing || record.officerProcessing || '').trim(),
    application_action: String(record.action || record.application_action || record.applicationAction || '').trim() || 'processed',
    decline_message: String(record.declineMessage || record.decline_message || ''),
    blacklist_message: String(record.blacklistMessage || record.blacklist_message || '')
  };
}

export async function recordGuildSyncApplications(applicationDB, records = []) {
  const normalizedRecords = (Array.isArray(records) ? records : [records])
    .map(normalizeApplicationRecord)
    .filter(Boolean);

  if (!normalizedRecords.length) {
    return { inserted: 0, skipped: Array.isArray(records) ? records.length : 1 };
  }

  for (const record of normalizedRecords) {
    await applicationDB.execute(
      `
        INSERT INTO guildsync_applications (
          applicant_account,
          application_text,
          application_timestamp,
          officer_processing,
          application_action,
          decline_message,
          blacklist_message,
          discord_broadcast
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        ON DUPLICATE KEY UPDATE
          application_text = VALUES(application_text),
          application_timestamp = VALUES(application_timestamp),
          officer_processing = VALUES(officer_processing),
          application_action = VALUES(application_action),
          decline_message = VALUES(decline_message),
          blacklist_message = VALUES(blacklist_message),
          discord_broadcast =
            CASE
              WHEN application_timestamp <> VALUES(application_timestamp)
                OR application_text <> VALUES(application_text)
                OR application_action <> VALUES(application_action)
              THEN 0
              ELSE discord_broadcast
            END
      `,
      [
        record.applicant_account,
        record.application_text,
        record.application_timestamp,
        record.officer_processing,
        record.application_action,
        record.decline_message,
        record.blacklist_message
      ]
    );
  }

  return { inserted: normalizedRecords.length, skipped: (Array.isArray(records) ? records.length : 1) - normalizedRecords.length };
}



export async function getGuildSyncApplicationsByApplicantSearch(applicationDB, applicantSearch) {
  const normalizedName = String(applicantSearch || '').trim();

  if (!normalizedName) {
    throw new Error('Applicant account name is required.');
  }

  const searchTerm = `%${normalizedName}%`;

  const [rows] = await applicationDB.execute(
    `
      SELECT
        applicant_account,
        application_text,
        application_timestamp,
        officer_processing,
        application_action,
        decline_message,
        blacklist_message,
        discord_broadcast
      FROM guildsync_applications
      WHERE applicant_account LIKE ?
      ORDER BY applicant_account, CAST(application_timestamp AS UNSIGNED) DESC
    `,
    [searchTerm]
  );

  return rows;
}

export async function markGuildSyncApplicationRecordBroadcasted(applicationDB, applicantAccount, applicationTimestamp) {
  await applicationDB.execute(
    `
      UPDATE guildsync_applications
      SET discord_broadcast = 1
      WHERE applicant_account = ?
        AND application_timestamp = ?
    `,
    [applicantAccount, applicationTimestamp]
  );
}

export async function getGuildSyncApplicationByApplicantAccount(applicationDB, applicantAccount) {
  const normalizedName = String(applicantAccount || '').trim();

  if (!normalizedName) {
    throw new Error('Applicant account name is required.');
  }

  const searchNames = Array.from(new Set([
    normalizedName,
    normalizedName.startsWith('@') ? normalizedName.slice(1) : `@${normalizedName}`
  ].filter(Boolean)));

  const placeholders = searchNames.map(() => '?').join(', ');

  const [rows] = await applicationDB.execute(
    `
      SELECT
        applicant_account,
        application_text,
        application_timestamp,
        officer_processing,
        application_action,
        decline_message,
        blacklist_message,
        discord_broadcast
      FROM guildsync_applications
      WHERE applicant_account IN (${placeholders})
      ORDER BY CAST(application_timestamp AS UNSIGNED) DESC, applicant_account
      LIMIT 1
    `,
    searchNames
  );

  return rows[0] || null;
}

export async function getPendingGuildSyncApplicationBroadcasts(applicationDB) {
  const [rows] = await applicationDB.execute(
    `
      SELECT
        applicant_account,
        application_text,
        application_timestamp,
        officer_processing,
        application_action,
        decline_message,
        blacklist_message
      FROM guildsync_applications
      WHERE discord_broadcast = 0
      ORDER BY CAST(application_timestamp AS UNSIGNED), applicant_account
    `
  );

  return rows;
}

export async function markGuildSyncApplicationBroadcasted(applicationDB, applicantAccount) {
  await applicationDB.execute(
    `
      UPDATE guildsync_applications
      SET discord_broadcast = 1
      WHERE applicant_account = ?
    `,
    [applicantAccount]
  );
}

export async function upsertLoginUser(loginDB, discordUser) {
  const now = new Date().toISOString();

  const [adminRows] = await loginDB.execute(`
    SELECT COUNT(*) AS admin_count
    FROM guildsync_users
    WHERE allowed = 1
      AND role = 'admin'
  `);

  const isFirstAdmin = Number(adminRows[0]?.admin_count || 0) === 0;

  const allowed = isFirstAdmin ? 1 : 0;
  const role = isFirstAdmin ? 'admin' : 'viewer';

  const username = discordUser.username || '';
  const globalName = discordUser.global_name || null;
  const email = discordUser.email || null;
  const avatar = discordUser.avatar || null;

  await loginDB.execute(
    `
      INSERT INTO guildsync_users (
        discord_user_id,
        username,
        global_name,
        email,
        avatar,
        allowed,
        role,
        requested_at,
        last_login_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        username = VALUES(username),
        global_name = VALUES(global_name),
        avatar = VALUES(avatar),
        role = IF(revoked_at IS NOT NULL, 'viewer', role),
        requested_at = IF(revoked_at IS NOT NULL, VALUES(requested_at), requested_at),
        approved_at = IF(revoked_at IS NOT NULL, NULL, approved_at),
        revoked_at = NULL,
        last_login_at = VALUES(last_login_at)
      `,
    [
      discordUser.id,
      username,
      globalName,
      email,
      avatar,
      allowed,
      role,
      now,
      now
    ]
  );

  const [rows] = await loginDB.execute(
    `
      SELECT *
      FROM guildsync_users
      WHERE discord_user_id = ?
    `,
    [discordUser.id]
  );

  return rows[0] || null;
}

export async function upsertDiscordRoles(applicationDB, payload) {
  const roles = Array.isArray(payload.roles) ? payload.roles : [];

  const connection = await applicationDB.getConnection();

  try {
    await connection.beginTransaction();

    for (const role of roles) {
      const roleID = String(role.role_id || role.id || '').trim();
      const roleName = String(role.role_name || role.name || '').trim();
      const roleColor = role.role_color ?? null;

      if (!roleID) {
        continue;
      }

      await connection.execute(
        `
          INSERT INTO discord_roles (
            role_id,
            role_name,
            role_color
          )
          VALUES (
            ?,
            ?,
            ?
          )
          ON DUPLICATE KEY UPDATE
            role_name = VALUES(role_name),
            role_color = VALUES(role_color)
        `,
        [
          roleID,
          roleName || 'Unnamed Role',
          roleColor
        ]
      );
    }


    await connection.commit();
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }

  return {
    roles_processed: roles.length
  };
}


export async function upsertDiscordMembers(applicationDB, payload) {
  const rawMembers = Array.isArray(payload?.members)
    ? payload.members
    : Array.isArray(payload)
      ? payload
      : [];
  const members = rawMembers.map((member) => normalizeDiscordMemberPayload(member));
  const source = String(payload?.source || 'full_sync').trim().slice(0, 64) || 'full_sync';

  if (members.length === 0) {
    return {
      members_processed: 0,
      members_removed: 0,
      member_roles_processed: 0,
      history_events_recorded: 0
    };
  }

  const connection = await applicationDB.getConnection();

  let membersProcessed = 0;
  let membersRemoved = 0;
  let memberRolesProcessed = 0;
  let historyEventsRecorded = 0;

  try {
    await connection.beginTransaction();

    await connection.execute(`
      UPDATE discord_members
      SET import_current = 0
    `);

    for (const member of members) {
      if (!member.discord_id) {
        continue;
      }

      const existing = await getDiscordMemberSnapshot(connection, member.discord_id);
      const existingRoleIDs = await getDiscordMemberRoleIDs(connection, member.discord_id);
      const newRoleIDs = getRoleIDsFromMember(member);

      historyEventsRecorded += await recordDiscordMemberSnapshotHistory(
        connection,
        existing,
        existingRoleIDs,
        member,
        newRoleIDs,
        source
      );

      await connection.execute(
        `
          INSERT INTO discord_members (
            discord_id,
            avatar,
            username,
            global_name,
            server_nickname,
            import_current
          )
          VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
          ON DUPLICATE KEY UPDATE
            avatar = VALUES(avatar),
            username = VALUES(username),
            global_name = VALUES(global_name),
            server_nickname = VALUES(server_nickname),
            import_current = VALUES(import_current)
        `,
        [
          member.discord_id,
          member.avatar || null,
          member.username || '',
          member.global_name || null,
          member.server_nickname || null,
          1
        ]
      );

      await connection.execute(
        `
          DELETE FROM discord_member_roles
          WHERE discord_id = ?
        `,
        [member.discord_id]
      );

      for (const roleID of newRoleIDs) {
        await connection.execute(
          `
            INSERT IGNORE INTO discord_member_roles (
              discord_id,
              role_id
            )
            VALUES (
              ?,
              ?
            )
          `,
          [
            member.discord_id,
            roleID
          ]
        );

        memberRolesProcessed += 1;
      }

      membersProcessed += 1;
    }

    const [removedMembers] = await connection.execute(`
      SELECT
        discord_id,
        avatar,
        username,
        global_name,
        server_nickname
      FROM discord_members
      WHERE import_current = 0
    `);

    for (const removedMember of removedMembers) {
      historyEventsRecorded += await insertDiscordMemberHistory(connection, {
        member: removedMember,
        event_type: 'left_server',
        field_name: null,
        old_value: summarizeDiscordMember(removedMember),
        new_value: null,
        source
      });
    }

    const [deleteResult] = await connection.execute(`
      DELETE FROM discord_members
      WHERE import_current = 0
    `);

    membersRemoved = deleteResult.affectedRows || 0;

    await connection.commit();
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }

  await setDiscordRefreshNow(applicationDB);
  await runMemberAutoLinking(applicationDB);

  return {
    members_processed: membersProcessed,
    members_removed: membersRemoved,
    member_roles_processed: memberRolesProcessed,
    history_events_recorded: historyEventsRecorded
  };
}

export async function upsertDiscordMember(applicationDB, payload) {
  const member = normalizeDiscordMemberPayload(payload?.member || payload);
  const source = String(payload?.source || member.source || 'live_event').trim().slice(0, 64) || 'live_event';

  if (!member.discord_id) {
    return {
      members_processed: 0,
      member_roles_processed: 0,
      history_events_recorded: 0
    };
  }

  const connection = await applicationDB.getConnection();
  let memberRolesProcessed = 0;
  let historyEventsRecorded = 0;

  try {
    await connection.beginTransaction();

    const existing = await getDiscordMemberSnapshot(connection, member.discord_id);
    const existingRoleIDs = await getDiscordMemberRoleIDs(connection, member.discord_id);
    const newRoleIDs = getRoleIDsFromMember(member);

    historyEventsRecorded += await recordDiscordMemberSnapshotHistory(
      connection,
      existing,
      existingRoleIDs,
      member,
      newRoleIDs,
      source
    );

    await connection.execute(
      `
        INSERT INTO discord_members (
          discord_id,
          avatar,
          username,
          global_name,
          server_nickname,
          import_current
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
        ON DUPLICATE KEY UPDATE
          avatar = VALUES(avatar),
          username = VALUES(username),
          global_name = VALUES(global_name),
          server_nickname = VALUES(server_nickname),
          import_current = VALUES(import_current)
      `,
      [
        member.discord_id,
        member.avatar || null,
        member.username || '',
        member.global_name || null,
        member.server_nickname || null,
        1
      ]
    );

    await connection.execute(
      `
        DELETE FROM discord_member_roles
        WHERE discord_id = ?
      `,
      [member.discord_id]
    );

    for (const roleID of newRoleIDs) {
      await connection.execute(
        `
          INSERT IGNORE INTO discord_member_roles (
            discord_id,
            role_id
          )
          VALUES (
            ?,
            ?
          )
        `,
        [
          member.discord_id,
          roleID
        ]
      );

      memberRolesProcessed += 1;
    }

    await connection.commit();
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }

  await setDiscordRefreshNow(applicationDB);
  await runMemberAutoLinking(applicationDB);

  return {
    members_processed: 1,
    member_roles_processed: memberRolesProcessed,
    history_events_recorded: historyEventsRecorded
  };
}

export async function deleteDiscordMember(applicationDB, payload) {
  const memberID = String(payload?.discord_id || payload?.id || payload || '').trim();
  const source = String(payload?.source || 'live_event').trim().slice(0, 64) || 'live_event';

  if (!memberID) {
    return {
      members_removed: 0,
      history_events_recorded: 0
    };
  }

  const connection = await applicationDB.getConnection();
  let membersRemoved = 0;
  let historyEventsRecorded = 0;

  try {
    await connection.beginTransaction();

    const existing = await getDiscordMemberSnapshot(connection, memberID);

    if (existing) {
      historyEventsRecorded += await insertDiscordMemberHistory(connection, {
        member: existing,
        event_type: 'left_server',
        field_name: null,
        old_value: summarizeDiscordMember(existing),
        new_value: null,
        source
      });
    }

    const [result] = await connection.execute(
      `
        DELETE FROM discord_members
        WHERE discord_id = ?
      `,
      [memberID]
    );

    membersRemoved = result.affectedRows || 0;

    await connection.commit();
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }

  await setDiscordRefreshNow(applicationDB);

  return {
    members_removed: membersRemoved,
    history_events_recorded: historyEventsRecorded
  };
}

export async function upsertDiscordRole(applicationDB, role) {
  const roleID = String(role?.role_id || role?.id || '').trim();
  const roleName = String(role?.role_name || role?.name || '').trim();
  const roleColor = role?.role_color ?? null;

  if (!roleID) {
    return {
      roles_processed: 0
    };
  }

  await applicationDB.execute(
    `
      INSERT INTO discord_roles (
        role_id,
        role_name,
        role_color
      )
      VALUES (
        ?,
        ?,
        ?
      )
      ON DUPLICATE KEY UPDATE
        role_name = VALUES(role_name),
        role_color = VALUES(role_color)
    `,
    [
      roleID,
      roleName || 'Unnamed Role',
      roleColor
    ]
  );

  await setDiscordRefreshNow(applicationDB);

  return {
    roles_processed: 1
  };
}

export async function deleteDiscordRole(applicationDB, roleID) {
  const discordRoleID = String(roleID || '').trim();

  if (!discordRoleID) {
    return {
      roles_removed: 0
    };
  }

  const [result] = await applicationDB.execute(
    `
      DELETE FROM discord_roles
      WHERE role_id = ?
    `,
    [discordRoleID]
  );

  await setDiscordRefreshNow(applicationDB);

  return {
    roles_removed: result.affectedRows || 0
  };
}

function getRoleIDsFromMember(member) {
  if (!Array.isArray(member.roles)) {
    return [];
  }

  const roleIDs = new Set();

  for (const role of member.roles) {
    const roleID = typeof role === 'object' && role !== null
      ? String(role.role_id || role.id || '').trim()
      : String(role || '').trim();

    if (roleID) {
      roleIDs.add(roleID);
    }
  }

  return [...roleIDs];
}


export async function updateDiscordMemberLastSeen(applicationDB, payload = {}) {
  const discordID = String(payload.discord_id || payload.id || '').trim();
  const username = String(payload.username || '').trim();
  const action = String(payload.action || 'unknown').trim().slice(0, 64);
  const timestamp = String(payload.timestamp || '').trim().slice(0, 25);

  if (!discordID && !username) {
    return {
      updated: 0
    };
  }

  if (!timestamp) {
    throw new Error('Missing last_seen timestamp.');
  }

  const activitySeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const weekAgoSeconds = nowSeconds - (7 * 24 * 60 * 60);
  const isHistoricalUpdate = action === 'historical_message_scan' || String(payload.source || '').trim() === 'historical_scan';

  const lookupParameters = [];
  let whereSql = 'discord_id = ?';

  if (discordID) {
    lookupParameters.push(discordID);
  } else {
    whereSql = 'username = ?';
    lookupParameters.push(username);
  }

  if (isHistoricalUpdate) {
    if (!Number.isFinite(activitySeconds) || activitySeconds < weekAgoSeconds) {
      return {
        updated: 0,
        skipped: true,
        reason: 'Historical activity is older than one week.',
        discord_id: discordID || null,
        username: username || null,
        last_seen: timestamp,
        last_seen_action: action || 'unknown'
      };
    }

    const [existingRows] = await applicationDB.execute(
      `
        SELECT last_seen
        FROM discord_members
        WHERE ${whereSql}
        LIMIT 1
      `,
      lookupParameters
    );

    const priorLastSeen = Number(existingRows[0]?.last_seen || 0);

    if (Number.isFinite(priorLastSeen) && priorLastSeen >= weekAgoSeconds) {
      return {
        updated: 0,
        skipped: true,
        reason: 'Existing last-seen value is already within the last week.',
        discord_id: discordID || null,
        username: username || null,
        last_seen: timestamp,
        last_seen_action: action || 'unknown'
      };
    }
  }

  const parameters = [timestamp, action || 'unknown', ...lookupParameters];

  const [result] = await applicationDB.execute(
    `
      UPDATE discord_members
      SET
        last_seen = ?,
        last_seen_action = ?
      WHERE ${whereSql}
    `,
    parameters
  );

  if (result.affectedRows > 0) {
    await setDiscordRefreshNow(applicationDB);
  }

  return {
    updated: result.affectedRows || 0,
    discord_id: discordID || null,
    username: username || null,
    last_seen: timestamp,
    last_seen_action: action || 'unknown'
  };
}

export async function getDiscordHistoricalScanStatus(applicationDB) {
  const completed = await getSettingValue(applicationDB, 'discord_historical_scan_completed');
  const completedAt = await getSettingValue(applicationDB, 'discord_historical_scan_completed_at');
  const nowMs = Date.now();
  const completedAtMs = completedAt ? Date.parse(completedAt) : NaN;
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const shouldRun = !completedAt || Number.isNaN(completedAtMs) || nowMs - completedAtMs >= oneWeekMs;

  return {
    completed: completed === '1',
    completed_at: completedAt,
    should_run: shouldRun,
    next_allowed_at: completedAt && !Number.isNaN(completedAtMs)
      ? new Date(completedAtMs + oneWeekMs).toISOString()
      : null
  };
}

export async function markDiscordHistoricalScanComplete(applicationDB, payload = {}) {
  const completedAt = new Date().toISOString();
  const messageCount = String(payload.message_count || 0);
  const memberCount = String(payload.member_count || 0);

  await setSetting(applicationDB, 'discord_historical_scan_completed', '1');
  await setSetting(applicationDB, 'discord_historical_scan_completed_at', completedAt);
  await setSetting(applicationDB, 'discord_historical_scan_message_count', messageCount);
  await setSetting(applicationDB, 'discord_historical_scan_member_count', memberCount);

  await setDiscordRefreshNow(applicationDB);

  return {
    completed: true,
    completed_at: completedAt,
    message_count: messageCount,
    member_count: memberCount
  };
}

export async function getDiscordDataDate(applicationDB) {
  const [rows] = await applicationDB.execute(
    `
      SELECT
        setting_key AS data,
        value
      FROM guildsync_settings
      WHERE setting_key = ?
      LIMIT 1
    `,
    [
      'discord_refresh'
    ]
  );

  return rows[0] || {
    data: 'discord_refresh',
    value: null
  };
}

export async function getDiscordMemberDataJSON(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT JSON_ARRAYAGG(
      JSON_OBJECT(
        'discord_id', member_rows.discord_id,
        'username', member_rows.username,
        'global_name', member_rows.global_name,
        'server_nickname', member_rows.server_nickname,
        'last_seen', member_rows.last_seen,
        'last_seen_action', member_rows.last_seen_action,
        'avatar', member_rows.avatar,
        'roles', member_rows.roles
      )
    ) AS members_json
    FROM (
      SELECT
        dm.discord_id,
        dm.username,
        dm.global_name,
        dm.server_nickname,
        dm.last_seen,
        dm.last_seen_action,
        dm.avatar,
        COALESCE(r.roles, JSON_ARRAY()) AS roles
      FROM discord_members dm
      LEFT JOIN (
        SELECT
          dmr.discord_id,
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'role_id', dr.role_id,
              'role_name', dr.role_name,
              'role_color', dr.role_color
            )
          ) AS roles
        FROM discord_member_roles dmr
        JOIN discord_roles dr
          ON dmr.role_id = dr.role_id
        GROUP BY dmr.discord_id
      ) r
        ON dm.discord_id = r.discord_id
      ORDER BY
        dm.server_nickname,
        dm.username
    ) AS member_rows
  `);

  const membersJson = rows[0]?.members_json;

  if (!membersJson) {
    return [];
  }

  if (typeof membersJson === 'string') {
    return JSON.parse(membersJson);
  }

  return membersJson;
}








export async function getDiscordRoleDataJSON(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT
      role_id,
      role_name,
      role_color
    FROM discord_roles
    ORDER BY role_name
  `);

  return rows;
}

export async function getDiscordMemberHistoryMatches(applicationDB, query = '') {
  const search = String(query || '').trim();

  if (!search) {
    return [];
  }

  const like = `%${search}%`;
  const [rows] = await applicationDB.execute(
    `
      SELECT
        h.discord_id AS discord_id,
        COALESCE(MAX(NULLIF(dm.username, '')), MAX(NULLIF(h.username, '')), h.discord_id) AS username,
        COALESCE(MAX(NULLIF(dm.global_name, '')), MAX(NULLIF(h.global_name, ''))) AS global_name,
        COALESCE(MAX(NULLIF(dm.server_nickname, '')), MAX(NULLIF(h.server_nickname, ''))) AS server_nickname,
        COUNT(*) AS event_count,
        MAX(h.event_datetime) AS last_event_datetime
      FROM discord_member_history h
      LEFT JOIN discord_members dm
        ON dm.discord_id = h.discord_id
      WHERE h.discord_id LIKE ?
        OR h.username LIKE ?
        OR h.global_name LIKE ?
        OR h.server_nickname LIKE ?
        OR dm.username LIKE ?
        OR dm.global_name LIKE ?
        OR dm.server_nickname LIKE ?
      GROUP BY h.discord_id
      ORDER BY
        LOWER(COALESCE(
          MAX(NULLIF(dm.server_nickname, '')),
          MAX(NULLIF(h.server_nickname, '')),
          MAX(NULLIF(dm.global_name, '')),
          MAX(NULLIF(h.global_name, '')),
          MAX(NULLIF(dm.username, '')),
          MAX(NULLIF(h.username, '')),
          h.discord_id
        )) ASC,
        h.discord_id ASC
      LIMIT 50
    `,
    [like, like, like, like, like, like, like]
  );

  return rows;
}

export async function getDiscordMemberHistoryForMember(applicationDB, discordID) {
  const memberID = String(discordID || '').trim();

  if (!memberID) {
    return [];
  }

  const [rows] = await applicationDB.execute(
    `
      SELECT
        history_id,
        discord_id,
        username,
        global_name,
        server_nickname,
        event_type,
        field_name,
        old_value,
        new_value,
        event_timestamp,
        event_datetime,
        source,
        initiator
      FROM discord_member_history
      WHERE discord_id = ?
      ORDER BY event_datetime DESC, history_id DESC
      LIMIT 300
    `,
    [memberID]
  );

  return rows;
}


export async function getBankingHistoryMatches(applicationDB, query = '') {
  const cleanQuery = String(query || '').trim();

  if (!cleanQuery) {
    return [];
  }

  const like = `%${cleanQuery}%`;
  const [rows] = await applicationDB.execute(
    `
      SELECT
        account_name,
        COUNT(*) AS record_count,
        MAX(CAST(event_timestamp AS UNSIGNED)) AS last_event_timestamp
      FROM guildsync_banking_entries
      WHERE account_name LIKE ?
      GROUP BY account_name
      ORDER BY LOWER(account_name) ASC
      LIMIT 50
    `,
    [like]
  );

  return rows;
}

export async function getBankingHistoryForAccount(applicationDB, accountName = '') {
  const cleanAccountName = String(accountName || '').trim();

  if (!cleanAccountName) {
    return [];
  }

  const [rows] = await applicationDB.execute(
    `
      SELECT
        event_id,
        transaction_type,
        account_name,
        event_timestamp,
        event_datetime,
        deposit_amount,
        COALESCE(ticket_quantity, 0) AS ticket_quantity,
        data_source,
        note
      FROM guildsync_banking_entries
      WHERE LOWER(account_name) = LOWER(?)
      ORDER BY CAST(event_timestamp AS UNSIGNED) ASC, CAST(event_id AS UNSIGNED) ASC
      LIMIT 500
    `,
    [cleanAccountName]
  );

  const versions = await getRaffleBonusVersions(applicationDB);
  const overrides = await getRaffleBonusOverrides(applicationDB);
  return rows.map((row) => ({ ...row, ...calculateBankingEntryBonus({
    type: row.transaction_type, time: row.event_timestamp, ticketAmount: row.ticket_quantity, dataSource: row.data_source
  }, versions, overrides) }));
}

export async function getBankingDataDate(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT
      setting_key AS data,
      value
    FROM guildsync_settings
    WHERE setting_key = ?
    LIMIT 1
  `,
    [
      'banking_refresh'
    ]
  );

  return rows[0] || {
    data: 'banking_refresh',
    value: null
  };
}

function raffleBonusEnabledByType(settings) {
  if (settings?.enabledByType != null) {
    if (typeof settings.enabledByType.biweekly !== 'boolean' || typeof settings.enabledByType.monthly !== 'boolean') {
      throw new Error('Provide a bonus enabled switch for both bi-weekly and 50/50 raffles.');
    }
    return { biweekly: settings.enabledByType.biweekly, monthly: settings.enabledByType.monthly };
  }
  if (typeof settings?.enabled !== 'boolean') throw new Error('Provide bonus enabled settings.');
  return { biweekly: settings.enabled, monthly: settings.enabled };
}

export async function getRaffleBonusSettings(applicationDB) {
  const saved = await getSettingValue(applicationDB, 'raffle_bonus_settings');
  const defaults = {
    enabled: String(process.env.GUILDSYNC_RAFFLE_BONUS_ENABLED || 'true').toLowerCase() !== 'false',
    biweekly: parseBonusTiers(process.env.GUILDSYNC_BIWEEKLY_BONUS_TIERS || DEFAULT_BONUS_TIERS.biweekly),
    monthly: parseBonusTiers(process.env.GUILDSYNC_MONTHLY_BONUS_TIERS || DEFAULT_BONUS_TIERS.monthly)
  };
  defaults.enabledByType = raffleBonusEnabledByType(defaults);
  defaults.envDefaults={enabled:defaults.enabled,enabledByType:defaults.enabledByType,biweekly:defaults.biweekly,monthly:defaults.monthly};
  defaults.source='.env';
  if (!saved) return defaults;
  try {
    const parsed = JSON.parse(saved);
    return {
      source:'GuildSync override',envDefaults:defaults.envDefaults,
      enabled: Object.values(raffleBonusEnabledByType(parsed)).some(Boolean),
      enabledByType: raffleBonusEnabledByType(parsed),
      biweekly: parseBonusTiers(parsed.biweekly.map(({ hours, percent }) => `${hours}:${percent}`).join(',')),
      monthly: parseBonusTiers(parsed.monthly.map(({ hours, percent }) => `${hours}:${percent}`).join(','))
    };
  } catch (error) {
    throw new Error(`Saved raffle bonus settings are invalid: ${error.message}`);
  }
}

async function initializeRaffleBonusVersions(db) {
  const settings = await getRaffleBonusSettings(db);
  const effectiveFrom = Math.floor(Date.now() / 1000);
  for (const type of ['biweekly', 'monthly']) {
    const [latest] = await db.execute(`
      SELECT enabled, tiers_json FROM guildsync_raffle_bonus_versions
      WHERE raffle_type = ? ORDER BY effective_from DESC, id DESC LIMIT 1
    `, [type]);
    if (latest.length && Boolean(Number(latest[0].enabled)) === settings.enabledByType[type] &&
        JSON.stringify(JSON.parse(latest[0].tiers_json)) === JSON.stringify(settings[type])) continue;
    await db.execute(`
      INSERT INTO guildsync_raffle_bonus_versions (raffle_type, effective_from, enabled, tiers_json)
      VALUES (?, ?, ?, ?)
    `, [type, effectiveFrom, settings.enabledByType[type] ? 1 : 0, JSON.stringify(settings[type])]);
  }
}

export async function getRaffleBonusVersions(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT raffle_type, effective_from, enabled, tiers_json
    FROM guildsync_raffle_bonus_versions
    ORDER BY effective_from ASC, id ASC
  `);
  return rows.map((row) => ({
    type: row.raffle_type,
    effectiveFrom: Number(row.effective_from),
    enabled: Boolean(Number(row.enabled)),
    tiers: typeof row.tiers_json === 'string' ? JSON.parse(row.tiers_json) : row.tiers_json
  }));
}

export async function getRaffleBonusOverrides(applicationDB) {
  const [rows] = await applicationDB.execute(
    'SELECT raffle_type, sales_end, enabled, tiers_json FROM guildsync_raffle_bonus_overrides');
  return rows.map((row) => ({
    type: row.raffle_type, salesEnd: Number(row.sales_end), enabled: Boolean(Number(row.enabled)),
    tiers: typeof row.tiers_json === 'string' ? JSON.parse(row.tiers_json) : row.tiers_json
  }));
}

export async function getRaffleBonusChoices(applicationDB, versions = null, overrides = null) {
  const [rows] = await applicationDB.execute(
    'SELECT transaction_type, event_timestamp FROM guildsync_banking_entries WHERE ticket_quantity > 0');
  const policies = versions || await getRaffleBonusVersions(applicationDB);
  const saved = overrides || await getRaffleBonusOverrides(applicationDB);
  const defaultSettings = await getRaffleBonusSettings(applicationDB);
  const choices = new Map();
  for (const row of rows) {
    const window = getAssociateTicketReportRaffleWindow(row);
    if (!window) continue;
    const key = `${window.type}:${window.salesEnd}`;
    if (choices.has(key)) continue;
    const override = saved.find((item) => item.type === window.type && item.salesEnd === window.salesEnd);
    const inherited = selectRaffleBonusSettings(policies, [], window.type, window.salesEnd);
    const policy = override || inherited;
    choices.set(key, {
      type: window.type, salesEnd: window.salesEnd, raffleTime: window.raffleTime,
      label: `${window.label} | Raffle ${formatAssociateTicketReportShortDateEastern(window.raffleTime)}`,
      enabled: policy?.enabled ?? false, tiers: policy?.tiers || defaultSettings[window.type], overridden: Boolean(override),
      inheritedSettings:{enabled:inherited?.enabled ?? false,tiers:inherited?.tiers || defaultSettings[window.type]}
    });
  }
  return [...choices.values()].sort((a, b) => b.salesEnd - a.salesEnd);
}

export async function saveRaffleBonusOverride(applicationDB, input) {
  const type = input?.raffleType;
  const salesEnd = Number(input?.salesEnd);
  if(input?.resetToDefaults === true){
    if(!['monthly','biweekly'].includes(type)||!Number.isSafeInteger(salesEnd)||salesEnd<=0)throw Error('Select a valid raffle.');
    await applicationDB.execute('DELETE FROM guildsync_raffle_bonus_overrides WHERE raffle_type = ? AND sales_end = ?',[type,salesEnd]);
    return;
  }
  if (!['monthly', 'biweekly'].includes(type) || !Number.isSafeInteger(salesEnd) || salesEnd <= 0 ||
      typeof input.enabled !== 'boolean' || !Array.isArray(input.tiers)) {
    throw new Error('Select a raffle and provide its bonus settings.');
  }
  const tiers = parseBonusTiers(input.tiers.map(({ hours, percent }) => `${hours}:${percent}`).join(','));
  const [rows] = await applicationDB.execute(
    'SELECT transaction_type, event_timestamp FROM guildsync_banking_entries WHERE transaction_type = ? AND ticket_quantity > 0', [type]);
  if (!rows.some((row) => getAssociateTicketReportRaffleWindow(row)?.salesEnd === salesEnd)) {
    throw new Error('The selected raffle has no ticket purchases.');
  }
  await applicationDB.execute(`
    INSERT INTO guildsync_raffle_bonus_overrides (raffle_type, sales_end, enabled, tiers_json)
    VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), tiers_json = VALUES(tiers_json)
  `, [type, salesEnd, input.enabled ? 1 : 0, JSON.stringify(tiers)]);
}

export async function saveRaffleBonusSettings(applicationDB, input) {
  const resetToDefaults = input?.resetToDefaults === true;
  if(resetToDefaults){
    const enabled = String(process.env.GUILDSYNC_RAFFLE_BONUS_ENABLED || 'true').toLowerCase() !== 'false';
    input={enabledByType:{biweekly:enabled,monthly:enabled},
      biweekly:parseBonusTiers(process.env.GUILDSYNC_BIWEEKLY_BONUS_TIERS || DEFAULT_BONUS_TIERS.biweekly),
      monthly:parseBonusTiers(process.env.GUILDSYNC_MONTHLY_BONUS_TIERS || DEFAULT_BONUS_TIERS.monthly)};
  }
  if (!Array.isArray(input?.biweekly) || !Array.isArray(input?.monthly)) {
    throw new Error('Provide biweekly tiers and monthly tiers.');
  }
  const enabledByType = raffleBonusEnabledByType(input);
  const settings = {
    enabled: Object.values(enabledByType).some(Boolean),
    enabledByType,
    biweekly: parseBonusTiers(input.biweekly.map(({ hours, percent }) => `${hours}:${percent}`).join(',')),
    monthly: parseBonusTiers(input.monthly.map(({ hours, percent }) => `${hours}:${percent}`).join(','))
  };
  for (const [type, tiers] of Object.entries(settings)) {
    if (!['biweekly', 'monthly'].includes(type)) continue;
    const availableHours = type === 'biweekly' ? 14 * 24 : 28 * 24;
    const configuredHours = tiers.reduce((sum, tier) => sum + tier.hours, 0);
    if (configuredHours > availableHours) {
      throw new Error(`${type === 'biweekly' ? 'Bi-weekly' : '50/50'} bonus periods total ${configuredHours} hours, but this raffle is only ${availableHours} hours long. Reduce the period hours and save again.`);
    }
  }
  const connection = await applicationDB.getConnection();
  try {
    await connection.beginTransaction();
    const previous = await getRaffleBonusSettings(connection);
    if(resetToDefaults)await connection.execute('DELETE FROM guildsync_settings WHERE setting_key = ?',['raffle_bonus_settings']);
    else await setSetting(connection, 'raffle_bonus_settings', JSON.stringify(settings));
    const effectiveFrom = Math.floor(Date.now() / 1000);
    for (const type of ['biweekly', 'monthly']) {
      if (previous.enabledByType[type] === settings.enabledByType[type] &&
          JSON.stringify(previous[type]) === JSON.stringify(settings[type])) continue;
      await connection.execute(`
        INSERT INTO guildsync_raffle_bonus_versions (raffle_type, effective_from, enabled, tiers_json)
        VALUES (?, ?, ?, ?)
      `, [type, effectiveFrom, settings.enabledByType[type] ? 1 : 0, JSON.stringify(settings[type])]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return settings;
}

// Refresh dates use the same schedule's calendar boundaries, at 19:00 Eastern.
// Convert each boundary separately so daylight-saving changes do not shift it.
const raffleLocalParts = timestamp => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date(timestamp * 1000)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
function raffleEvening({ year, month, day }) {
  const target = Date.UTC(year, month - 1, day, 19) / 1000;
  let timestamp = target;
  for (let i = 0; i < 2; i++) {
    const local = raffleLocalParts(timestamp);
    timestamp += target - Date.UTC(local.year, local.month - 1, local.day, local.hour) / 1000;
  }
  return timestamp;
}
export function getRaffleRefreshSelection(date, now = Math.floor(Date.now() / 1000), boundaryChoices = {}) {
  let lookupAt = now;
  let dateNormalization;
  if (date !== undefined) {
    dateNormalization = normalizeRaffleDate(date);
    date = dateNormalization.value;
    const month = Number(date.slice(0, 2)), day = Number(date.slice(2, 4)), year = 2000 + Number(date.slice(4));
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
      throw new Error('Enter a valid calendar date in MMDDYY format.');
    }
    lookupAt = raffleEvening({ year, month, day });
  }
  const local = raffleLocalParts(lookupAt);
  const noon = Date.UTC(local.year, local.month - 1, local.day, 12) / 1000;
  const raffles = ['biweekly', 'monthly'].map(type => {
    const next = type === 'biweekly' ? getDepositMailBiweeklySalesEndAtOrAfter : getDepositMailMonthlySalesEndAtOrAfter;
    let cutoff = next(noon);
    let end = raffleEvening(raffleLocalParts(cutoff));
    if (lookupAt >= end) {
      cutoff = next(cutoff + 1);
      end = raffleEvening(raffleLocalParts(cutoff));
    }
    const previous = type === 'biweekly' ? cutoff - BANKING_BIWEEKLY_INTERVAL_SECONDS : getDepositMailPreviousMonthlySalesEnd(cutoff);
    return { type, label: type === 'biweekly' ? 'Bi-Weekly' : '50/50', start: raffleEvening(raffleLocalParts(previous)), end };
  });
  const boundaryTypes = date === undefined ? [] : raffles.filter(raffle => raffle.type === 'biweekly' && raffle.start === lookupAt).map(raffle => raffle.type);
  for (const type of boundaryTypes) {
    const choice = boundaryChoices[type];
    if (choice !== undefined && !['starts','ends'].includes(choice)) throw Error('Invalid raffle boundary choice.');
    if (choice === 'ends') {
      const previous = getRaffleRefreshSelection(undefined, lookupAt - 1).raffles.find(raffle => raffle.type === type);
      raffles[raffles.findIndex(raffle => raffle.type === type)] = previous;
    }
  }
  if (date !== undefined) {
    const biweekly = raffles.find(raffle => raffle.type === 'biweekly');
    const monthly = getRaffleRefreshSelection(undefined, biweekly.start + 1).raffles.find(raffle => raffle.type === 'monthly');
    if (monthly.start > biweekly.start || monthly.end < biweekly.end) throw Error('Selected Bi-Weekly raffle is not contained in a single 50/50 raffle.');
    raffles[raffles.findIndex(raffle => raffle.type === 'monthly')] = monthly;
  }
  return { asOf: now, lookupAt, timeZone: 'America/New_York', raffles, boundaryTypes, ...(dateNormalization ? { dateNormalization } : {}) };
}

export function selectSheetsCatchupEntries(entries, now = Math.floor(Date.now() / 1000)) {
  const windows = getSheetsRaffleWindows(now);
  return entries.filter(entry => {
    const period = getAssociateTicketReportRaffleWindow(entry);
    return Number(entry.time) <= now && period && windows.some(window => window.type === period.type && window.salesEnd === period.salesEnd);
  }).sort((a, b) => Number(a.time) - Number(b.time) || String(a.eventId).localeCompare(String(b.eventId)));
}

export function getSheetsRaffleWindows(now = Math.floor(Date.now() / 1000)) {
  return ['biweekly', 'monthly'].map(type => {
    const salesEnd = type === 'monthly'
      ? getDepositMailMonthlySalesEndAtOrAfter(now)
      : getDepositMailBiweeklySalesEndAtOrAfter(now);
    return { type, salesEnd, drawTime: salesEnd + BANKING_RAFFLE_AFTER_SALES_SECONDS };
  });
}

export async function getActiveRaffleSummary(applicationDB, now = Math.floor(Date.now() / 1000)) {
  const entries = await getBankingDataJSON(applicationDB);
  const bonusVersions = await getRaffleBonusVersions(applicationDB);
  const bonusOverrides = await getRaffleBonusOverrides(applicationDB);
  const raffles = ['biweekly', 'monthly'].map((type) => {
    // Selection advances at draw time, not at the earlier ticket cutoff.
    // +1 makes the next raffle active at the exact draw-time boundary.
    const reference = now - BANKING_RAFFLE_AFTER_SALES_SECONDS + 1;
    const salesEnd = type === 'monthly'
      ? getDepositMailMonthlySalesEndAtOrAfter(reference)
      : getDepositMailBiweeklySalesEndAtOrAfter(reference);
    const previousSalesEnd = type === 'monthly'
      ? getDepositMailPreviousMonthlySalesEnd(salesEnd)
      : salesEnd - BANKING_BIWEEKLY_INTERVAL_SECONDS;
    const salesStart = previousSalesEnd + 1;
    const rows = entries.filter((entry) => normalizeDepositMailTicketType(entry.type) === type &&
      Number(entry.time) > previousSalesEnd && Number(entry.time) <= salesEnd && Number(entry.time) <= now);
    const deposits = rows.reduce((sum, entry) => {
      const amount = Number(entry.amount) || 0;
      const digit = Math.abs(Math.trunc(amount)) % 10;
      const marker = digit === 1 || digit === 3 ? digit : 0;
      return sum + (marker && amount > marker ? amount - marker : amount);
    }, 0);
    const prizeGold = type === 'biweekly'
      ? Math.ceil(Math.max(0, deposits) / 2 / 200000) * 200000
      : Math.floor(Math.max(0, deposits) / 2);
    const bonus = getCurrentRaffleBonusInfo(type, salesEnd, salesStart, now, bonusVersions, bonusOverrides);
    return {
      id: `${type}:${salesEnd}`, type, label: getDepositMailTicketTypeLabel(type),
      activeStart: previousSalesEnd + BANKING_RAFFLE_AFTER_SALES_SECONDS,
      salesStart: previousSalesEnd + 1, salesEnd,
      drawTime: salesEnd + BANKING_RAFFLE_AFTER_SALES_SECONDS,
      salesOpen: now < salesEnd, prizeGold,
      latestTransactionAt: rows.reduce((latest, entry) => Math.max(latest, Number(entry.time)), 0) || null,
      ...(type === 'biweekly' ? { drawCount: prizeGold / 200000, goldPerDraw: 200000 } : {}),
      totalTickets: rows.reduce((sum, entry) => sum + (Number(entry.totalTickets) || 0), 0),
      bonusEnabled: bonus.enabled,
      bonusTickets: rows.reduce((sum, entry) => sum + (Number(entry.bonusTickets) || 0), 0),
      bonusPercent: bonus.percent,
      bonusExpiresAt: bonus.expiresAt,
      ...(bonus.nextPercent > 0 ? { nextBonusPercent: bonus.nextPercent, nextBonusExpiresAt: bonus.nextExpiresAt } : {})
    };
  });
  return { asOf: now, raffles };
}

function getCurrentRaffleBonusInfo(type, salesEnd, salesStart, now, versions, overrides) {
  const policy = selectRaffleBonusSettings(versions, overrides, type, salesEnd, now);
  if (!policy?.enabled || now >= salesEnd || now < salesStart || !Array.isArray(policy.tiers)) {
    return { enabled: false, percent: 0, expiresAt: salesEnd, nextPercent: 0, nextExpiresAt: salesEnd };
  }
  const totalHours = policy.tiers.reduce((sum, tier) => sum + Number(tier.hours || 0), 0);
  const elapsedHours = Math.max(0, (now - (salesEnd - totalHours * 3600)) / 3600);
  let cumulative = 0;
  for (let index = 0; index < policy.tiers.length; index += 1) {
    const tier = policy.tiers[index];
    const endElapsed = cumulative + Number(tier.hours || 0);
    if (elapsedHours < endElapsed) {
      const expiresAt = Math.min(salesEnd, Math.floor(salesEnd - (totalHours - endElapsed) * 3600));
      const next = policy.tiers[index + 1];
      const nextExpiresAt = next ? Math.min(salesEnd, Math.floor(expiresAt + Number(next.hours || 0) * 3600)) : salesEnd;
      return { enabled: Number(tier.percent) > 0, percent: Number(tier.percent) || 0, expiresAt, nextPercent: next ? Number(next.percent) || 0 : 0, nextExpiresAt };
    }
    cumulative = endElapsed;
  }
  return { enabled: false, percent: 0, expiresAt: salesEnd, nextPercent: 0, nextExpiresAt: salesEnd };
}

export async function getRaffleUserTickets(applicationDB, discordUserId, now = Math.floor(Date.now() / 1000), requestedEsoAccountName = '') {
  const id = String(discordUserId || '').trim();
  if (!id) return { linked: false, purchases: [] };
  const [links] = requestedEsoAccountName ? [ [] ] : await applicationDB.execute(`
    SELECT eso_account_name FROM guildsync_member_links
    WHERE discord_user_id = ? AND link_status = 'linked' LIMIT 1
  `, [id]);
  const linkedName = links[0]?.eso_account_name;
  const entries = await getBankingDataJSON(applicationDB);
  const getPurchases = (esoAccountName) => ['biweekly', 'monthly'].flatMap(type => {
    const reference = now - BANKING_RAFFLE_AFTER_SALES_SECONDS + 1;
    const salesEnd = type === 'monthly' ? getDepositMailMonthlySalesEndAtOrAfter(reference) : getDepositMailBiweeklySalesEndAtOrAfter(reference);
    const previousSalesEnd = type === 'monthly' ? getDepositMailPreviousMonthlySalesEnd(salesEnd) : salesEnd - BANKING_BIWEEKLY_INTERVAL_SECONDS;
    return entries.filter(entry => normalizeDepositMailTicketType(entry.type) === type && Number(entry.time) > previousSalesEnd && Number(entry.time) <= salesEnd && Number(entry.time) <= now && String(entry.displayName || '').replace(/^@+/, '').toLowerCase() === String(esoAccountName).toLowerCase() && Number(entry.purchasedTickets || 0) > 0)
      .map(entry => ({ raffleType: type, raffleLabel: type === 'biweekly' ? 'Bi-weekly' : '50/50', time: Number(entry.time), purchasedTickets: Number(entry.purchasedTickets) || 0, bonusEnabled: entry.bonusEnabled === true, bonusPercent: Number(entry.bonusPercent) || 0, bonusTickets: Number(entry.bonusTickets) || 0, totalTickets: Number(entry.totalTickets) || 0 }));
  });
  if (!requestedEsoAccountName) {
    if (!linkedName) return { linked: false, purchases: [] };
    return { linked: true, esoAccountName: linkedName, purchases: getPurchases(linkedName) };
  }
  const providedName = String(requestedEsoAccountName).trim();
  const directPurchases = getPurchases(providedName);
  if (directPurchases.length) return { linked: true, esoAccountName: providedName, purchases: directPurchases };
  const [nameLinks] = await applicationDB.execute(`
    SELECT eso_account_name FROM guildsync_member_links
    WHERE link_status = 'linked' AND (
      LOWER(discord_username) = LOWER(?) OR
      LOWER(discord_display_name) = LOWER(?) OR
      LOWER(discord_server_nickname) = LOWER(?)
    ) LIMIT 1
  `, [providedName, providedName, providedName]);
  const fallbackName = nameLinks[0]?.eso_account_name;
  if (fallbackName) return { linked: true, esoAccountName: fallbackName, purchases: getPurchases(fallbackName) };
  return { linked: true, esoAccountName: providedName, purchases: [] };
}

export async function getBankingDataJSON(applicationDB, bonusVersions = null) {
  const bonusOverrides = await getRaffleBonusOverrides(applicationDB);
  const [rows] = await applicationDB.execute(`
    SELECT JSON_ARRAYAGG(
      JSON_OBJECT(
        'type', banking_rows.transaction_type,
        'eventId', banking_rows.event_id,
        'time', CAST(banking_rows.event_timestamp AS UNSIGNED),
        'displayName', banking_rows.account_name,
        'amount', banking_rows.deposit_amount,
        'ticketAmount', COALESCE(banking_rows.ticket_quantity, 0),
        'dataSource', banking_rows.data_source,
        'note', banking_rows.note,
        'mailStatus', banking_rows.mail_status,
        'mailRequestId', banking_rows.mail_request_id,
        'mailBatchId', banking_rows.mail_batch_id,
        'checkedOutBy', banking_rows.checked_out_by,
        'checkedOutAt', banking_rows.checked_out_at,
        'checkoutExpiresAt', banking_rows.checkout_expires_at,
        'writtenToEsoAt', banking_rows.written_to_eso_at,
        'sentAt', banking_rows.sent_at,
        'failedReason', banking_rows.failed_reason
      )
    ) AS banking_json
    FROM (
      SELECT
        event_id,
        transaction_type,
        account_name,
        event_timestamp,
        deposit_amount,
        ticket_quantity,
        data_source,
        note,
        mail_status,
        mail_request_id,
        mail_batch_id,
        checked_out_by,
        checked_out_at,
        checkout_expires_at,
        written_to_eso_at,
        sent_at,
        failed_reason
      FROM guildsync_banking_entries
      ORDER BY CAST(event_timestamp AS UNSIGNED) DESC, CAST(event_id AS UNSIGNED) DESC
    ) AS banking_rows
  `);

  const bankingJson = rows[0]?.banking_json;

  if (!bankingJson) {
    return [];
  }

  const entries = typeof bankingJson === 'string' ? JSON.parse(bankingJson) : bankingJson;
  const versions = bonusVersions || await getRaffleBonusVersions(applicationDB);
  return entries.map((entry) => ({ ...entry, ...calculateBankingEntryBonus(entry, versions, bonusOverrides) }));
}

function calculateBankingEntryBonus(entry, versions, overrides = []) {
    const type = normalizeDepositMailTicketType(entry.type);
    const paid = Math.max(0, Math.floor(Number(entry.ticketAmount) || 0));
    const noBonus = { purchasedTickets: paid, bonusPercent: 0, bonusTickets: 0, totalTickets: paid, bonusEnabled: false };
    if (type !== 'monthly' && type !== 'biweekly') {
      return noBonus;
    }
    const windowInfo = getAssociateTicketReportRaffleWindow({ transaction_type: type, event_timestamp: entry.time });
    if (!windowInfo) {
      return noBonus;
    }
    // Select the raffle's current policy for all of its purchases. Freeze that
    // policy at the end of sales so changes cannot rewrite completed raffles.
    // The purchase timestamp still selects the hour tier below.
    const policy = selectRaffleBonusSettings(versions, overrides, type, windowInfo.salesEnd);
    if (!policy) {
      return noBonus;
    }
    // Manual counts already include any discretionary award (e.g. FFTG).
    // Moved entries also carry an explicitly entered final ticket count.
    if (/^manual/i.test(String(entry.dataSource || ''))) {
      return { ...noBonus, bonusEnabled: policy.enabled };
    }
    const result = calculateRaffleBonus({
      purchasedTickets: paid,
      purchaseTimestamp: entry.time,
      salesStart: windowInfo.salesStart,
      salesEnd: windowInfo.salesEnd,
      tiers: policy.tiers,
      enabled: policy.enabled
    });
    return { ...result, bonusEnabled: policy.enabled };
}


function normalizeDepositMailRow(row = {}) {
  return {
    type: row.transaction_type,
    eventId: row.event_id,
    time: Number(row.event_timestamp || 0),
    displayName: row.account_name,
    amount: Number(row.deposit_amount || 0),
    ticketAmount: Number(row.ticket_quantity || 0),
    dataSource: row.data_source,
    note: row.note || null,
    mailStatus: row.mail_status,
    mailRequestId: row.mail_request_id || null,
    mailBatchId: row.mail_batch_id || null,
    checkedOutBy: row.checked_out_by || null,
    checkedOutAt: row.checked_out_at || null,
    checkoutExpiresAt: row.checkout_expires_at || null,
    writtenToEsoAt: row.written_to_eso_at || null,
    sentAt: row.sent_at || null,
    failedReason: row.failed_reason || null
  };
}

function normalizePositiveInteger(value, defaultValue, minValue, maxValue) {
  const number = Number(value);
  if (!Number.isFinite(number)) return defaultValue;
  const integer = Math.floor(number);
  return Math.min(Math.max(integer, minValue), maxValue);
}

export async function checkoutDepositMail(applicationDB, payload = {}) {
  const checkedOutBy = String(payload.checked_out_by || payload.checkedOutBy || '').trim();

  if (!checkedOutBy) {
    throw new Error('Authenticated user is required to check out deposit mail.');
  }

  const maxRecords = normalizePositiveInteger(payload.max_records ?? payload.maxRecords, 100, 1, 500);
  const checkoutMinutes = normalizePositiveInteger(payload.checkout_minutes ?? payload.checkoutMinutes, 30, 1, 1440);
  const mailBatchId = String(payload.mail_batch_id || payload.mailBatchId || randomUUID()).trim();

  const connection = await applicationDB.getConnection();

  try {
    await connection.beginTransaction();

    const [candidateRows] = await connection.query(
      `
        SELECT event_id
        FROM guildsync_banking_entries
        WHERE mail_status = 'unsent'
          AND LOWER(transaction_type) IN ('biweekly', 'monthly')
        ORDER BY event_datetime ASC, CAST(event_id AS UNSIGNED) ASC
        LIMIT ${maxRecords}
        FOR UPDATE
      `
    );

    const eventIds = candidateRows.map((row) => row.event_id).filter(Boolean);

    if (eventIds.length === 0) {
      await connection.commit();
      return {
        mail_batch_id: mailBatchId,
        checked_out_by: checkedOutBy,
        checkout_minutes: checkoutMinutes,
        records: [],
        records_checked_out: 0
      };
    }

    const placeholders = eventIds.map(() => '?').join(', ');

    await connection.query(
      `
        UPDATE guildsync_banking_entries
        SET mail_status = 'checked_out',
            mail_request_id = COALESCE(NULLIF(mail_request_id, ''), CONCAT('deposit_', event_id)),
            mail_batch_id = ?,
            checked_out_by = ?,
            checked_out_at = NOW(),
            checkout_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE),
            written_to_eso_at = NULL,
            sent_at = NULL,
            failed_reason = NULL
        WHERE mail_status = 'unsent'
          AND LOWER(transaction_type) IN ('biweekly', 'monthly')
          AND event_id IN (${placeholders})
      `,
      [mailBatchId, checkedOutBy, checkoutMinutes, ...eventIds]
    );

    const [checkedOutRows] = await connection.query(
      `
        SELECT
          event_id,
          transaction_type,
          account_name,
          event_timestamp,
          event_datetime,
          deposit_amount,
          ticket_quantity,
          data_source,
          note,
          mail_status,
          mail_request_id,
          mail_batch_id,
          checked_out_by,
          checked_out_at,
          checkout_expires_at,
          written_to_eso_at,
          sent_at,
          failed_reason
        FROM guildsync_banking_entries
        WHERE mail_status = 'checked_out'
          AND mail_batch_id = ?
          AND checked_out_by = ?
        ORDER BY event_datetime ASC, CAST(event_id AS UNSIGNED) ASC
      `,
      [mailBatchId, checkedOutBy]
    );

    const versions = await getRaffleBonusVersions(connection);
    const overrides = await getRaffleBonusOverrides(connection);
    const records = checkedOutRows.map(row => addRenderedDepositMailContent(row, versions, overrides));
    await connection.commit();

    return {
      mail_batch_id: mailBatchId,
      checked_out_by: checkedOutBy,
      checkout_minutes: checkoutMinutes,
      records,
      records_checked_out: checkedOutRows.length
    };
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}

export async function markDepositMailWrittenToESO(applicationDB, payload = {}) {
  const checkedOutBy = String(payload.checked_out_by || payload.checkedOutBy || '').trim();
  const mailBatchId = String(payload.mail_batch_id || payload.mailBatchId || '').trim();
  const eventIds = (Array.isArray(payload.event_ids) ? payload.event_ids : Array.isArray(payload.eventIds) ? payload.eventIds : [])
    .map((eventId) => String(eventId || '').trim())
    .filter(Boolean);

  if (!checkedOutBy) {
    throw new Error('Authenticated user is required to mark deposit mail written to ESO.');
  }

  if (!mailBatchId && eventIds.length === 0) {
    throw new Error('A mail batch id or event id list is required.');
  }

  const connection = await applicationDB.getConnection();

  try {
    await connection.beginTransaction();

    const conditions = [
      "mail_status = 'checked_out'",
      'checked_out_by = ?'
    ];
    const params = [checkedOutBy];

    if (mailBatchId) {
      conditions.push('mail_batch_id = ?');
      params.push(mailBatchId);
    }

    if (eventIds.length > 0) {
      conditions.push(`event_id IN (${eventIds.map(() => '?').join(', ')})`);
      params.push(...eventIds);
    }

    const whereClause = conditions.join('\n          AND ');

    const [updateResult] = await connection.query(
      `
        UPDATE guildsync_banking_entries
        SET mail_status = 'written_to_eso',
            written_to_eso_at = NOW()
        WHERE ${whereClause}
      `,
      params
    );

    const [updatedRows] = await connection.query(
      `
        SELECT
          event_id,
          transaction_type,
          account_name,
          event_timestamp,
          event_datetime,
          deposit_amount,
          ticket_quantity,
          data_source,
          note,
          mail_status,
          mail_request_id,
          mail_batch_id,
          checked_out_by,
          checked_out_at,
          checkout_expires_at,
          written_to_eso_at,
          sent_at,
          failed_reason
        FROM guildsync_banking_entries
        WHERE mail_status = 'written_to_eso'
          AND checked_out_by = ?
          ${mailBatchId ? 'AND mail_batch_id = ?' : ''}
          ${eventIds.length > 0 ? `AND event_id IN (${eventIds.map(() => '?').join(', ')})` : ''}
        ORDER BY event_datetime ASC, CAST(event_id AS UNSIGNED) ASC
      `,
      [checkedOutBy, ...(mailBatchId ? [mailBatchId] : []), ...eventIds]
    );

    await connection.commit();

    return {
      mail_batch_id: mailBatchId || null,
      checked_out_by: checkedOutBy,
      records_written_to_eso: updateResult.affectedRows || 0,
      records: updatedRows.map(normalizeDepositMailRow)
    };
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}


export async function markDepositMailSent(applicationDB, payload = {}) {
  const checkedOutBy = String(payload.checked_out_by || payload.checkedOutBy || '').trim();
  const ackEntries = Array.isArray(payload.mail_ack)
    ? payload.mail_ack
    : Array.isArray(payload.mailAck)
      ? payload.mailAck
      : [];
  const explicitRequestIds = Array.isArray(payload.mail_request_ids)
    ? payload.mail_request_ids
    : Array.isArray(payload.mailRequestIds)
      ? payload.mailRequestIds
      : [];

  const mailRequestIds = Array.from(new Set([
    ...ackEntries.map((entry) => entry?.mail_request_id || entry?.mailRequestId),
    ...explicitRequestIds
  ]
    .map((mailRequestId) => String(mailRequestId || '').trim())
    .filter(Boolean)));

  if (!checkedOutBy) {
    throw new Error('Authenticated user is required to mark deposit mail sent.');
  }

  if (mailRequestIds.length === 0) {
    throw new Error('At least one mail_request_id is required to mark deposit mail sent.');
  }

  const connection = await applicationDB.getConnection();

  try {
    await connection.beginTransaction();

    const placeholders = mailRequestIds.map(() => '?').join(', ');
    const [existingRows] = await connection.query(
      `
        SELECT
          event_id,
          transaction_type,
          account_name,
          event_timestamp,
          event_datetime,
          deposit_amount,
          ticket_quantity,
          data_source,
          note,
          mail_status,
          mail_request_id,
          mail_batch_id,
          checked_out_by,
          checked_out_at,
          checkout_expires_at,
          written_to_eso_at,
          sent_at,
          failed_reason
        FROM guildsync_banking_entries
        WHERE mail_request_id IN (${placeholders})
          AND checked_out_by = ?
          AND mail_status IN ('written_to_eso', 'checked_out', 'sent')
      `,
      [...mailRequestIds, checkedOutBy]
    );

    const confirmedRequestIds = Array.from(new Set(existingRows
      .map((row) => String(row.mail_request_id || '').trim())
      .filter(Boolean)));

    let updatedCount = 0;
    if (confirmedRequestIds.length > 0) {
      const confirmedPlaceholders = confirmedRequestIds.map(() => '?').join(', ');
      const [updateResult] = await connection.query(
        `
          UPDATE guildsync_banking_entries
          SET mail_status = 'sent',
              sent_at = COALESCE(sent_at, NOW())
          WHERE mail_request_id IN (${confirmedPlaceholders})
            AND checked_out_by = ?
            AND mail_status IN ('written_to_eso', 'checked_out', 'sent')
        `,
        [...confirmedRequestIds, checkedOutBy]
      );
      updatedCount = updateResult.affectedRows || 0;
    }

    const [updatedRows] = confirmedRequestIds.length > 0
      ? await connection.query(
        `
          SELECT
            event_id,
            transaction_type,
            account_name,
            event_timestamp,
            event_datetime,
            deposit_amount,
            ticket_quantity,
            data_source,
            note,
            mail_status,
            mail_request_id,
            mail_batch_id,
            checked_out_by,
            checked_out_at,
            checkout_expires_at,
            written_to_eso_at,
            sent_at,
            failed_reason
          FROM guildsync_banking_entries
          WHERE mail_request_id IN (${confirmedRequestIds.map(() => '?').join(', ')})
            AND checked_out_by = ?
          ORDER BY event_datetime ASC, CAST(event_id AS UNSIGNED) ASC
        `,
        [...confirmedRequestIds, checkedOutBy]
      )
      : [[]];

    await connection.commit();

    return {
      mail_request_ids: confirmedRequestIds,
      requested_mail_request_ids: mailRequestIds,
      records_marked_sent: updatedCount,
      records_confirmed_sent: confirmedRequestIds.length,
      records: updatedRows.map(normalizeDepositMailRow)
    };
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}

export async function insertBankingEntries(applicationDB, payload) {
  const entries = Array.isArray(payload?.entries)
    ? payload.entries
    : [];

  if (entries.length === 0) {
    return {
      banking_entries_received: 0,
      banking_entries_inserted: 0,
      banking_entries_ignored: 0
    };
  }

  const connection = await applicationDB.getConnection();
  let insertedCount = 0;
  const insertedEntries = [];

  try {
    await connection.beginTransaction();

    for (const entry of entries) {
      const event_id = Number(entry.eventId || entry.event_id);
      const transaction_type = String(entry.type || entry.transactionType || entry.transaction_type || '').trim();
      const normalized_transaction_type = transaction_type.toLowerCase();
      const is_other_transaction_type = normalized_transaction_type === 'other';
      const initial_mail_status = is_other_transaction_type ? 'N/A' : 'unsent';
      const initial_mail_request_id = is_other_transaction_type ? 'N/A' : null;
      const initial_mail_batch_id = is_other_transaction_type ? 'N/A' : null;
      const initial_checked_out_by = is_other_transaction_type ? '000000000000000000' : null;
      const initial_checked_out_at_expression = is_other_transaction_type ? 'NOW()' : 'NULL';
      const initial_written_to_eso_at_expression = is_other_transaction_type ? 'NOW()' : 'NULL';
      const initial_sent_at_expression = is_other_transaction_type ? 'NOW()' : 'NULL';
      const initial_failed_reason = is_other_transaction_type ? 'No deposit mail required for other category' : null;
      const account_name = String(entry.displayName || entry.receivedFrom || entry.accountName || entry.account_name || '').trim();
      const event_timestamp = Number(entry.time || entry.eventTimestamp || entry.event_timestamp);
      const deposit_amount = Number(entry.amount || entry.depositAmount || entry.deposit_amount);

      const ticket_quantityRaw =
        entry.ticketAmount ??
        entry.ticket_quantity ??
        null;

      const ticket_quantity =
        ticket_quantityRaw === null || ticket_quantityRaw === undefined
          ? null
          : Number(ticket_quantityRaw);

      if (!event_id || !transaction_type || !account_name || !event_timestamp || !deposit_amount) {
        continue;
      }

      const [result] = await connection.execute(
        `
          INSERT IGNORE INTO guildsync_banking_entries (
            event_id,
            transaction_type,
            account_name,
            event_timestamp,
            event_datetime,
            deposit_amount,
            ticket_quantity,
            data_source,
            note,
            mail_status,
            mail_request_id,
            mail_batch_id,
            checked_out_by,
            checked_out_at,
            written_to_eso_at,
            sent_at,
            failed_reason
          )
          VALUES (
            ?,
            ?,
            ?,
            ?,
            FROM_UNIXTIME(?),
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ${initial_checked_out_at_expression},
            ${initial_written_to_eso_at_expression},
            ${initial_sent_at_expression},
            ?
          )
        `,
        [
          event_id,
          transaction_type,
          account_name,
          event_timestamp,
          event_timestamp,
          deposit_amount,
          ticket_quantity,
          bankingSource(payload?.source || 'GuildSyncBanking', payload.uploadedBy),
          String(entry.note || '').trim() || null,
          initial_mail_status,
          initial_mail_request_id,
          initial_mail_batch_id,
          initial_checked_out_by,
          initial_failed_reason
        ]
      );

      insertedCount += result.affectedRows || 0;
      if (result.affectedRows) insertedEntries.push({ eventId: event_id, type: normalizeDepositMailTicketType(transaction_type), displayName: account_name, amount: deposit_amount, ticketAmount: ticket_quantity || 0 });
    }

    if (entries.length > 0) {
      await connection.execute(
        `
          INSERT INTO guildsync_settings (
            setting_key,
            value
          )
          VALUES (
            ?,
            ?
          )
          ON DUPLICATE KEY UPDATE
            value = VALUES(value)
        `,
        [
          'banking_refresh',
          new Date().toISOString()
        ]
      );
    }

    await connection.commit();
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }

  if (insertedEntries.length) {
    try {
      const settings = googleSheetsBankingConfig();
      const enriched = settings.enabled ? await getBankingDataJSON(applicationDB) : insertedEntries;
      const byId = new Map(enriched.map(entry => [String(entry.eventId), entry]));
      await syncBankingEntriesToGoogleSheets(insertedEntries.map(entry => ({ ...entry, ...(byId.get(String(entry.eventId)) || {}) })), { uploadedBy: payload.uploadedBy });
    } catch (error) { console.error(`Google Sheets banking sync failed: ${error.message}`); }
  }

  return {
    banking_entries_received: entries.length,
    banking_entries_inserted: insertedCount,
    banking_entries_ignored: entries.length - insertedCount
  };
}


























export async function getRosterDataDate(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT
      setting_key AS data,
      value
    FROM guildsync_settings
    WHERE setting_key = ?
    LIMIT 1
  `,
    [
      'roster_refresh'
    ]
  );

  return rows[0] || {
    data: 'roster_refresh',
    value: null
  };
}

async function ensureRosterMemberNotesTable(applicationDB) {
  await applicationDB.query(`
    CREATE TABLE IF NOT EXISTS guildsync_roster_member_notes (
      note_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      account_name VARCHAR(64) NOT NULL,
      officer_name VARCHAR(255) NOT NULL,
      note_text TEXT NOT NULL,
      note_timestamp VARCHAR(32) NOT NULL,
      PRIMARY KEY (note_id),
      INDEX idx_guildsync_roster_member_notes_account_name (account_name),
      INDEX idx_guildsync_roster_member_notes_timestamp (note_timestamp)
    )
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `);

  await applicationDB.query(`
    ALTER TABLE guildsync_roster_member_notes
      MODIFY COLUMN note_timestamp VARCHAR(32) NOT NULL
  `);
}

export async function getRosterDataJSON(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT JSON_ARRAYAGG(
      JSON_OBJECT(
        'account_name', roster_rows.account_name,
        'rank', roster_rows.rank_name,
        'joined', roster_rows.joined_timestamp,
        'in_roster', roster_rows.in_roster
      )
    ) AS roster_json
    FROM (
      SELECT
        account_name,
        rank_name,
        joined_timestamp,
        in_roster
      FROM guildsync_roster_members
      WHERE in_roster = 1
      ORDER BY account_name ASC
    ) AS roster_rows
  `);

  const rosterJson = rows[0]?.roster_json;

  if (!rosterJson) {
    return [];
  }

  const rosterMembers = typeof rosterJson === 'string'
    ? JSON.parse(rosterJson)
    : rosterJson;

  if (!Array.isArray(rosterMembers) || rosterMembers.length === 0) {
    return [];
  }

  try {
    await ensureRosterMemberNotesTable(applicationDB);
    const [noteRows] = await applicationDB.execute(`
      SELECT
        LOWER(account_name) AS account_key,
        COUNT(*) AS note_count
      FROM guildsync_roster_member_notes
      GROUP BY LOWER(account_name)
    `);

    const noteCountsByAccount = new Map(
      noteRows.map((row) => [String(row.account_key || '').trim(), Number(row.note_count || 0)])
    );

    return rosterMembers.map((member) => ({
      ...member,
      note_count: noteCountsByAccount.get(String(member.account_name || '').trim().toLowerCase()) || 0
    }));
  } catch (error) {
    console.warn('Unable to load roster member note counts; roster data will be returned without note counts.', error?.message || error);
    return rosterMembers.map((member) => ({
      ...member,
      note_count: 0
    }));
  }
}

export async function getRosterMemberNotes(applicationDB, accountName = '') {
  const cleanAccountName = normalizeRosterAccountName(accountName);

  if (!cleanAccountName) {
    return [];
  }

  await ensureRosterMemberNotesTable(applicationDB);

  const [rows] = await applicationDB.execute(`
    SELECT
      note_id,
      account_name,
      officer_name,
      note_text,
      note_timestamp
    FROM guildsync_roster_member_notes
    WHERE LOWER(account_name) = LOWER(?)
    ORDER BY note_timestamp ASC, note_id ASC
  `, [cleanAccountName]);

  return rows.map((row) => ({
    note_id: row.note_id,
    account_name: row.account_name,
    officer: row.officer_name,
    note: row.note_text,
    timestamp: Number(row.note_timestamp || 0)
  }));
}

export async function addRosterMemberNote(applicationDB, { accountName = '', officerName = '', note = '' } = {}) {
  const cleanAccountName = normalizeRosterAccountName(accountName);
  const cleanOfficerName = String(officerName || '').trim();
  const cleanNote = String(note || '').trim();

  if (!cleanAccountName) {
    throw new Error('ESO account name is required.');
  }

  if (!cleanOfficerName) {
    throw new Error('Officer name is required.');
  }

  if (!cleanNote) {
    throw new Error('Note is required.');
  }

  await ensureRosterMemberNotesTable(applicationDB);

  const timestamp = Math.floor(Date.now() / 1000);
  const [result] = await applicationDB.execute(`
    INSERT INTO guildsync_roster_member_notes (
      account_name,
      officer_name,
      note_text,
      note_timestamp
    ) VALUES (?, ?, ?, ?)
  `, [cleanAccountName, cleanOfficerName, cleanNote, timestamp]);

  return {
    note_id: result.insertId,
    account_name: cleanAccountName,
    officer: cleanOfficerName,
    note: cleanNote,
    timestamp
  };
}
export async function getRosterRankHistoryMatches(applicationDB, query = '') {
  const cleanQuery = normalizeRosterAccountName(query);

  if (!cleanQuery) {
    return [];
  }

  const [rows] = await applicationDB.execute(
    `
      SELECT
        account_name,
        rank_name AS rank
      FROM guildsync_roster_rank_history
      WHERE account_name LIKE ?
      ORDER BY account_name ASC
      LIMIT 50
    `,
    [`%${cleanQuery}%`]
  );

  return rows;
}

export async function getRosterStreamHistoryForAccount(applicationDB, accountName = '') {
  const cleanAccountName = normalizeRosterAccountName(accountName);

  if (!cleanAccountName) {
    return [];
  }

  const [rows] = await applicationDB.execute(
    `
      SELECT
        event_type,
        rank_name AS rank,
        event_timestamp AS timestamp,
        officer_account_name AS officer
      FROM guildsync_roster_events
      WHERE account_name = ?
      ORDER BY CAST(event_timestamp AS UNSIGNED) DESC, event_timestamp DESC
      LIMIT 250
    `,
    [cleanAccountName]
  );

  return rows;
}


export async function processRosterData(applicationDB, payload = {}) {
  const data = payload?.data && typeof payload.data === 'object'
    ? payload.data
    : payload;

  const guildList = data?.guildList && typeof data.guildList === 'object'
    ? data.guildList
    : null;

  const rosterEvents = normalizeRosterEvents(data?.rosterEvents);

  const connection = await applicationDB.getConnection();
  const result = {
    guildlist_received: Boolean(guildList),
    guildlist_processed: false,
    guildlist_skipped_stale: false,
    guildlist_members_received: 0,
    guildlist_members_upserted: 0,
    automatic_removals_inserted: 0,
    stream_events_received: rosterEvents.length,
    stream_events_inserted: 0,
    roster_members_returned: 0
  };

  try {
    await connection.beginTransaction();

    if (guildList) {
      const listTimestamp = normalizeRosterTimestamp(guildList.listTimestamp || guildList.dumpTimestamp);
      const guildMembers = normalizeGuildListMembers(guildList.guildListMembers || guildList.guildMembers);
      result.guildlist_members_received = guildMembers.length;

      if (listTimestamp) {
        const [settingRows] = await connection.execute(
          `
            SELECT value
            FROM guildsync_settings
            WHERE setting_key = ?
            LIMIT 1
          `,
          ['lastGuildList']
        );

        const lastGuildList = Number(settingRows[0]?.value || 0);

        if (lastGuildList > Number(listTimestamp)) {
          result.guildlist_skipped_stale = true;
        } else {
          await connection.execute(
            `
              INSERT INTO guildsync_settings (setting_key, value)
              VALUES (?, ?)
              ON DUPLICATE KEY UPDATE
                value = VALUES(value)
            `,
            ['lastGuildList', String(listTimestamp)]
          );

          await connection.execute(`UPDATE guildsync_roster_members SET in_roster = 0`);

          for (const member of guildMembers) {
            const accountName = normalizeRosterAccountName(member.accountName);
            const rankName = normalizeRosterRank(member.rankName || member.rank);

            if (!accountName) {
              continue;
            }

            const [upsertResult] = await connection.execute(
              `
                INSERT INTO guildsync_roster_members (
                  account_name,
                  rank_name,
                  joined_timestamp,
                  in_roster
                )
                VALUES (?, ?, ?, 1)
                ON DUPLICATE KEY UPDATE
                  rank_name = VALUES(rank_name),
                  in_roster = 1
              `,
              [accountName, rankName, String(listTimestamp)]
            );

            result.guildlist_members_upserted += upsertResult.affectedRows || 0;

            await connection.execute(
              `
                INSERT IGNORE INTO guildsync_roster_rank_history (
                  account_name,
                  rank_name
                )
                VALUES (?, ?)
              `,
              [accountName, rankName]
            );
          }

          const [removedRows] = await connection.execute(
            `
              SELECT account_name, rank_name AS rank
              FROM guildsync_roster_members
              WHERE in_roster = 0
            `
          );

          for (const removed of removedRows) {
            const accountName = normalizeRosterAccountName(removed.account_name);
            const rankName = normalizeRosterRank(removed.rank);
            const generatedEventId = createAutomaticRosterEventId(listTimestamp);

            await connection.execute(
              `
                INSERT IGNORE INTO guildsync_roster_events (
                  event_id,
                  account_name,
                  event_type,
                  rank_name,
                  event_timestamp,
                  officer_account_name
                )
                VALUES (?, ?, ?, ?, ?, ?)
              `,
              [generatedEventId, accountName, 'Removed (Not On Roster)', rankName, String(listTimestamp), 'Automatic']
            );

            await connection.execute(
              `
                INSERT INTO guildsync_roster_rank_history (
                  account_name,
                  rank_name
                )
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE
                  rank_name = VALUES(rank_name)
              `,
              [accountName, rankName]
            );

            result.automatic_removals_inserted += 1;
          }

          await connection.execute(`DELETE FROM guildsync_roster_members WHERE in_roster = 0`);
          result.guildlist_processed = true;
        }
      }
    }

    for (const event of rosterEvents) {
      const processed = await processSingleRosterStreamEvent(connection, event);
      if (processed) {
        result.stream_events_inserted += 1;
      }
    }

    await connection.execute(
      `
        INSERT INTO guildsync_settings (setting_key, value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE
          value = VALUES(value)
      `,
      ['roster_refresh', new Date().toISOString()]
    );

    await connection.commit();
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }

  await runMemberAutoLinking(applicationDB);

  const roster = await getRosterDataJSON(applicationDB);
  result.roster_members_returned = roster.length;
  result.roster = roster;

  return result;
}

async function processSingleRosterStreamEvent(connection, event = {}) {
  const event_id = String(event.eventId || event.event_id || '').trim();
  const eventType = normalizeRosterEventType(event.eventType || event.event_type);
  const rankName = normalizeRosterRank(event.rankName || event.rank);
  const timestamp = normalizeRosterTimestamp(event.timestampS || event.timeStamp || event.timestamp || event.time);
  const actingDisplayName = normalizeRosterAccountName(event.actingDisplayName || event.acting_display_name);
  const targetDisplayName = normalizeRosterAccountName(event.targetDisplayName || event.target_display_name);

  if (!event_id || !eventType || eventType === 'unknown' || !timestamp) {
    return false;
  }

  const accountName = targetDisplayName || actingDisplayName;

  const officerName = ['kicked', 'promoted', 'demoted', 'application accepted', 'application declined', 'application_accepted', 'application_declined'].includes(eventType)
    ? actingDisplayName
    : '';

  if (!accountName) {
    return false;
  }

  const [insertResult] = await connection.execute(
    `
      INSERT IGNORE INTO guildsync_roster_events (
        event_id,
        account_name,
        event_type,
        rank_name,
        event_timestamp,
        officer_account_name
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [event_id, accountName, eventType, rankName, String(timestamp), officerName]
  );

  if (eventType === 'joined') {
    await connection.execute(
      `
        INSERT INTO guildsync_roster_members (
          account_name,
          rank_name,
          joined_timestamp,
          in_roster
        )
        VALUES (?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          rank_name = VALUES(rank_name),
          in_roster = 1
      `,
      [accountName, 'Associate', String(timestamp)]
    );

    await connection.execute(
      `
        INSERT IGNORE INTO guildsync_roster_rank_history (
          account_name,
          rank_name
        )
        VALUES (?, ?)
      `,
      [accountName, 'Associate']
    );
  } else if (eventType === 'kicked' || eventType === 'left') {
    const [rows] = await connection.execute(
      `
        SELECT rank_name AS rank
        FROM guildsync_roster_members
        WHERE account_name = ?
        LIMIT 1
      `,
      [accountName]
    );

    const currentRank = normalizeRosterRank(rows[0]?.rank || rankName);

    await connection.execute(
      `
        INSERT INTO guildsync_roster_rank_history (
          account_name,
          rank_name
        )
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE
          rank_name = VALUES(rank_name)
      `,
      [accountName, currentRank]
    );

    await connection.execute(
      `
        DELETE FROM guildsync_roster_members
        WHERE account_name = ?
      `,
      [accountName]
    );
  } else if (eventType === 'promoted' || eventType === 'demoted') {
    await connection.execute(
      `
        INSERT INTO guildsync_roster_members (
          account_name,
          rank_name,
          joined_timestamp,
          in_roster
        )
        VALUES (?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          rank_name = VALUES(rank_name),
          in_roster = 1
      `,
      [accountName, rankName, String(timestamp)]
    );
  }

  return (insertResult.affectedRows || 0) > 0;
}

function normalizeGuildListMembers(guildMembers) {
  if (!guildMembers || typeof guildMembers !== 'object') {
    return [];
  }

  if (Array.isArray(guildMembers)) {
    return guildMembers.filter((member) => member && typeof member === 'object');
  }

  return Object.values(guildMembers).filter((member) => member && typeof member === 'object');
}

export async function getAssociateTicketReport(applicationDB) {
  const twoWeeksAgo = Math.floor(Date.now() / 1000) - (14 * 24 * 60 * 60);

  const [rows] = await applicationDB.execute(
    `
      SELECT
        roster.account_name,
        roster.rank_name AS rank,
        roster.joined_timestamp AS joined,
        COALESCE(SUM(COALESCE(bank.ticket_quantity, 0)), 0) AS purchased_tickets,
        MIN(CAST(bank.event_timestamp AS UNSIGNED)) AS earliest_deposit_timestamp,
        SUBSTRING_INDEX(
          GROUP_CONCAT(bank.transaction_type ORDER BY CAST(bank.event_timestamp AS UNSIGNED) ASC, bank.event_id ASC SEPARATOR '||'),
          '||',
          1
        ) AS earliest_deposit_type,
        links.discord_user_id,
        links.discord_username,
        links.discord_display_name,
        links.discord_server_nickname,
        links.link_status,
        links.link_method,
        links.match_confidence,
        links.match_field,
        CASE
          WHEN links.link_status = 'linked' AND COALESCE(links.discord_user_id, '') <> '' THEN 'eligible'
          ELSE 'eligible_if_linked'
        END AS report_group
      FROM guildsync_roster_members roster
      INNER JOIN guildsync_banking_entries bank
        ON LOWER(TRIM(LEADING '@' FROM bank.account_name)) = LOWER(roster.account_name)
      LEFT JOIN guildsync_member_links links
        ON LOWER(links.eso_account_name) = LOWER(roster.account_name)
      WHERE LOWER(roster.rank_name) = 'associate'
        AND roster.in_roster = 1
        AND CAST(roster.joined_timestamp AS UNSIGNED) > 0
        AND CAST(roster.joined_timestamp AS UNSIGNED) <= ?
        AND COALESCE(bank.ticket_quantity, 0) > 0
        AND COALESCE(bank.deposit_amount, 0) > 0
        AND COALESCE(bank.data_source, '') <> 'ManualBiweeklyTicket'
        AND COALESCE(bank.data_source, '') NOT LIKE 'ManualBiweeklyTicket (%'
      GROUP BY
        roster.account_name,
        roster.rank_name,
        roster.joined_timestamp,
        links.discord_user_id,
        links.discord_username,
        links.discord_display_name,
        links.discord_server_nickname,
        links.link_status,
        links.link_method,
        links.match_confidence,
        links.match_field
      ORDER BY
        CASE
          WHEN links.link_status = 'linked' AND COALESCE(links.discord_user_id, '') <> '' THEN 0
          ELSE 1
        END,
        LOWER(roster.account_name) ASC
    `,
    [twoWeeksAgo]
  );

  return rows.map((row) => ({
    ...row,
    earliest_deposit_date: formatAssociateTicketReportDateEastern(row.earliest_deposit_timestamp),
    earliest_deposit_raffle_period: formatAssociateTicketReportRafflePeriod({
      earliest_deposit_timestamp: row.earliest_deposit_timestamp,
      earliest_deposit_type: row.earliest_deposit_type
    }),
    earliest_deposit_summary: formatAssociateTicketReportEarliestDeposit({
      earliest_deposit_timestamp: row.earliest_deposit_timestamp,
      earliest_deposit_type: row.earliest_deposit_type
    })
  }));
}


export async function getDiscordRankAuditReport(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT *
    FROM (
      SELECT
        discord.discord_id,
        discord.username,
        discord.global_name,
        discord.server_nickname,
        COALESCE(discord_rank.discord_rank_name, '') AS discord_rank,
        COALESCE(discord_rank.discord_rank_order, 999) AS discord_rank_order,
        COALESCE(discord_rank.discord_rank_roles, '') AS discord_rank_roles,
        COALESCE(linked_roster.linked_account_count, 0) AS linked_account_count,
        COALESCE(linked_roster.active_roster_count, 0) AS active_roster_count,
        COALESCE(linked_roster.eso_accounts, '') AS eso_accounts,
        COALESCE(linked_roster.highest_eso_rank_name, '') AS eso_rank,
        COALESCE(linked_roster.highest_eso_rank_order, 999) AS eso_rank_order,
        CASE
          WHEN COALESCE(linked_roster.linked_account_count, 0) = 0 THEN 'no_linked_eso_account'
          WHEN COALESCE(linked_roster.active_roster_count, 0) = 0 THEN 'linked_eso_not_on_roster'
          WHEN COALESCE(discord_rank.discord_rank_order, 999) < COALESCE(linked_roster.highest_eso_rank_order, 999) THEN 'discord_role_above_roster_rank'
          WHEN COALESCE(discord_rank.discord_rank_order, 999) > COALESCE(linked_roster.highest_eso_rank_order, 999) THEN 'discord_role_below_roster_rank'
          ELSE NULL
        END AS issue_type
      FROM discord_members discord
      LEFT JOIN (
        SELECT
          ranked.discord_id,
          MIN(ranked.rank_order) AS discord_rank_order,
          SUBSTRING_INDEX(
            GROUP_CONCAT(ranked.rank_name ORDER BY ranked.rank_order ASC, ranked.rank_name ASC SEPARATOR '||'),
            '||',
            1
          ) AS discord_rank_name,
          GROUP_CONCAT(DISTINCT ranked.role_name ORDER BY ranked.rank_order ASC, ranked.role_name ASC SEPARATOR ', ') AS discord_rank_roles
        FROM (
          SELECT
            member_roles.discord_id,
            roles.role_name,
            CASE
              WHEN LOWER(TRIM(roles.role_name)) = 'kingpin' THEN 'Consigliere'
              ELSE roles.role_name
            END AS rank_name,
            CASE
              WHEN LOWER(TRIM(roles.role_name)) IN ('kingpin', 'consigliere') THEN 1
              WHEN LOWER(TRIM(roles.role_name)) IN ('caporegime') THEN 2
              WHEN LOWER(TRIM(roles.role_name)) = 'capo' THEN 3
              WHEN LOWER(TRIM(roles.role_name)) = 'soldiers' THEN 4
              WHEN LOWER(TRIM(roles.role_name)) = 'associates' THEN 5
              ELSE 999
            END AS rank_order
          FROM discord_member_roles member_roles
          INNER JOIN discord_roles roles
            ON roles.role_id = member_roles.role_id
          WHERE LOWER(TRIM(roles.role_name)) IN (
            'kingpin',
            'consigliere',
            'caporegime',
            'capo',
            'soldiers',
            'associates'
          )
        ) ranked
        GROUP BY ranked.discord_id
      ) discord_rank
        ON discord_rank.discord_id = discord.discord_id
      LEFT JOIN (
        SELECT
          links.discord_user_id,
          COUNT(DISTINCT links.eso_account_name) AS linked_account_count,
          COUNT(DISTINCT roster.account_name) AS active_roster_count,
          GROUP_CONCAT(
            DISTINCT CONCAT(
              links.eso_account_name,
              COALESCE(CONCAT(' (', roster.rank_name, ')'), ' (not on roster)')
            )
            ORDER BY LOWER(links.eso_account_name) ASC
            SEPARATOR ', '
          ) AS eso_accounts,
          MIN(
            CASE
              WHEN LOWER(TRIM(roster.rank_name)) IN ('kingpin', 'consigliere') THEN 1
              WHEN LOWER(TRIM(roster.rank_name)) IN ('caporegime') THEN 2
              WHEN LOWER(TRIM(roster.rank_name)) = 'capo' THEN 3
              WHEN LOWER(TRIM(roster.rank_name)) = 'soldier' THEN 4
              WHEN LOWER(TRIM(roster.rank_name)) = 'associate' THEN 5
              ELSE 999
            END
          ) AS highest_eso_rank_order,
          SUBSTRING_INDEX(
            GROUP_CONCAT(
              CASE
                WHEN roster.account_name IS NULL THEN NULL
                WHEN LOWER(TRIM(roster.rank_name)) IN ('kingpin', 'consigliere') THEN 'Consigliere'
                WHEN LOWER(TRIM(roster.rank_name)) IN ('caporegime') THEN 'Caporegime'
                WHEN LOWER(TRIM(roster.rank_name)) = 'capo' THEN 'Capo'
                WHEN LOWER(TRIM(roster.rank_name)) = 'soldier' THEN 'Soldier'
                WHEN LOWER(TRIM(roster.rank_name)) = 'associate' THEN 'Associate'
                ELSE roster.rank_name
              END
              ORDER BY
                CASE
                  WHEN LOWER(TRIM(roster.rank_name)) IN ('kingpin', 'consigliere') THEN 1
                  WHEN LOWER(TRIM(roster.rank_name)) IN ('caporegime') THEN 2
                  WHEN LOWER(TRIM(roster.rank_name)) = 'capo' THEN 3
                  WHEN LOWER(TRIM(roster.rank_name)) = 'soldier' THEN 4
                  WHEN LOWER(TRIM(roster.rank_name)) = 'associate' THEN 5
                  ELSE 999
                END ASC
              SEPARATOR '||'
            ),
            '||',
            1
          ) AS highest_eso_rank_name
        FROM guildsync_member_links links
        LEFT JOIN guildsync_roster_members roster
          ON LOWER(roster.account_name) = LOWER(links.eso_account_name)
          AND roster.in_roster = 1
        WHERE links.link_status = 'linked'
        GROUP BY links.discord_user_id
      ) linked_roster
        ON linked_roster.discord_user_id = discord.discord_id
    ) audit_rows
    WHERE issue_type IS NOT NULL
    ORDER BY
      CASE issue_type
        WHEN 'no_linked_eso_account' THEN 0
        WHEN 'linked_eso_not_on_roster' THEN 1
        WHEN 'discord_role_above_roster_rank' THEN 2
        WHEN 'discord_role_below_roster_rank' THEN 3
        ELSE 9
      END,
      LOWER(COALESCE(server_nickname, global_name, username, discord_id)) ASC
  `);

  return rows;
}


export async function addManualBiweeklyTicketEntry(applicationDB, payload = {}) {
  const accountName = normalizeRosterAccountName(payload.account_name || payload.accountName);
  const note = String(payload.note || payload.reason || '').trim().slice(0, 160);
  const ticketTypeInput = String(payload.ticket_type || payload.ticketType || payload.raffle_type || payload.raffleType || '').trim().toLowerCase();
  const transactionType = ticketTypeInput === 'monthly' || ticketTypeInput === '50/50' || ticketTypeInput === '5050'
    ? 'monthly'
    : 'biweekly';
  const tickets = Math.floor(Number(payload.tickets ?? payload.ticket_quantity ?? payload.ticketAmount ?? 0));
  const goldValue = Math.floor(Number(payload.gold_value ?? payload.goldValue ?? payload.deposit_amount ?? payload.depositAmount ?? 0));
  const addedBy = String(payload.addedBy || payload.auditUser || '').trim().slice(0, 64);

  if (!accountName) {
    throw new Error('Missing guild member account name.');
  }

  if (!Number.isFinite(goldValue) || goldValue < 0) {
    throw new Error('Manual ticket gold value must be zero or greater.');
  }

  if (!Number.isFinite(tickets) || tickets < 0) {
    throw new Error('Manual ticket quantity must be zero or greater.');
  }

  const isAnonymousAccount = accountName.toLowerCase() === 'anonymous';

  if (isAnonymousAccount && tickets > 0) {
    throw new Error('Anonymous cannot be awarded tickets. Use 0 tickets and enter a gold value.');
  }

  if (goldValue === 0 && tickets === 0) {
    throw new Error('Manual entry must include gold or tickets. Anonymous entries may use 0 tickets when a gold value is entered.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const random = Math.floor(Math.random() * 900000) + 100000;
  const event_id = `Manual${timestamp}${random}`.slice(0, 32);
  const defaultNote = transactionType === 'monthly' ? 'Manual 50/50 ticket entry' : 'Manual bi-weekly ticket entry';
  const auditedNote = note || defaultNote;
  const dataSource = bankingSource(transactionType === 'monthly' ? 'ManualMonthlyTicket' : 'ManualBiweeklyTicket', addedBy);
  const isAnonymousEntry = isAnonymousAccount;
  const mailStatus = isAnonymousEntry ? 'sent' : 'unsent';
  const mailRequestId = isAnonymousEntry ? `manual_no_mail_${event_id}` : null;

  const [result] = await applicationDB.execute(
    `
      INSERT IGNORE INTO guildsync_banking_entries (
        event_id,
        transaction_type,
        account_name,
        event_timestamp,
        event_datetime,
        deposit_amount,
        ticket_quantity,
        data_source,
        note,
        mail_status,
        mail_request_id,
        mail_batch_id,
        checked_out_by,
        checked_out_at,
        written_to_eso_at,
        sent_at,
        failed_reason
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        FROM_UNIXTIME(?),
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ${isAnonymousEntry ? 'NOW()' : 'NULL'},
        ${isAnonymousEntry ? 'NOW()' : 'NULL'},
        ${isAnonymousEntry ? 'NOW()' : 'NULL'},
        ?
      )
    `,
    [
      event_id,
      transactionType,
      accountName,
      String(timestamp),
      timestamp,
      goldValue,
      tickets,
      dataSource,
      auditedNote,
      mailStatus,
      mailRequestId,
      isAnonymousEntry ? 'N/A' : null,
      isAnonymousEntry ? '000000000000000000' : null,
      isAnonymousEntry ? 'Anonymous manual entry - no recipient email required' : null
    ]
  );

  await setSetting(applicationDB, 'banking_refresh', new Date().toISOString());

  if (result.affectedRows && googleSheetsBankingConfig().enabled) {
    try {
      const entry = {
        type: transactionType, eventId: event_id, displayName: accountName,
        amount: goldValue, ticketAmount: tickets, dataSource, note: auditedNote, time: timestamp
      };
      const versions = await getRaffleBonusVersions(applicationDB);
      const overrides = await getRaffleBonusOverrides(applicationDB);
      await syncBankingEntriesToGoogleSheets([{
        ...entry, ...calculateBankingEntryBonus(entry, versions, overrides)
      }], { uploadedBy: addedBy });
    } catch (error) { console.error(`Google Sheets manual entry sync failed: ${error.message}`); }
  }

  return {
    eventId: event_id,
    inserted: result.affectedRows || 0,
    entry: {
      type: transactionType,
      eventId: event_id,
      time: timestamp,
      displayName: accountName,
      amount: goldValue,
      ticketAmount: tickets,
      dataSource,
      note: auditedNote
    }
  };
}


export async function moveBankingEntry(applicationDB, payload = {}) {
  const originalEventId = String(payload.event_id || payload.eventId || '').trim();
  const targetTypeInput = String(payload.target_type || payload.targetType || '').trim().toLowerCase();
  const targetType = targetTypeInput === 'monthly' || targetTypeInput === '50/50' || targetTypeInput === '5050'
    ? 'monthly'
    : targetTypeInput === 'biweekly' || targetTypeInput === 'bi-weekly' || targetTypeInput === 'bi weekly'
      ? 'biweekly'
      : targetTypeInput === 'other'
        ? 'other'
        : '';
  const moveNote = String(payload.note || payload.reason || '').trim().slice(0, 120);
  const movedBy = String(payload.movedBy || payload.auditUser || '').trim().slice(0, 64);
  const requestedTickets = Math.floor(Number(payload.tickets ?? payload.ticket_quantity ?? payload.ticketAmount ?? 0));

  if (!originalEventId) {
    throw new Error('Missing banking entry event id.');
  }

  if (!targetType) {
    throw new Error('Select Bi-Weekly, 50/50, or Other as the destination.');
  }

  if (!Number.isFinite(requestedTickets) || requestedTickets < 0) {
    throw new Error('Ticket quantity must be zero or greater.');
  }

  const connection = await applicationDB.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
        SELECT *
        FROM guildsync_banking_entries
        WHERE event_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [originalEventId]
    );

    const original = rows[0];
    if (!original) {
      throw new Error('Original banking entry was not found.');
    }

    const originalType = String(original.transaction_type || '').trim().toLowerCase();
    if (originalType === 'moved') {
      throw new Error('This banking entry has already been moved.');
    }

    if (originalType === targetType) {
      throw new Error('The destination must be different from the current section.');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const random = Math.floor(Math.random() * 900000) + 100000;
    const movedEventId = `ManualMove${timestamp}${random}`.slice(0, 32);
    const fromLabel = originalType === 'monthly' ? '50/50' : originalType === 'biweekly' ? 'Bi-Weekly' : 'Other';
    const toLabel = targetType === 'monthly' ? '50/50' : targetType === 'biweekly' ? 'Bi-Weekly' : 'Other';
    const noteParts = [`Moved from ${fromLabel} to ${toLabel} by ${movedBy || 'Unknown user'}.`, `Ref ${originalEventId}`];
    if (moveNote) noteParts.push(`Reason: ${moveNote}`);
    const originalExistingNote = String(original.note || '').trim();
    if (originalExistingNote) noteParts.push(`Original Note: ${originalExistingNote}`);
    const movedNote = noteParts.join('\n').slice(0, 255);
    const originalNote = [`Moved to ${toLabel}.`, `Replacement ${movedEventId}`].join(' ').slice(0, 255);
    const ticketQuantity = targetType === 'other' ? 0 : requestedTickets;
    const isOtherTarget = targetType === 'other';
    const targetDataSource = targetType === 'monthly'
      ? 'ManualMovedMonthlyTicket'
      : targetType === 'biweekly'
        ? 'ManualMovedBiweeklyTicket'
        : 'ManualMovedOther';
    const targetMailStatus = isOtherTarget ? 'N/A' : 'unsent';
    const targetMailRequestId = isOtherTarget ? 'N/A' : null;
    const targetMailBatchId = isOtherTarget ? 'N/A' : null;
    const targetCheckedOutBy = isOtherTarget ? '000000000000000000' : null;
    const targetFailedReason = isOtherTarget ? 'No deposit mail required for other category' : null;

    await connection.execute(
      `
        UPDATE guildsync_banking_entries
        SET transaction_type = 'moved',
            data_source = 'MovedOriginal',
            note = ?,
            mail_status = 'N/A',
            mail_request_id = 'N/A',
            mail_batch_id = 'N/A',
            checked_out_by = '000000000000000000',
            checked_out_at = COALESCE(checked_out_at, NOW()),
            checkout_expires_at = NULL,
            written_to_eso_at = COALESCE(written_to_eso_at, NOW()),
            sent_at = COALESCE(sent_at, NOW()),
            failed_reason = 'Original entry moved to another banking section'
        WHERE event_id = ?
      `,
      [originalNote, originalEventId]
    );

    await connection.execute(
      `
        INSERT INTO guildsync_banking_entries (
          event_id,
          transaction_type,
          account_name,
          event_timestamp,
          event_datetime,
          deposit_amount,
          ticket_quantity,
          data_source,
          note,
          mail_status,
          mail_request_id,
          mail_batch_id,
          checked_out_by,
          checked_out_at,
          written_to_eso_at,
          sent_at,
          failed_reason
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          FROM_UNIXTIME(?),
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ${isOtherTarget ? 'NOW()' : 'NULL'},
          ${isOtherTarget ? 'NOW()' : 'NULL'},
          ${isOtherTarget ? 'NOW()' : 'NULL'},
          ?
        )
      `,
      [
        movedEventId,
        targetType,
        original.account_name,
        String(original.event_timestamp || timestamp),
        Number(original.event_timestamp || timestamp),
        Number(original.deposit_amount || 0),
        ticketQuantity,
        targetDataSource,
        movedNote,
        targetMailStatus,
        targetMailRequestId,
        targetMailBatchId,
        targetCheckedOutBy,
        targetFailedReason
      ]
    );

    await setSetting(connection, 'banking_refresh', new Date().toISOString());
    await connection.commit();

    return {
      originalEventId,
      movedEventId,
      fromType: originalType,
      targetType,
      note: movedNote
    };
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}

function normalizeRosterEvents(rosterEvents) {
  if (!rosterEvents || typeof rosterEvents !== 'object') {
    return [];
  }

  if (Array.isArray(rosterEvents)) {
    return rosterEvents.filter((event) => event && typeof event === 'object');
  }

  return Object.values(rosterEvents).filter((event) => event && typeof event === 'object');
}

function normalizeRosterAccountName(value) {
  const clean = String(value || '').trim();
  return clean.startsWith('@') ? clean.slice(1) : clean;
}

function normalizeRosterRank(value) {
  return String(value || '').trim().slice(0, 20);
}

function normalizeRosterTimestamp(value) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }

  if (/^\d+(\.0+)?$/.test(clean)) {
    return String(Math.trunc(Number(clean)));
  }

  return clean;
}

function normalizeRosterEventType(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', ' ');
}

function createAutomaticRosterEventId(timestamp) {
  return `Auto${timestamp}${Math.floor(Math.random() * 100000000)}`;
}


export function parseGuildSyncBankingSavedVarsLua(rawLuaText = '') {
  const tableText = extractLuaAssignmentTable(rawLuaText, 'GuildSyncBanking');
  const parsed = parseEsoLuaTableForRoster(tableText);
  const defaultSection = parsed?.Default || {};
  const accountName = Object.keys(defaultSection).find((key) => key.startsWith('@')) || '';
  const accountWide = accountName
    ? defaultSection?.[accountName]?.['$AccountWide'] || {}
    : {};

  const biweekly = Array.isArray(accountWide.biweekly) ? accountWide.biweekly : [];
  const monthly = Array.isArray(accountWide.monthly) ? accountWide.monthly : [];
  const other = Array.isArray(accountWide.other) ? accountWide.other : [];

  const entries = [
    ...biweekly.map((entry) => ({ ...entry, type: 'biweekly' })),
    ...monthly.map((entry) => ({ ...entry, type: 'monthly' })),
    ...other.map((entry) => ({ ...entry, type: 'other' }))
  ];

  return {
    table_name: 'GuildSyncBanking',
    account_name: accountName,
    entries,
    entries_count: entries.length,
    section_counts: {
      biweekly: biweekly.length,
      monthly: monthly.length,
      other: other.length
    }
  };
}

export function parseGuildSyncRosterSavedVarsLua(rawLuaText = '') {
  const tableText = extractLuaAssignmentTable(rawLuaText, 'GuildSyncRoster');
  const parsed = parseEsoLuaTableForRoster(tableText);
  const defaultSection = parsed?.Default || {};
  const accountName = Object.keys(defaultSection).find((key) => key.startsWith('@')) || '';
  const accountWide = accountName
    ? defaultSection?.[accountName]?.['$AccountWide'] || {}
    : {};

  return {
    table_name: 'GuildSyncRoster',
    account_name: accountName,
    guildList: accountWide.guildList || null,
    rosterEvents: accountWide.rosterEvents || {}
  };
}

export function parseGuildSyncApplicationsSavedVarsLua(rawLuaText = '') {
  const tableText = extractLuaAssignmentTable(rawLuaText, 'GuildSyncApplications');
  const parsed = parseEsoLuaTableForRoster(tableText);
  const defaultSection = parsed?.Default || {};
  const accountName = Object.keys(defaultSection).find((key) => key.startsWith('@')) || '';
  const accountWide = accountName
    ? defaultSection?.[accountName]?.['$AccountWide'] || {}
    : {};

  const recordsSource = accountWide.records || {};
  const records = normalizeApplicationsSavedVarsRecords(recordsSource);

  return {
    table_name: 'GuildSyncApplications',
    account_name: accountName,
    records,
    records_count: records.length
  };
}

function normalizeApplicationsSavedVarsRecords(recordsSource) {
  if (!recordsSource || typeof recordsSource !== 'object') {
    return [];
  }

  const entries = Array.isArray(recordsSource)
    ? recordsSource.map((value, index) => [String(index + 1), value])
    : Object.entries(recordsSource);

  return entries
    .sort(([leftKey], [rightKey]) => {
      const leftNumber = Number(leftKey);
      const rightNumber = Number(rightKey);
      const leftIsNumber = Number.isInteger(leftNumber);
      const rightIsNumber = Number.isInteger(rightNumber);

      if (leftIsNumber && rightIsNumber) {
        return leftNumber - rightNumber;
      }

      if (leftIsNumber !== rightIsNumber) {
        return leftIsNumber ? -1 : 1;
      }

      return String(leftKey).localeCompare(String(rightKey), undefined, { sensitivity: 'base' });
    })
    .map(([recordKey, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return {
          ...value,
          recordKey
        };
      }

      return {
        recordKey,
        value
      };
    });
}

function extractLuaAssignmentTable(text, tableName) {
  const assignment = new RegExp(`\\b${tableName}\\s*=\\s*\\{`).exec(text);
  if (!assignment) {
    throw new Error(`Could not find table assignment: ${tableName} = {`);
  }

  const openBraceIndex = assignment.index + assignment[0].lastIndexOf('{');
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }

    if (depth === 0) {
      return text.slice(openBraceIndex, i + 1);
    }
  }

  throw new Error(`Could not find matching closing brace for ${tableName}`);
}

function parseEsoLuaTableForRoster(luaTableText) {
  const parser = { text: luaTableText, i: 0 };
  return parseRosterLuaValue(parser);
}

function skipRosterLuaWhitespace(parser) {
  while (parser.i < parser.text.length && /[\s,]/.test(parser.text[parser.i])) {
    parser.i += 1;
  }
}

function parseRosterLuaValue(parser) {
  skipRosterLuaWhitespace(parser);
  const char = parser.text[parser.i];

  if (char === '{') return parseRosterLuaTable(parser);
  if (char === '"') return parseRosterLuaString(parser);
  if (char === '-' || /\d/.test(char || '')) return parseRosterLuaNumber(parser);
  if (parser.text.slice(parser.i, parser.i + 4) === 'true') { parser.i += 4; return true; }
  if (parser.text.slice(parser.i, parser.i + 5) === 'false') { parser.i += 5; return false; }
  if (parser.text.slice(parser.i, parser.i + 3) === 'nil') { parser.i += 3; return null; }

  throw new Error(`Unexpected Lua value at ${parser.i}`);
}

function parseRosterLuaString(parser) {
  parser.i += 1;
  let output = '';
  let escaped = false;

  while (parser.i < parser.text.length) {
    const char = parser.text[parser.i];
    parser.i += 1;

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      return output;
    }

    output += char;
  }

  throw new Error('Unterminated Lua string.');
}

function parseRosterLuaNumber(parser) {
  const start = parser.i;
  while (parser.i < parser.text.length && /[-.\d]/.test(parser.text[parser.i])) {
    parser.i += 1;
  }

  return Number(parser.text.slice(start, parser.i));
}

function parseRosterLuaKey(parser) {
  skipRosterLuaWhitespace(parser);
  if (parser.text[parser.i] !== '[') {
    throw new Error(`Expected Lua key at ${parser.i}`);
  }
  parser.i += 1;
  skipRosterLuaWhitespace(parser);
  const key = parser.text[parser.i] === '"' ? parseRosterLuaString(parser) : parseRosterLuaNumber(parser);
  skipRosterLuaWhitespace(parser);
  if (parser.text[parser.i] !== ']') {
    throw new Error(`Expected ] at ${parser.i}`);
  }
  parser.i += 1;
  skipRosterLuaWhitespace(parser);
  if (parser.text[parser.i] !== '=') {
    throw new Error(`Expected = at ${parser.i}`);
  }
  parser.i += 1;
  return key;
}

function parseRosterLuaTable(parser) {
  parser.i += 1;
  const entries = [];

  while (parser.i < parser.text.length) {
    skipRosterLuaWhitespace(parser);
    if (parser.text[parser.i] === '}') {
      parser.i += 1;
      break;
    }

    const key = parseRosterLuaKey(parser);
    const value = parseRosterLuaValue(parser);
    entries.push({ key, value });
  }

  const allNumericKeys = entries.length > 0 && entries.every((entry) => Number.isInteger(entry.key) && entry.key >= 1);

  if (allNumericKeys) {
    return entries
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.value);
  }

  const object = {};
  for (const entry of entries) {
    object[String(entry.key)] = entry.value;
  }
  return object;
}


function normalizeDiscordMemberPayload(member = {}) {
  return {
    discord_id: String(member.discord_id || member.id || '').trim(),
    avatar: member.avatar || null,
    username: String(member.username || '').trim(),
    global_name: String(member.global_name || member.globalName || '').trim(),
    server_nickname: String(member.server_nickname || member.serverNickname || member.nickname || '').trim(),
    joined_at: String(member.joined_at || member.joinedAt || '').trim(),
    source: String(member.source || '').trim(),
    initiator: String(member.initiator || '').trim().slice(0, 50),
    roles: Array.isArray(member.roles) ? member.roles : []
  };
}

async function getDiscordMemberSnapshot(connection, discordID) {
  const [rows] = await connection.execute(
    `
      SELECT
        discord_id,
        username,
        global_name,
        server_nickname,
        avatar
      FROM discord_members
      WHERE discord_id = ?
      LIMIT 1
    `,
    [discordID]
  );

  return rows[0] || null;
}

async function getDiscordMemberRoleIDs(connection, discordID) {
  const [rows] = await connection.execute(
    `
      SELECT role_id
      FROM discord_member_roles
      WHERE discord_id = ?
      ORDER BY role_id
    `,
    [discordID]
  );

  return new Set(rows.map((row) => String(row.role_id || '').trim()).filter(Boolean));
}

function cleanDiscordRoleHistoryLabel(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const missingRoleMatch = text.match(/^\[\s*missing\s+role\s*:?[\s#]*([^\]]+)\]$/i);
  if (missingRoleMatch?.[1]) {
    return missingRoleMatch[1].trim();
  }

  return text;
}

async function getDiscordRoleNameMap(connection, roleIDs = []) {
  const normalizedRoleIDs = [...new Set(
    [...roleIDs].map((roleID) => cleanDiscordRoleHistoryLabel(roleID)).filter(Boolean)
  )];

  if (normalizedRoleIDs.length === 0) {
    return new Map();
  }

  const placeholders = normalizedRoleIDs.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `
      SELECT role_id, role_name
      FROM discord_roles
      WHERE role_id IN (${placeholders})
         OR role_name IN (${placeholders})
    `,
    [...normalizedRoleIDs, ...normalizedRoleIDs]
  );

  const roleNameMap = new Map();

  for (const row of rows) {
    const roleID = String(row.role_id || '').trim();
    const roleName = String(row.role_name || '').trim();

    if (roleID && roleName) {
      roleNameMap.set(roleID, roleName);
    }

    if (roleName) {
      roleNameMap.set(roleName, roleName);
    }
  }

  return roleNameMap;
}

function formatDiscordRoleNamesForHistory(roleIDs = [], roleNameMap = new Map()) {
  return [...roleIDs]
    .map((roleID) => {
      const normalizedRoleID = cleanDiscordRoleHistoryLabel(roleID);
      return roleNameMap.get(normalizedRoleID) || normalizedRoleID;
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
    .join(', ');
}

async function recordDiscordMemberSnapshotHistory(connection, existing, existingRoleIDs, member, newRoleIDs, source) {
  let recorded = 0;

  if (!existing) {
    recorded += await insertDiscordMemberHistory(connection, {
      member,
      event_type: 'joined_server',
      field_name: null,
      old_value: null,
      new_value: summarizeDiscordMember(member),
      source
    });
    return recorded;
  }

  const fields = [
    ['username', 'username'],
    ['global_name', 'global_name'],
    ['server_nickname', 'server_nickname']
  ];

  for (const [fieldName, memberKey] of fields) {
    const oldValue = normalizeHistoryValue(existing[fieldName]);
    const newValue = normalizeHistoryValue(member[memberKey]);

    if (oldValue !== newValue) {
      recorded += await insertDiscordMemberHistory(connection, {
        member,
        event_type: `${fieldName}_changed`,
        field_name: fieldName,
        old_value: oldValue,
        new_value: newValue,
        source
      });
    }
  }

  const oldRoles = [...existingRoleIDs].sort();
  const newRoles = [...newRoleIDs].sort();

  if (oldRoles.join('|') !== newRoles.join('|')) {
    const roleNameMap = await getDiscordRoleNameMap(connection, [...oldRoles, ...newRoles]);

    recorded += await insertDiscordMemberHistory(connection, {
      member,
      event_type: 'roles_changed',
      field_name: 'roles',
      old_value: formatDiscordRoleNamesForHistory(oldRoles, roleNameMap),
      new_value: formatDiscordRoleNamesForHistory(newRoles, roleNameMap),
      source,
      initiator: member.initiator
    });
  }

  return recorded;
}

async function insertDiscordMemberHistory(connection, event = {}) {
  const member = event.member || {};
  const now = new Date();
  const eventTimestamp = String(Math.floor(now.getTime() / 1000));

  await connection.execute(
    `
      INSERT INTO discord_member_history (
        discord_id,
        username,
        global_name,
        server_nickname,
        event_type,
        field_name,
        old_value,
        new_value,
        event_timestamp,
        event_datetime,
        source,
        initiator
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      String(member.discord_id || member.id || '').trim(),
      normalizeHistoryValue(member.username),
      normalizeHistoryValue(member.global_name || member.globalName),
      normalizeHistoryValue(member.server_nickname || member.serverNickname || member.nickname),
      String(event.event_type || 'unknown').trim().slice(0, 64) || 'unknown',
      event.field_name ? String(event.field_name).trim().slice(0, 64) : null,
      event.old_value == null ? null : String(event.old_value),
      event.new_value == null ? null : String(event.new_value),
      eventTimestamp,
      now,
      String(event.source || 'unknown').trim().slice(0, 64) || 'unknown',
      String(event.initiator || member.initiator || '').trim().slice(0, 50) || null
    ]
  );

  return 1;
}

function normalizeHistoryValue(value) {
  return String(value ?? '').trim();
}

function summarizeDiscordMember(member = {}) {
  const parts = [];
  const username = normalizeHistoryValue(member.username);
  const globalName = normalizeHistoryValue(member.global_name || member.globalName);
  const serverNickname = normalizeHistoryValue(member.server_nickname || member.serverNickname || member.nickname);

  if (username) parts.push(`username=${username}`);
  if (globalName) parts.push(`global_name=${globalName}`);
  if (serverNickname) parts.push(`server_nickname=${serverNickname}`);

  return parts.join('; ');
}

async function safeRollback(connection) {
  try {
    await connection.rollback();
  } catch {
    // Ignore rollback failures so the original error can be thrown.
  }
}

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replaceAll('`', '``')}\``;
}

function requiredDatabaseEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required MariaDB environment variable: ${name}`
    );
  }

  return value;
}

async function setDiscordRefreshNow(db) {
  await setSetting(
    db,
    'discord_refresh',
    new Date().toISOString()
  );
}

async function setSetting(db, settingKey, value) {
  await db.execute(
    `
      INSERT INTO guildsync_settings (
        setting_key,
        value
      )
      VALUES (
        ?,
        ?
      )
      ON DUPLICATE KEY UPDATE
        value = VALUES(value)
    `,
    [
      settingKey,
      value
    ]
  );
}


async function getSettingValue(db, settingKey) {
  const [rows] = await db.execute(
    `
      SELECT value
      FROM guildsync_settings
      WHERE setting_key = ?
      LIMIT 1
    `,
    [settingKey]
  );

  return rows[0]?.value || null;
}

async function ensureColumn(db, tableName, columnName, columnDefinition, afterColumnName = null) {
  const [rows] = await db.execute(
    `
      SELECT COUNT(*) AS column_count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    [GUILDSYNC_DB_NAME, tableName, columnName]
  );

  const exists = Number(rows[0]?.column_count || 0) > 0;

  if (exists) {
    return;
  }

  const afterSql = afterColumnName
    ? ` AFTER ${quoteIdentifier(afterColumnName)}`
    : '';

  await db.query(
    `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDefinition}${afterSql}`
  );
}


function normalizeMemberLinkName(value) {
  let text = String(value || '').toLowerCase().trim();
  if (!text) return '';
  text = text.replace(/^@+/, '');
  text = text.replace(/\([^)]*\b(?:she|her|he|him|they|them|it|its|any|all)\b[^)]*\)/gi, '');
  text = text.replace(/\[[^\]]*\b(?:she|her|he|him|they|them|it|its|any|all)\b[^\]]*\]/gi, '');
  text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/[^a-z0-9]/g, '');
  return text;
}

function getDiscordNameCandidates(member = {}) {
  return [
    { field: 'discord_username', priority: 1, value: member.username },
    { field: 'discord_display_name', priority: 2, value: member.global_name },
    { field: 'discord_server_nickname', priority: 3, value: member.server_nickname }
  ]
    .map((candidate) => ({
      ...candidate,
      value: String(candidate.value || '').trim(),
      normalized: normalizeMemberLinkName(candidate.value)
    }))
    .filter((candidate) => candidate.value && candidate.normalized);
}

function getBestDiscordNameMatch(esoName, discord) {
  const candidates = getDiscordNameCandidates(discord);
  let best = null;

  for (const candidate of candidates) {
    const score = fuzzyNameScore(esoName, candidate.value);

    if (
      !best
      || score > best.score
      || (score === best.score && candidate.priority < best.priority)
    ) {
      best = {
        field: candidate.field,
        value: candidate.value,
        normalized: candidate.normalized,
        priority: candidate.priority,
        score
      };
    }
  }

  return best;
}

function levenshteinDistance(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

function fuzzyNameScore(left, right) {
  const a = normalizeMemberLinkName(left);
  const b = normalizeMemberLinkName(right);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const longer = Math.max(a.length, b.length);
  const distanceScore = Math.round((1 - (levenshteinDistance(a, b) / longer)) * 100);
  const containsScore = (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 4 ? 88 : 0;
  return Math.max(distanceScore, containsScore);
}

async function loadMemberLinkInputs(db) {
  const [rosterRows] = await db.execute(`
    SELECT account_name, rank_name AS rank, joined_timestamp AS joined
    FROM guildsync_roster_members
    WHERE in_roster = 1
    ORDER BY LOWER(account_name) ASC
  `);

  const [discordRows] = await db.execute(`
    SELECT discord_id, username, global_name, server_nickname
    FROM discord_members
    ORDER BY LOWER(COALESCE(server_nickname, global_name, username)) ASC
  `);

  const [linkRows] = await db.execute(`
    SELECT *
    FROM guildsync_member_links
  `);

  return { rosterRows, discordRows, linkRows };
}

function getMemberLinkPairKey(esoAccountName, discordUserId) {
  return `${normalizeRosterAccountName(esoAccountName).toLowerCase()}::${String(discordUserId || '').trim()}`;
}

function buildExistingLinkMaps(linkRows = []) {
  const byPair = new Map();
  const byEso = new Map();
  const byDiscord = new Map();
  const blockedPairs = new Set();
  const linkedPairs = new Set();

  for (const link of linkRows) {
    const esoName = normalizeRosterAccountName(link.eso_account_name);
    const discordID = String(link.discord_user_id || '').trim();

    if (!esoName || !discordID) {
      continue;
    }

    const pairKey = getMemberLinkPairKey(esoName, discordID);
    byPair.set(pairKey, link);

    const esoKey = esoName.toLowerCase();
    if (!byEso.has(esoKey)) byEso.set(esoKey, []);
    byEso.get(esoKey).push(link);

    if (!byDiscord.has(discordID)) byDiscord.set(discordID, []);
    byDiscord.get(discordID).push(link);

    if (Number(link.auto_link_blocked || 0) === 1) {
      blockedPairs.add(pairKey);
    }

    if (String(link.link_status || '').toLowerCase() === 'linked') {
      linkedPairs.add(pairKey);
    }
  }

  return { byPair, byEso, byDiscord, blockedPairs, linkedPairs };
}

function isMemberLinkPairBlocked(maps, esoAccountName, discordUserId) {
  return maps.blockedPairs.has(getMemberLinkPairKey(esoAccountName, discordUserId));
}

function isMemberLinkPairLinked(maps, esoAccountName, discordUserId) {
  return maps.linkedPairs.has(getMemberLinkPairKey(esoAccountName, discordUserId));
}

function isMemberLinkPairAutoUpgradeable(maps, esoAccountName, discordUserId, newConfidence = 0) {
  if (isMemberLinkPairBlocked(maps, esoAccountName, discordUserId)) return false;

  const existingPair = maps.byPair.get(getMemberLinkPairKey(esoAccountName, discordUserId));
  if (!existingPair) return true;

  const status = String(existingPair.link_status || '').toLowerCase();
  const method = String(existingPair.link_method || '').toLowerCase();
  const existingConfidence = Number(existingPair.match_confidence || 0);

  if (status === 'blocked' || Number(existingPair.auto_link_blocked || 0) === 1) return false;
  if (status === 'linked' && method === 'manual') return false;
  if (status === 'linked' && method === 'exact') return false;

  return ['candidate', 'unlinked'].includes(status) || (method === 'fuzzy' && newConfidence > existingConfidence);
}

async function removeWeakerMemberAutoLinkCandidates(applicationDB, { esoAccountName, discordUserId, matchConfidence }) {
  const esoName = String(esoAccountName || '').trim().replace(/^@+/, '');
  const discordId = String(discordUserId || '').trim();
  const confidence = Number(matchConfidence || 0);

  if (!esoName || !discordId) return;

  await applicationDB.execute(`
    DELETE FROM guildsync_member_links
    WHERE auto_link_blocked = 0
      AND (
        LOWER(eso_account_name) = LOWER(?)
        OR discord_user_id = ?
      )
      AND NOT (
        LOWER(eso_account_name) = LOWER(?)
        AND discord_user_id = ?
      )
      AND (
        link_status IN ('candidate', 'unlinked')
        OR (link_status = 'linked' AND link_method = 'fuzzy' AND match_confidence < ?)
      )
      AND match_confidence < ?
  `, [esoName, discordId, esoName, discordId, confidence, confidence]);
}

export async function runMemberAutoLinking(applicationDB) {
  const { rosterRows, discordRows, linkRows } = await loadMemberLinkInputs(applicationDB);
  const maps = buildExistingLinkMaps(linkRows);

  let linked = 0;
  let candidates = 0;
  const exactDiscordByName = new Map();

  for (const discord of discordRows) {
    if (!discord.discord_id) continue;

    for (const candidate of getDiscordNameCandidates(discord)) {
      if (!exactDiscordByName.has(candidate.normalized)) exactDiscordByName.set(candidate.normalized, []);
      exactDiscordByName.get(candidate.normalized).push({
        discord,
        field: candidate.field,
        value: candidate.value,
        priority: candidate.priority
      });
    }
  }

  for (const roster of rosterRows) {
    const esoName = String(roster.account_name || '').trim();
    const normalizedEso = normalizeMemberLinkName(esoName);

    if (!esoName || !normalizedEso) continue;

    const exactMatches = exactDiscordByName.get(normalizedEso) || [];
    const usableExactMatches = exactMatches
      .filter((match) => match.discord?.discord_id)
      .filter((match) => !isMemberLinkPairBlocked(maps, esoName, match.discord.discord_id))
      .filter((match) => isMemberLinkPairAutoUpgradeable(maps, esoName, match.discord.discord_id, 100));

    usableExactMatches.sort((left, right) => left.priority - right.priority);

    if (usableExactMatches.length > 0) {
      for (const match of usableExactMatches) {
        const discord = match.discord;
        await upsertMemberLink(applicationDB, {
          esoAccountName: esoName,
          discordUserId: discord.discord_id,
          discordUsername: discord.username,
          discordDisplayName: discord.global_name,
          discordServerNickname: discord.server_nickname,
          linkStatus: 'linked',
          linkMethod: 'exact',
          matchConfidence: 100,
          matchReason: `Exact normalized ${match.field} match`,
          matchField: match.field,
          auto_link_blocked: 0
        });
        maps.linkedPairs.add(getMemberLinkPairKey(esoName, discord.discord_id));
        await removeWeakerMemberAutoLinkCandidates(applicationDB, {
          esoAccountName: esoName,
          discordUserId: discord.discord_id,
          matchConfidence: 100
        });
        linked += 1;
      }
      continue;
    }

    let best = null;
    for (const discord of discordRows) {
      if (!discord.discord_id) continue;
      if (isMemberLinkPairBlocked(maps, esoName, discord.discord_id)) continue;

      const match = getBestDiscordNameMatch(esoName, discord);
      if (!match) continue;

      if (
        !best
        || match.score > best.score
        || (match.score === best.score && match.priority < best.priority)
      ) {
        best = { discord, ...match };
      }
    }

    if (best && best.score >= 82 && isMemberLinkPairAutoUpgradeable(maps, esoName, best.discord.discord_id, best.score)) {
      await removeWeakerMemberAutoLinkCandidates(applicationDB, {
        esoAccountName: esoName,
        discordUserId: best.discord.discord_id,
        matchConfidence: best.score
      });
      await upsertMemberLink(applicationDB, {
        esoAccountName: esoName,
        discordUserId: best.discord.discord_id,
        discordUsername: best.discord.username,
        discordDisplayName: best.discord.global_name,
        discordServerNickname: best.discord.server_nickname,
        linkStatus: 'candidate',
        linkMethod: 'fuzzy',
        matchConfidence: best.score,
        matchReason: `Fuzzy normalized ${best.field} match candidate`,
        matchField: best.field,
        auto_link_blocked: 0
      });
      candidates += 1;
    }
  }

  return { linked, candidates };
}

export async function upsertMemberLink(applicationDB, link = {}) {
  const esoAccountName = String(link.esoAccountName || link.eso_account_name || '').trim().replace(/^@+/, '');
  const discordUserId = String(link.discordUserId || link.discord_user_id || '').trim();

  if (!esoAccountName) throw new Error('ESO account name is required.');
  if (!discordUserId) throw new Error('Discord user id is required.');

  await applicationDB.execute(`
    INSERT INTO guildsync_member_links (
      eso_account_name,
      discord_user_id,
      discord_username,
      discord_display_name,
      discord_server_nickname,
      link_status,
      link_method,
      match_confidence,
      match_reason,
      match_field,
      auto_link_blocked
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      discord_username = VALUES(discord_username),
      discord_display_name = VALUES(discord_display_name),
      discord_server_nickname = VALUES(discord_server_nickname),
      link_status = VALUES(link_status),
      link_method = VALUES(link_method),
      match_confidence = VALUES(match_confidence),
      match_reason = VALUES(match_reason),
      match_field = VALUES(match_field),
      auto_link_blocked = VALUES(auto_link_blocked)
  `, [
    esoAccountName,
    discordUserId,
    link.discordUsername || link.discord_username || null,
    link.discordDisplayName || link.discord_display_name || null,
    link.discordServerNickname || link.discord_server_nickname || null,
    link.linkStatus || link.link_status || 'candidate',
    link.linkMethod || link.link_method || 'none',
    Number(link.matchConfidence ?? link.match_confidence ?? 0),
    link.matchReason || link.match_reason || null,
    link.matchField || link.match_field || null,
    Number(link.auto_link_blocked || 0) ? 1 : 0
  ]);
  if ((link.linkStatus || link.link_status) === 'linked') await notifyDiscordConfirmedLink(applicationDB, discordUserId);
}

export async function getMemberLinks(applicationDB) {
  const [rows] = await applicationDB.execute(`
    SELECT
      links.eso_account_name,
      links.discord_user_id,
      links.discord_username,
      links.discord_display_name,
      links.discord_server_nickname,
      links.link_status,
      links.link_method,
      links.match_confidence,
      links.match_reason,
      links.match_field,
      links.auto_link_blocked AS locked,
      links.updated_at,
      roster.rank_name AS eso_rank,
      roster.joined_timestamp AS eso_joined
    FROM guildsync_member_links links
    LEFT JOIN guildsync_roster_members roster
      ON LOWER(roster.account_name) = LOWER(links.eso_account_name)
    ORDER BY
      CASE links.link_status WHEN 'candidate' THEN 0 WHEN 'linked' THEN 1 ELSE 2 END,
      links.match_confidence DESC,
      LOWER(links.eso_account_name) ASC,
      LOWER(COALESCE(links.discord_server_nickname, links.discord_display_name, links.discord_username, links.discord_user_id)) ASC
  `);
  return rows;
}

export async function getMemberLinkOptions(applicationDB, payload = {}) {
  const mode = String(payload.mode || '').trim();
  const accountName = String(payload.accountName || '').trim().replace(/^@+/, '');
  const discordUserId = String(payload.discordUserId || '').trim();
  const { rosterRows, discordRows, linkRows } = await loadMemberLinkInputs(applicationDB);
  const maps = buildExistingLinkMaps(linkRows);

  if (mode === 'discord-to-eso') {
    const source = discordRows.find((row) => String(row.discord_id) === discordUserId);
    const names = source ? getDiscordNameCandidates(source) : [];
    return rosterRows
      .filter((row) => !isMemberLinkPairLinked(maps, row.account_name, discordUserId))
      .filter((row) => !isMemberLinkPairBlocked(maps, row.account_name, discordUserId))
      .map((row) => {
        let best = { confidence: 0, matchField: '' };
        for (const name of names) {
          const score = fuzzyNameScore(row.account_name, name.value || name);
          if (score > best.confidence) {
            best = { confidence: score, matchField: name.field || '' };
          }
        }
        return {
          account_name: row.account_name,
          rank: row.rank,
          confidence: best.confidence,
          matchField: best.matchField
        };
      })
      .sort((a, b) => b.confidence - a.confidence || String(a.account_name).localeCompare(String(b.account_name), undefined, { sensitivity: 'base' }));
  }

  const sourceEso = accountName;
  return discordRows
    .filter((row) => !isMemberLinkPairLinked(maps, sourceEso, row.discord_id))
    .filter((row) => !isMemberLinkPairBlocked(maps, sourceEso, row.discord_id))
    .map((row) => {
      let best = { confidence: 0, matchField: '' };
      for (const name of getDiscordNameCandidates(row)) {
        const score = fuzzyNameScore(sourceEso, name.value || name);
        if (score > best.confidence) {
          best = { confidence: score, matchField: name.field || '' };
        }
      }
      return {
        discord_id: row.discord_id,
        username: row.username,
        global_name: row.global_name,
        server_nickname: row.server_nickname,
        confidence: best.confidence,
        matchField: best.matchField
      };
    })
    .sort((a, b) => {
      const confidenceDelta = b.confidence - a.confidence;
      if (confidenceDelta !== 0) return confidenceDelta;
      const leftName = String(a.server_nickname || a.global_name || a.username || '');
      const rightName = String(b.server_nickname || b.global_name || b.username || '');
      return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
    });
}

export async function acceptMemberLinkCandidate(applicationDB, payload = {}) {
  const esoAccountName = String(payload.esoAccountName || payload.eso_account_name || '').trim().replace(/^@+/, '');
  const discordUserId = String(payload.discordUserId || payload.discord_user_id || '').trim();
  if (!esoAccountName) throw new Error('ESO account name is required.');

  const params = [esoAccountName];
  let discordClause = '';
  if (discordUserId) {
    discordClause = ' AND discord_user_id = ?';
    params.push(discordUserId);
  }

  const [rows] = await applicationDB.execute(`
    SELECT *
    FROM guildsync_member_links
    WHERE LOWER(eso_account_name) = LOWER(?)
      ${discordClause}
      AND link_status = 'candidate'
      AND auto_link_blocked = 0
    ORDER BY match_confidence DESC
    LIMIT 1
  `, params);

  const candidate = rows[0];
  if (!candidate) throw new Error('No auto-link candidate found for this ESO/Discord pair.');

  await upsertMemberLink(applicationDB, {
    esoAccountName,
    discordUserId: candidate.discord_user_id,
    discordUsername: candidate.discord_username,
    discordDisplayName: candidate.discord_display_name,
    discordServerNickname: candidate.discord_server_nickname,
    linkStatus: 'linked',
    linkMethod: 'fuzzy',
    matchConfidence: candidate.match_confidence,
    matchReason: 'Accepted fuzzy candidate',
    matchField: candidate.match_field,
    auto_link_blocked: 0
  });
}

function linkFieldNameFromPayload(value) {
  const field = String(value || '').trim().toLowerCase();
  if (field === 'discord_username' || field === 'username') return 'discord_username';
  if (field === 'discord_display_name' || field === 'global_name' || field === 'display_name') return 'discord_display_name';
  if (field === 'discord_server_nickname' || field === 'server_nickname' || field === 'nickname') return 'discord_server_nickname';
  return null;
}

export async function manualLinkMember(applicationDB, payload = {}) {
  const esoAccountName = String(payload.esoAccountName || payload.eso_account_name || '').trim().replace(/^@+/, '');
  const discordUserId = String(payload.discordUserId || payload.discord_user_id || '').trim();
  if (!esoAccountName || !discordUserId) throw new Error('ESO account and Discord user are required.');

  const [discordRows] = await applicationDB.execute(`
    SELECT discord_id, username, global_name, server_nickname
    FROM discord_members
    WHERE discord_id = ?
    LIMIT 1
  `, [discordUserId]);
  const discord = discordRows[0];
  if (!discord) throw new Error('Discord member was not found.');

  const suppliedMatchField = linkFieldNameFromPayload(payload.matchField || payload.match_field || payload.discordMatchField || payload.discord_match_field);
  const suppliedConfidence = Number(payload.matchConfidence ?? payload.match_confidence ?? 100);
  const confidence = Number.isFinite(suppliedConfidence) ? suppliedConfidence : 100;
  const matchReason = suppliedMatchField
    ? `Manually linked from suggested match on ${suppliedMatchField}`
    : 'Manually linked by user';

  await upsertMemberLink(applicationDB, {
    esoAccountName,
    discordUserId,
    discordUsername: discord.username,
    discordDisplayName: discord.global_name,
    discordServerNickname: discord.server_nickname,
    linkStatus: 'linked',
    linkMethod: 'manual',
    matchConfidence: confidence,
    matchReason,
    matchField: suppliedMatchField,
    auto_link_blocked: 0
  });
}


export async function unblockMemberAutoLink(applicationDB, payload = {}) {
  const esoAccountName = String(payload.esoAccountName || payload.eso_account_name || '').trim().replace(/^@+/, '');
  const discordUserId = String(payload.discordUserId || payload.discord_user_id || '').trim();

  if (!esoAccountName || !discordUserId) {
    throw new Error('ESO account and Discord user are required to remove an auto-link block.');
  }

  const [result] = await applicationDB.execute(`
    DELETE FROM guildsync_member_links
    WHERE LOWER(eso_account_name) = LOWER(?)
      AND discord_user_id = ?
      AND (
        auto_link_blocked = 1
        OR link_status = 'blocked'
        OR link_method = 'manual_unlink'
      )
  `, [esoAccountName, discordUserId]);

  return { removed: Number(result?.affectedRows || 0) };
}

export async function manualUnlinkMember(applicationDB, payload = {}) {
  const esoAccountName = String(payload.esoAccountName || payload.eso_account_name || '').trim().replace(/^@+/, '');
  const discordUserId = String(payload.discordUserId || payload.discord_user_id || '').trim();

  if (!esoAccountName || !discordUserId) {
    throw new Error('ESO account and Discord user are required to unlink a specific member link.');
  }

  const [rows] = await applicationDB.execute(`
    SELECT *
    FROM guildsync_member_links
    WHERE LOWER(eso_account_name) = LOWER(?)
      AND discord_user_id = ?
    LIMIT 1
  `, [esoAccountName, discordUserId]);

  const existing = rows[0];
  if (!existing) {
    return { unlinked: 0, blocked: false };
  }

  const status = String(existing.link_status || '').toLowerCase();
  const method = String(existing.link_method || '').toLowerCase();

  if (status === 'linked' && method === 'exact') {
    await applicationDB.execute(`
      UPDATE guildsync_member_links
      SET link_status = 'blocked',
          link_method = 'manual_unlink',
          match_confidence = 0,
          match_reason = 'Exact auto-link disabled by user after unlink',
          auto_link_blocked = 1
      WHERE LOWER(eso_account_name) = LOWER(?)
        AND discord_user_id = ?
    `, [esoAccountName, discordUserId]);

    return { unlinked: 1, blocked: true };
  }

  await applicationDB.execute(`
    DELETE FROM guildsync_member_links
    WHERE LOWER(eso_account_name) = LOWER(?)
      AND discord_user_id = ?
  `, [esoAccountName, discordUserId]);

  await runMemberAutoLinking(applicationDB);

  return { unlinked: 1, blocked: false };
}
function formatAssociateTicketReportDateEastern(timestamp) {
  const numeric = Number(timestamp || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';

  const date = new Date(numeric * 1000);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function formatAssociateTicketReportShortDateEastern(timestamp) {
  const numeric = Number(timestamp || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';

  const date = new Date(numeric * 1000);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function getAssociateTicketReportRaffleWindow(row = {}) {
  const type = normalizeDepositMailTicketType(row.transaction_type || row.earliest_deposit_type || row.ticket_type || row.type);
  if (type !== 'monthly' && type !== 'biweekly') return null;

  const eventTimestamp = Number(row.event_timestamp || row.earliest_deposit_timestamp || row.time || 0);
  if (!Number.isFinite(eventTimestamp) || eventTimestamp <= 0) return null;

  const salesEnd = type === 'monthly'
    ? getDepositMailMonthlySalesEndAtOrAfter(eventTimestamp)
    : getDepositMailBiweeklySalesEndAtOrAfter(eventTimestamp);

  const previousSalesEnd = type === 'monthly'
    ? getDepositMailPreviousMonthlySalesEnd(salesEnd)
    : salesEnd - BANKING_BIWEEKLY_INTERVAL_SECONDS;

  return {
    type,
    label: getDepositMailTicketTypeLabel(type),
    salesStart: previousSalesEnd + 1,
    salesEnd,
    raffleTime: salesEnd + BANKING_RAFFLE_AFTER_SALES_SECONDS
  };
}

function getDepositMailPreviousMonthlySalesEnd(currentSalesEnd) {
  let salesEnd = currentSalesEnd - BANKING_BIWEEKLY_INTERVAL_SECONDS;

  while (!isDepositMailLastRaffleSalesEndInEasternMonth(salesEnd)) {
    salesEnd -= BANKING_BIWEEKLY_INTERVAL_SECONDS;
  }

  return salesEnd;
}

function formatAssociateTicketReportRafflePeriod(row = {}) {
  const windowInfo = getAssociateTicketReportRaffleWindow(row);
  if (!windowInfo) return '';

  const raffleDate = formatAssociateTicketReportShortDateEastern(windowInfo.raffleTime);
  return [windowInfo.label, raffleDate ? `Raffle ${raffleDate}` : ''].filter(Boolean).join(' | ');
}

function formatAssociateTicketReportEarliestDeposit(row = {}) {
  const depositDate = formatAssociateTicketReportShortDateEastern(row.earliest_deposit_timestamp);
  const rafflePeriod = formatAssociateTicketReportRafflePeriod(row);
  return [depositDate, rafflePeriod].filter(Boolean).join(' | ');
}

