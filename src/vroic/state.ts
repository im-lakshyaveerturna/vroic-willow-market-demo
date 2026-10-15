/**
 * Owned Core-14 integration state. All tables are created by the additive
 * Payload forward migration `20261014_120000_vroic_owned_state`; nothing here
 * performs DDL. Existing Payload records (products, orders, users) are read
 * through the Local API; only genuinely missing integration state is persisted.
 */
import { createHash } from 'node:crypto'
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { rowsOf, withExec } from './store'

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export const sha256Json = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

// ---------------------------------------------------------------------------
// shipping configuration
// ---------------------------------------------------------------------------

export interface ShippingConfig {
  deliveryMethod: 'self' | 'provider' | null
  providerId: string | null
  source: string
  updatedAt: string | null
}

const DEFAULT_SHIPPING: ShippingConfig = { deliveryMethod: null, providerId: null, source: 'unconfigured', updatedAt: null }

export async function readShippingConfig(payload: Payload): Promise<{ config: ShippingConfig; revision: number }> {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT data, revision FROM vroic_shipping_config WHERE singleton = true`)
    const row = rowsOf(res)[0]
    if (!row) return { config: DEFAULT_SHIPPING, revision: 0 }
    return { config: { ...DEFAULT_SHIPPING, ...parseJson<Partial<ShippingConfig>>(row.data, {}) }, revision: Number(row.revision) }
  })
}

export async function writeShippingConfig(
  payload: Payload,
  input: { deliveryMethod: 'self' | 'provider'; providerId?: string | null },
): Promise<{ config: ShippingConfig; revision: number }> {
  const config: ShippingConfig = {
    deliveryMethod: input.deliveryMethod,
    providerId: input.providerId ?? null,
    source: 'merchant',
    updatedAt: new Date().toISOString(),
  }
  return withExec(payload, async (exec) => {
    const res = await exec(sql`INSERT INTO vroic_shipping_config (singleton, data, revision)
      VALUES (true, ${JSON.stringify(config)}::jsonb, 1)
      ON CONFLICT (singleton) DO UPDATE SET data = ${JSON.stringify(config)}::jsonb, revision = vroic_shipping_config.revision + 1, updated_at = now()
      RETURNING data, revision`)
    const row = rowsOf(res)[0]
    return { config: { ...DEFAULT_SHIPPING, ...parseJson<Partial<ShippingConfig>>(row.data, {}) }, revision: Number(row.revision) }
  })
}

// ---------------------------------------------------------------------------
// workflow cases
// ---------------------------------------------------------------------------

export interface WorkflowCaseRow {
  id: string
  correlationKey: string
  subject: string | null
  title: string
  reason: string | null
  status: string
  ownerEmail: string | null
  dueAt: string | null
  version: number
  data: Record<string, unknown>
  events: unknown[]
  createdAt: string
  updatedAt: string
}

const mapWorkflowCase = (row: Record<string, unknown>): WorkflowCaseRow => ({
  id: String(row.id),
  correlationKey: String(row.correlation_key),
  subject: row.subject ? String(row.subject) : null,
  title: String(row.title),
  reason: row.reason ? String(row.reason) : null,
  status: String(row.status),
  ownerEmail: row.owner_email ? String(row.owner_email) : null,
  dueAt: row.due_at ? new Date(String(row.due_at)).toISOString() : null,
  version: Number(row.version),
  data: parseJson<Record<string, unknown>>(row.data, {}),
  events: parseJson<unknown[]>(row.events, []),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
})

export async function findByCorrelationKey(payload: Payload, correlationKey: string): Promise<WorkflowCaseRow | null> {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT * FROM vroic_workflow_cases WHERE correlation_key = ${correlationKey}`)
    const row = rowsOf(res)[0]
    return row ? mapWorkflowCase(row) : null
  })
}

