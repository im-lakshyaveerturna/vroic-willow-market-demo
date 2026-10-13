import { createHash } from 'node:crypto'
import Stripe from 'stripe'
import { sql } from '@payloadcms/db-postgres'
import { addDataAndFileToRequest, type PayloadRequest, type Plugin } from 'payload'
import { stripeAdapter } from '@payloadcms/plugin-ecommerce/payments/stripe'
import type { PaymentAdapter } from '@payloadcms/plugin-ecommerce/types'

type AdapterOptions = Parameters<typeof stripeAdapter>[0]
type ConfirmArgs = Parameters<PaymentAdapter['confirmOrder']>[0]
const idOf = (value: number | { id: number } | null | undefined) => typeof value === 'object' ? value?.id : value

/** Keep the upstream order/transaction mechanism, with one atomic TEST settlement per exact PI. */
export function demoStripeAdapter(options: AdapterOptions, stripe = options.secretKey?.startsWith('sk_test_') ? new Stripe(options.secretKey) : undefined, base: PaymentAdapter = stripeAdapter(options)) {
  const findTransaction = async (req: PayloadRequest, paymentIntentID: string) => {
    const result = await req.payload.find({ collection: 'transactions', depth: 0, limit: 2,
      where: { 'stripe.paymentIntentID': { equals: paymentIntentID } }, req })
    if (result.docs.length > 1) throw new Error('Ambiguous owned payment transaction')
    if (result.docs.length !== 1 || result.docs[0].paymentMethod !== 'stripe') return null
    return result.docs[0]
  }
  const settle = async (args: ConfirmArgs, fromWebhook = false) => {
    if (!stripe) throw new Error('Stripe TEST setup required')
    const paymentIntentID = args.data.paymentIntentID
    if (typeof paymentIntentID !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentID)) throw new Error('Payment intent required')
    const { payload } = args.req
    const lockKey = BigInt(`0x${createHash('sha256').update(paymentIntentID).digest('hex').slice(0, 15)}`).toString()
    let transactionID: string | number | null = null
    try {
      transactionID = await payload.db.beginTransaction()
      if (transactionID === null) throw new Error('Atomic settlement transaction required')
      const database = payload.db.sessions?.[transactionID]?.db as { execute(statement: unknown): Promise<unknown> } | undefined
      if (!database || typeof database.execute !== 'function') throw new Error('Postgres transaction session required')
      await database.execute(sql`SET LOCAL lock_timeout = '15s'`)
      await database.execute(sql`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`)
      const req = { ...args.req, transactionID } as PayloadRequest
      const transaction = await findTransaction(req, paymentIntentID)
      if (!transaction) throw new Error('Owned transaction required')
      const intent = await stripe.paymentIntents.retrieve(paymentIntentID)
      const snapshot = JSON.parse(intent.metadata.cartItemsSnapshot || 'null')
      const items = (values: typeof transaction.items) => values?.map(item => ({ product: idOf(item.product), variant: idOf(item.variant) || null, quantity: item.quantity }))
      if (!Array.isArray(snapshot) || JSON.stringify(items(snapshot)) !== JSON.stringify(items(transaction.items))) throw new Error('Retained cart snapshot mismatch')
      if (intent.livemode || intent.status !== 'succeeded' || intent.amount_received !== transaction.amount ||
          intent.amount !== transaction.amount || intent.currency.toUpperCase() !== transaction.currency ||
          String(idOf(transaction.cart)) !== intent.metadata.cartID ||
          (typeof intent.customer === 'string' ? intent.customer : intent.customer?.id) !== transaction.stripe?.customerID)
        throw new Error('Verified TEST payment does not match the owned transaction')
      const customerId = idOf(transaction.customer)
      const customer = customerId ? await payload.findByID({ collection: 'users', id: customerId, req, depth: 0 }) : null
      const email = transaction.customerEmail || customer?.email
      if (!email || (!fromWebhook && (customerId ? args.req.user?.id !== customerId : args.data.customerEmail !== email)))
        throw new Error('Payment customer does not match')
      const priorOrderId = idOf(transaction.order)
      if (priorOrderId) {
        const order = await payload.findByID({ collection: 'orders', id: priorOrderId, req, depth: 0 })
        if (!['succeeded', 'refunded'].includes(transaction.status) || order.amount !== transaction.amount || order.currency !== transaction.currency ||
            !order.transactions?.some(value => idOf(value) === transaction.id)) throw new Error('Settlement recovery mismatch')
        await payload.db.commitTransaction(transactionID)
        transactionID = null
        return { message: 'Existing verified TEST order recovered', transactionStatus: transaction.status, orderID: order.id, transactionID: transaction.id, accessToken: order.accessToken }
      }
      if (transaction.status !== 'pending') throw new Error('Transaction is not available for settlement')
      const result = await base.confirmOrder({ ...args, req, data: { ...args.data, customerEmail: email } })
      // The upstream public handler decrements again on each retry. Own this once,
      // in the same Payload transaction as its genuine order/cart/payment records.
      for (const item of transaction.items || []) {
        const variantId = idOf(item.variant), productId = idOf(item.product)
        const collection = variantId ? 'variants' : 'products'
        const id = variantId || productId
        if (!id || !Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new Error('Invalid retained cart item')
        await payload.db.updateOne({ collection, id, data: { inventory: { $inc: -item.quantity } }, req })
      }
      if (customerId) await payload.update({ collection: 'orders', id: result.orderID, req, data: { customer: customerId, customerEmail: null } })
      await payload.db.commitTransaction(transactionID)
      transactionID = null
      return result
    } catch (error) {
      if (transactionID !== null) await payload.db.rollbackTransaction(transactionID)
      throw error
    }
  }
  const confirmHandler = async (req: PayloadRequest) => {
    await addDataAndFileToRequest(req)
    const data = req.data || {}
    if (typeof data.paymentIntentID !== 'string') return Response.json({ error: 'payment_intent_required' }, { status: 400 })
    const transaction = await findTransaction(req, data.paymentIntentID)
    if (!transaction?.cart) return Response.json({ error: 'owned_transaction_required' }, { status: 400 })
    // Preserve upstream customer/guest cart access, including the actual guest secret.
    req.query = { ...req.query, ...(typeof data.secret === 'string' ? { secret: data.secret } : {}) }
    try {
      await req.payload.findByID({ collection: 'carts', id: idOf(transaction.cart)!, overrideAccess: false, req })
      const result = await settle({ req, data })
      return Response.json(result)
    } catch {
      return Response.json({ error: 'test_payment_confirmation_failed' }, { status: 409 })
    }
  }
  const webhook = async (req: PayloadRequest) => {
    if (!stripe || !options.webhookSecret || !req.text) return Response.json({ error: 'test_webhook_not_configured' }, { status: 503 })
    const signature = req.headers.get('stripe-signature')
    if (!signature) return Response.json({ error: 'stripe_signature_required' }, { status: 400 })
    let event: Stripe.Event
    try { event = stripe.webhooks.constructEvent(await req.text(), signature, options.webhookSecret) }
    catch { return Response.json({ error: 'stripe_signature_invalid' }, { status: 400 }) }
    if (event.livemode) return Response.json({ error: 'test_event_required' }, { status: 400 })
    if (!['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded'].includes(event.type))
      return Response.json({ received: true, ignored: 'unsupported_event' })
    const object = event.data.object as Stripe.PaymentIntent | Stripe.Charge
    const paymentIntentID = event.type === 'charge.refunded' ? (object as Stripe.Charge).payment_intent : object.id
    if (typeof paymentIntentID !== 'string') return Response.json({ received: true, ignored: 'foreign_payment' })
    const transaction = await findTransaction(req, paymentIntentID)
    if (!transaction) return Response.json({ received: true, ignored: 'foreign_payment' })
    try {
      if (event.type === 'payment_intent.succeeded') await settle({ req, data: { paymentIntentID } }, true)
      else {
        const lockKey = BigInt(`0x${createHash('sha256').update(paymentIntentID).digest('hex').slice(0, 15)}`).toString()
        let transactionID: string | number | null = null
        try {
          transactionID = await req.payload.db.beginTransaction()
          if (transactionID === null) throw new Error('Atomic reconciliation required')
          const database = req.payload.db.sessions?.[transactionID]?.db as { execute(statement: unknown): Promise<unknown> } | undefined
          if (!database || typeof database.execute !== 'function') throw new Error('Postgres transaction session required')
          await database.execute(sql`SET LOCAL lock_timeout = '15s'`)
          await database.execute(sql`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`)
          const lockedReq = { ...req, transactionID } as PayloadRequest
          const current = await findTransaction(lockedReq, paymentIntentID)
          if (!current) throw new Error('Owned transaction disappeared')
          // A delayed failure cannot overwrite a concurrently committed paid order.
          const intent = await stripe.paymentIntents.retrieve(paymentIntentID)
          if (intent.livemode || intent.amount !== current.amount || intent.currency.toUpperCase() !== current.currency ||
              intent.metadata.cartID !== String(idOf(current.cart)) ||
              (typeof intent.customer === 'string' ? intent.customer : intent.customer?.id) !== current.stripe?.customerID) throw new Error('Owned payment mismatch')
          if (current.status === 'pending' && intent.status === 'canceled')
            await req.payload.update({ collection: 'transactions', id: current.id, data: { status: 'cancelled' }, req: lockedReq })
          // Partial refunds remain succeeded; require the authoritative fully refunded charge.
          if (event.type === 'charge.refunded') {
            const charge = await stripe.charges.retrieve(object.id)
            if (current.status === 'succeeded' && charge.payment_intent === paymentIntentID && !charge.livemode && charge.refunded && charge.amount_refunded === current.amount)
              await req.payload.update({ collection: 'transactions', id: current.id, data: { status: 'refunded' }, req: lockedReq })
          }
          await req.payload.db.commitTransaction(transactionID)
          transactionID = null
        } catch (error) {
          if (transactionID !== null) await req.payload.db.rollbackTransaction(transactionID)
          throw error
        }
      }
      return Response.json({ received: true, matched: true })
    } catch {
      return Response.json({ error: 'test_webhook_reconciliation_failed' }, { status: 500 })
    }
  }
  return { ...base, confirmOrder: (args: ConfirmArgs) => settle(args), confirmHandler,
    endpoints: [{ method: 'post' as const, path: '/webhooks', handler: webhook }] }
}

/** Replace the upstream confirm endpoint, preserving its backend collections and all other routes. */
export function withDemoStripeConfirmation(plugin: Plugin, handler: (req: PayloadRequest) => Promise<Response>): Plugin {
  return async config => {
    const result = await plugin(config)
    result.endpoints = result.endpoints?.map(endpoint => endpoint.path === '/payments/stripe/confirm-order' ? { ...endpoint, handler } : endpoint)
    return result
  }
}
