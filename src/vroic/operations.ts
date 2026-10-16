/**
 * Implemented subset of the shared storefront commerce contract.
 *
 * Each operation/action is implemented against the REAL imported Payload +
 * Postgres backend. Discovery advertises exactly this implemented set; any
 * operation or action outside it is reported as unsupported rather than
 * simulated.
 */
import type { Payload, PayloadRequest } from 'payload'
import { fail } from './errors'
import { fromPublicId, toPublicId } from './ids'
import {
  cartOut,
  collectionOut,
  customerOut,
  lexicalParagraph,
  mediaOut,
  orderOut,
  pagination,
  productOut,
  transactionOut,
} from './serialize'
import { readStoreSettings, writeStoreSettings } from './store'
import {
  appendContactReply,
  createPurchaseOrder,
  findByCorrelationKey,
  getContactCase,
  getPurchaseOrder,
  getReorderPolicy,
  getReturn,
  getSupportCase,
  getWorkflowCase,
  insertWorkflowCase,
  listContactCases,
  listReorderPolicies,
  listSupportCases,
  listWorkflowCases,
  orderPurchaseOrder,
  readShippingConfig,
  receiveConfirmedReturn,
  receivePurchaseOrder,
  recordProductionCompletion,
  replySupportCase,
  resolveContactCase,
  updateWorkflowCase,
} from './state'
import contractJson from './storefront-commerce-contract.json'

export type Effect = 'read' | 'write'

export interface ActionMeta {
  action: string
  effect: Effect
}

export interface OperationMeta {
  name: string
  title: string
  description: string
  effect: Effect
  roles: string[]
  idempotency: 'required' | 'none'
  actions: ActionMeta[]
}

export interface ActorContext {
  principalId: string
  role: string
  userId: number
}

export interface HandlerContext {
  payload: Payload
  req: PayloadRequest
  actor: ActorContext
  args: Record<string, unknown>
}

type Handler = (ctx: HandlerContext) => Promise<unknown>

const A = (action: string, effect: Effect): ActionMeta => ({ action, effect })

export const IMPLEMENTED_OPERATIONS: OperationMeta[] = [
  {
    name: 'activity',
    title: 'Activity',
    description: 'Read recent store activity recorded by the existing backend.',
    effect: 'read',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'none',
    actions: [A('list', 'read')],
  },
  {
    name: 'products',
    title: 'Products',
    description: 'Read the product catalog and apply safe edits to existing products.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read'), A('update', 'write')],
  },
  {
    name: 'collections',
    title: 'Collections',
    description: 'Read product categories (collections) and their products.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read'), A('products', 'read')],
  },
  {
    name: 'media',
    title: 'Media',
    description: 'Read registered catalog media.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read')],
  },
  {
    name: 'customers',
    title: 'Customers',
    description: 'Read customer accounts and their orders.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read'), A('orders', 'read')],
  },
  {
    name: 'carts',
    title: 'Carts',
    description: 'Read and manage customer carts without exposing cart secrets.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [
      A('list', 'read'),
      A('get', 'read'),
      A('create', 'write'),
      A('set_items', 'write'),
      A('abandon', 'write'),
    ],
  },
  {
    name: 'orders',
    title: 'Orders',
    description: 'Read orders and cancel unpaid orders.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read'), A('cancel', 'write')],
  },
  {
    name: 'inventory',
    title: 'Inventory',
    description: 'Read stock and apply stock adjustments to existing products.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('stock', 'read'), A('history', 'read'), A('adjust', 'write')],
  },
  {
    name: 'payments',
    title: 'Payments',
    description: 'Read verified payment/transaction state from the existing backend.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read'), A('find_reference', 'read')],
  },
  {
    name: 'store_settings',
    title: 'Store settings',
    description: 'Read and update store identity and default shipping settings.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('get', 'read'), A('update', 'write')],
  },
  {
    name: 'staff_access',
    title: 'Staff access',
    description: 'Read the existing staff identity bound to the signed actor and list admin accounts.',
    effect: 'write',
    roles: ['OWNER'],
    idempotency: 'required',
    actions: [A('current', 'read'), A('list', 'read')],
  },
  {
    name: 'workflow_cases',
    title: 'Workflow cases',
    description: 'Open, read and update correlated business cases with version checks and immutable history.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('open', 'write'), A('get', 'read'), A('list', 'read'), A('update', 'write')],
  },
  {
    name: 'contact_cases',
    title: 'Contact cases',
    description: 'Read general customer cases and record retained response/resolution evidence.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read'), A('record_reply', 'write'), A('resolve', 'write')],
  },
  {
    name: 'support',
    title: 'Support',
    description: 'Read customer support conversations and publish retained replies.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('list', 'read'), A('get', 'read'), A('reply', 'write')],
  },
  {
    name: 'shipping_dispatch',
    title: 'Shipping dispatch',
    description: 'Read the merchant shipping provider selection and retained shipping configuration.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('provider_selection', 'read'), A('configuration', 'read')],
  },
  {
    name: 'store_operations',
    title: 'Store operations',
    description: 'Read production candidates/contact context and record merchant-confirmed production completions against real stock.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [
      A('candidates', 'read'),
      A('contact_context', 'read'),
      A('supplier_contact', 'read'),
      A('correlate_supplier_whatsapp', 'read'),
      A('production_candidates', 'read'),
      A('production_complete', 'write'),
    ],
  },
  {
    name: 'purchases',
    title: 'Purchases',
    description: 'Operate supplier purchase drafts, receipts and saved reorder policy against real stock.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [
      A('get', 'read'),
      A('order', 'write'),
      A('receive', 'write'),
      A('reorder_policy_get', 'read'),
      A('reorder_candidates', 'read'),
      A('reorder_saved', 'write'),
    ],
  },
  {
    name: 'returns',
    title: 'Returns',
    description: 'Read return requests and receive merchant-confirmed physical return quantities.',
    effect: 'write',
    roles: ['OWNER', 'ADMIN'],
    idempotency: 'required',
    actions: [A('get', 'read'), A('receive_confirmed', 'write')],
  },
]