export async function insertWorkflowCase(
  payload: Payload,
  input: { correlationKey: string; subject: string | null; title: string; reason: string | null; ownerEmail: string | null; ownerPrincipalId: string | null; dueAt: string | null; data: Record<string, unknown> },
): Promise<WorkflowCaseRow | null> {
  const id = globalThis.crypto.randomUUID()
  return withExec(payload, async (exec) => {
    const res = await exec(sql`INSERT INTO vroic_workflow_cases
      (id, correlation_key, subject, title, reason, status, owner_email, owner_principal_id, due_at, data, events)
      VALUES (${id}, ${input.correlationKey}, ${input.subject}, ${input.title}, ${input.reason}, 'open', ${input.ownerEmail}, ${input.ownerPrincipalId},
        ${input.dueAt}::timestamptz, ${JSON.stringify(input.data)}::jsonb,
        ${JSON.stringify([{ type: 'opened', at: new Date().toISOString() }])}::jsonb)
      ON CONFLICT (correlation_key) DO NOTHING
      RETURNING *`)
    const row = rowsOf(res)[0]
    return row ? mapWorkflowCase(row) : null
  })
}

export async function getWorkflowCase(payload: Payload, id: string): Promise<WorkflowCaseRow | null> {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT * FROM vroic_workflow_cases WHERE id = ${id}`)
    const row = rowsOf(res)[0]
    return row ? mapWorkflowCase(row) : null
  })
}

export async function listWorkflowCases(
  payload: Payload,
  input: { status?: string; subject?: string; dueBefore?: string; limit: number; offset: number },
): Promise<{ cases: WorkflowCaseRow[]; total: number }> {
  return withExec(payload, async (exec) => {
    const conds = [sql`true`]
    if (input.status) conds.push(sql`status = ${input.status}`)
    if (input.subject) conds.push(sql`subject = ${input.subject}`)
    if (input.dueBefore) conds.push(sql`due_at IS NOT NULL AND due_at <= ${input.dueBefore}::timestamptz`)
    const where = conds.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`), sql``)
    const res = await exec(sql`SELECT * FROM vroic_workflow_cases WHERE ${where} ORDER BY created_at DESC LIMIT ${input.limit} OFFSET ${input.offset}`)
    const count = await exec(sql`SELECT count(*)::int AS total FROM vroic_workflow_cases WHERE ${where}`)
    return { cases: rowsOf(res).map(mapWorkflowCase), total: Number(rowsOf(count)[0]?.total ?? 0) }
  })
}

export async function updateWorkflowCase(
  payload: Payload,
  input: { id: string; expectedVersion: number; status: string; reason: string; ownerEmail?: string | null; dueAt?: string | null; evidence?: string[] },
): Promise<{ ok: boolean; conflict: boolean; missing: boolean; row?: WorkflowCaseRow }> {
  return withExec(payload, async (exec) => {
    const existing = await exec(sql`SELECT * FROM vroic_workflow_cases WHERE id = ${input.id}`)
    const row = rowsOf(existing)[0]
    if (!row) return { ok: false, conflict: false, missing: true }
    if (Number(row.version) !== input.expectedVersion) return { ok: false, conflict: true, missing: false }
    const event = { type: 'updated', status: input.status, reason: input.reason, evidence: input.evidence ?? [], at: new Date().toISOString() }
    const upd = await exec(sql`UPDATE vroic_workflow_cases
      SET status = ${input.status},
          reason = ${input.reason},
          owner_email = COALESCE(${input.ownerEmail ?? null}, owner_email),
          due_at = COALESCE(${input.dueAt ?? null}::timestamptz, due_at),
          version = version + 1,
          events = events || ${JSON.stringify([event])}::jsonb,
          updated_at = now()
      WHERE id = ${input.id} AND version = ${input.expectedVersion}
      RETURNING *`)
    const updated = rowsOf(upd)[0]
    if (!updated) return { ok: false, conflict: true, missing: false }
    return { ok: true, conflict: false, missing: false, row: mapWorkflowCase(updated) }
  })
}

// ---------------------------------------------------------------------------
// contact cases
// ---------------------------------------------------------------------------

