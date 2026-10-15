/**
 * Pure planning/verification helpers for the reviewed additive Payload
 * migration. No I/O: the preflight supplies real Payload status text, the real
 * Postgres ledger/constraint metadata and this module decides fail-closed
 * whether a reviewed migrate may run and whether the result is genuine.
 *
 * Payload 3.80 executes both `.ts` and `.js` migration files (excluding
 * `index`), so the registered inventory covers both extensions.
 */

export const BASELINE_MIGRATION = '20261013_101157_initial'
export const APPROVED_MIGRATION = '20261014_120000_vroic_owned_state'
export const APPROVED_MIGRATION_PATH = `src/migrations/${APPROVED_MIGRATION}.ts`

export function isValidSourceSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

export function isValidRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(value)
}

/** Executable migration basenames (.ts and .js, excluding index) sorted. */
export function registeredInventory(fileNames) {
  return fileNames
    .filter((name) => (name.endsWith('.ts') || name.endsWith('.js')) && !/^index\.(ts|js)$/.test(name))
    .map((name) => name.replace(/\.(ts|js)$/, ''))
    .sort()
}

/** Parse `payload migrate:status`; `ambiguous` when no migration rows surface. */
export function parseMigrationStatus(text) {
  const rows = []
  let ambiguous = true
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('-')) continue
    const named = line.match(/(\d{8}_\d{6}_[A-Za-z0-9_]+)/)
    if (!named) continue
    ambiguous = false
    rows.push({ name: named[1] })
  }
  return { rows, ambiguous }
}

/**
 * Decide the plan from the authoritative ledger rows
 * [{ id, name, batch, createdAt, updatedAt }].
 * Enforces exact sets: baseline exactly once with batch>0; approved absent or
 * once with batch>0; no unknown/duplicate/devbatch rows.
 */
export function evaluatePlan({ registered, ledger, approved = APPROVED_MIGRATION, baseline = BASELINE_MIGRATION }) {
  const names = ledger.map((r) => r.name)
  if (names.length !== new Set(names).size) return { state: 'fail', reason: 'duplicate_ledger_row' }
  if (ledger.some((r) => !Number.isInteger(r.batch) || r.batch < 1)) return { state: 'fail', reason: 'devbatch_or_invalid_batch' }
  const unknown = names.filter((n) => !registered.includes(n))
  if (unknown.length) return { state: 'fail', reason: `unknown_ledger_row:${unknown[0]}` }
  if (!registered.includes(baseline)) return { state: 'fail', reason: 'baseline_not_registered' }
  if (!registered.includes(approved)) return { state: 'fail', reason: 'approved_not_registered' }

  const baselineRows = ledger.filter((r) => r.name === baseline)
  if (baselineRows.length !== 1) return { state: 'fail', reason: 'baseline_ledger_not_exactly_once' }
  const approvedRows = ledger.filter((r) => r.name === approved)
  if (approvedRows.length > 1) return { state: 'fail', reason: 'approved_ledger_duplicate' }

  const applied = new Set(names)
  const pending = registered.filter((n) => !applied.has(n))
  if (pending.length === 0) {
    return approvedRows.length === 1
      ? { state: 'replay', reason: 'approved_already_applied' }
      : { state: 'fail', reason: 'no_pending_and_approved_missing' }
  }
  if (pending.length !== 1 || pending[0] !== approved) return { state: 'fail', reason: `unexpected_pending_set:${pending.join(',')}` }
  if (approvedRows.length !== 0) return { state: 'fail', reason: 'approved_present_with_pending' }
  return { state: 'pending', reason: 'singleton_approved_pending' }
}

/**
 * Post-migration evidence: prior ledger rows preserved exactly (id/name/batch/
 * created/updated), approved added once, no devbatch/duplicates, owned tables
 * present and schema verified.
 */
export function evaluatePostMigration({ ledgerBefore, ledgerAfter, approved = APPROVED_MIGRATION, tables, expectedTables, schemaOk }) {
  const after = ledgerAfter.map((r) => r.name)
  if (ledgerAfter.some((r) => !Number.isInteger(r.batch) || r.batch < 1)) return { ok: false, reason: 'devbatch_after' }
  if (after.length !== new Set(after).size) return { ok: false, reason: 'duplicate_after' }
  if (after.filter((n) => n === approved).length !== 1) return { ok: false, reason: 'approved_not_applied_once' }

  const afterById = new Map(ledgerAfter.map((r) => [r.id, r]))
  for (const row of ledgerBefore) {
    if (row.name === approved) continue
    const now = afterById.get(row.id)
    if (!now) return { ok: false, reason: 'prior_ledger_row_lost' }
    if (now.name !== row.name || now.batch !== row.batch || now.createdAt !== row.createdAt || now.updatedAt !== row.updatedAt) {
      return { ok: false, reason: 'prior_ledger_row_changed' }
    }
  }

  const present = new Set(tables)
  for (const table of expectedTables) if (!present.has(table)) return { ok: false, reason: `missing_table:${table}` }
  if (tables.length !== expectedTables.length) return { ok: false, reason: 'unexpected_owned_tables' }
  if (!schemaOk) return { ok: false, reason: 'schema_mismatch' }
  return { ok: true, reason: 'verified' }
}

/**
 * Reviewed owned schema. `cols` values are `<information_schema data_type>:<is_nullable>`.
 */
