import test from 'node:test'
import assert from 'node:assert/strict'
import { runCaptured } from './exec.mjs'
import {
  APPROVED_MIGRATION,
  BASELINE_MIGRATION,
  EXPECTED_SCHEMA,
  EXPECTED_TABLES,
  evaluatePlan,
  evaluatePostMigration,
  evaluateStatusAgreement,
  isValidRequestId,
  isValidSourceSha,
  parseMigrationStatus,
  registeredInventory,
  verifyOwnedSchema,
} from './migration-plan.mjs'

const registered = [BASELINE_MIGRATION, APPROVED_MIGRATION].sort()
const row = (id, name, batch) => ({ id, name, batch, createdAt: `t${id}`, updatedAt: `t${id}` })
const baselineRow = row('1', BASELINE_MIGRATION, 1)
const approvedRow = row('2', APPROVED_MIGRATION, 2)
const statusYes = (name) => ({ name, ran: 'Yes', batch: 1 })
const statusNo = (name) => ({ name, ran: 'No', batch: null })

function buildSchema(mutate = () => {}) {
  const columns = []
  const constraints = []
  for (const [table, spec] of Object.entries(EXPECTED_SCHEMA)) {
    for (const [col, sig] of Object.entries(spec.cols)) {
      const [dataType, nullable] = sig.split(':')
      columns.push({ table, column: col, dataType, nullable })
    }
    constraints.push({ table, type: 'p', columns: spec.pk, validated: true, def: `PRIMARY KEY (${spec.pk.join(', ')})` })
    for (const u of spec.uniques) constraints.push({ table, type: 'u', columns: u, validated: true, def: `UNIQUE (${u.join(', ')})` })
    if (spec.checkDef) constraints.push({ table, type: 'c', columns: [], validated: true, def: spec.checkDef })
  }
  mutate(columns, constraints)
  return { columns, constraints }
}

// --- defect (1): child-process output must be captured, never inherited ------
test('child-process stdout/stderr is captured in memory (fails if stdio were inherited)', () => {
  const r = runCaptured(process.execPath, ['-e', "process.stdout.write('OUT');process.stderr.write('ERR');process.exit(3)"])
  assert.equal(r.ok, false)
  assert.equal(r.code, 3)
  assert.equal(r.stdout, 'OUT')
  assert.equal(r.stderr, 'ERR')
  const ok = runCaptured(process.execPath, ['-e', "process.stdout.write('OK')"])
  assert.deepEqual([ok.ok, ok.stdout], [true, 'OK'])
})

// --- defect (2): status table with Ran column; mentions w/o Ran are ambiguous -
test('status parsing uses the Payload Name/Batch/Ran table and rejects unparsed rows', () => {
  const table = `| Name                     | Batch | Ran |\n| ${BASELINE_MIGRATION}  | 1     | Yes |\n| ${APPROVED_MIGRATION} |       | No  |\n`
  const parsed = parseMigrationStatus(table)
  assert.equal(parsed.ambiguous, false)
  assert.deepEqual(parsed.rows.map((r) => [r.name, r.ran]), [[BASELINE_MIGRATION, 'Yes'], [APPROVED_MIGRATION, 'No']])
  // hostile: a line naming a migration but with no Yes/No must be ambiguous, not silently accepted
  assert.equal(parseMigrationStatus(`Error applying ${APPROVED_MIGRATION}: pending`).ambiguous, true)
  assert.equal(parseMigrationStatus('$(whoami)').ambiguous, true)
})

test('status must agree exactly with the ledger (applied and pending)', () => {
  const ok = evaluateStatusAgreement({ statusRows: [statusYes(BASELINE_MIGRATION), statusNo(APPROVED_MIGRATION)], registered, ledger: [baselineRow] })
  assert.equal(ok.ok, true)
  const appliedMismatch = evaluateStatusAgreement({ statusRows: [statusYes(BASELINE_MIGRATION), statusYes(APPROVED_MIGRATION)], registered, ledger: [baselineRow] })
  assert.deepEqual([appliedMismatch.ok, appliedMismatch.reason], [false, 'status_applied_mismatch'])
  const pendingMismatch = evaluateStatusAgreement({ statusRows: [statusYes(BASELINE_MIGRATION)], registered, ledger: [baselineRow] })
  assert.equal(pendingMismatch.ok, false)
})

test('hostile source input is rejected', () => {
  for (const bad of ['', '  ', '$(rm -rf /)', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '27833f162ca72a02864b4ef36e77ff915cd84d5']) assert.equal(isValidSourceSha(bad), false)
  assert.equal(isValidSourceSha('27833f162ca72a02864b4ef36e77ff915cd84d56'), true)
  assert.equal(isValidRequestId('req-2026_10-14:1'), true)
  assert.equal(isValidRequestId('a;b'), false)
})