export interface ContactCaseRow {
  id: string
  subject: string
  body: string
  customerEmail: string | null
  status: string
  replies: unknown[]
  resolution: string | null
  createdAt: string
  updatedAt: string
}

const mapContactCase = (row: Record<string, unknown>): ContactCaseRow => ({
  id: String(row.id),
  subject: String(row.subject),
  body: String(row.body),
  customerEmail: row.customer_email ? String(row.customer_email) : null,
  status: String(row.status),
  replies: parseJson<unknown[]>(row.replies, []),
  resolution: row.resolution ? String(row.resolution) : null,
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
})

export async function getContactCase(payload: Payload, id: string): Promise<ContactCaseRow | null> {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT * FROM vroic_contact_cases WHERE id = ${id}`)
    const row = rowsOf(res)[0]
    return row ? mapContactCase(row) : null
  })
}

export async function listContactCases(
  payload: Payload,
  input: { status?: string; limit: number; offset: number },
): Promise<{ cases: ContactCaseRow[]; total: number }> {
  return withExec(payload, async (exec) => {
    const filter = input.status ? sql`WHERE status = ${input.status}` : sql``
    const res = await exec(sql`SELECT * FROM vroic_contact_cases ${filter} ORDER BY created_at ASC LIMIT ${input.limit} OFFSET ${input.offset}`)
    const count = await exec(sql`SELECT count(*)::int AS total FROM vroic_contact_cases ${filter}`)
    return { cases: rowsOf(res).map(mapContactCase), total: Number(rowsOf(count)[0]?.total ?? 0) }
  })
}

export async function appendContactReply(
  payload: Payload,
  input: { id: string; eventKey: string; body: string; providerId: string; accountId: string; providerMessageId: string; effectReceiptId: string; evidenceReference: string },
): Promise<{ found: boolean; duplicate: boolean; row?: ContactCaseRow }> {
  return withExec(payload, async (exec) => {
    const existing = await exec(sql`SELECT * FROM vroic_contact_cases WHERE id = ${input.id}`)
    const row = rowsOf(existing)[0]
    if (!row) return { found: false, duplicate: false }
    const replies = parseJson<Array<Record<string, unknown>>>(row.replies, [])
    if (replies.some((r) => r.eventKey === input.eventKey)) return { found: true, duplicate: true, row: mapContactCase(row) }
    replies.push({
      eventKey: input.eventKey,
      body: input.body,
      providerId: input.providerId,
      accountId: input.accountId,
      providerMessageId: input.providerMessageId,
      effectReceiptId: input.effectReceiptId,
      evidenceReference: input.evidenceReference,
      recordedAt: new Date().toISOString(),
    })
    const res = await exec(sql`UPDATE vroic_contact_cases SET replies = ${JSON.stringify(replies)}::jsonb, updated_at = now() WHERE id = ${input.id} RETURNING *`)
    const updated = rowsOf(res)[0]
    return { found: true, duplicate: false, row: updated ? mapContactCase(updated) : undefined }
  })
}

export async function resolveContactCase(
  payload: Payload,
  input: { id: string; eventKey: string; resolution: string; evidenceReference: string },
): Promise<{ found: boolean; alreadyResolved: boolean; row?: ContactCaseRow }> {
  return withExec(payload, async (exec) => {
    const existing = await exec(sql`SELECT * FROM vroic_contact_cases WHERE id = ${input.id}`)
    const row = rowsOf(existing)[0]
    if (!row) return { found: false, alreadyResolved: false }
    if (String(row.status) === 'resolved') return { found: true, alreadyResolved: true, row: mapContactCase(row) }
    const resolution = JSON.stringify({ resolution: input.resolution, evidenceReference: input.evidenceReference, eventKey: input.eventKey, resolvedAt: new Date().toISOString() })
    const res = await exec(sql`UPDATE vroic_contact_cases SET status = 'resolved', resolution = ${resolution}, updated_at = now() WHERE id = ${input.id} RETURNING *`)
    const updated = rowsOf(res)[0]
    return { found: true, alreadyResolved: false, row: updated ? mapContactCase(updated) : undefined }
  })
}

// ---------------------------------------------------------------------------
// support cases
// ---------------------------------------------------------------------------

export interface SupportCaseRow {
  id: string
  orderNumber: string | null
  subject: string
  status: string
  messages: unknown[]
  createdAt: string
  updatedAt: string
}

const mapSupportCase = (row: Record<string, unknown>): SupportCaseRow => ({
  id: String(row.id),
  orderNumber: row.order_number ? String(row.order_number) : null,
  subject: String(row.subject),
  status: String(row.status),
  messages: parseJson<unknown[]>(row.messages, []),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
})

export async function getSupportCase(payload: Payload, id: string): Promise<SupportCaseRow | null> {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT * FROM vroic_support_cases WHERE id = ${id}`)
    const row = rowsOf(res)[0]
    return row ? mapSupportCase(row) : null
  })
}

