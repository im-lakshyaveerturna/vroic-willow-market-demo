/**
 * Durable server-side stores for the generated-app operations protocol.
 *
 * Everything here is backed by the SAME Postgres database the imported Payload
 * application already uses. No second database, cache or wrapper service is
 * introduced. Tables are created on first use inside the application's own
 * transaction, so no external migration step is required.
 */
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { fail } from './errors'

type Exec = (query: unknown) => Promise<unknown>

interface TxCapableAdapter {
  beginTransaction(): Promise<string | number | null>
  commitTransaction(id: string | number): Promise<void>
  rollbackTransaction(id: string | number): Promise<void>
  sessions?: Record<string, { db?: { execute?: Exec } }>
}

export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object') return []
  const r = result as { rows?: unknown }
  if (Array.isArray(r.rows)) return r.rows as Record<string, unknown>[]
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  return []
}

/**
 * Runs `fn` inside one application-owned Postgres transaction. Owned tables are
 * created ONLY by the additive Payload forward migration
 * (migrations/20261014_120000_vroic_owned_state); nothing here performs DDL.
 */
export async function withExec<T>(
  payload: Payload,
  fn: (exec: Exec) => Promise<T>,
): Promise<T> {
  const adapter = payload.db as unknown as TxCapableAdapter
  if (typeof adapter.beginTransaction !== 'function') fail('postgres_required', 503)
  const transactionID = await adapter.beginTransaction()
  if (transactionID === null || transactionID === undefined) fail('atomic_transaction_required', 503)
  const sessionDb = adapter.sessions?.[String(transactionID)]?.db
  if (!sessionDb || typeof sessionDb.execute !== 'function') {
    await adapter.rollbackTransaction(transactionID)
    fail('postgres_transaction_required', 503)
  }
  const exec: Exec = (query) => sessionDb.execute!(query)
  try {
    const result = await fn(exec)
    await adapter.commitTransaction(transactionID)
    return result
  } catch (error) {
    try {
      await adapter.rollbackTransaction(transactionID)
    } catch {
      /* connection already returned to pool */
    }
    throw error
  }
}

export interface WriteReceiptInput {
  operation: string
  action: string
  actorId: string
  idempotencyKey: string
  requestSha256: string
}

export type ReceiptClaim =
  | { kind: 'new' }
  | { kind: 'cached'; result: unknown }

/**
 * Atomically claims an idempotency key for a write action.
 * - first call inserts a pending row and returns { kind: 'new' }
 * - identical retry returns the stored response
 * - conflicting payload throws idempotency_conflict
 * - concurrent in-flight retry throws idempotency_in_progress
 */
export async function claimWriteReceipt(
  payload: Payload,
  input: WriteReceiptInput,
): Promise<ReceiptClaim> {
  return withExec(payload, async (exec) => {
    const inserted = await exec(sql`INSERT INTO vroic_operation_receipts
      (operation, idempotency_key, action, actor_id, request_sha256, status)
      VALUES (${input.operation}, ${input.idempotencyKey}, ${input.action}, ${input.actorId}, ${input.requestSha256}, 'pending')
      ON CONFLICT (operation, idempotency_key) DO NOTHING
      RETURNING idempotency_key`)
    if (rowsOf(inserted).length > 0) return { kind: 'new' as const }

    const existing = await exec(sql`SELECT request_sha256, status, response_json
      FROM vroic_operation_receipts
      WHERE operation = ${input.operation} AND idempotency_key = ${input.idempotencyKey}`)
    const row = rowsOf(existing)[0]
    if (!row) fail('idempotency_state_missing', 500)
    if (row.request_sha256 !== input.requestSha256) fail('idempotency_conflict', 409)
    if (row.status !== 'completed') fail('idempotency_in_progress', 409)
    const raw = row.response_json
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw
    return { kind: 'cached' as const, result }
  })
}

export async function completeWriteReceipt(
  payload: Payload,
  input: { operation: string; idempotencyKey: string; result: unknown },
): Promise<void> {
  await withExec(payload, async (exec) => {
    await exec(sql`UPDATE vroic_operation_receipts
      SET status = 'completed', response_json = ${JSON.stringify(input.result)}::jsonb, updated_at = now()
      WHERE operation = ${input.operation} AND idempotency_key = ${input.idempotencyKey}`)
  })
}

export async function abandonWriteReceipt(
  payload: Payload,
  input: { operation: string; idempotencyKey: string },
): Promise<void> {
  await withExec(payload, async (exec) => {
    await exec(sql`DELETE FROM vroic_operation_receipts
      WHERE operation = ${input.operation} AND idempotency_key = ${input.idempotencyKey} AND status = 'pending'`)
  })
}

export interface PrincipalLink {
  userId: number
  role: string
}

export async function getPrincipalLink(
  payload: Payload,
  principalId: string,
): Promise<PrincipalLink | null> {
  return withExec(payload, async (exec) => {
    const result = await exec(sql`SELECT user_id, role FROM vroic_principal_links WHERE principal_id = ${principalId}`)
    const row = rowsOf(result)[0]
    if (!row) return null
    return { userId: Number(row.user_id), role: String(row.role) }
  })
}

export async function linkPrincipal(
  payload: Payload,
  input: { principalId: string; userId: number; role: string },
): Promise<void> {
  await withExec(payload, async (exec) => {
    await exec(sql`INSERT INTO vroic_principal_links (principal_id, user_id, role)
      VALUES (${input.principalId}, ${input.userId}, ${input.role})
      ON CONFLICT (principal_id) DO UPDATE SET user_id = ${input.userId}, role = ${input.role}, updated_at = now()`)
  })
}

/** Atomically consumes a one-time owner-access nonce. Returns false on replay. */
export async function consumeOwnerNonce(
  payload: Payload,
  input: { nonce: string; issuedAt: number; expiresAt: number },
): Promise<boolean> {
  return withExec(payload, async (exec) => {
    const inserted = await exec(sql`INSERT INTO vroic_owner_nonces (nonce, issued_at, expires_at)
      VALUES (${input.nonce}, to_timestamp(${input.issuedAt}::double precision / 1000), to_timestamp(${input.expiresAt}::double precision / 1000))
      ON CONFLICT (nonce) DO NOTHING
      RETURNING nonce`)
    return rowsOf(inserted).length > 0
  })
}

export interface StoreSettingsRow {
  data: Record<string, unknown>
  revision: number
}

export async function readStoreSettings(payload: Payload): Promise<StoreSettingsRow | null> {
  return withExec(payload, async (exec) => {
    const result = await exec(sql`SELECT data, revision FROM vroic_store_settings WHERE singleton = true`)
    const row = rowsOf(result)[0]
    if (!row) return null
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data as Record<string, unknown>)
    return { data, revision: Number(row.revision) }
  })
}

export async function writeStoreSettings(
  payload: Payload,
  data: Record<string, unknown>,
): Promise<StoreSettingsRow> {
  return withExec(payload, async (exec) => {
    const result = await exec(sql`INSERT INTO vroic_store_settings (singleton, data, revision)
      VALUES (true, ${JSON.stringify(data)}::jsonb, 1)
      ON CONFLICT (singleton) DO UPDATE SET data = ${JSON.stringify(data)}::jsonb,
        revision = vroic_store_settings.revision + 1, updated_at = now()
      RETURNING data, revision`)
    const row = rowsOf(result)[0]
    const stored = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data as Record<string, unknown>)
    return { data: stored, revision: Number(row.revision) }
  })
}
