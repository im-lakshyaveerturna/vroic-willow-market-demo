import { Grid } from '@/components/Grid'
import { ProductGridItem } from '@/components/ProductGridItem'
import configPromise from '@payload-config'
import { getPayload } from 'payload'
import React from 'react'
import Link from 'next/link'

export const metadata = {
  description: 'Search for products in the store.',
  title: 'Shop',
}

type SearchParams = { [key: string]: string | string[] | undefined }

type Props = {
  searchParams: Promise<SearchParams>
}

export default async function ShopPage({ searchParams }: Props) {
  const params = await searchParams
  const { q: searchValue, sort, category } = params
  const pageInput = typeof params.page === 'string' ? Number(params.page) : 1
  const page = Number.isSafeInteger(pageInput) && pageInput > 0 ? pageInput : 1
  const payload = await getPayload({ config: configPromise })

  const products = await payload.find({
    collection: 'products',
    draft: false,
    limit: 12,
    page,
    overrideAccess: false,
    select: {
      title: true,
      slug: true,
      gallery: true,
      categories: true,
      priceInUSD: true,
    },
    ...(sort ? { sort } : { sort: 'title' }),
    ...(searchValue || category
      ? {
          where: {
            and: [
              {
                _status: {
                  equals: 'published',
                },
              },
              ...(searchValue
                ? [
                    {
                      or: [
                        {
                          title: {
                            like: searchValue,
                          },
                        },
                        {
                          description: {
                            like: searchValue,
                          },
                        },
                      ],
                    },
                  ]
                : []),
              ...(category
                ? [
                    {
                      categories: {
                        contains: category,
                      },
                    },
                  ]
                : []),
            ],
          },
        }
      : {}),
  })

  const pageHref = (page: number) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (key === 'page' || value === undefined) continue
      if (Array.isArray(value)) value.forEach(item => query.append(key, item))
      else query.set(key, value)
    }
    query.set('page', String(page))
    return `/shop?${query}`
  }

  const resultsText = products.docs.length > 1 ? 'results' : 'result'

  return (
    <div>
      {searchValue ? (
        <p className="mb-4">
          {products.docs?.length === 0
            ? 'There are no products that match '
            : `Showing ${products.docs.length} ${resultsText} for `}
          <span className="font-bold">&quot;{searchValue}&quot;</span>
        </p>
      ) : null}

      {!searchValue && products.docs?.length === 0 && (
        <p className="mb-4">No products found. Please try different filters.</p>
      )}

      {products?.docs.length > 0 ? (
        <Grid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {products.docs.map((product) => {
            return <ProductGridItem key={product.id} product={product} />
          })}
        </Grid>
      ) : null}
      {products.totalPages > 1 && (
        <nav aria-label="Catalog pages" className="mt-8 flex items-center justify-between gap-4">
          {products.hasPrevPage ? <Link href={pageHref(products.prevPage!)}>Previous page</Link> : <span />}
          <span>Page {products.page} of {products.totalPages} · {products.totalDocs} products</span>
          {products.hasNextPage ? <Link href={pageHref(products.nextPage!)}>Next page</Link> : <span />}
        </nav>
      )}
    </div>
  )
}
