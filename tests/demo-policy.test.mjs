import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertDemoStripeKeys, demoPaymentConfigured, paymentErrorCode } from '../src/utilities/demo-payment-policy.ts'

test('demo refuses live Stripe secret and publishable keys before payment adapter use', () => {
  assert.throws(() => assertDemoStripeKeys({ STRIPE_SECRET_KEY: 'sk_live_synthetic' }), /TEST secret/)
  assert.throws(() => assertDemoStripeKeys({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_synthetic' }), /TEST publishable/)
  assert.doesNotThrow(() => assertDemoStripeKeys({ STRIPE_SECRET_KEY: 'sk_test_synthetic', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic' }))
})
test('fictional catalog is substantial and internally consistent', async () => {
  const catalog = JSON.parse(await readFile(new URL('../scripts/demo-catalog.json', import.meta.url)))
  assert.equal(catalog.products.length, 20)
  assert.equal(catalog.categories.length, 6)
  assert.equal(new Set(catalog.products.map(product => product.slug)).size, 20)
  assert.equal(catalog.products.filter(product => product.enableVariants).length, 4)
  for (const product of catalog.products) {
    assert.ok(catalog.categories.includes(product.category))
    assert.ok(Number.isInteger(product.priceInUSD) && product.priceInUSD > 0)
    assert.ok(Number.isInteger(product.inventory) && product.inventory > 0)
    assert.match(product.description, /fictional/)
  }
})

test('missing TEST configuration stays unavailable and provider text errors remain recoverable', () => {
  assert.equal(demoPaymentConfigured({}), false)
  assert.equal(demoPaymentConfigured({ STRIPE_SECRET_KEY: 'sk_test_synthetic', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic' }), false)
  assert.equal(demoPaymentConfigured({ STRIPE_SECRET_KEY: 'sk_test_synthetic', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic', STRIPE_WEBHOOKS_SIGNING_SECRET: 'whsec_synthetic' }), true)
  assert.equal(paymentErrorCode('Network request failed'), undefined)
  assert.equal(paymentErrorCode('null'), undefined)
  assert.equal(paymentErrorCode('{"cause":{"code":"OutOfStock"}}'), 'OutOfStock')
})
