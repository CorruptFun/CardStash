/**
 * Enough Dexie for db.ts to be *imported* in node, and no more.
 *
 * db.ts builds its schema at module scope — chained `version().stores()`,
 * `.upgrade()` on two of them, and `hook()` on the collection table — so a
 * stub that only answers `version()` is not enough to get through the import.
 * None of it is exercised: these tests pin the pure functions beside it.
 *
 * Tables are materialised from the names passed to `stores()`, the way Dexie
 * itself assigns them, so `db.<table>.hook()` resolves.
 */

class StubTable {
  hook() {}
}

export default class Dexie {
  constructor(name) {
    this.name = name
  }
  version() {
    const declare = (schema) => {
      for (const table of Object.keys(schema ?? {})) {
        if (!this[table]) this[table] = new StubTable()
      }
      // `.upgrade()` returns the version object again so chains keep working.
      return { stores: declare, upgrade: () => ({ stores: declare, upgrade: () => ({}) }) }
    }
    return { stores: declare, upgrade: () => ({ stores: declare, upgrade: () => ({}) }) }
  }
  transaction() {
    throw new Error('no transactions in node tests')
  }
}

export const Table = class {}