export async function listSupportCases(
  payload: Payload,
  input: { orderNumber?: string; limit: number; offset: number },
): Promise<{ cases: SupportCaseRow[]; total: number }> {
  return withExec(payload, async (exec) => {
    const filter = input.orderNumber ? sql`WHERE order_number = ${input.orderNumber}` : sql``
    const res = await exec(sql`SELECT * FROM vroic_support_cases ${filter} ORDER BY created_at ASC LIMIT ${input.limit} OFFSET ${input.offset}`)
    const count = await exec(sql`SELECT count(*)::int AS total FROM vroic_support_cases ${filter}`)
    return { cases: rowsOf(res).map(mapSupportCase), total: Number(rowsOf(count)[0]?.total ?? 0) }
  })
}

export async function replySupportCase(
  payload: Payload,
  input: { id: string; messageKey: string; body: string; evidenceReference: string },
): Promise<{ found: boolean; duplicate: boolean; row?: SupportCaseRow }> {
  return withExec(payload, async (exec) => {
    const existing = await exec(sql`SELECT * FROM vroic_support_cases WHERE id = ${input.id}`)
    const row = rowsOf(existing)[0]
    if (!row) return { found: false, duplicate: false }
    const messages = parseJson<Array<Record<string, unknown>>>(row.messages, [])
    if (messages.some((m) => m.messageKey === input.messageKey)) return { found: true, duplicate: true, row: mapSupportCase(row) }
    messages.push({ messageKey: input.messageKey, body: input.body, evidenceReference: input.evidenceReference, direction: 'outbound_reply', delivered: false, at: new Date().toISOString() })
    const res = await exec(sql`UPDATE vroic_support_cases SET messages = ${JSON.stringify(messages)}::jsonb, updated_at = now() WHERE id = ${input.id} RETURNING *`)
    const updated = rowsOf(res)[0]
    return { found: true, duplicate: false, row: updated ? mapSupportCase(updated) : undefined }
  })
}

// ---------------------------------------------------------------------------
// production runs (store_operations)
// ---------------------------------------------------------------------------

export async function recordProductionCompletion(
  payload: Payload,
  input: { productId: number; variantId: number | null; quantity: number; beforeStock: number; afterStock: number; reason: string },
): Promise<void> {
  const id = globalThis.crypto.randomUUID()
  await withExec(payload, async (exec) => {
    await exec(sql`INSERT INTO vroic_production_runs (id, product_id, variant_id, quantity, before_stock, after_stock, status, reason)
      VALUES (${id}, ${input.productId}, ${input.variantId}, ${input.quantity}, ${input.beforeStock}, ${input.afterStock}, 'completed', ${input.reason})`)
  })
}

