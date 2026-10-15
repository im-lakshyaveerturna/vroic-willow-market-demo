import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVED_MIGRATION,
  BASELINE_MIGRATION,
  EXPECTED_SCHEMA,
  EXPECTED_TABLES,
  evaluatePlan,
  evaluatePostMigration,
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

function buildSchema(mutate = () => {}) {
  const columns = []
  const constraints = []
  for (const [table, spec] of Object.entries(EXPECTED_SCHEMA)) {
    for (const [col, sig] of Object.entries(spec.cols)) {
      const [dataType, nullable] = sig.split(':')
      columns.push({ table, column: col, dataType, nullable })
    }
    constraints.push({ table, type: 'p', columns: spec.pk })
    for (const u of spec.uniques) constraints.push({ table, type: 'u', columns: u })
    if (spec.checks) constraints.push({ table, type: 'c', columns: [] })
  }
  mutate(columns, constraints)
  return { columns, constraints }
}

test('hostile source input is rejected', () => {
  for (const bad of ['', '  ', '$(rm -rf /)', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '2783f16', '27833f162ca72a02864b4ef36e77ff915cd84d5', '27833f162ca72a02864b4ef36e77ff915cd84d56 ']) {
    assert.equal(isValidSourceSha(bad), false, `expected invalid: ${JSON.stringify(bad)}`)
  }
  assert.equal(isValidSourceSha('27833f162ca72a02864b4ef36e77ff915cd84d56'), true)
  assert.equal(isValidRequestId('req-2026_10-14:1'), true)
  assert.equal(isValidRequestId('a;b'), false)
})

test('inventory covers executable .ts and .js migrations, excluding index', () => {
  const inv = registeredInventory(['20261013_101157_initial.ts', '20261014_120000_vroic_owned_state.ts', 'extra.js', 'index.ts'])
  assert.deepEqual(inv, ['20261013_101157_initial', '20261014_120000_vroic_owned_state', 'extra'].sort())
})

test('status parsing is fail-closed on hostile/empty output', () => {
  const parsed = parseMigrationStatus(`  ${BASELINE_MIGRATION}  1\n`)
  assert.equal(parsed.ambiguous, false)
  assert.equal(parseMigrationStatus('$(whoami)').ambiguous, true)
  assert.equal(parseMigrationStatus('').ambiguous, true)
})

test('ledger set rules: baseline exactly once with batch>0, no unknown/duplicate/devbatch', () => {
  assert.deepEqual(evaluatePlan({ registered, ledger: [] }).reason, 'baseline_ledger_not_exactly_once')
  assert.deepEqual(evaluatePlan({ registered, ledger: [baselineRow] }).state, 'pending')
  assert.deepEqual(evaluatePlan({ registered, ledger: [baselineRow, approvedRow] }).state, 'replay')
  assert.equal(evaluatePlan({ registered, ledger: [baselineRow, baselineRow] }).reason, 'duplicate_ledger_row')
  assert.equal(evaluatePlan({ registered, ledger: [row('1', BASELINE_MIGRATION, -1)] }).reason, 'devbatch_or_invalid_batch')
  assert.match(evaluatePlan({ registered, ledger: [baselineRow, row('9', '20990101_000000_other', 1)] }).reason, /unknown_ledger_row/)
})

test('extra pending migration fails closed (approved still registered)', () => {
  const plan = evaluatePlan({ registered: [BASELINE_MIGRATION, APPROVED_MIGRATION, '20990101_000000_extra'].sort(), ledger: [baselineRow] })
  assert.equal(plan.state, 'fail')
  assert.match(plan.reason, /unexpected_pending_set/)
})

test('post-migration evidence rejects fake success, changed prior rows and missing tables', () => {
  const okTables = EXPECTED_TABLES
  const zero = evaluatePostMigration({ ledgerBefore: [baselineRow], ledgerAfter: [baselineRow], tables: okTables, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([zero.ok, zero.reason], [false, 'approved_not_applied_once'])

  const changed = evaluatePostMigration({ ledgerBefore: [baselineRow], ledgerAfter: [{ ...baselineRow, batch: 7 }, approvedRow], tables: okTables, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([changed.ok, changed.reason], [false, 'prior_ledger_row_changed'])

  const missing = evaluatePostMigration({ ledgerBefore: [baselineRow], ledgerAfter: [baselineRow, approvedRow], tables: EXPECTED_TABLES.slice(1), expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([missing.ok, missing.reason], [false, `missing_table:${EXPECTED_TABLES[0]}`])

  const schemaBad = evaluatePostMigration({ ledgerBefore: [baselineRow], ledgerAfter: [baselineRow, approvedRow], tables: EXPECTED_TABLES, expectedTables: EXPECTED_TABLES, schemaOk: false })
  assert.deepEqual([schemaBad.ok, schemaBad.reason], [false, 'schema_mismatch'])

  const devAfter = evaluatePostMigration({ ledgerBefore: [baselineRow], ledgerAfter: [baselineRow, row('2', APPROVED_MIGRATION, -1)], tables: okTables, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([devAfter.ok, devAfter.reason], [false, 'devbatch_after'])
})

test('post-migration evidence accepts the exact verified outcome', () => {
  const evidence = evaluatePostMigration({ ledgerBefore: [baselineRow], ledgerAfter: [baselineRow, approvedRow], tables: EXPECTED_TABLES, expectedTables: EXPECTED_TABLES, schemaOk: true })
  assert.deepEqual([evidence.ok, evidence.reason], [true, 'verified'])
})

test('schema verification requires exact columns/types/nullability and pk/unique/check', () => {
  assert.equal(verifyOwnedSchema(buildSchema()).ok, true)
  const badType = verifyOwnedSchema(buildSchema((cols) => { cols.find((c) => c.table === 'vroic_returns' && c.column === 'items').dataType = 'text' }))
  assert.equal(badType.ok, false)
  assert.match(badType.reason, /column_mismatch:vroic_returns.items/)
  const noPk = verifyOwnedSchema(buildSchema((_c, cons) => { const i = cons.findIndex((c) => c.table === 'vroic_owner_nonces' && c.type === 'p'); cons.splice(i, 1) }))
  assert.equal(noPk.reason, 'missing_pk:vroic_owner_nonces')
  const noCheck = verifyOwnedSchema(buildSchema((_c, cons) => { const i = cons.findIndex((c) => c.table === 'vroic_store_settings' && c.type === 'c'); cons.splice(i, 1) }))
  assert.equal(noCheck.reason, 'missing_check:vroic_store_settings')
})
