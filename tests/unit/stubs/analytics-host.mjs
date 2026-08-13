/**
 * Stands in for the two browser-shaped modules analytics.ts pulls in at import
 * time: Dexie (node has no IndexedDB) and the zustand settings store (no
 * localStorage). Neither is exercised here — these tests pin the module's pure
 * rules, which are the ones the content-free contract rests on.
 */

export default class Dexie {
  constructor(name) {
    this.name = name
  }
  version() {
    return { stores: () => ({}) }
  }
}

export function settings() {
  return { diagShare: false, diagEndpoint: '', diagToken: '', gameFilter: 'auto', enabledGames: [] }
}