const OPERATION_BY_NAME = new Map(IMPLEMENTED_OPERATIONS.map((op) => [op.name, op]))

export function operationMeta(name: string): OperationMeta | undefined {
  return OPERATION_BY_NAME.get(name)
}

export function actionEffect(name: string, action: string): Effect {
  const op = OPERATION_BY_NAME.get(name)
  const found = op?.actions.find((a) => a.action === action)
  if (!found) fail('unsupported_action', 404, `Unsupported action ${name}.${action}`)
  return found.effect
}

// ---------------------------------------------------------------------------
// argument helpers
// ---------------------------------------------------------------------------

const MAX_LIMIT = 100
const MAX_OFFSET = 100000

function optString(args: Record<string, unknown>, key: string, max = 200): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('invalid_argument', 400, `${key} must be a string`)
  if (value.length > max) fail('invalid_argument', 400, `${key} too long`)
  return value
}

function reqString(args: Record<string, unknown>, key: string, max = 500): string {
  const value = optString(args, key, max)
  if (value === undefined || value.length === 0) fail('invalid_argument', 400, `${key} is required`)
  return value
}

function optInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('invalid_argument', 400, `${key} out of range`)
  }
  return value
}

function reqInt(args: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = optInt(args, key, min, max)
  if (value === undefined) fail('invalid_argument', 400, `${key} is required`)
  return value
}

interface ListArgs {
  limit: number
  offset: number
  page: number
  sort: string
  q?: string
  filter?: string
}

function listArgs(args: Record<string, unknown>): ListArgs {
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 25
  const offset = optInt(args, 'offset', 0, MAX_OFFSET) ?? 0
  const sortKey = optString(args, 'sort', 20) ?? 'newest'
  const sort = sortKey === 'oldest' ? 'createdAt' : sortKey === 'name' ? 'title' : '-createdAt'
  return { limit, offset, page: Math.floor(offset / limit) + 1, sort, q: optString(args, 'q', 200), filter: optString(args, 'filter', 80) }
}

function applyOffset<T>(docs: T[], list: ListArgs): T[] {
  const skip = list.offset - (list.page - 1) * list.limit
  return skip > 0 ? docs.slice(skip) : docs
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const SHA256_RE = /^[a-f0-9]{64}$/

function reqUuid(args: Record<string, unknown>, key: string): string {
  const value = reqString(args, key, 64)
  if (!UUID_RE.test(value)) fail('invalid_argument', 400, `${key} must be a UUID`)
  return value
}

function optUuid(args: Record<string, unknown>, key: string): string | undefined {
  const value = optString(args, key, 64)
  if (value !== undefined && !UUID_RE.test(value)) fail('invalid_argument', 400, `${key} must be a UUID`)
  return value
}

function reqBool(args: Record<string, unknown>, key: string): boolean {
  const value = args[key]
  if (typeof value !== 'boolean') fail('invalid_argument', 400, `${key} must be a boolean`)
  return value
}

function reqEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = reqString(args, key, 120)
  if (!(allowed as readonly string[]).includes(value)) fail('invalid_argument', 400, `${key} invalid`)
  return value as T
}

function reqArray(args: Record<string, unknown>, key: string, min: number, max: number): Record<string, unknown>[] {
  const value = args[key]
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail('invalid_argument', 400, `${key} must be an array of ${min}..${max}`)
  }
  return value as Record<string, unknown>[]
}

function reqObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_argument', 400, `${key} must be an object`)
  return value as Record<string, unknown>
}

function reqSha256(args: Record<string, unknown>, key: string): string {
  const value = reqString(args, key, 64)
  if (!SHA256_RE.test(value)) fail('invalid_argument', 400, `${key} must be a sha256`)
  return value
}

async function listProductOut(docs: any[]) {
  return docs.map((doc) => productOut(doc))
}

// ---------------------------------------------------------------------------
// read handlers
// ---------------------------------------------------------------------------

async function activityList({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const [orders, carts, transactions] = await Promise.all([
    payload.find({ collection: 'orders', limit: list.limit, sort: '-createdAt', depth: 0, overrideAccess: true }),
    payload.find({ collection: 'carts', limit: list.limit, sort: '-createdAt', depth: 0, overrideAccess: true }),
    payload.find({ collection: 'transactions', limit: list.limit, sort: '-createdAt', depth: 0, overrideAccess: true }),
  ])
  const events = [
    ...orders.docs.map((o: any) => ({ kind: 'order', id: toPublicId(o.id), number: String(o.id), status: o.status ?? null, amount_cents: o.amount ?? null, createdAt: o.createdAt })),
    ...carts.docs.map((c: any) => ({ kind: 'cart', id: toPublicId(c.id), status: c.status ?? null, createdAt: c.createdAt })),
    ...transactions.docs.map((t: any) => ({ kind: 'payment', id: toPublicId(t.id), status: t.status ?? null, amount_cents: t.amount ?? null, createdAt: t.createdAt })),
  ]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, list.limit)
  return { activity: events, pagination: pagination(events.length, list.limit, list.offset) }
}

