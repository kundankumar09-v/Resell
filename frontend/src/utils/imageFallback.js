export const PRODUCT_FALLBACK_IMAGE =
  "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600' viewBox='0 0 600 600'%3E%3Cdefs%3E%3ClinearGradient id='bg' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23f8fafc'/%3E%3Cstop offset='100%25' stop-color='%23e2e8f0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='600' height='600' fill='url(%23bg)'/%3E%3Cg transform='translate(236, 220)' stroke='%2394a3b8' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Crect x='6' y='14' width='116' height='90' rx='14' ry='14' fill='%23ffffff' fill-opacity='0.6' stroke='%23cbd5e1'/%3E%3Ccircle cx='48' cy='48' r='14' stroke='%2394a3b8'/%3E%3Cpath d='M120 86l-28-30-40 44' stroke='%2394a3b8'/%3E%3Cpath d='M44 20l12-10h28l12 10' stroke='%2394a3b8'/%3E%3C/g%3E%3Ctext x='300' y='370' font-family='system-ui, -apple-system, sans-serif' font-size='17' font-weight='600' fill='%2364748b' text-anchor='middle'%3ENo image available%3C/text%3E%3C/svg%3E";

export const AVATAR_FALLBACK_IMAGE =
  "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23e2e8f0' rx='60'/%3E%3Cg transform='translate(36, 32)' stroke='%2394a3b8' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='M24 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z'/%3E%3Cpath d='M4 52v-4a16 16 0 0 1 16-16h8a16 16 0 0 1 16 16v4'/%3E%3C/g%3E%3C/svg%3E";

export function handleImageError(e, fallback = PRODUCT_FALLBACK_IMAGE) {
  if (e?.target && e.target.src !== fallback) {
    e.target.onerror = null;
    e.target.src = fallback;
  }
}

export function getProductImageUrl(product, fallback = PRODUCT_FALLBACK_IMAGE) {
  if (!product) return fallback;
  if (typeof product === 'string') return product;
  const primary = product.images?.find((img) => img?.isPrimary)?.url;
  const first = product.images?.[0]?.url;
  return primary || first || fallback;
}