test('inventory covers executable .ts and .js migrations, excluding index', () => {
  assert.deepEqual(registeredInventory(['20261013_101157_initial.ts', '20261014_120000_vroic_owned_state.ts', 'extra.js', 'index.ts']), ['20261013_101157_initial', '20261014_120000_vroic_owned_state', 'extra'].sort())
})

test('ledger plan rules (baseline once, no unknown/dev/duplicate, singleton pending or replay)', () => {
  assert.deepEqual(evaluatePlan({ registered, ledger: [baselineRow] }).state, 'pending')
  assert.deepEqual(evaluatePlan({ registered, ledger: [baselineRow, approvedRow] }).state, 'replay')
  assert.equal(evaluatePlan({ registered, ledger: [baselineRow, baselineRow] }).reason, 'duplicate_ledger_row')
  assert.equal(evaluatePlan({ registered, ledger: [row('1', BASELINE_MIGRATION, -1)] }).reason, 'devbatch_or_invalid_batch')
  assert.match(evaluatePlan({ registered, ledger: [baselineRow, row('9', '20990101_000000_other', 1)] }).reason, /unknown_ledger_row/)
})

// --- defect (3): exact final set; unknown rows rejected; approved preserved --
test('post-migration evidence enforces exact final set and never allows unknown extra rows', () => {
  const ok = evaluatePostMigration({ registered, ledgerBefore: [baselineRow], ledgerAfter: [baselineRow, approvedRow], tables: EXPECTED_TABLES, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([ok.ok, ok.reason], [true, 'verified'])

  const unknownExtra = evaluatePostMigration({ registered, ledgerBefore: [baselineRow], ledgerAfter: [baselineRow, approvedRow, row('9', '20990101_000000_other', 2)], tables: EXPECTED_TABLES, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([unknownExtra.ok, unknownExtra.reason], [false, 'unknown_after:20990101_000000_other'])

  const missingApproved = evaluatePostMigration({ registered, ledgerBefore: [baselineRow], ledgerAfter: [baselineRow], tables: EXPECTED_TABLES, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.equal(missingApproved.ok, false)
})

test('replaying an already-applied approval preserves its full row (change fails closed)', () => {
  const unchanged = evaluatePostMigration({ registered, ledgerBefore: [baselineRow, approvedRow], ledgerAfter: [baselineRow, approvedRow], tables: EXPECTED_TABLES, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([unchanged.ok, unchanged.reason], [true, 'verified'])
  const changed = evaluatePostMigration({ registered, ledgerBefore: [baselineRow, approvedRow], ledgerAfter: [baselineRow, { ...approvedRow, batch: 5 }], tables: EXPECTED_TABLES, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([changed.ok, changed.reason], [false, 'prior_ledger_row_changed'])
})

// --- defect (4): exact CHECK definition + convalidated -----------------------
test('schema verification requires exact columns/types/nullability and pk/unique/check including CHECK definition', () => {
  assert.equal(verifyOwnedSchema(buildSchema()).ok, true)

  const wrongType = verifyOwnedSchema(buildSchema((cols) => { cols.find((c) => c.table === 'vroic_returns' && c.column === 'items').dataType = 'text' }))
  assert.match(wrongType.reason, /column_mismatch:vroic_returns.items/)

  const checkFalse = verifyOwnedSchema(buildSchema((_c, cons) => { cons.find((c) => c.table === 'vroic_store_settings' && c.type === 'c').def = 'CHECK (false)' }))
  assert.equal(checkFalse.reason, 'missing_check:vroic_store_settings')

  const notValid = verifyOwnedSchema(buildSchema((_c, cons) => { cons.find((c) => c.table === 'vroic_shipping_config' && c.type === 'c').validated = false }))
  assert.equal(notValid.reason, 'invalid_constraint:vroic_shipping_config')

  const noPk = verifyOwnedSchema(buildSchema((_c, cons) => { cons.splice(cons.findIndex((c) => c.table === 'vroic_owner_nonces' && c.type === 'p'), 1) }))
  assert.equal(noPk.reason, 'missing_pk:vroic_owner_nonces')

  const noUnique = verifyOwnedSchema(buildSchema((_c, cons) => { cons.splice(cons.findIndex((c) => c.table === 'vroic_reorder_policies' && c.type === 'u'), 1) }))
  assert.equal(noUnique.reason, 'missing_unique:vroic_reorder_policies')
})
