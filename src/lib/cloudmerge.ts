/**
 * Merging a remote vault into the local one.
 *
 * Sync is usually got wrong here rather than in the transport, so this is
 * pure: two `Backup`s in, one `Backup` out, no Dexie, no network, no clock.
 * `tests/unit/cloudmerge.test.mjs` holds it to the rules below.
 *
 * The rules, and why:
 *
 * - **Union, keyed by primary key.** Every table already has a stable id
 *   (`key` for wants), so a row that exists on one side only is kept. Last-
 *   write-wins over whole tables would silently discard a session's scanning
 *   done on the other device, which is the exact failure sync exists to stop.
 *
 * - **Per-row recency decides collisions**, using the field each table
 *   already carries — `addedAt` for collection rows, `updatedAt` for decks.
 *   Tables with no timestamp (deck cards, wants, friends, trades) take the
 *   remote row only when the remote vault as a whole is newer, so a stale
 *   device cannot roll back a fresher one.
 *
 * - **Quantities are NOT summed.** Two devices that both hold a row at qty 3
 *   describe the same three cards, not six. Summing turns every merge into
 *   silent inflation of the user's portfolio value.
 *
 * ## The deletion caveat, stated plainly
 *
 * A union cannot tell "deleted here" from "never existed here", so a row
 * deleted on device A reappears from device B's copy until B syncs. Fixing it
 * properly needs tombstones — a schema change and a real design, not a tweak
 * to this file. Until then the bias is deliberate: resurrecting a card the
 * user removed is recoverable in seconds; losing a shoebox they spent an
 * evening scanning is not. `docs/social.md` records this as a known gap.
 */

import type { Backup } from './db'

export interface MergeReport {
  /** Rows that existed only remotely and were adopted. */
  added: number
  /** Rows present on both sides where the remote copy won on recency. */
  updated: number
  /** Rows present on both sides where the local copy was kept. */
  kept: number
}

export interface MergeResult {
  merged: Backup
  report: MergeReport
}

/** How a row identifies itself. `history` has no id — its Dexie primary key
 * is the compound `[cardId+date]`, so it needs a composite. */
type KeyOf<T> = (row: T) => string

/** Row types are plain data interfaces without index signatures, so field
 * access for the generic merge goes through one narrow cast. */
function field(row: unknown, name: string): unknown {
  return (row as Record<string, unknown> | null)?.[name]
}

const byField =
  <T,>(name: string): KeyOf<T> =>
  (row) => {
    const id = field(row, name)
    return typeof id === 'string' ? id : ''
  }

/**
 * Merge one table. `recency` names a numeric field to compare per row; when a
 * table has none, `remoteWins` (the vault-level comparison) breaks the tie.
 * Positions are tracked in a map so a large collection merges in linear time.
 */
function mergeTable<T>(
  local: T[],
  remote: T[],
  keyOf: KeyOf<T>,
  recency: string | null,
  remoteWins: boolean,
  report: MergeReport,
): T[] {
  const out: T[] = []
  const at = new Map<string, number>()

  for (const row of local) {
    const id = keyOf(row)
    if (!id || at.has(id)) continue
    at.set(id, out.length)
    out.push(row)
  }

  for (const row of remote) {
    const id = keyOf(row)
    if (!id) continue
    const pos = at.get(id)
    if (pos === undefined) {
      at.set(id, out.length)
      out.push(row)
      report.added++
      continue
    }
    let takeRemote = remoteWins
    if (recency) {
      const mineAt = field(out[pos], recency)
      const rowAt = field(row, recency)
      const a = typeof mineAt === 'number' ? mineAt : 0
      const b = typeof rowAt === 'number' ? rowAt : 0
      // Strictly greater: an exact tie keeps the local row, so a merge that
      // changes nothing is a no-op rather than a rewrite.
      if (a !== b) takeRemote = b > a
    }
    if (takeRemote) {
      out[pos] = row
      report.updated++
    } else {
      report.kept++
    }
  }
  return out
}

function timeOf(backup: Backup): number {
  const parsed = Date.parse(backup?.exportedAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Merge a decrypted remote vault into the local backup. Neither input is
 * mutated. `remote` is untrusted — it has already been through
 * `sanitizeBackup` by the time it reaches here.
 */
export function mergeBackups(local: Backup, remote: Backup): MergeResult {
  const report: MergeReport = { added: 0, updated: 0, kept: 0 }
  const remoteWins = timeOf(remote) > timeOf(local)

  const merged: Backup = {
    ...local,
    exportedAt: new Date(Math.max(timeOf(local), timeOf(remote)) || Date.now()).toISOString(),
    collection: mergeTable(local.collection, remote.collection, byField('id'), 'addedAt', remoteWins, report),
    decks: mergeTable(local.decks, remote.decks, byField('id'), 'updatedAt', remoteWins, report),
    deckCards: mergeTable(local.deckCards, remote.deckCards, byField('id'), null, remoteWins, report),
    // Compound Dexie key, and a price point for a given day is the same fact
    // whichever device recorded it — newest vault wins on a disagreement.
    history: mergeTable(
      local.history,
      remote.history,
      (r) => `${r?.cardId ?? ''}|${r?.date ?? ''}`,
      null,
      remoteWins,
      report,
    ),
    friends: mergeTable(local.friends, remote.friends, byField('id'), 'addedAt', remoteWins, report),
    trades: mergeTable(local.trades, remote.trades, byField('id'), 'createdAt', remoteWins, report),
    wants: mergeTable(local.wants, remote.wants, byField('key'), 'addedAt', remoteWins, report),
    // A binder is a label the user renames in place, so `updatedAt` decides —
    // the device that last renamed it wins, whichever vault is newer overall.
    // Deleting one is the known union gap (see above): it comes back until
    // every device has seen the delete, and a stale label costs a tap.
    binders: mergeTable(local.binders ?? [], remote.binders ?? [], byField('id'), 'updatedAt', remoteWins, report),
    // One patch per card, keyed by the card it patches, and it carries its own
    // `updatedAt` — so the device that most recently corrected a card wins,
    // regardless of which vault is newer overall.
    patches: mergeTable(local.patches ?? [], remote.patches ?? [], byField('cardId'), 'updatedAt', remoteWins, report),
  }
  return { merged, report }
}