export const EXPECTED_SCHEMA = {
  vroic_operation_receipts: {
    pk: ['operation', 'idempotency_key'],
    uniques: [],
    checks: false,
    cols: {
      operation: 'text:NO', idempotency_key: 'text:NO', action: 'text:NO', actor_id: 'text:NO', request_sha256: 'text:NO',
      status: 'text:NO', response_json: 'jsonb:YES', created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO',
    },
  },
  vroic_principal_links: {
    pk: ['principal_id'], uniques: [], checks: false,
    cols: { principal_id: 'text:NO', user_id: 'integer:NO', role: 'text:NO', created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO' },
  },
  vroic_owner_nonces: {
    pk: ['nonce'], uniques: [], checks: false,
    cols: { nonce: 'text:NO', issued_at: 'timestamp with time zone:NO', expires_at: 'timestamp with time zone:NO', consumed_at: 'timestamp with time zone:NO' },
  },
  vroic_store_settings: {
    pk: ['singleton'], uniques: [], checks: true,
    cols: { singleton: 'boolean:NO', data: 'jsonb:NO', revision: 'integer:NO', updated_at: 'timestamp with time zone:NO' },
  },
  vroic_shipping_config: {
    pk: ['singleton'], uniques: [], checks: true,
    cols: { singleton: 'boolean:NO', data: 'jsonb:NO', revision: 'integer:NO', updated_at: 'timestamp with time zone:NO' },
  },
  vroic_workflow_cases: {
    pk: ['id'], uniques: [['correlation_key']], checks: false,
    cols: {
      id: 'text:NO', correlation_key: 'text:NO', subject: 'text:YES', title: 'text:NO', reason: 'text:YES', status: 'text:NO',
      owner_email: 'text:YES', owner_principal_id: 'text:YES', due_at: 'timestamp with time zone:YES', version: 'integer:NO',
      data: 'jsonb:NO', events: 'jsonb:NO', created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO',
    },
  },
  vroic_contact_cases: {
    pk: ['id'], uniques: [], checks: false,
    cols: {
      id: 'text:NO', subject: 'text:NO', body: 'text:NO', customer_email: 'text:YES', status: 'text:NO',
      replies: 'jsonb:NO', resolution: 'text:YES', created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO',
    },
  },
  vroic_support_cases: {
    pk: ['id'], uniques: [], checks: false,
    cols: {
      id: 'text:NO', order_number: 'text:YES', subject: 'text:NO', status: 'text:NO', messages: 'jsonb:NO',
      created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO',
    },
  },
  vroic_production_runs: {
    pk: ['id'], uniques: [], checks: false,
    cols: {
      id: 'text:NO', product_id: 'integer:NO', variant_id: 'integer:YES', quantity: 'integer:NO', before_stock: 'integer:NO',
      after_stock: 'integer:NO', status: 'text:NO', reason: 'text:YES', created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO',
    },
  },
  vroic_reorder_policies: {
    pk: ['id'], uniques: [['product_id', 'variant_id']], checks: false,
    cols: {
      id: 'text:NO', product_id: 'integer:NO', variant_id: 'integer:YES', supplier_ref: 'text:YES', revision: 'integer:NO',
      policy: 'jsonb:NO', updated_at: 'timestamp with time zone:NO', created_at: 'timestamp with time zone:NO',
    },
  },
  vroic_purchase_orders: {
    pk: ['id'], uniques: [], checks: false,
    cols: {
      id: 'text:NO', status: 'text:NO', currency: 'text:NO', supplier_ref: 'text:YES', notes: 'text:YES', expected_at: 'date:YES',
      lines: 'jsonb:NO', receipts: 'jsonb:NO', revision: 'integer:NO', revision_digest: 'text:NO',
      created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO',
    },
  },
  vroic_returns: {
    pk: ['id'], uniques: [], checks: false,
    cols: {
      id: 'text:NO', order_number: 'text:NO', status: 'text:NO', reason: 'text:YES', items: 'jsonb:NO', dispositions: 'jsonb:NO',
      attestation: 'text:YES', events: 'jsonb:NO', created_at: 'timestamp with time zone:NO', updated_at: 'timestamp with time zone:NO',
    },
  },
}

export const EXPECTED_TABLES = Object.keys(EXPECTED_SCHEMA).sort()

/**
 * Verify actual `information_schema` columns and `pg_constraint` metadata against
 * the reviewed owned schema (types, nullability, primary/unique/check).
 */
export function verifyOwnedSchema({ columns, constraints }) {
  const colsByTable = {}
  for (const c of columns) (colsByTable[c.table] ||= []).push(c)
  const consByTable = {}
  for (const c of constraints) (consByTable[c.table] ||= []).push(c)

  for (const [table, spec] of Object.entries(EXPECTED_SCHEMA)) {
    const actual = colsByTable[table]
    if (!actual) return { ok: false, reason: `missing_table:${table}` }
    const actualCols = new Map(actual.map((c) => [c.column, `${c.dataType}:${c.nullable}`]))
    const expectedCols = new Map(Object.entries(spec.cols))
    if (actualCols.size !== expectedCols.size) return { ok: false, reason: `column_count:${table}` }
    for (const [name, sig] of expectedCols) {
      if (actualCols.get(name) !== sig) return { ok: false, reason: `column_mismatch:${table}.${name}` }
    }
    const cons = consByTable[table] || []
    const pk = cons.find((c) => c.type === 'p')
    if (!pk) return { ok: false, reason: `missing_pk:${table}` }
    if (pk.columns.slice().sort().join(',') !== spec.pk.slice().sort().join(',')) return { ok: false, reason: `pk_mismatch:${table}` }
    const uniques = cons.filter((c) => c.type === 'u').map((c) => c.columns.slice().sort().join(','))
    for (const u of spec.uniques) if (!uniques.includes(u.slice().sort().join(','))) return { ok: false, reason: `missing_unique:${table}` }
    if (spec.checks && !cons.some((c) => c.type === 'c')) return { ok: false, reason: `missing_check:${table}` }
  }
  return { ok: true, reason: 'schema_verified' }
}
