import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repairDemoShopLinks } from '../scripts/demo-link-repair.mjs'

test('upgrades only exact seeded CTA and preserves merchant changes and record identity', () => {
  const exact = { id: 'seed-cta', link: { type: 'custom', url: '/search', label: 'Shop' } }
  const custom = { id: 'merchant-cta', link: { type: 'custom', url: '/search', label: 'Merchant collection' } }
  const external = { link: { type: 'custom', url: 'https://example.com/search', label: 'Shop' } }
  const repaired = repairDemoShopLinks([exact, custom, external], 'Shop')
  assert.equal(repaired.changed, true)
  assert.equal(repaired.links[0].id, 'seed-cta')
  assert.equal(repaired.links[0].link.url, '/shop')
  assert.equal(repaired.links[1], custom)
  assert.equal(repaired.links[2], external)
  assert.deepEqual(repairDemoShopLinks(repaired.links, 'Shop'), { changed: false, links: repaired.links })
})
