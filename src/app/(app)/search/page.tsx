import { redirect } from 'next/navigation'

/** Preserve upstream and already-published catalog links, including search/filter queries. */
export default async function SearchRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach(item => query.append(name, item))
    else if (value !== undefined) query.set(name, value)
  }
  redirect(`/shop${query.size ? `?${query}` : ''}`)
}
