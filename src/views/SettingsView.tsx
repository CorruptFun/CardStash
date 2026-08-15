import { useEffect, useState } from 'react'
import { Modal, Toggle } from '../components/basics'
import { Icon } from '../components/Icon'
import { clearAnalytics, insights, noteDiagConsent, type Insights } from '../lib/analytics'
import { DIAG_AVAILABLE } from '../lib/diagconfig'
import { clearAllData } from '../lib/db'
import { GAMES, GAME_LABEL, GAME_SHORT } from '../lib/games'
import { useSettings } from '../lib/settings'
import { relativeAge } from '../lib/util'
import { APP_VERSION } from '../lib/version'
import { CloudSync } from '../components/CloudSync'
import { useUi } from '../store/ui'

const INSIGHT_DAYS = 30

const ENGINE_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  ocr: 'OCR',
  cache: 'Cache',
  unknown: 'Other',
}

const STAGE_LABEL: Record<string, string> = {
  'no-text': 'Read nothing',
  'no-match': 'Read, no match',
  api: 'Network',
  unknown: 'Other',
}

const SCREEN_LABEL: Record<string, string> = {
  scan: 'Scan',
  search: 'Search',
  collection: 'Collection',
  decks: 'Decks',
  builder: 'AI builder',
  friends: 'Friends',
  trades: 'Trades',
  orders: 'Purchases',
  ingest: 'Shared link',
  settings: 'Settings',
}

const MISS_LABEL: Record<string, string> = {
  api: 'API error',
  'no-card': 'No card',
  'not-found': 'Not found',
  'ocr-miss': 'OCR miss',
  'cached-miss': 'Cached miss',
  unknown: 'Other',
}

