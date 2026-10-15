/**
 * Serializers mapping the imported Payload ecommerce records to the shared
 * commerce contract's output shapes. Underlying integer keys are exposed only
 * through the reversible public-id mapping in ./ids.
 */
import { toPublicId } from './ids'

type AnyDoc = Record<string, any>

const refId = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const id = (value as AnyDoc).id
    return typeof id === 'number' ? id : null
  }
  return typeof value === 'number' ? value : null
}

export function mediaOut(m: AnyDoc) {
  return {
    id: toPublicId(m.id),
    url: m.url ?? null,
    alt: m.alt ?? '',
    filename: m.filename ?? null,
    mime_type: m.mimeType ?? null,
    width: m.width ?? null,
    height: m.height ?? null,
    created_at: m.createdAt ?? null,
  }
}

export function collectionOut(c: AnyDoc) {
  return {
    id: toPublicId(c.id),
    title: c.title ?? '',
    slug: c.slug ?? '',
    description: null,
    active: true,
  }
}

export function productOut(p: AnyDoc, opts: { includeVariants?: boolean } = {}) {
  const gallery = Array.isArray(p.gallery) ? p.gallery : []
  const images = gallery
    .map((entry: AnyDoc) => (entry?.image && typeof entry.image === 'object' ? entry.image.url : null))
    .filter((url: unknown): url is string => typeof url === 'string')
  const categories = Array.isArray(p.categories) ? p.categories : []
  const category = categories.find((c: AnyDoc) => c && typeof c === 'object')
  const variants = Array.isArray(p.variants?.docs) ? p.variants.docs : undefined
  return {
    id: toPublicId(p.id),
    slug: p.slug ?? null,
    name: p.title ?? null,
    title: p.title ?? null,
    price_cents: typeof p.priceInUSD === 'number' ? p.priceInUSD : null,
    compare_at_cents: null,
    currency: 'USD',
    active: p._status === 'published',
    status: p._status ?? null,
    inventory: typeof p.inventory === 'number' ? p.inventory : 0,
    stock: typeof p.inventory === 'number' ? p.inventory : 0,
    featured: false,
    enable_variants: Boolean(p.enableVariants),
    category: category ? { id: toPublicId(category.id), title: category.title ?? null, slug: category.slug ?? null } : null,
    images,
    image_url: images[0] ?? null,
    created_at: p.createdAt ?? null,
    updated_at: p.updatedAt ?? null,
    ...(opts.includeVariants && variants
      ? {
          variants: variants.map((v: AnyDoc) => ({
            id: toPublicId(v.id),
            title: v.title ?? null,
            inventory: typeof v.inventory === 'number' ? v.inventory : 0,
            price_cents: typeof v.priceInUSD === 'number' ? v.priceInUSD : null,
          })),
        }
      : {}),
  }
}

export function customerOut(u: AnyDoc, opts: { addresses?: boolean } = {}) {
  const addresses = Array.isArray(u.addresses?.docs) ? u.addresses.docs : []
  return {
    id: toPublicId(u.id),
    name: u.name ?? null,
    email: u.email ?? null,
    roles: Array.isArray(u.roles) ? u.roles : [],
    created_at: u.createdAt ?? null,
    ...(opts.addresses
      ? {
          addresses: addresses.map((a: AnyDoc) => ({
            id: toPublicId(a.id),
            address_line1: a.addressLine1 ?? null,
            address_line2: a.addressLine2 ?? null,
            city: a.city ?? null,
            state: a.state ?? null,
            postal_code: a.postalCode ?? null,
            country: a.country ?? null,
          })),
        }
      : {}),
  }
}

export function cartOut(c: AnyDoc) {
  const items = Array.isArray(c.items) ? c.items : []
  return {
    id: toPublicId(c.id),
    customer_id: refId(c.customer) !== null ? toPublicId(refId(c.customer) as number) : null,
    status: c.status ?? null,
    currency: c.currency ?? 'USD',
    subtotal_cents: typeof c.subtotal === 'number' ? c.subtotal : null,
    purchased_at: c.purchasedAt ?? null,
    items: items.map((item: AnyDoc) => ({
      product_id: refId(item.product) !== null ? toPublicId(refId(item.product) as number) : null,
      variant_id: refId(item.variant) !== null ? toPublicId(refId(item.variant) as number) : null,
      quantity: item.quantity ?? 0,
    })),
    created_at: c.createdAt ?? null,
    updated_at: c.updatedAt ?? null,
  }
}

export function transactionOut(t: AnyDoc) {
  const orderId = refId(t.order)
  return {
    id: toPublicId(t.id),
    order_number: orderId !== null ? String(orderId) : null,
    status: t.status ?? null,
    amount_cents: typeof t.amount === 'number' ? t.amount : null,
    currency: t.currency ?? 'USD',
    provider: t.paymentMethod ?? null,
    provider_reference: t.stripe?.paymentIntentID ?? null,
    customer_id: refId(t.customer) !== null ? toPublicId(refId(t.customer) as number) : null,
    created_at: t.createdAt ?? null,
  }
}

export function orderOut(o: AnyDoc) {
  const items = Array.isArray(o.items) ? o.items : []
  const transactions = Array.isArray(o.transactions) ? o.transactions : []
  return {
    number: String(o.id),
    id: toPublicId(o.id),
    status: o.status ?? null,
    amount_cents: typeof o.amount === 'number' ? o.amount : null,
    currency: o.currency ?? 'USD',
    customer_id: refId(o.customer) !== null ? toPublicId(refId(o.customer) as number) : null,
    customer_email: o.customerEmail ?? null,
    shipping_address: o.shippingAddress ?? null,
    items: items.map((item: AnyDoc) => ({
      product_id: refId(item.product) !== null ? toPublicId(refId(item.product) as number) : null,
      variant_id: refId(item.variant) !== null ? toPublicId(refId(item.variant) as number) : null,
      quantity: item.quantity ?? 0,
    })),
    transactions: transactions.map((t: AnyDoc) =>
      t && typeof t === 'object'
        ? { id: toPublicId(t.id), status: t.status ?? null, provider_reference: t.stripe?.paymentIntentID ?? null }
        : { id: null, status: null, provider_reference: null },
    ),
    created_at: o.createdAt ?? null,
    updated_at: o.updatedAt ?? null,
  }
}

export function lexicalParagraph(text: string) {
  return {
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', text, version: 1 }],
          direction: 'ltr' as const,
          format: '' as const,
          indent: 0,
          version: 1,
        },
      ],
      direction: 'ltr' as const,
      format: '' as const,
      indent: 0,
      version: 1,
    },
  }
}

export function pagination(totalDocs: number, limit: number, offset: number) {
  return {
    total: totalDocs,
    limit,
    offset,
    has_more: offset + limit < totalDocs,
  }
}