async function productsList({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const where: any = {}
  const and: any[] = []
  if (list.q) and.push({ or: [{ title: { contains: list.q } }, { slug: { contains: list.q } }] })
  if (list.filter === 'active') and.push({ _status: { equals: 'published' } })
  if (list.filter === 'draft') and.push({ _status: { equals: 'draft' } })
  if (and.length) where.and = and
  const res = await payload.find({ collection: 'products', depth: 1, limit: list.limit, page: list.page, sort: list.sort, where, overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return { products: await listProductOut(docs), pagination: pagination(res.totalDocs, list.limit, list.offset) }
}

async function productsGet({ payload, args }: HandlerContext) {
  const slug = reqString(args, 'slug', 120)
  const res = await payload.find({ collection: 'products', where: { slug: { equals: slug } }, depth: 2, limit: 1, overrideAccess: true })
  const doc = res.docs[0]
  if (!doc) fail('product_not_found', 404)
  return { product: productOut(doc, { includeVariants: true }) }
}

async function collectionsList({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const where: any = list.q ? { title: { contains: list.q } } : {}
  const res = await payload.find({ collection: 'categories', depth: 0, limit: list.limit, page: list.page, sort: list.sort, where, overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return { collections: docs.map((c: any) => collectionOut(c)), pagination: pagination(res.totalDocs, list.limit, list.offset) }
}

async function collectionsGet({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const doc = (await payload.findByID({ collection: 'categories', id, depth: 0, overrideAccess: true })) as any
  if (!doc) fail('collection_not_found', 404)
  return { collection: collectionOut(doc) }
}

async function collectionsProducts({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const res = await payload.find({ collection: 'products', where: { categories: { in: [id] } }, depth: 1, limit: 100, overrideAccess: true })
  return { collection_id: toPublicId(id), products: await listProductOut(res.docs) }
}

async function mediaList({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const where: any = list.q ? { or: [{ alt: { contains: list.q } }, { filename: { contains: list.q } }] } : {}
  const res = await payload.find({ collection: 'media', depth: 0, limit: list.limit, page: list.page, sort: list.sort, where, overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return { items: docs.map((m: any) => mediaOut(m)), pagination: pagination(res.totalDocs, list.limit, list.offset) }
}

async function mediaGet({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const doc = (await payload.findByID({ collection: 'media', id, depth: 0, overrideAccess: true })) as any
  if (!doc) fail('media_not_found', 404)
  return { item: mediaOut(doc) }
}

async function customerOutList(payload: Payload, list: ListArgs) {
  const res = await payload.find({
    collection: 'users',
    depth: 0,
    limit: list.limit,
    page: list.page,
    sort: list.sort,
    where: { roles: { contains: 'customer' } },
    overrideAccess: true,
  })
  const docs = applyOffset(res.docs, list)
  return { customers: docs.map((u: any) => customerOut(u)), pagination: pagination(res.totalDocs, list.limit, list.offset) }
}

async function customersList(ctx: HandlerContext) {
  return customerOutList(ctx.payload, listArgs(ctx.args))
}

async function customersGet({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const doc = (await payload.findByID({ collection: 'users', id, depth: 1, overrideAccess: true })) as any
  if (!doc) fail('customer_not_found', 404)
  return { customer: customerOut(doc, { addresses: true }) }
}

async function customersOrders({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 25
  const offset = optInt(args, 'offset', 0, MAX_OFFSET) ?? 0
  const res = await payload.find({ collection: 'orders', where: { customer: { equals: id } }, depth: 0, limit, page: Math.floor(offset / limit) + 1, sort: '-createdAt', overrideAccess: true })
  return { customer_id: toPublicId(id), orders: res.docs.map((o: any) => orderOut(o)), pagination: pagination(res.totalDocs, limit, offset) }
}

async function cartsList({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const res = await payload.find({ collection: 'carts', depth: 0, limit: list.limit, page: list.page, sort: list.sort, overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return { carts: docs.map((c: any) => cartOut(c)), pagination: pagination(res.totalDocs, list.limit, list.offset) }
}

async function cartsGet({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const doc = (await payload.findByID({ collection: 'carts', id, depth: 1, overrideAccess: true })) as any
  if (!doc) fail('cart_not_found', 404)
  return { cart: cartOut(doc) }
}

async function ordersList({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const where: any = {}
  if (list.filter === 'processing' || list.filter === 'completed' || list.filter === 'cancelled' || list.filter === 'refunded') {
    where.status = { equals: list.filter }
  }
  const res = await payload.find({ collection: 'orders', depth: 1, limit: list.limit, page: list.page, sort: list.sort, where, overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return { orders: docs.map((o: any) => orderOut(o)), pagination: pagination(res.totalDocs, list.limit, list.offset) }
}

async function resolveOrder(payload: Payload, number: unknown) {
  const raw = typeof number === 'string' ? number : String(number)
  const id = Number.parseInt(raw.replace(/[^0-9]/g, ''), 10)
  if (!Number.isSafeInteger(id) || id <= 0) fail('order_not_found', 404)
  const doc = (await payload.findByID({ collection: 'orders', id, depth: 1, overrideAccess: true })) as any
  if (!doc) fail('order_not_found', 404)
  return doc
}

async function ordersGet({ payload, args }: HandlerContext) {
  const doc = await resolveOrder(payload, args.number)
  return { order: orderOut(doc) }
}

async function inventoryStock({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const where: any = list.q ? { or: [{ title: { contains: list.q } }, { slug: { contains: list.q } }] } : {}
  const res = await payload.find({ collection: 'products', depth: 0, limit: list.limit, page: list.page, sort: list.sort, where, overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return {
    items: docs.map((p: any) => ({
      product_id: toPublicId(p.id),
      slug: p.slug ?? null,
      name: p.title ?? null,
      inventory: typeof p.inventory === 'number' ? p.inventory : 0,
      low: typeof p.inventory === 'number' ? p.inventory <= 5 : false,
    })),
    pagination: pagination(res.totalDocs, list.limit, list.offset),
  }
}

async function inventoryHistory({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const res = await payload.find({ collection: 'products', depth: 0, limit: list.limit, page: list.page, sort: '-updatedAt', overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return {
    history: docs.map((p: any) => ({
      product_id: toPublicId(p.id),
      slug: p.slug ?? null,
      inventory: typeof p.inventory === 'number' ? p.inventory : 0,
      observed_at: p.updatedAt ?? null,
      note: 'current recorded stock level',
    })),
    pagination: pagination(res.totalDocs, list.limit, list.offset),
  }
}

async function paymentsList({ payload, args }: HandlerContext) {
  const list = listArgs(args)
  const res = await payload.find({ collection: 'transactions', depth: 0, limit: list.limit, page: list.page, sort: list.sort, overrideAccess: true })
  const docs = applyOffset(res.docs, list)
  return { payments: docs.map((t: any) => transactionOut(t)), pagination: pagination(res.totalDocs, list.limit, list.offset) }
}

async function paymentsGet({ payload, args }: HandlerContext) {
  const order = await resolveOrder(payload, args.number)
  const txns = Array.isArray(order.transactions) ? order.transactions : []
  const details = await Promise.all(
    txns.map(async (t: any) => {
      const id = typeof t === 'object' ? t.id : t
      const doc = (await payload.findByID({ collection: 'transactions', id, depth: 0, overrideAccess: true })) as any
      return doc ? transactionOut(doc) : null
    }),
  )
  return { order_number: String(order.id), payments: details.filter(Boolean) }
}

async function paymentsFindReference({ payload, args }: HandlerContext) {
  const reference = reqString(args, 'providerPaymentId', 255)
  const res = await payload.find({ collection: 'transactions', where: { 'stripe.paymentIntentID': { equals: reference } }, depth: 0, limit: 2, overrideAccess: true })
  if (res.docs.length === 0) fail('payment_not_found', 404)
  if (res.docs.length > 1) fail('payment_reference_ambiguous', 409)
  return { payment: transactionOut(res.docs[0]) }
}

const DEFAULT_SETTINGS = () => ({
  name: process.env.SITE_NAME || process.env.COMPANY_NAME || 'Willow Market',
  currency: 'USD',
  country: 'US',
  support_email: process.env.SUPPORT_EMAIL || '',
  shipping_flat_cents: 0,
  free_shipping_threshold_cents: null as number | null,
  prices_include_tax: false,
  cod: { enabled: false },
})

async function storeSettingsGet({ payload }: HandlerContext) {
  const row = await readStoreSettings(payload)
  return { settings: row ? row.data : DEFAULT_SETTINGS(), revision: row ? row.revision : 0 }
}

async function storeSettingsUpdate({ payload, args }: HandlerContext) {
  const changes = args.changes
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) fail('invalid_argument', 400, 'changes is required')
  const patch = changes as Record<string, unknown>
  const allowed = ['name', 'currency', 'country', 'support_email', 'shipping_flat_cents', 'free_shipping_threshold_cents', 'prices_include_tax']
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) fail('unsupported_change', 400, `Unsupported settings change: ${key}`)
  }
  if (patch.currency !== undefined && !/^[A-Z]{3}$/.test(String(patch.currency))) fail('invalid_argument', 400, 'currency invalid')
  if (patch.country !== undefined && !/^[A-Z]{2}$/.test(String(patch.country))) fail('invalid_argument', 400, 'country invalid')
  const existing = await readStoreSettings(payload)
  const merged = { ...(existing ? existing.data : DEFAULT_SETTINGS()), ...patch }
  const written = await writeStoreSettings(payload, merged)
  return { settings: written.data, revision: written.revision }
}

// ---------------------------------------------------------------------------
// write handlers
// ---------------------------------------------------------------------------

async function productsUpdate({ payload, args }: HandlerContext) {
  const slug = reqString(args, 'slug', 120)
  const changes = args.changes
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) fail('invalid_argument', 400, 'changes required')
  const patch = changes as Record<string, unknown>
  const res = await payload.find({ collection: 'products', where: { slug: { equals: slug } }, depth: 1, limit: 1, overrideAccess: true })
  const doc = res.docs[0] as any
  if (!doc) fail('product_not_found', 404)
  const data: Record<string, unknown> = {}
  if (patch.title !== undefined) data.title = reqString(patch, 'title', 200)
  if (patch.name !== undefined) data.title = reqString(patch, 'name', 200)
  if (patch.price_cents !== undefined) data.priceInUSD = reqInt(patch, 'price_cents', 0, 100000000)
  if (patch.active !== undefined) data._status = patch.active ? 'published' : 'draft'
  if (patch.description !== undefined) data.description = lexicalParagraph(String(patch.description))
  if (Object.keys(data).length === 0) fail('no_changes', 400)
  const updated = (await payload.update({ collection: 'products', id: doc.id, data, depth: 1, overrideAccess: true })) as any
  return { product: productOut(updated, { includeVariants: true }) }
}

async function inventoryAdjust({ payload, args }: HandlerContext) {
  const slug = reqString(args, 'slug', 120)
  const delta = reqInt(args, 'delta', -1000000, 1000000)
  reqString(args, 'reason', 500)
  const res = await payload.find({ collection: 'products', where: { slug: { equals: slug } }, depth: 0, limit: 1, overrideAccess: true })
  const doc = res.docs[0] as any
  if (!doc) fail('product_not_found', 404)
  const before = typeof doc.inventory === 'number' ? doc.inventory : 0
  const after = Math.max(0, before + delta)
  const updated = (await payload.update({ collection: 'products', id: doc.id, data: { inventory: after }, depth: 0, overrideAccess: true })) as any
  return { item: { product_id: toPublicId(doc.id), slug: doc.slug ?? null, before_stock: before, after_stock: after, delta, inventory: updated.inventory ?? after } }
}

function normalizeItems(value: unknown): Array<{ product?: number; variant?: number; quantity: number }> {
  if (!Array.isArray(value)) fail('invalid_argument', 400, 'items must be an array')
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') fail('invalid_argument', 400, 'item invalid')
    const item = raw as Record<string, unknown>
    const quantity = reqInt(item, 'quantity', 1, 100000)
    const out: { product?: number; variant?: number; quantity: number } = { quantity }
    if (item.productId !== undefined) out.product = fromPublicId(item.productId)
    if (item.variantId !== undefined) out.variant = fromPublicId(item.variantId)
    if (out.product === undefined && out.variant === undefined) fail('invalid_argument', 400, 'item needs productId or variantId')
    return out
  })
}

async function cartsCreate({ payload, args }: HandlerContext) {
  const userId = fromPublicId(args.userId)
  const user = (await payload.findByID({ collection: 'users', id: userId, depth: 0, overrideAccess: true })) as any
  if (!user) fail('customer_not_found', 404)
  const cart = (await payload.create({
    collection: 'carts',
    data: { customer: userId, status: 'active', currency: 'USD', secret: crypto.randomUUID(), items: [] } as any,
    depth: 0,
    overrideAccess: true,
  })) as any
  return { cart: cartOut(cart) }
}

async function cartsSetItems({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const items = normalizeItems(args.items)
  const cart = (await payload.findByID({ collection: 'carts', id, depth: 0, overrideAccess: true })) as any
  if (!cart) fail('cart_not_found', 404)
  const updated = (await payload.update({
    collection: 'carts',
    id,
    data: { items } as any,
    depth: 0,
    overrideAccess: true,
  })) as any
  return { cart: cartOut(updated) }
}

async function cartsAbandon({ payload, args }: HandlerContext) {
  const id = fromPublicId(args.id)
  const cart = (await payload.findByID({ collection: 'carts', id, depth: 0, overrideAccess: true })) as any
  if (!cart) fail('cart_not_found', 404)
  const updated = (await payload.update({ collection: 'carts', id, data: { status: 'abandoned' } as any, depth: 0, overrideAccess: true })) as any
  return { cart: cartOut(updated) }
}

async function ordersCancel({ payload, args }: HandlerContext) {
  const order = await resolveOrder(payload, args.number)
  if (order.status === 'completed' && (order.transactions || []).some((t: any) => t && typeof t === 'object' && t.status === 'succeeded')) {
    fail('order_already_paid', 409, 'Paid orders cannot be cancelled here')
  }
  const updated = (await payload.update({ collection: 'orders', id: order.id, data: { status: 'cancelled' }, depth: 1, overrideAccess: true })) as any
  return { order: orderOut(updated) }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Core-14 groups
// ---------------------------------------------------------------------------

const publicUser = (u: any) => ({ id: toPublicId(u.id), name: u.name ?? null, email: u.email ?? null })

async function staffCurrent({ payload, actor }: HandlerContext) {
  const user = (await payload.findByID({ collection: 'users', id: actor.userId, depth: 0, overrideAccess: true })) as any
  if (!user) fail('staff_not_found', 404)
  return { staff: { ...publicUser(user), role: actor.role.toLowerCase(), disabled: false, linked: true } }
}

async function staffList({ payload, args }: HandlerContext) {
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 25
  const offset = optInt(args, 'offset', 0, MAX_OFFSET) ?? 0
  const res = await payload.find({ collection: 'users', where: { roles: { contains: 'admin' } }, depth: 0, limit, page: Math.floor(offset / limit) + 1, sort: 'createdAt', overrideAccess: true })
  return { staff: res.docs.map((u: any) => ({ ...publicUser(u), role: 'admin', disabled: false })), pagination: pagination(res.totalDocs, limit, offset) }
}

const caseOut = (row: Awaited<ReturnType<typeof getWorkflowCase>>) => row && {
  id: row.id,
  correlation_key: row.correlationKey,
  subject: row.subject,
  title: row.title,
  reason: row.reason,
  status: row.status,
  owner_email: row.ownerEmail,
  due_at: row.dueAt,
  version: row.version,
  events: row.events,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
}

async function workflowOpen({ payload, actor, args }: HandlerContext) {
  const correlationKey = reqString(args, 'correlationKey', 200)
  const subject = optString(args, 'subject', 300) ?? null
  const title = reqString(args, 'title', 200)
  const reason = reqString(args, 'reason', 4000)
  const dueAt = reqString(args, 'dueAt', 40)
  const ownerEmail = optString(args, 'ownerEmail', 200) ?? null
  const existing = await findByCorrelationKey(payload, correlationKey)
  if (existing) return { case: caseOut(existing), created: false }
  const row = await insertWorkflowCase(payload, { correlationKey, subject, title, reason, ownerEmail, ownerPrincipalId: actor.principalId, dueAt, data: {} })
  if (!row) {
    const raced = await findByCorrelationKey(payload, correlationKey)
    if (!raced) fail('case_open_failed', 500)
    return { case: caseOut(raced), created: false }
  }
  return { case: caseOut(row), created: true }
}

async function workflowGet({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const row = await getWorkflowCase(payload, id)
  if (!row) fail('case_not_found', 404)
  return { case: caseOut(row) }
}

async function workflowList({ payload, args }: HandlerContext) {
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 25
  const offset = optInt(args, 'offset', 0, MAX_OFFSET) ?? 0
  const status = optString(args, 'status', 20)
  const subject = optString(args, 'subject', 300)
  const dueBefore = optString(args, 'dueBefore', 40)
  const res = await listWorkflowCases(payload, { status, subject, dueBefore, limit, offset })
  return { cases: res.cases.map((c) => caseOut(c)), pagination: pagination(res.total, limit, offset) }
}

async function workflowUpdate({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const expectedVersion = reqInt(args, 'expectedVersion', 1, 1000000000)
  const status = reqEnum(args, 'status', ['open', 'waiting', 'resolved', 'dismissed'] as const)
  const reason = reqString(args, 'reason', 4000)
  const ownerEmail = optString(args, 'ownerEmail', 200)
  const dueAt = optString(args, 'dueAt', 40)
  const evidence = Array.isArray(args.evidence) ? (args.evidence as unknown[]).map((e) => String(e)) : undefined
  const result = await updateWorkflowCase(payload, { id, expectedVersion, status, reason, ownerEmail, dueAt, evidence })
  if (result.missing) fail('case_not_found', 404)
  if (result.conflict) fail('version_conflict', 409)
  return { case: caseOut(result.row ?? null) }
}

const contactCaseOut = (row: NonNullable<Awaited<ReturnType<typeof getContactCase>>>) => ({
  id: row.id,
  subject: row.subject,
  body: row.body,
  customer_email: row.customerEmail,
  status: row.status,
  replies: row.replies,
  resolution: row.resolution,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})

async function contactCasesList({ payload, args }: HandlerContext) {
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 25
  const offset = optInt(args, 'offset', 0, MAX_OFFSET) ?? 0
  const status = optString(args, 'status', 20)
  const res = await listContactCases(payload, { status, limit, offset })
  return { cases: res.cases.map(contactCaseOut), pagination: pagination(res.total, limit, offset) }
}

async function contactCaseGet({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const row = await getContactCase(payload, id)
  if (!row) fail('contact_case_not_found', 404)
  return { case: contactCaseOut(row) }
}

async function contactCaseRecordReply({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const eventKey = reqUuid(args, 'eventKey')
  const body = reqString(args, 'body', 8000)
  const providerId = reqString(args, 'providerId', 120)
  const accountId = reqString(args, 'accountId', 300)
  const providerMessageId = reqString(args, 'providerMessageId', 500)
  const effectReceiptId = reqString(args, 'effectReceiptId', 500)
  const evidenceReference = reqString(args, 'evidenceReference', 2000)
  const res = await appendContactReply(payload, { id, eventKey, body, providerId, accountId, providerMessageId, effectReceiptId, evidenceReference })
  if (!res.found) fail('contact_case_not_found', 404)
  return { case: res.row && contactCaseOut(res.row), duplicate: res.duplicate }
}

async function contactCaseResolve({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const eventKey = reqUuid(args, 'eventKey')
  const resolution = reqString(args, 'resolution', 4000)
  const evidenceReference = reqString(args, 'evidenceReference', 2000)
  const res = await resolveContactCase(payload, { id, eventKey, resolution, evidenceReference })
  if (!res.found) fail('contact_case_not_found', 404)
  return { case: res.row && contactCaseOut(res.row), already_resolved: res.alreadyResolved }
}

const supportCaseOut = (row: NonNullable<Awaited<ReturnType<typeof getSupportCase>>>) => ({
  id: row.id,
  order_number: row.orderNumber,
  subject: row.subject,
  status: row.status,
  messages: row.messages,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})

async function supportList({ payload, args }: HandlerContext) {
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 25
  const offset = optInt(args, 'offset', 0, MAX_OFFSET) ?? 0
  const orderNumber = optString(args, 'number', 40)
  const res = await listSupportCases(payload, { orderNumber, limit, offset })
  return { cases: res.cases.map(supportCaseOut), pagination: pagination(res.total, limit, offset) }
}

async function supportGet({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const row = await getSupportCase(payload, id)
  if (!row) fail('support_case_not_found', 404)
  return { case: supportCaseOut(row) }
}

async function supportReply({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const messageKey = reqUuid(args, 'messageKey')
  const body = reqString(args, 'body', 4000)
  const evidenceReference = reqString(args, 'evidenceReference', 1000)
  const res = await replySupportCase(payload, { id, messageKey, body, evidenceReference })
  if (!res.found) fail('support_case_not_found', 404)
  return { case: res.row && supportCaseOut(res.row), duplicate: res.duplicate }
}

async function shippingProviderSelection({ payload }: HandlerContext) {
  const { config } = await readShippingConfig(payload)
  return { provider_selection: { delivery_method: config.deliveryMethod, provider_id: config.providerId, source: config.source, configured: config.deliveryMethod !== null } }
}

async function shippingConfiguration({ payload }: HandlerContext) {
  const { config, revision } = await readShippingConfig(payload)
  return { configuration: { delivery_method: config.deliveryMethod, provider_id: config.providerId, source: config.source, revision, configured: config.deliveryMethod !== null }, unconfigured: config.deliveryMethod === null }
}

const LOW_STOCK_THRESHOLD = 5

async function soProductionCandidates({ payload, args }: HandlerContext) {
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 50
  const afterId = optString(args, 'afterId', 80)
  const where: any = afterId ? { id: { greater_than: fromPublicId(afterId) } } : undefined
  const res = await payload.find({ collection: 'products', depth: 0, limit, where, sort: 'id', overrideAccess: true })
  const candidates = res.docs
    .filter((p: any) => typeof p.inventory === 'number' && p.inventory <= LOW_STOCK_THRESHOLD)
    .map((p: any) => ({ product_id: toPublicId(p.id), slug: p.slug, name: p.title, stock: p.inventory, threshold: LOW_STOCK_THRESHOLD }))
  const last = res.docs[res.docs.length - 1]
  return { candidates, next_after_id: res.docs.length === limit && last ? toPublicId(last.id) : null, basis: 'recorded available stock at or below the default replenishment threshold' }
}

async function soProductionComplete({ payload, args }: HandlerContext) {
  const productId = fromPublicId(reqUuid(args, 'productId'))
  const quantity = reqInt(args, 'quantity', 1, 10000)
  const expectedStock = reqInt(args, 'expectedStock', 0, 1000000000)
  if (!reqBool(args, 'merchantConfirmed')) fail('merchant_confirmation_required', 400)
  const reason = reqString(args, 'reason', 200)
  const product = (await payload.findByID({ collection: 'products', id: productId, depth: 0, overrideAccess: true })) as any
  if (!product) fail('product_not_found', 404)
  const before = typeof product.inventory === 'number' ? product.inventory : 0
  if (before !== expectedStock) fail('stock_conflict', 409, 'Recorded stock did not match expectedStock')
  const after = before + quantity
  await payload.update({ collection: 'products', id: productId, data: { inventory: after }, overrideAccess: true })
  await recordProductionCompletion(payload, { productId, variantId: null, quantity, beforeStock: before, afterStock: after, reason })
  return { product_id: toPublicId(productId), before_stock: before, after_stock: after, quantity }
}

async function soCandidates({ payload, args }: HandlerContext) {
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 50
  const res = await listContactCases(payload, { status: 'open', limit, offset: 0 })
  return {
    candidates: res.cases.map((c) => ({ kind: 'contact_case', id: c.id, subject: c.subject, created_at: c.createdAt })),
    delivered_reverse_shipments: [],
    note: 'reverse-shipment inspection candidates require configured carrier integration; none are tracked',
  }
}

async function soContactContext({ payload, args }: HandlerContext) {
  const contactCaseId = reqUuid(args, 'contactCaseId')
  const c = await getContactCase(payload, contactCaseId)
  if (!c) fail('contact_case_not_found', 404)
  const products = await payload.find({ collection: 'products', where: { _status: { equals: 'published' } }, depth: 0, limit: 50, overrideAccess: true })
  const pages = await payload.find({ collection: 'pages', where: { _status: { equals: 'published' } }, depth: 0, limit: 50, overrideAccess: true })
  return {
    contact_case_id: contactCaseId,
    products: products.docs.map((p: any) => ({ slug: p.slug, title: p.title })),
    policies: pages.docs.map((p: any) => ({ slug: p.slug, title: p.title })),
    note: 'published/public information only; no customer orders or private data',
  }
}

async function soSupplierContact({ args }: HandlerContext) {
  reqUuid(args, 'supplierId')
  return { supplier: null, communication: null, configured: false, reason: 'no_supplier_records_configured' }
}

async function soCorrelateSupplierWhatsapp({ args }: HandlerContext) {
  reqString(args, 'accountId', 256)
  reqString(args, 'senderPhone', 40)
  optString(args, 'body', 50000)
  return { matched: false, purchase_order: null, reason: 'no_supplier_whatsapp_bindings_configured', confirms_receipt: false }
}

const purchaseOut = (row: NonNullable<Awaited<ReturnType<typeof getPurchaseOrder>>>) => ({
  id: row.id,
  status: row.status,
  currency: row.currency,
  supplier_ref: row.supplierRef,
  notes: row.notes,
  lines: row.lines,
  receipts: row.receipts,
  revision: row.revision,
  revision_digest: row.revisionDigest,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})

async function purchasesReorderPolicyGet({ payload, args }: HandlerContext) {
  const productId = fromPublicId(reqUuid(args, 'productId'))
  const variantId = optUuid(args, 'variantId')
  const row = await getReorderPolicy(payload, { productId, variantId: variantId ? fromPublicId(variantId) : null })
  return row
    ? { policy: { id: row.id, product_id: toPublicId(row.productId), variant_id: row.variantId ? toPublicId(row.variantId) : null, supplier_ref: row.supplierRef, revision: row.revision, policy: row.policy }, configured: true }
    : { policy: null, configured: false }
}

async function purchasesReorderCandidates({ payload, args }: HandlerContext) {
  const afterId = optString(args, 'afterId', 80)
  const limit = optInt(args, 'limit', 1, MAX_LIMIT) ?? 50
  const policies = await listReorderPolicies(payload, { afterId: afterId ?? null, limit })
  const candidates: Record<string, unknown>[] = []
  for (const pol of policies) {
    const policy = pol.policy as Record<string, unknown>
    if (policy && policy.mode === 'automatic') {
      const product = (await payload.findByID({ collection: 'products', id: pol.productId, depth: 0, overrideAccess: true }).catch(() => null)) as any
      const stock = product && typeof product.inventory === 'number' ? product.inventory : 0
      if (stock <= Number(policy.reorderPoint ?? 0)) {
        candidates.push({ policy_id: pol.id, product_id: toPublicId(pol.productId), stock, reorder_point: policy.reorderPoint })
      }
    }
  }
  return { candidates, next_after_id: policies.length === limit && policies.length ? policies[policies.length - 1].id : null }
}

async function purchasesReorderSaved({ payload, args }: HandlerContext) {
  const productId = fromPublicId(reqUuid(args, 'productId'))
  const variantId = optUuid(args, 'variantId')
  const expectedPolicyId = reqUuid(args, 'expectedPolicyId')
  const expectedRevision = reqInt(args, 'expectedRevision', 1, 1000000000)
  const pol = await getReorderPolicy(payload, { productId, variantId: variantId ? fromPublicId(variantId) : null })
  if (!pol) fail('policy_not_found', 404)
  if (pol.id !== expectedPolicyId || pol.revision !== expectedRevision) fail('policy_conflict', 409)
  const policy = pol.policy as Record<string, unknown>
  if (!policy || policy.mode !== 'automatic') fail('policy_not_automatic', 409)
  const product = (await payload.findByID({ collection: 'products', id: productId, depth: 0, overrideAccess: true })) as any
  const stock = product && typeof product.inventory === 'number' ? product.inventory : 0
  const shortage = Math.max(0, Number(policy.targetQuantity) - stock)
  if (shortage <= 0) return { draft: null, created: false, reason: 'stock_above_target' }
  const pack = Math.max(1, Number(policy.packSize))
  const qty = Math.max(Number(policy.minimumOrderQuantity), Math.ceil(shortage / pack) * pack)
  const cost = qty * Number(policy.unitCostCents)
  if (cost > Number(policy.maxDraftCostCents)) fail('draft_cost_exceeds_cap', 409)
  const po = await createPurchaseOrder(payload, { currency: 'USD', supplierRef: pol.supplierRef, notes: 'reorder draft', expectedAt: null, lines: [{ productId: toPublicId(productId), variantId: variantId ?? null, quantity: qty, unitCostCents: Number(policy.unitCostCents) }] })
  return { draft: { id: po.id, status: po.status, revision_digest: po.revisionDigest, lines: po.lines }, created: true }
}

async function purchasesGet({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const po = await getPurchaseOrder(payload, id)
  if (!po) fail('purchase_not_found', 404)
  return { purchase: purchaseOut(po) }
}

async function purchasesOrder({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const expectedRevision = reqSha256(args, 'expectedRevision')
  const r = await orderPurchaseOrder(payload, { id, expectedRevision })
  if (r.missing) fail('purchase_not_found', 404)
  if (!r.ok) fail('revision_conflict', 409)
  return { purchase: purchaseOut(r.row!) }
}

async function purchasesReceive({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const deliveryReference = reqString(args, 'deliveryReference', 200)
  const lines = reqArray(args, 'lines', 1, 100)
  const po = await getPurchaseOrder(payload, id)
  if (!po) fail('purchase_not_found', 404)
  const stock: Record<string, unknown>[] = []
  for (const raw of lines) {
    const lineId = reqUuid(raw, 'lineId')
    const quantity = reqInt(raw, 'quantity', 0, 100000)
    const line = (po.lines as any[]).find((l) => l.lineId === lineId)
    if (line && line.productId) {
      const productId = fromPublicId(line.productId)
      const product = (await payload.findByID({ collection: 'products', id: productId, depth: 0, overrideAccess: true })) as any
      const before = product && typeof product.inventory === 'number' ? product.inventory : 0
      if (product) await payload.update({ collection: 'products', id: productId, data: { inventory: before + quantity }, overrideAccess: true })
      stock.push({ line_id: lineId, product_id: line.productId, before_stock: before, after_stock: before + quantity })
    }
  }
  const r = await receivePurchaseOrder(payload, { id, deliveryReference, lines: lines.map((l) => ({ lineId: String(l.lineId), quantity: Number(l.quantity) })) })
  if (!r.ok) fail('purchase_not_found', 404)
  return { purchase: purchaseOut(r.row!), stock }
}

const returnOut = (row: NonNullable<Awaited<ReturnType<typeof getReturn>>>) => ({
  id: row.id,
  order_number: row.orderNumber,
  status: row.status,
  reason: row.reason,
  items: row.items,
  dispositions: row.dispositions,
  attestation: row.attestation,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})

async function returnsGet({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const row = await getReturn(payload, id)
  if (!row) fail('return_not_found', 404)
  return { return: returnOut(row) }
}

const RECEIVE_ATTESTATION = 'I physically received and inspected these exact quantities and conditions.'

async function returnsReceiveConfirmed({ payload, args }: HandlerContext) {
  const id = reqUuid(args, 'id')
  const dispositions = reqArray(args, 'dispositions', 1, 150)
  const attestation = reqString(args, 'attestation', 200)
  if (attestation !== RECEIVE_ATTESTATION) fail('attestation_mismatch', 400)
  const res = await receiveConfirmedReturn(payload, { id, dispositions, attestation })
  if (!res.ok) fail('return_not_found', 404)
  return { return: res.row && returnOut(res.row), already_received: res.alreadyReceived }
}

const HANDLERS: Record<string, Handler> = {
  'activity.list': activityList,
  'products.list': productsList,
  'products.get': productsGet,
  'products.update': productsUpdate,
  'collections.list': collectionsList,
  'collections.get': collectionsGet,
  'collections.products': collectionsProducts,
  'media.list': mediaList,
  'media.get': mediaGet,
  'customers.list': customersList,
  'customers.get': customersGet,
  'customers.orders': customersOrders,
  'carts.list': cartsList,
  'carts.get': cartsGet,
  'carts.create': cartsCreate,
  'carts.set_items': cartsSetItems,
  'carts.abandon': cartsAbandon,
  'orders.list': ordersList,
  'orders.get': ordersGet,
  'orders.cancel': ordersCancel,
  'inventory.stock': inventoryStock,
  'inventory.history': inventoryHistory,
  'inventory.adjust': inventoryAdjust,
  'payments.list': paymentsList,
  'payments.get': paymentsGet,
  'payments.find_reference': paymentsFindReference,
  'store_settings.get': storeSettingsGet,
  'store_settings.update': storeSettingsUpdate,
  'staff_access.current': staffCurrent,
  'staff_access.list': staffList,
  'workflow_cases.open': workflowOpen,
  'workflow_cases.get': workflowGet,
  'workflow_cases.list': workflowList,
  'workflow_cases.update': workflowUpdate,
  'contact_cases.list': contactCasesList,
  'contact_cases.get': contactCaseGet,
  'contact_cases.record_reply': contactCaseRecordReply,
  'contact_cases.resolve': contactCaseResolve,
  'support.list': supportList,
  'support.get': supportGet,
  'support.reply': supportReply,
  'shipping_dispatch.provider_selection': shippingProviderSelection,
  'shipping_dispatch.configuration': shippingConfiguration,
  'store_operations.production_candidates': soProductionCandidates,
  'store_operations.production_complete': soProductionComplete,
  'store_operations.candidates': soCandidates,
  'store_operations.contact_context': soContactContext,
  'store_operations.supplier_contact': soSupplierContact,
  'store_operations.correlate_supplier_whatsapp': soCorrelateSupplierWhatsapp,
  'purchases.reorder_policy_get': purchasesReorderPolicyGet,
  'purchases.reorder_candidates': purchasesReorderCandidates,
  'purchases.reorder_saved': purchasesReorderSaved,
  'purchases.get': purchasesGet,
  'purchases.order': purchasesOrder,
  'purchases.receive': purchasesReceive,
  'returns.get': returnsGet,
  'returns.receive_confirmed': returnsReceiveConfirmed,
}

interface ContractOperationShape {
  name: string
  actionEffects?: Record<string, 'read' | 'write'>
  actionAvailability?: Record<string, { available: false; reason: string }>
  [key: string]: unknown
}

// Single declaration authority: the complete retained contract catalog, with a
// source-owned denial for EVERY action this adapter does not actually handle.
// Availability is derived solely from the real handler registry (HANDLERS).
const CONTRACT_SOURCE = (contractJson as unknown as { operations: ContractOperationShape[] }).operations

export const CONTRACT_OPERATIONS = CONTRACT_SOURCE.map((op) => {
  const effects = op.actionEffects || {}
  const actionAvailability: Record<string, { available: false; reason: string }> = {}
  for (const action of Object.keys(effects)) {
    if (!HANDLERS[`${op.name}.${action}`]) {
      actionAvailability[action] = { available: false, reason: 'provider_operation_unavailable' }
    }
  }
  return Object.keys(actionAvailability).length > 0 ? { ...op, actionAvailability } : { ...op }
})

const CONTRACT_BY_NAME = new Map(CONTRACT_OPERATIONS.map((op) => [op.name, op]))

export function contractOperation(name: string): ContractOperationShape | undefined {
  return CONTRACT_BY_NAME.get(name) as ContractOperationShape | undefined
}

export function unavailableReason(name: string, action: string): string | undefined {
  const op = CONTRACT_BY_NAME.get(name) as ContractOperationShape | undefined
  const status = op?.actionAvailability?.[action]
  return status && status.available === false ? status.reason : undefined
}

export function handlerFor(name: string, action: string): Handler {
  const handler = HANDLERS[`${name}.${action}`]
  if (!handler) fail('unsupported_action', 404, `Unsupported action ${name}.${action}`)
  return handler
}
