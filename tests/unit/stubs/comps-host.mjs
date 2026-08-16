/**
 * Stands in for `./db` when unit-testing ebaycomps.ts (and the sports module
 * it borrows its query terms from). The comp cache is all the tested surface
 * touches, and a miss is what these tests want.
 */
export const db = {
  cache: { toCollection: () => ({ primaryKeys: async () => [] }), bulkDelete: async () => {}, delete: async () => {} },
  collection: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
  scans: { orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
}
export async function kvGet() {
  return null
}
export async function kvPut() {}