export function SettingsView() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [confirmErase, setConfirmErase] = useState(false)
  const [stats, setStats] = useState<Insights | null>(null)
  const [statsEpoch, setStatsEpoch] = useState(0)

  useEffect(() => {
    let live = true
    insights(INSIGHT_DAYS).then((result) => {
      if (live) setStats(result)
    })
    return () => {
      live = false
    }
  }, [statsEpoch])

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <h1>Settings</h1>
      </header>
      <section className="setsec">
        <h3>Card games</h3>
        <p className="setsec__note">
          Pick the games you play. The rest disappear from search, scanning and deck building — and their card catalogs
          are never downloaded in the background. Cards you already own always stay in your collection.
        </p>
        <div className="gamegrid" role="group" aria-label="Games shown in the app">
          {GAMES.map((game) => {
            const on = config.enabledGames.includes(game)
            return (
              <button
                key={game}
                className={`gamepick ${on ? 'gamepick--on' : ''}`}
                aria-pressed={on}
                onClick={() => {
                  if (on && config.enabledGames.length === 1) {
                    toast('Keep at least one game on', 'info')
                    return
                  }
                  config.toggleGame(game)
                }}
              >
                <span className="gamepick__name">{GAME_LABEL[game]}</span>
                <em className="gamepick__code">{GAME_SHORT[game]}</em>
                <span className="gamepick__tick" aria-hidden="true">
                  <Icon name="check" size={13} />
                </span>
              </button>
            )
          })}
        </div>
      </section>
      <section className="setsec">
        <h3>Scanning</h3>
        <div className="setrow">
          <div className="setrow__text">
            <span>Collect mode</span>
            <em>Every confident scan is added to your collection automatically</em>
          </div>
          <Toggle on={config.collectMode} onChange={(collectMode) => config.set({ collectMode })} label="Collect mode" />
        </div>
        <div className="setrow">
          <div className="setrow__text">
            <span>Haptics</span>
            <em>Vibrate when a card locks</em>
          </div>
          <Toggle on={config.haptics} onChange={(haptics) => config.set({ haptics })} label="Haptics" />
        </div>
        <div className="setrow">
          <div className="setrow__text">
            <span>Cloud rescue</span>
            <em>
              Send a card this device can’t settle — or can’t tell which printing of — to be read in the cloud. One
              photo, only for that card; scans this device settles on its own never leave. Off by default.
            </em>
          </div>
          <Toggle
            on={config.cloudScanRescue}
            onChange={(cloudScanRescue) => config.set({ cloudScanRescue })}
            label="Cloud rescue"
          />
        </div>
        <p className="setsec__note">
          Scanning runs on this device: text recognition reads the card name and the collector line (so the exact
          edition autopopulates), and a pixel check spots foil sheen. No account or API key needed — the recognition
          engine downloads ~12 MB once and is cached for offline use.
          {config.cloudScanRescue
            ? ' Cloud rescue is on, so the cards this device can’t read — and the few it reads in a way known to be unreliable, including a card whose collector line never came through and whose set prints it in more than one frame — are sent as a single photo to be identified. It needs an account and a subscription; without one, scanning simply carries on locally.'
            : ' With cloud rescue off, no image ever leaves this device.'}
        </p>
      </section>
      <CloudSync />
      <section className="setsec">
        <h3>Data</h3>
        {/* Gone from here: "Demo data" and "Reset scanner cache". The first
            seeded a fake collection into a real one — a developer convenience
            sitting one tap away from a user's actual cards. The second cleared
            an in-memory array of 60 entries that a page reload empties anyway,
            so it never did anything a user could perceive. `?demo=1` still
            seeds demo data for the harnesses, which is where that belongs. */}
        <div className="setrow">
          <div className="setrow__text">
            <span>Erase everything</span>
            <em>Deletes collection, decks and history from this device</em>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => setConfirmErase(true)}>
            Erase…
          </button>
        </div>
        <p className="setsec__note">Tip: export a JSON backup from the Collection screen before erasing — it restores everything.</p>
      </section>
      <section className="setsec">
        <h3>Diagnostics</h3>
        <p className="setsec__note">
          A private log of counts and timings kept on this device — never card names, never search text, never your
          keys. Cards that fail to scan are recorded as a hash, so a card that defeats the scanner can be counted
          without storing what it was, and your collection size travels as a range rather than a number. Sharing is off
          by default.
        </p>
        <div className="diag__tiles">
          <div className="diag__tile">
            <span className="diag__legend">Scan hit rate</span>
            <span className="num diag__fig">{stats && stats.scans.attempts ? `${Math.round(stats.scans.successRate * 100)}%` : '—'}</span>
            <span className="diag__foot">
              {stats?.scans.attempts ?? 0} attempts · {INSIGHT_DAYS}d
            </span>
          </div>
          <div className="diag__tile">
            <span className="diag__legend">Events logged</span>
            <span className="num diag__fig">{(stats?.total ?? 0).toLocaleString()}</span>
            <span className="diag__foot">{stats?.oldestAt ? `Oldest ${relativeAge(stats.oldestAt)}` : 'Empty'}</span>
          </div>
          <div className="diag__tile">
            <span className="diag__legend">Visits</span>
            <span className="num diag__fig">{(stats?.usage.sessions ?? 0).toLocaleString()}</span>
            <span className="diag__foot">
              {stats?.firstSeen ? `Since ${relativeAge(stats.firstSeen)} · ${stats.activeDays}d active` : 'This is the first'}
            </span>
          </div>
          {config.diagShare && (
            <div className="diag__tile">
              <span className="diag__legend">Queued</span>
              <span className="num diag__fig">{(stats?.queued ?? 0).toLocaleString()}</span>
              <span className="diag__foot">{stats?.lastFlushAt ? `Sent ${relativeAge(stats.lastFlushAt)} ago` : 'Never sent'}</span>
            </div>
          )}
        </div>
        {/* Everything below is maintainer tooling: latency percentiles, miss
            reasons, the stage a scan died at, hashed repeat offenders, a screen
            histogram. It is genuinely useful — it is how scanning gets fixed —
            but a person cannot act on "ocr-miss 43%" or on a card called
            `a3f21b09`, and at full tilt it ran to eight hundred pixels of table
            in the middle of Settings. Folded away, not deleted. */}
        <details className="diagmore">
          <summary className="diagmore__head">Technical detail</summary>
        {stats && Object.keys(stats.scans.byEngine).length > 0 && (
          <div className="diag__table diag__table--engines">
            <div className="diag__row diag__row--head">
              <span>Engine</span>
              <span className="num">N</span>
              <span className="num">P50 ms</span>
              <span className="num">P95 ms</span>
            </div>
            {Object.entries(stats.scans.byEngine)
              .sort((a, b) => b[1].n - a[1].n)
              .map(([engine, row]) => (
                <div key={engine} className="diag__row">
                  <span className="diag__cell">{ENGINE_LABEL[engine] ?? engine}</span>
                  <span className="num">{row.n}</span>
                  <span className="num">{Math.round(row.p50)}</span>
                  <span className="num num--quiet">{Math.round(row.p95)}</span>
                </div>
              ))}
          </div>
        )}
        {stats && Object.keys(stats.scans.missReasons).length > 0 && (
          <div className="diag__table diag__table--misses">
            <div className="diag__row diag__row--head">
              <span>Miss reason</span>
              <span className="num">N</span>
              <span className="num">Share</span>
            </div>
            {Object.entries(stats.scans.missReasons)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <div key={reason} className="diag__row">
                  <span className="diag__cell">{MISS_LABEL[reason] ?? reason}</span>
                  <span className="num">{count}</span>
                  <span className="num num--quiet">{Math.round((count / Math.max(1, stats.scans.attempts)) * 100)}%</span>
                </div>
              ))}
          </div>
        )}
        {stats && stats.failures.total > 0 && (
          <div className="diag__table diag__table--stages">
            <div className="diag__row diag__row--head">
              <span>Where scans fail</span>
              <span className="num">N</span>
              <span className="num">Share</span>
            </div>
            {Object.entries(stats.failures.byStage)
              .sort((a, b) => b[1] - a[1])
              .map(([stage, count]) => (
                <div key={stage} className="diag__row">
                  <span className="diag__cell">{STAGE_LABEL[stage] ?? stage}</span>
                  <span className="num">{count}</span>
                  <span className="num num--quiet">{Math.round((count / stats.failures.total) * 100)}%</span>
                </div>
              ))}
          </div>
        )}
        {stats && stats.failures.cards.length > 0 && (
          <div className="diag__table diag__table--cards">
            <div className="diag__row diag__row--head">
              <span>Cards that keep failing</span>
              <span className="num">Game</span>
              <span className="num">N</span>
            </div>
            {stats.failures.cards.map((row) => (
              <div key={row.card} className="diag__row">
                <span className="diag__cell num num--quiet">{row.card}</span>
                <span className="num">{(GAME_SHORT as Record<string, string>)[row.game] ?? row.game}</span>
                <span className="num">{row.n}</span>
              </div>
            ))}
          </div>
        )}
        {stats && Object.keys(stats.usage.screens).length > 0 && (
          <div className="diag__table diag__table--screens">
            <div className="diag__row diag__row--head">
              <span>Screens opened</span>
              <span className="num">N</span>
              <span className="num">Share</span>
            </div>
            {Object.entries(stats.usage.screens)
              .sort((a, b) => b[1] - a[1])
              .map(([screen, count]) => (
                <div key={screen} className="diag__row">
                  <span className="diag__cell">{SCREEN_LABEL[screen] ?? screen}</span>
                  <span className="num">{count}</span>
                  <span className="num num--quiet">
                    {Math.round((count / Math.max(1, stats.counts.screen_view)) * 100)}%
                  </span>
                </div>
              ))}
          </div>
        )}
        </details>
        {stats && stats.total === 0 && (
          <p className="diag__empty">Nothing logged yet — scan a card or run a search and the numbers show up here.</p>
        )}
        <div className="setrow">
          <div className="setrow__text">
            <span>Clear diagnostics</span>
            <em>Deletes the local log — your collection is untouched</em>
          </div>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              clearAnalytics().then(() => {
                setStatsEpoch((n) => n + 1)
                toast('Diagnostics cleared', 'success')
              })
            }}
          >
            Clear
          </button>
        </div>
        {/* Only offered when the build has somewhere to post to. A switch that
            cannot succeed is worse than no switch — see diagconfig.ts. */}
        {DIAG_AVAILABLE && (
          <div className="setrow">
            <div className="setrow__text">
              <span>Share diagnostics</span>
              <em>Send the anonymous log so scanning gets better. Never card names, searches or keys.</em>
            </div>
            {/* Through `noteDiagConsent` rather than a bare `set`, so toggling
                it on here counts as being asked and buries anything collected
                before this moment. */}
            <Toggle
              on={config.diagShare}
              onChange={(diagShare) => void noteDiagConsent(diagShare)}
              label="Share diagnostics"
            />
          </div>
        )}
      </section>
      <section className="setsec setsec--about">
        <h3>About</h3>
        <p className="setabout">
          <span className="wordmark">Cardstock</span>
          <span className="setabout__ver">v{APP_VERSION}</span>
        </p>
        <p className="setsec__note">
          Point at any card, know what it's worth. Card data & prices (USD, US market): Scryfall (Magic),
          pokemontcg.io (Pokémon), YGOPRODeck (Yu-Gi-Oh!), Lorcast (Lorcana), and TCGplayer market data via TCGCSV
          (Riftbound, One Piece, Star Wars: Unlimited, Digimon, Gundam). Prices are market estimates from those
          services, refreshed on demand — always verify before big trades. Cardstock is unaffiliated with the
          publishers of any of these games.
        </p>
      </section>
      <Modal open={confirmErase} onClose={() => setConfirmErase(false)} title="Erase everything?">
        <p className="setsec__note">
          This deletes your collection, decks, price history and recent scans from this device. It cannot be undone — a
          JSON backup from the Collection screen is the only way back.
        </p>
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setConfirmErase(false)}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            onClick={() => {
              Promise.all([clearAllData(), clearAnalytics()]).then(() => {
                setConfirmErase(false)
                setStatsEpoch((n) => n + 1)
                toast('All local data erased', 'success')
              })
            }}
          >
            Erase everything
          </button>
        </div>
      </Modal>
    </div>
  )
}
