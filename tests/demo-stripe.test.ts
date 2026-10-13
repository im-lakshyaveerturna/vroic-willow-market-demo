import { test } from 'node:test'
import assert from 'node:assert/strict'
import Stripe from 'stripe'
import { postgresAdapter } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'
import type { PaymentAdapter } from '@payloadcms/plugin-ecommerce/types'
import { demoStripeAdapter, withDemoStripeConfirmation } from '../src/utilities/demo-stripe'

const secret = 'whsec_synthetic_fixture_only'
function fixture() {
  let state = { stock: 10, orders: [] as Record<string, unknown>[], transaction: {
    id: 1, paymentMethod: 'stripe', stripe: { paymentIntentID: 'pi_fixture', customerID: 'cus_fixture' },
    cart: 4, amount: 2400, currency: 'USD', status: 'pending', customerEmail: 'shopper@example.test', order: null as number | null,
    items: [{ product: 7, quantity: 2 }],
  } }
  let snapshot = structuredClone(state), failStock = false
  const calls = { created: 0, commits: 0, rollbacks: 0, lock: 0 }
  const intent = { id: 'pi_fixture', livemode: false, status: 'succeeded', amount: 2400, amount_received: 2400,
    currency: 'usd', customer: 'cus_fixture', metadata: { cartID: '4', cartItemsSnapshot: JSON.stringify([{ product: 7, quantity: 2 }]) } }
  const sdk = new Stripe('sk_test_synthetic_fixture_only')
  const stripe = { webhooks: sdk.webhooks, paymentIntents: { retrieve: async () => intent }, charges: { retrieve: async () => ({ id: 'ch_fixture', livemode: false, payment_intent: 'pi_fixture', amount_refunded: 2400, refunded: true }) } } as unknown as Stripe
  const payload = {
    find: async ({ where }: { where: Record<string, { equals: string }> }) => ({ docs: where['stripe.paymentIntentID'].equals === 'pi_fixture' ? [state.transaction] : [] }),
    findByID: async ({ collection, id }: { collection: string; id: number }) => collection === 'orders' ? state.orders.find(order => order.id === id) : { id },
    update: async ({ collection, data }: { collection: string; data: Record<string, unknown> }) => { if (collection === 'transactions') Object.assign(state.transaction, data) },
    db: {
      sessions: { 'payload-transaction': { db: { execute: async (statement: unknown) => { if (JSON.stringify(statement).includes('pg_advisory_xact_lock')) calls.lock++ } } } },
      beginTransaction: async () => { snapshot = structuredClone(state); return 'payload-transaction' },
      commitTransaction: async () => { calls.commits++ },
      rollbackTransaction: async () => { calls.rollbacks++; state = structuredClone(snapshot) },
      updateOne: async ({ req, data }: { req: PayloadRequest; data: { inventory: { $inc: number } } }) => {
        assert.equal(req.transactionID, 'payload-transaction')
        if (failStock) { failStock = false; throw new Error('interrupted_stock_write') }
        state.stock += data.inventory.$inc
      },
    },
  }
  const base: PaymentAdapter = { name: 'stripe', group: { type: 'group', name: 'stripe', fields: [] }, initiatePayment: async () => { throw new Error('unused initiation') }, confirmOrder: async ({ req }: { req: PayloadRequest }) => {
    assert.equal(req.transactionID, 'payload-transaction')
    calls.created++
    const order = { id: state.orders.length + 1, amount: 2400, currency: 'USD', transactions: [1], accessToken: 'synthetic-order-access' }
    state.orders.push(order)
    state.transaction.order = order.id
    state.transaction.status = 'succeeded'
    return { message: 'Created order', orderID: order.id, transactionID: 1, accessToken: order.accessToken }
  } }
  const adapter = demoStripeAdapter({ secretKey: 'sk_test_synthetic_fixture_only', publishableKey: 'pk_test_synthetic_fixture_only', webhookSecret: secret }, stripe, base)
  const req = { payload, headers: new Headers(), user: null } as unknown as PayloadRequest
  const args = { req, data: { paymentIntentID: 'pi_fixture', customerEmail: 'shopper@example.test' } }
  const webhookRequest = (type = 'payment_intent.succeeded', id = 'pi_fixture', signature = true): PayloadRequest => {
    const body = JSON.stringify({ id: 'evt_fixture', object: 'event', type, livemode: false, data: { object: { ...intent, id } } })
    return { ...req, headers: new Headers(signature ? { 'stripe-signature': sdk.webhooks.generateTestHeaderString({ payload: body, secret }) } : {}), text: async () => body } as PayloadRequest
  }
  return { adapter, args, req, intent, calls, state: () => state, failStock: () => { failStock = true }, webhookRequest }
}

