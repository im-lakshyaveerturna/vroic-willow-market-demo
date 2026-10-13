import 'dotenv/config'
import { getPayload, type Payload } from 'payload'
import config from '../src/payload.config'
import sharp from 'sharp'
import catalog from './demo-catalog.json'

if (process.env.DEMO_FIXTURE_DATABASE !== 'true') throw new Error('Explicit isolated demo database required')
if (!process.env.DEMO_ADMIN_PASSWORD || process.env.DEMO_ADMIN_PASSWORD.length < 24) throw new Error('Managed random demo admin password required')
const payload = await getPayload({ config })
const req = { context: { disableRevalidate: true } }
const richText = (text: string) => ({ root: { type: 'root', version: 1, direction: 'ltr' as const, format: '' as const, indent: 0, children: [{ type: 'paragraph', version: 1, direction: 'ltr' as const, format: '' as const, indent: 0, children: [{ type: 'text', version: 1, text, detail: 0, format: 0, mode: 'normal', style: '' }] }] } })
const find = async (collection: 'products' | 'categories' | 'pages' | 'media' | 'users', field: string, value: string) => (await payload.find({ collection, where: { [field]: { equals: value } }, limit: 1, depth: 0 })).docs[0]
// This seed is additive and refuses an unrelated catalog. It never clears collections or orders.
const existing = await payload.find({ collection: 'products', limit: 1, depth: 0 })
if (existing.docs.some(doc => !catalog.products.some(product => product.slug === doc.slug))) throw new Error('Unrelated catalog: refuse demo seeding')
if (!await find('users', 'email', 'operator@willow-market.example')) await payload.create({ collection: 'users', data: { email: 'operator@willow-market.example', name: 'Willow Demo Operator', roles: ['admin'], password: process.env.DEMO_ADMIN_PASSWORD } })
const categoryIDs = new Map<string, number>()
for (const title of catalog.categories) {
  const found = await find('categories', 'title', title)
  const item = found || await payload.create({ collection: 'categories', data: { title, slug: title.toLowerCase().replace(/ /g, '-') } })
  categoryIDs.set(title, Number(item.id))
}
let variantType = (await payload.find({ collection: 'variantTypes', where: { name: { equals: 'finish' } }, limit: 1 })).docs[0]
if (!variantType) variantType = await payload.create({ collection: 'variantTypes', data: { name: 'finish', label: 'Finish' } })
const options: Array<{ id: number; label: string; value: string }> = []
for (const [label, value] of [['Natural', 'natural'], ['Warm Oak', 'warm-oak'], ['Charcoal', 'charcoal']]) {
  const found = (await payload.find({ collection: 'variantOptions', where: { and: [{ value: { equals: value } }, { variantType: { equals: variantType.id } }] }, limit: 1 })).docs[0]
  const option = found || await payload.create({ collection: 'variantOptions', data: { label, value, variantType: variantType.id } })
  options.push({ id: Number(option.id), label, value })
}
const palette = ['#8d9b7c', '#b39572', '#8a8e8e', '#ac8b74', '#9d927b', '#a89378']
for (const [index, product] of catalog.products.entries()) {
  if (await find('products', 'slug', product.slug)) continue
  const filename = `${product.slug}.png`
  let image = await find('media', 'filename', filename)
  if (!image) {
    // Original generated artwork, kept local to the fixture; no third-party image requests.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#f2eee5"/><ellipse cx="600" cy="695" rx="320" ry="50" fill="#ded8cb"/><rect x="330" y="250" width="540" height="430" rx="${index % 2 ? 80 : 22}" fill="${palette[index % palette.length]}"/><rect x="380" y="300" width="440" height="325" rx="20" fill="none" stroke="#f2eee5" stroke-width="8"/><text x="600" y="775" text-anchor="middle" font-family="sans-serif" font-size="38" fill="#393d34">${product.title}</text><text x="600" y="830" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#6c7164">WILLOW MARKET · DEMO CATALOG</text></svg>`
    const data = await sharp(Buffer.from(svg)).png().toBuffer()
    image = await payload.create({ collection: 'media', data: { alt: `Original illustration of ${product.title}` }, file: { data, mimetype: 'image/png', name: filename, size: data.length } })
  }
  const created = await payload.create({ collection: 'products', context: req.context, data: { title: product.title, slug: product.slug, _status: 'published', description: richText(product.description), gallery: [{ image: image.id }], categories: [categoryIDs.get(product.category)!], priceInUSDEnabled: true, priceInUSD: product.priceInUSD, inventory: product.inventory, enableVariants: product.enableVariants, ...(product.enableVariants ? { variantTypes: [variantType.id] } : {}), layout: [] } })
  if (product.enableVariants) for (const option of options) await payload.create({ collection: 'variants', data: { product: created.id, options: [option.id], title: `${product.title} — ${option.label}`, priceInUSDEnabled: true, priceInUSD: product.priceInUSD, inventory: product.inventory } })
}
const pages = [
  ['home', 'Considered goods for everyday living', 'Welcome to Willow Market, a fictional full-stack shop for thoughtful desk, kitchen, textile and travel essentials. Browse twenty demo products with genuine backend catalog, variant, cart and order records. Every payment is Stripe TEST and no physical goods are shipped.'],
  ['about', 'Our story', 'Willow Market is an invented demonstration brand. We use considered everyday objects to exercise a substantial ecommerce application, including independent backend operations and storefront adoption.'],
  ['shipping', 'Shipping and delivery', 'This is a software demonstration. No physical items are dispatched. Any delivery state or shipping record created during qualification uses synthetic data and sandbox services.'],
  ['returns', 'Returns and refunds', 'Purchases use Stripe TEST only. Refunds and cancellations are synthetic qualification scenarios. No real financial or physical transaction occurs.'],
  ['privacy', 'Demo privacy', 'Use fictional data only. The demo stores catalog, cart and synthetic customer/order records in its isolated backend. Do not enter personal information.'],
  ['terms', 'Demo terms', 'Willow Market is provided solely as an ecommerce product qualification fixture. It is not a merchant accepting real orders, and every product is fictional.'],
  ['contact', 'Contact Willow Market', 'This demonstration has no external customer support recipient. Use your Vroic Task for qualification questions; do not submit personal or sensitive information.'],
] as const
for (const [slug, title, body] of pages) if (!await find('pages', 'slug', slug)) await payload.create({ collection: 'pages', context: req.context, data: { slug, title, _status: 'published', hero: { type: 'lowImpact', richText: richText(title), links: [{ link: { type: 'custom', url: '/search', label: 'Shop the demo catalog', appearance: 'default' } }] }, layout: [{ blockType: 'content', columns: [{ size: 'full', richText: richText(body) }] }] } })
await payload.updateGlobal({ slug: 'header', context: req.context, data: { navItems: [{ link: { type: 'custom', url: '/search', label: 'Shop' } }, { link: { type: 'custom', url: '/about', label: 'Our story' } }] } })
await payload.updateGlobal({ slug: 'footer', context: req.context, data: { navItems: pages.slice(1).map(([slug, title]) => ({ link: { type: 'custom' as const, url: `/${slug}`, label: title } })) } })
const counts = await Promise.all(['products', 'categories', 'variants', 'pages'].map(async collection => ({ collection, count: (await payload.count({ collection: collection as 'products' })).totalDocs })))
console.log(JSON.stringify({ fixture: 'Willow Market', counts, realCharges: 0, messagesSent: 0, destructiveChanges: 0 }))
await payload.destroy()
