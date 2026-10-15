/**
 * Bounded repository-local preflight + reviewed migration runner for the
 * additive Payload owned-state migration. Runs ONLY in the manual
 * workflow_dispatch job (payload-owned-state-migrate).
 *
 * Guarantees:
 *  - validates exact source/request id, reviewed migration bytes/inventory (all
 *    executable .ts/.js migrations) and the trusted backend fingerprint BEFORE
 *    connecting or mutating anything;
 *  - ALL child processes are captured in memory (never stdio:inherit); only
 *    sanitized outcome codes and evidence hashes are emitted — never raw
 *    stdout/stderr, exceptions, the connection URI, credentials or customer data;
 *  - requires normal `payload migrate:status` BEFORE and AFTER and enforces exact
 *    applied/pending agreement with the authoritative ledger (batch>0, no
 *    unknown/duplicate/devbatch), permitting only the singleton approved pending
 *    migration or a clean replay;
 *  - verifies owned column types/nullability and primary/unique/check constraints
 *    (exact CHECK definition, convalidated) against the reviewed migration.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { runCaptured } from './exec.mjs'
import {
  APPROVED_MIGRATION,
  APPROVED_MIGRATION_PATH,
  BASELINE_MIGRATION,
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

// --- pre-connection validation (no secret/DB use) ---------------------------
if (!source || !migrationSha || !inventory || !fingerprint || !requestId) fail('missing_input')
if (!isValidSourceSha(source)) fail('invalid_source_sha')
if (!/^[a-f0-9]{64}$/.test(migrationSha) || !/^[a-f0-9]{64}$/.test(inventory) || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('invalid_hash')
if (!isValidRequestId(requestId)) fail('invalid_request_id')
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== source) fail('source_mismatch')

const migrationsDir = 'src/migrations'
const registered = registeredInventory(readdirSync(migrationsDir))
const expectedRegistered = [BASELINE_MIGRATION, APPROVED_MIGRATION].sort()
if (registered.length !== expectedRegistered.length || registered.join(',') !== expectedRegistered.join(',')) fail('unexpected_migration_inventory')
if (sha256(readFileSync(APPROVED_MIGRATION_PATH)) !== migrationSha) fail('migration_sha_mismatch')
const inventoryHash = sha256(registered.map((name) => `${name}:${sha256(readFileSync(`${migrationsDir}/${name}.ts`))}`).join('\n'))
if (inventoryHash !== inventory) fail('migration_inventory_mismatch')

if (!dbUrl || !payloadSecret) fail('missing_secret')

// --- backend fingerprint (host/port/database/schema only, no credentials) ----
let url
try {
  url = new URL(dbUrl)
} catch {
  fail('invalid_database_url')
}
if (url.searchParams.get('schema') || url.searchParams.get('options') || url.searchParams.get('search_path')) fail('ambiguous_schema_override')
const computedFingerprint = sha256(
  JSON.stringify({
    host: url.hostname.toLowerCase().replace(/\.$/, ''),
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    schema: 'public',
  }),
)
if (computedFingerprint !== fingerprint) fail('backend_fingerprint_mismatch')

// --- psql over environment only; never the URI on argv ----------------------
const pgEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
}
if (url.searchParams.get('sslmode')) pgEnv.PGSSLMODE = url.searchParams.get('sslmode')

const psql = (sql) => {
  const r = runCaptured('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { env: pgEnv })
  if (!r.ok) fail('psql_query_failed')
  return r.stdout.trim()
}

const readLedger = () =>
  psql("select id::text || '|' || name || '|' || batch::text || '|' || created_at::text || '|' || updated_at::text from payload_migrations order by id")
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((line) => { const [id, name, batch, createdAt, updatedAt] = line.split('|'); return { id, name, batch: Number(batch), createdAt, updatedAt } })

const readColumns = () =>
  psql("select table_name || '|' || column_name || '|' || data_type || '|' || is_nullable from information_schema.columns where table_schema = 'public' and table_name like 'vroic!_%' escape '!' order by table_name, ordinal_position")
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((line) => { const [table, column, dataType, nullable] = line.split('|'); return { table, column, dataType, nullable } })

const readConstraints = () =>
  psql("select r.relname || '|' || c.contype || '|' || c.convalidated::text || '|' || replace(pg_get_constraintdef(c.oid), chr(10), ' ') || '|' || coalesce((select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum)) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)), '') from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and r.relname like 'vroic!_%' escape '!' order by r.relname, c.contype")
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((line) => { const parts = line.split('|'); return { table: parts[0], type: parts[1], validated: parts[2] === 't', def: parts[3], columns: parts[4] ? parts[4].split(',') : [] } })

const runStatus = () => {
  const r = runCaptured('pnpm', ['payload', 'migrate:status'], { env: { ...process.env, NODE_OPTIONS: '--no-deprecation' } })
  return `${r.stdout}${r.stderr}`
}

// --- BEFORE: normal Payload status + authoritative ledger --------------------
const statusBefore = parseMigrationStatus(runStatus())
if (statusBefore.ambiguous) fail('ambiguous_status_before')
const ledgerBefore = readLedger()
const agreementBefore = evaluateStatusAgreement({ statusRows: statusBefore.rows, registered, ledger: ledgerBefore })
if (!agreementBefore.ok) fail(`status_disagreement_before:${agreementBefore.reason}`)

const plan = evaluatePlan({ registered, ledger: ledgerBefore })
if (plan.state === 'fail') fail(`plan_failed:${plan.reason}`)

if (plan.state === 'pending') {
  const migrate = runCaptured('pnpm', ['payload', 'migrate'], { env: { ...process.env, NODE_OPTIONS: '--no-deprecation' } })
  if (!migrate.ok) fail('payload_migrate_failed')
}

// --- AFTER: status + full evidence -------------------------------------------
const statusAfter = parseMigrationStatus(runStatus())
if (statusAfter.ambiguous) fail('ambiguous_status_after')
const ledgerAfter = readLedger()
const agreementAfter = evaluateStatusAgreement({ statusRows: statusAfter.rows, registered, ledger: ledgerAfter })
if (!agreementAfter.ok) fail(`status_disagreement_after:${agreementAfter.reason}`)

const columns = readColumns()
const schema = verifyOwnedSchema({ columns, constraints: readConstraints() })
const evidence = evaluatePostMigration({
  registered,
  ledgerBefore,
  ledgerAfter,
  tables: [...new Set(columns.map((c) => c.table))],
  expectedTables: EXPECTED_TABLES,
  schemaOk: schema.ok,
})
if (!evidence.ok) fail(`post_evidence_failed:${evidence.reason}`)

done({
  outcome: plan.state === 'replay' ? 'verified_already_applied' : 'migrated',
  source,
  migration: APPROVED_MIGRATION,
  migrationSha256: migrationSha,
  inventorySha256: inventory,
  backendFingerprint: fingerprint,
  requestId,
  ledgerRows: ledgerAfter.length,
  ownedTables: EXPECTED_TABLES.length,
  schema: schema.reason,
})