export async function listProductionRuns(payload: Payload, input: { limit: number; offset: number }) {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT * FROM vroic_production_runs ORDER BY created_at DESC LIMIT ${input.limit} OFFSET ${input.offset}`)
    const count = await exec(sql`SELECT count(*)::int AS total FROM vroic_production_runs`)
    return {
      runs: rowsOf(res).map((row) => ({
        id: String(row.id),
        product_id: Number(row.product_id),
        variant_id: row.variant_id === null || row.variant_id === undefined ? null : Number(row.variant_id),
        quantity: Number(row.quantity),
        before_stock: Number(row.before_stock),
        after_stock: Number(row.after_stock),
        status: String(row.status),
        reason: row.reason ? String(row.reason) : null,
        created_at: new Date(String(row.created_at)).toISOString(),
      })),
      total: Number(rowsOf(count)[0]?.total ?? 0),
    }
  })
}

// ---------------------------------------------------------------------------
// reorder policies (purchases)
// ---------------------------------------------------------------------------

export interface ReorderPolicyRow {
  id: string
  productId: number
  variantId: number | null
  supplierRef: string | null
  revision: number
  policy: Record<string, unknown>
}

const mapReorderPolicy = (row: Record<string, unknown>): ReorderPolicyRow => ({
  id: String(row.id),
  productId: Number(row.product_id),
  variantId: row.variant_id === null || row.variant_id === undefined ? null : Number(row.variant_id),
  supplierRef: row.supplier_ref ? String(row.supplier_ref) : null,
  revision: Number(row.revision),
  policy: parseJson<Record<string, unknown>>(row.policy, {}),
})

export async function getReorderPolicy(payload: Payload, input: { productId: number; variantId: number | null }): Promise<ReorderPolicyRow | null> {
  return withExec(payload, async (exec) => {
    const variantFilter = input.variantId === null ? sql`variant_id IS NULL` : sql`variant_id = ${input.variantId}`
    const res = await exec(sql`SELECT * FROM vroic_reorder_policies WHERE product_id = ${input.productId} AND ${variantFilter}`)
    const row = rowsOf(res)[0]
    return row ? mapReorderPolicy(row) : null
  })
}

export async function saveReorderPolicy(
  payload: Payload,
  input: { productId: number; variantId: number | null; supplierRef: string | null; expectedRevision: number; policy: Record<string, unknown> },
): Promise<{ ok: boolean; conflict: boolean; row?: ReorderPolicyRow }> {
  const id = globalThis.crypto.randomUUID()
  return withExec(payload, async (exec) => {
    const variantFilter = input.variantId === null ? sql`variant_id IS NULL` : sql`variant_id = ${input.variantId}`
    const existing = await exec(sql`SELECT id, revision FROM vroic_reorder_policies WHERE product_id = ${input.productId} AND ${variantFilter}`)
    const row = rowsOf(existing)[0]
    if (!row) {
      if (input.expectedRevision !== 0) return { ok: false, conflict: true }
      const ins = await exec(sql`INSERT INTO vroic_reorder_policies (id, product_id, variant_id, supplier_ref, revision, policy)
        VALUES (${id}, ${input.productId}, ${input.variantId}, ${input.supplierRef}, 1, ${JSON.stringify(input.policy)}::jsonb)
        ON CONFLICT (product_id, variant_id) DO NOTHING RETURNING *`)
      const created = rowsOf(ins)[0]
      if (!created) return { ok: false, conflict: true }
      return { ok: true, conflict: false, row: mapReorderPolicy(created) }
    }
    if (Number(row.revision) !== input.expectedRevision) return { ok: false, conflict: true }
    const upd = await exec(sql`UPDATE vroic_reorder_policies SET supplier_ref = ${input.supplierRef}, policy = ${JSON.stringify(input.policy)}::jsonb, revision = revision + 1, updated_at = now() WHERE id = ${String(row.id)} RETURNING *`)
    const updated = rowsOf(upd)[0]
    return { ok: true, conflict: false, row: updated ? mapReorderPolicy(updated) : undefined }
  })
}

export async function listReorderPolicies(payload: Payload, input: { afterId: string | null; limit: number }): Promise<ReorderPolicyRow[]> {
  return withExec(payload, async (exec) => {
    const filter = input.afterId ? sql`WHERE id > ${input.afterId}` : sql``
    const res = await exec(sql`SELECT * FROM vroic_reorder_policies ${filter} ORDER BY id ASC LIMIT ${input.limit}`)
    return rowsOf(res).map(mapReorderPolicy)
  })
}

// ---------------------------------------------------------------------------
// purchase orders (purchases)
// ---------------------------------------------------------------------------

export interface PurchaseOrderRow {
  id: string
  status: string
  currency: string
  supplierRef: string | null
  notes: string | null
  lines: unknown[]
  receipts: unknown[]
  revision: number
  revisionDigest: string
  createdAt: string
  updatedAt: string
}

const mapPurchaseOrder = (row: Record<string, unknown>): PurchaseOrderRow => ({
  id: String(row.id),
  status: String(row.status),
  currency: String(row.currency),
  supplierRef: row.supplier_ref ? String(row.supplier_ref) : null,
  notes: row.notes ? String(row.notes) : null,
  lines: parseJson<unknown[]>(row.lines, []),
  receipts: parseJson<unknown[]>(row.receipts, []),
  revision: Number(row.revision),
  revisionDigest: String(row.revision_digest ?? ''),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
})

const digestOf = (row: Record<string, unknown>): string =>
  sha256Json({
    status: row.status,
    currency: row.currency,
    supplierRef: row.supplier_ref,
    notes: row.notes,
    lines: parseJson(row.lines, []),
    receipts: parseJson(row.receipts, []),
  })

export async function getPurchaseOrder(payload: Payload, id: string): Promise<PurchaseOrderRow | null> {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT * FROM vroic_purchase_orders WHERE id = ${id}`)
    const row = rowsOf(res)[0]
    return row ? mapPurchaseOrder(row) : null
  })
}

