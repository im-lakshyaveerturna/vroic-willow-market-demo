/**
 * Bounded repository-local preflight + reviewed migration runner for the
 * additive Payload owned-state migration. Runs ONLY in the manual
 * workflow_dispatch job (payload-owned-state-migrate).
 *
 * Guarantees:
 *  - refuses to connect or mutate before validating exact source, reviewed
 *    migration bytes/inventory and the trusted backend fingerprint;
 *  - never emits the database URI, credentials or customer data;
 *  - applies ONLY the single reviewed additive migration (or verifies an
 *    already-recorded one instead of rerunning);
 *  - requires a real finished ledger row (no dev batch -1) and the exact
 *    created owned tables.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

const sha256 = (v) => createHash('sha256').update(v).digest('hex')
const done = (obj) => {
  console.log(JSON.stringify(obj))
  process.exit(0)
}
const fail = (code) => {
  console.log(JSON.stringify({ outcome: code }))
  process.exit(1)
}

const source = process.env.SOURCE_SHA || ''
const migrationSha = process.env.MIGRATION_SHA256 || ''
const inventory = process.env.MIGRATION_INVENTORY || ''
const fingerprint = process.env.BACKEND_FINGERPRINT || ''
const requestId = process.env.REQUEST_ID || ''
const dbUrl = process.env.DATABASE_URL || ''
const payloadSecret = process.env.PAYLOAD_SECRET || ''

if (!source || !migrationSha || !inventory || !fingerprint || !requestId) fail('missing_input')
if (!/^[a-f0-9]{40}$/.test(source)) fail('invalid_source_sha')
if (!/^[a-f0-9]{64}$/.test(migrationSha) || !/^[a-f0-9]{64}$/.test(inventory) || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('invalid_hash')
if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(requestId)) fail('invalid_request_id')
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== source) fail('source_mismatch')
if (!dbUrl || !payloadSecret) fail('missing_secret')

// --- backend fingerprint (host/port/database/schema only, no credentials) ----
let url
try {
  url = new URL(dbUrl)
} catch {
  fail('invalid_database_url')
}
if (url.searchParams.get('schema') || url.searchParams.get('options') || url.searchParams.get('search_path')) {
  fail('ambiguous_schema_override')
}
const computedFingerprint = sha256(
  JSON.stringify({
    host: url.hostname.toLowerCase().replace(/\.$/, ''),
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    schema: 'public',
  }),
)
if (computedFingerprint !== fingerprint) fail('backend_fingerprint_mismatch')

// --- reviewed migration bytes and inventory ---------------------------------
const APPROVED = 'src/migrations/20261014_120000_vroic_owned_state.ts'
const migrationsDir = 'src/migrations'
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
  .sort()
if (files.length !== 2) fail('unexpected_migration_inventory')
if (!files.some((f) => `${migrationsDir}/${f}` === APPROVED)) fail('approved_migration_absent')
if (sha256(readFileSync(APPROVED)) !== migrationSha) fail('migration_sha_mismatch')
const inventoryHash = sha256(files.map((f) => `${f}:${sha256(readFileSync(`${migrationsDir}/${f}`))}`).join('\n'))
if (inventoryHash !== inventory) fail('migration_inventory_mismatch')

// --- Postgres helpers (never echo the URI) ----------------------------------
const psql = (sql) => execFileSync('psql', [dbUrl, '-tAc', sql], { encoding: 'utf8' }).trim()
const payloadMigrate = (args) =>
  execFileSync('pnpm', ['payload', ...args], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--no-deprecation' },
  })

const approvedName = '20261014_120000_vroic_owned_state'
const BEFORE = psql('select name from payload_migrations where batch >= 0 order by id')
const applied = BEFORE.split('\n').map((r) => r.trim()).filter(Boolean)
const devBatches = psql('select count(*) from payload_migrations where batch = -1')
if (Number(devBatches) !== 0) fail('dev_ledger_batch_present')
const alreadyRecorded = applied.includes(approvedName)

if (!alreadyRecorded) {
  payloadMigrate(['migrate'])
} else {
  payloadMigrate(['migrate:status'])
}

// --- independent ledger + schema verification --------------------------------
const AFTER = psql('select name from payload_migrations where batch >= 0 order by id')
const namesAfter = AFTER.split('\n').map((r) => r.trim()).filter(Boolean)
if (!namesAfter.includes(approvedName)) fail('ledger_row_missing')
if (Number(psql('select count(*) from payload_migrations where batch = -1')) !== 0) fail('dev_ledger_batch_after')
for (const prior of applied) if (prior !== approvedName && !namesAfter.includes(prior)) fail('prior_ledger_row_lost')

const EXPECTED_TABLES = [
  'vroic_contact_cases',
  'vroic_operation_receipts',
  'vroic_owner_nonces',
  'vroic_principal_links',
  'vroic_production_runs',
  'vroic_purchase_orders',
  'vroic_reorder_policies',
  'vroic_returns',
  'vroic_shipping_config',
  'vroic_store_settings',
  'vroic_support_cases',
  'vroic_workflow_cases',
]
const present = psql(
  "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'vroic!_%' escape '!' order by table_name",
)
  .split('\n')
  .map((r) => r.trim())
  .filter(Boolean)
for (const table of EXPECTED_TABLES) if (!present.includes(table)) fail(`missing_table:${table}`)
if (present.length !== EXPECTED_TABLES.length) fail('unexpected_owned_tables')

done({
  outcome: alreadyRecorded ? 'verified_existing' : 'migrated',
  source,
  migration: approvedName,
  migrationSha256: migrationSha,
  inventorySha256: inventory,
  backendFingerprint: fingerprint,
  requestId,
  ledgerRows: namesAfter.length,
  ownedTables: present.length,
})
