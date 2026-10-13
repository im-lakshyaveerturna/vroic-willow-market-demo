/** Repair only the fixture's exact old CTA; unrelated merchant links are retained. */
export function repairDemoShopLinks(items, label) {
  let changed = false
  const links = items?.map(item => {
    if (item.link?.type !== 'custom' || item.link?.url !== '/search' || item.link?.label !== label) return item
    changed = true
    return { ...item, link: { ...item.link, url: '/shop' } }
  })
  return { changed, links }
}
