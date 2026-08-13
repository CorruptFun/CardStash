import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { track } from '../lib/analytics'
import { db } from '../lib/db'
import { useSettings } from '../lib/settings'
import {
  checkSyncServer,
  fetchDirectory,
  followFromServer,
  resetSyncState,
  syncNow,
  type DirectoryEntry,
} from '../lib/sync'
import { relativeAge } from '../lib/util'
import { useUi } from '../store/ui'
import { Icon } from './Icon'

/**
 * Live sync against a self-hosted server. Off by default — the app works
 * exactly as before without it, and turning it off returns you to links.
 */
export function SyncPanel() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const friends = useLiveQuery(() => db.friends.toArray(), [])
  const [address, setAddress] = useState(config.syncUrl)
  const [busy, setBusy] = useState<'connect' | 'sync' | null>(null)
  const [directory, setDirectory] = useState<DirectoryEntry[] | null>(null)

  const on = config.syncOn && !!config.syncUrl

  const loadDirectory = useCallback(() => {
    if (!config.syncOn || !config.syncUrl) return
    fetchDirectory().then(setDirectory, () => setDirectory(null))
  }, [config.syncOn, config.syncUrl])

  useEffect(() => {
    loadDirectory()
  }, [loadDirectory, config.syncAt])

  const connect = async () => {
    if (!config.profileName.trim()) {
      toast('Add your name first — it labels your binder on the server', 'error')
      return
    }
    setBusy('connect')
    try {
      const health = await checkSyncServer(address)
      resetSyncState()
      config.set({ syncOn: true })
      const summary = await syncNow(true)
      track('sync_run', { published: summary.published, friends: summary.friendsUpdated, connect: true })
      toast(`Connected — ${health.binders} ${health.binders === 1 ? 'binder' : 'binders'} on this server`, 'success')
      loadDirectory()
    } catch (err: any) {
      toast(err?.message ?? 'Could not connect', 'error')
    } finally {
      setBusy(null)
    }
  }

  const disconnect = () => {
    config.set({ syncOn: false })
    resetSyncState()
    setDirectory(null)
    toast('Live sync off — sharing by link still works', 'info')
  }

  const runSync = async () => {
    setBusy('sync')
    try {
      const summary = await syncNow(true)
      const parts: string[] = []
      if (summary.published) parts.push('binder published')
      if (summary.friendsUpdated) parts.push(`${summary.friendsUpdated} updated`)
      if (summary.tradesReceived) parts.push(`${summary.tradesReceived} new trade${summary.tradesReceived === 1 ? '' : 's'}`)
      if (summary.repliesApplied) parts.push(`${summary.repliesApplied} repl${summary.repliesApplied === 1 ? 'y' : 'ies'}`)
      toast(parts.length ? `Synced — ${parts.join(' · ')}` : 'Synced — nothing new', 'success')
      loadDirectory()
    } catch (err: any) {
      toast(err?.message ?? 'Sync failed', 'error')
    } finally {
      setBusy(null)
    }
  }

  const follow = async (entry: DirectoryEntry) => {
    try {
      const payload = await followFromServer(entry.id)
      track('friend_added', { method: 'sync', cards: payload.cards.length, update: false })
      toast(`Following ${payload.name}`, 'success')
      location.hash = `#/friends/${payload.id}`
    } catch (err: any) {
      toast(err?.message ?? 'Could not follow that binder', 'error')
    }
  }

  const followedIds = new Set((friends ?? []).map((friend) => friend.id))
  const others = (directory ?? []).filter((entry) => entry.id !== config.profileId && !followedIds.has(entry.id))

  return (
    <div className="syncpanel">
      <div className="syncpanel__row">
        <input
          className="input"
          type="url"
          inputMode="url"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !on) connect()
          }}
          placeholder="http://192.168.1.20:8787"
          aria-label="Sync server address"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={on}
        />
        {on ? (
          <button className="btn btn--ghost" onClick={disconnect}>
            Disconnect
          </button>
        ) : (
          <button className="btn btn--primary" onClick={connect} disabled={busy === 'connect' || !address.trim()}>
            {busy === 'connect' ? 'Checking…' : 'Connect'}
          </button>
        )}
      </div>

      {on ? (
        <>
          <div className="syncstate">
            <span className="syncstate__dot" />
            <span className="syncstate__text">
              Live · {config.syncAt ? `synced ${relativeAge(config.syncAt)} ago` : 'first sync running'}
              {directory ? ` · ${directory.length} ${directory.length === 1 ? 'collector' : 'collectors'} here` : ''}
            </span>
            <button className="btn btn--ghost btn--sm" onClick={runSync} disabled={busy === 'sync'}>
              <Icon name="refresh" size={14} className={busy === 'sync' ? 'spin' : ''} /> Sync now
            </button>
          </div>
          {others.length > 0 && (
            <div className="syncdir">
              <span className="syncdir__label">On this server</span>
              {others.map((entry) => (
                <button key={entry.id} className="syncdir__row" onClick={() => follow(entry)}>
                  <span className="social-row__avatar" aria-hidden="true">
                    {entry.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="social-row__body">
                    <span className="social-row__name">{entry.name}</span>
                    <span className="social-row__meta">
                      {entry.cards} cards · updated {relativeAge(entry.updatedAt)} ago
                    </span>
                  </span>
                  <span className="btn btn--ghost btn--sm">Follow</span>
                </button>
              ))}
            </div>
          )}
          <p className="setsec__note">
            Your binder republishes automatically and friends’ binders refresh every few seconds while the app is
            open. Trades and replies go straight to their inbox — no links to paste.
          </p>
        </>
      ) : (
        <p className="setsec__note">
          Optional. Run <code>npm run sync</code> on a computer, then paste the address it prints — everyone on the
          same wi-fi who enters it sees each other’s binders update live, and trades arrive without links. Leave this
          empty and nothing changes: sharing stays link-only.
        </p>
      )}
    </div>
  )
}
