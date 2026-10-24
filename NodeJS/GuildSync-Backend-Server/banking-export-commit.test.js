import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {validateEsoGuildImport} from './eso-guild-origin.js';
import { bankingSource } from './banking-source.js';

const source = fs.readFileSync(new URL('./guildsync-database-actions.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function insertBankingEntries(');
const end = source.indexOf('export async function getRosterDataDate(', start);
const functionSource = source.slice(start, end).replace('export ', '');

test('Sheets receives only new inserts after commit and preserves uploader attribution', async () => {
  for (const scenario of ['mixed', 'duplicate', 'commit-failure']) {
    let committed = false;
    const exports = [];
    const connection = {
      async beginTransaction() {}, async rollback() {}, release() {},
      async commit() { if (scenario === 'commit-failure') throw new Error('commit failed'); committed = true; },
      async execute(sql, params) {
        if (sql.includes('INSERT IGNORE')) assert.equal(params[7], 'GuildSyncBanking (EvaineFaye)');
        return [{ affectedRows: sql.includes('INSERT IGNORE') ? (scenario === 'duplicate' || params[0] === 2 ? 0 : 1) : 1 }];
      }
    };
    const context = vm.createContext({
      console, bankingSource, validateEsoGuildImport,
      enqueueSheetsExports:async()=>{assert.equal(committed,false);},
      createSheetsExportStore:()=>({completed:async()=>{}}), normalizeDepositMailTicketType: value => value,
      safeRollback: async c => c.rollback(),
      googleSheetsBankingConfig: () => ({ enabled: true }),
      getBankingDataJSON: async () => [],
      syncBankingEntriesToGoogleSheets: async (entries, options) => {
        assert.equal(committed, true);
        exports.push({ entries, options });
      }
    });
    vm.runInContext(functionSource, context);
    const operation = context.insertBankingEntries({ getConnection: async () => connection }, {
      uploadedBy: 'EvaineFaye', entries: [1, 2].map(eventId => ({ eventId, type: 'biweekly', displayName: 'Buyer', time: 1000, amount: 100001, ticketAmount: 10 }))
    });
    if (scenario === 'commit-failure') await assert.rejects(operation, /commit failed/);
    else await operation;
    if (scenario === 'mixed') {
      assert.equal(exports.length, 1);
      assert.equal(exports[0].entries.length, 1);
      assert.equal(exports[0].entries[0].eventId, 1);
      assert.equal(exports[0].options.uploadedBy, 'EvaineFaye');
    } else assert.equal(exports.length, 0);
  }
});