export async function createPurchaseOrder(
  payload: Payload,
  input: { currency: string; supplierRef: string | null; notes: string | null; expectedAt: string | null; lines: unknown[] },
): Promise<PurchaseOrderRow> {
  const id = globalThis.crypto.randomUUID()
  return withExec(payload, async (exec) => {
    const base: Record<string, unknown> = { status: 'draft', currency: input.currency, supplier_ref: input.supplierRef, notes: input.notes, lines: input.lines, receipts: [] }
    const digest = digestOf(base)
    const res = await exec(sql`INSERT INTO vroic_purchase_orders (id, status, currency, supplier_ref, notes, expected_at, lines, receipts, revision_digest)
      VALUES (${id}, 'draft', ${input.currency}, ${input.supplierRef}, ${input.notes}, ${input.expectedAt}, ${JSON.stringify(input.lines)}::jsonb, '[]'::jsonb, ${digest})
      RETURNING *`)
    return mapPurchaseOrder(rowsOf(res)[0])
  })
}

export async function orderPurchaseOrder(
  payload: Payload,
  input: { id: string; expectedRevision: string },
): Promise<{ ok: boolean; conflict: boolean; missing: boolean; row?: PurchaseOrderRow }> {
  return withExec(payload, async (exec) => {
    const existing = await exec(sql`SELECT * FROM vroic_purchase_orders WHERE id = ${input.id}`)
    const row = rowsOf(existing)[0]
    if (!row) return { ok: false, conflict: false, missing: true }
    if (String(row.revision_digest) !== input.expectedRevision) return { ok: false, conflict: true, missing: false }
    if (String(row.status) !== 'draft') return { ok: false, conflict: false, missing: false }
    const next: Record<string, unknown> = { ...row, status: 'ordered' }
    const digest = digestOf(next)
    const upd = await exec(sql`UPDATE vroic_purchase_orders SET status = 'ordered', revision = revision + 1, revision_digest = ${digest}, updated_at = now()
      WHERE id = ${input.id} AND revision_digest = ${input.expectedRevision} RETURNING *`)
    const updated = rowsOf(upd)[0]
    if (!updated) return { ok: false, conflict: true, missing: false }
    return { ok: true, conflict: false, missing: false, row: mapPurchaseOrder(updated) }
  })
}

