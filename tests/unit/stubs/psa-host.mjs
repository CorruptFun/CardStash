/**
 * Stands in for `./db` when unit-testing psa.ts. The cert cache is the only
 * thing the tested surface touches, and a miss is what these tests want.
 */
export const db = { cache: { toCollection: () => ({ primaryKeys: async () => [] }), bulkDelete: async () => {} } }
export async function kvGet() {
  return null
}
export async function kvPut() {}