test('TEST settlement retains actual order and stock once across completed retries', async () => {
  const h = fixture()
  const first = await h.adapter.confirmOrder(h.args)
  const retry = await h.adapter.confirmOrder(h.args)
  assert.equal(first.orderID, retry.orderID)
  assert.equal(h.calls.created, 1)
  assert.equal(h.state().stock, 8)
  assert.equal(h.state().orders.length, 1)
  assert.equal(h.calls.lock, 2)
})
test('signed succeeded webhook recovers a missed browser confirmation and replays without another order', async () => {
  const h = fixture(), handler = h.adapter.endpoints[0].handler
  assert.equal((await handler(h.webhookRequest())).status, 200)
  assert.equal((await handler(h.webhookRequest())).status, 200)
  assert.equal(h.state().transaction.status, 'succeeded')
  assert.equal(h.state().orders.length, 1)
  assert.equal(h.state().stock, 8)
})
test('rejects missing/malformed signatures and ignores foreign payments without mutating fixture records', async () => {
  const h = fixture(), handler = h.adapter.endpoints[0].handler
  assert.equal((await handler(h.webhookRequest(undefined, undefined, false))).status, 400)
  const bad = h.webhookRequest(); bad.headers.set('stripe-signature', 't=1,v1=bad')
  assert.equal((await handler(bad)).status, 400)
  const foreign = await handler(h.webhookRequest('payment_intent.succeeded', 'pi_foreign'))
  assert.equal(foreign.status, 200)
  assert.equal((await foreign.json()).ignored, 'foreign_payment')
  assert.equal(h.state().orders.length, 0)
  assert.equal(h.state().stock, 10)
})
test('rejects unpaid, live, amount, cart, customer, and item snapshot mismatches before an order', async () => {
  for (const failure of ['unpaid', 'live', 'amount', 'cart', 'customer', 'items']) {
    const h = fixture()
    if (failure === 'unpaid') h.intent.status = 'requires_payment_method'
    if (failure === 'live') h.intent.livemode = true
    if (failure === 'amount') h.intent.amount_received = 1
    if (failure === 'cart') h.intent.metadata.cartID = 'foreign-cart'
    if (failure === 'customer') h.intent.customer = 'cus_foreign'
    if (failure === 'items') h.intent.metadata.cartItemsSnapshot = JSON.stringify([{ product: 7, quantity: 3 }])
    await assert.rejects(h.adapter.confirmOrder(h.args))
    assert.equal(h.calls.created, 0)
    assert.equal(h.state().stock, 10)
  }
})
test('interrupted stock persistence rolls back order/payment together and permits one exact recovery', async () => {
  const h = fixture(); h.failStock()
  await assert.rejects(h.adapter.confirmOrder(h.args), /interrupted_stock_write/)
  assert.equal(h.state().orders.length, 0)
  assert.equal(h.state().transaction.status, 'pending')
  await h.adapter.confirmOrder(h.args)
  assert.equal(h.state().orders.length, 1)
  assert.equal(h.state().stock, 8)
  assert.equal(h.calls.rollbacks, 1)
})
test('stale failed event cannot overwrite a succeeded order', async () => {
  const h = fixture(); await h.adapter.confirmOrder(h.args)
  await h.adapter.endpoints[0].handler(h.webhookRequest('payment_intent.payment_failed'))
  assert.equal(h.state().transaction.status, 'succeeded')
  assert.equal(h.state().stock, 8)
})
test('replaces only the actual plugin confirm endpoint, preserving all other routes', async () => {
  const h = fixture(), original = async () => new Response('original')
  const plugin = withDemoStripeConfirmation(config => ({ ...config, endpoints: [
    { method: 'post', path: '/payments/stripe/confirm-order', handler: original },
    { method: 'post', path: '/payments/stripe/initiate', handler: original },
  ] }), h.adapter.confirmHandler)
  const configured = await plugin({ collections: [], secret: 'synthetic_fixture_only', db: postgresAdapter({ pool: { connectionString: 'postgresql://synthetic@localhost/demo' } }) })
  assert.equal(configured.endpoints?.[0].handler, h.adapter.confirmHandler)
  assert.equal(configured.endpoints?.[1].handler, original)
})

test('a fully refunded retained order does not settle or decrement again on a delayed succeeded event', async () => {
  const h = fixture(); await h.adapter.confirmOrder(h.args)
  h.state().transaction.status = 'refunded'
  assert.equal((await h.adapter.endpoints[0].handler(h.webhookRequest())).status, 200)
  assert.equal(h.state().transaction.status, 'refunded')
  assert.equal(h.state().stock, 8)
  assert.equal(h.state().orders.length, 1)
})