export async function receivePurchaseOrder(
  payload: Payload,
  input: { id: string; deliveryReference: string; lines: Array<{ lineId: string; quantity: number }> },
): Promise<{ ok: boolean; missing: boolean; row?: PurchaseOrderRow }> {
  return withExec(payload, async (exec) => {
    const existing = await exec(sql`SELECT * FROM vroic_purchase_orders WHERE id = ${input.id}`)
    const row = rowsOf(existing)[0]
    if (!row) return { ok: false, missing: true }
    const receipt = { deliveryReference: input.deliveryReference, lines: input.lines, receivedAt: new Date().toISOString() }
    const next: Record<string, unknown> = { ...row, receipts: [...parseJson<unknown[]>(row.receipts, []), receipt] }
    const digest = digestOf(next)
    const upd = await exec(sql`UPDATE vroic_purchase_orders
      SET receipts = receipts || ${JSON.stringify([receipt])}::jsonb, status = 'received', revision = revision + 1, revision_digest = ${digest}, updated_at = now()
      WHERE id = ${input.id} RETURNING *`)
    const updated = rowsOf(upd)[0]
    return { ok: true, missing: false, row: updated ? mapPurchaseOrder(updated) : undefined }
  })
}

// ---------------------------------------------------------------------------
// returns
// ---------------------------------------------------------------------------

export interface ReturnRow {
  id: string
  orderNumber: string
  status: string
  reason: string | null
  items: unknown[]
  dispositions: unknown[]
  attestation: string | null
  createdAt: string
  updatedAt: string
}

const mapReturn = (row: Record<string, unknown>): ReturnRow => ({
  id: String(row.id),
  orderNumber: String(row.order_number),
  status: String(row.status),
  reason: row.reason ? String(row.reason) : null,
  items: parseJson<unknown[]>(row.items, []),
  dispositions: parseJson<unknown[]>(row.dispositions, []),
  attestation: row.attestation ? String(row.attestation) : null,
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
})

export async function getReturn(payload: Payload, id: string): Promise<ReturnRow | null> {
  return withExec(payload, async (exec) => {
    const res = await exec(sql`SELECT * FROM vroic_returns WHERE id = ${id}`)
    const row = rowsOf(res)[0]
    return row ? mapReturn(row) : null
  })
}

export async function createReturn(
  payload: Payload,
  input: { orderNumber: string; reason: string | null; items: unknown[] },
): Promise<ReturnRow> {
  const id = globalThis.crypto.randomUUID()
  return withExec(payload, async (exec) => {
    const res = await exec(sql`INSERT INTO vroic_returns (id, order_number, reason, items)
      VALUES (${id}, ${input.orderNumber}, ${input.reason}, ${JSON.stringify(input.items)}::jsonb) RETURNING *`)
    return mapReturn(rowsOf(res)[0])
  })
}

export async function receiveConfirmedReturn(
  payload: Payload,
  input: { id: string; dispositions: unknown[]; attestation: string },
): Promise<{ ok: boolean; alreadyReceived: boolean; row?: ReturnRow }> {
  return withExec(payload, async (exec) => {
    const existing = await exec(sql`SELECT * FROM vroic_returns WHERE id = ${input.id}`)
    const row = rowsOf(existing)[0]
    if (!row) return { ok: false, alreadyReceived: false }
    if (String(row.status) === 'received') return { ok: true, alreadyReceived: true, row: mapReturn(row) }
    const upd = await exec(sql`UPDATE vroic_returns
      SET status = 'received', dispositions = ${JSON.stringify(input.dispositions)}::jsonb, attestation = ${input.attestation},
          events = events || ${JSON.stringify([{ type: 'receive_confirmed', at: new Date().toISOString() }])}::jsonb, updated_at = now()
      WHERE id = ${input.id} AND status <> 'received' RETURNING *`)
    const updated = rowsOf(upd)[0]
    return { ok: true, alreadyReceived: false, row: updated ? mapReturn(updated) : undefined }
  })
}
