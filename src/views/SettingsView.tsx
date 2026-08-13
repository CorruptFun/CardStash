import { useEffect, useState } from 'react'
import { Modal, Toggle } from '../components/basics'
import { Icon } from '../components/Icon'
import { clearAnalytics, insights, type Insights } from '../lib/analytics'
import { clearAllData } from '../lib/db'
import { seedDemoData } from '../lib/demo'
import { testGeminiKey } from '../lib/gemini'
import { clearScanCache } from '../lib/identify'
import { DEFAULT_GEMINI_MODEL, useSettings } from '../lib/settings'
import { relativeAge } from '../lib/util'
import { APP_VERSION } from '../lib/version'
import { useUi } from '../store/ui'

const INSIGHT_DAYS = 30

const ENGINE_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  ocr: 'OCR',
  cache: 'Cache',
  unknown: 'Other',
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
  const [showGeminiKey, setShowGeminiKey] = useState(false)
  const [showPokemonKey, setShowPokemonKey] = useState(false)
  const [showDiagToken, setShowDiagToken] = useState(false)
  const [confirmErase, setConfirmErase] = useState(false)
  const [testingKey, setTestingKey] = useState(false)
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

  const testKey = async () => {
    if (testingKey) return
    setTestingKey(true)
    const result = await testGeminiKey(config.geminiKey, config.geminiModel)
    setTestingKey(false)
    if (result.ok) toast(`Key works — answered by ${result.model}`, 'success')
    else toast(`Key test failed: ${result.error}`, 'error')
  }

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <h1>Settings</h1>
      </header>
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
        <p className="setsec__note">
          Scanning runs fully on this device: text recognition reads the card name and the collector line (so the exact
          edition autopopulates), and a pixel check spots foil sheen. No account or API key needed — the recognition
          engine downloads ~12 MB once and is cached for offline use.
        </p>
      </section>
      <section className="setsec">
        <h3>AI & API keys</h3>
        <p className="setsec__note">
          Keys are stored only on this device and sent only to their own service. The Gemini key powers the AI deck
          builder and nothing else — scanning never uses it. Only add one if you want AI-built decks:{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            get a free key here <Icon name="external" size={12} />
          </a>
          .
        </p>
        <div className="setfield">
          <label htmlFor="gemini-key">
            <span>Gemini API key</span>
            <KeyState set={!!config.geminiKey} />
          </label>
          <div className="setfield__row">
            <input
              id="gemini-key"
              name="gemini-api-key"
              className={`input ${showGeminiKey ? '' : 'input--masked'}`}
              type="text"
              value={config.geminiKey}
              placeholder="AIza…"
              onChange={(e) => config.set({ geminiKey: e.target.value.trim() })}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
            />
            <button className="iconbtn" onClick={() => setShowGeminiKey(!showGeminiKey)} aria-label="Show key" aria-pressed={showGeminiKey}>
              <Icon name="eye" size={17} />
            </button>
          </div>
          {config.geminiKey && (
            <button
              className="btn btn--ghost btn--sm setfield__test"
              onClick={() => {
                testKey()
              }}
              disabled={testingKey}
            >
              {testingKey ? 'Testing…' : 'Test key'}
            </button>
          )}
        </div>
        <div className="setfield">
          <label htmlFor="gemini-model">
            <span>Gemini model</span>
          </label>
          <input
            id="gemini-model"
            className="input"
            value={config.geminiModel}
            onChange={(e) => config.set({ geminiModel: e.target.value.trim() || DEFAULT_GEMINI_MODEL })}
          />
        </div>
        <div className="setfield">
          <label htmlFor="pokemon-key">
            <span>Pokémon TCG API key</span>
            <KeyState set={!!config.pokemonKey} />
          </label>
          <div className="setfield__row">
            <input
              id="pokemon-key"
              name="pokemon-tcg-api-key"
              className={`input ${showPokemonKey ? '' : 'input--masked'}`}
              type="text"
              value={config.pokemonKey}
              placeholder="from dev.pokemontcg.io"
              onChange={(e) => config.set({ pokemonKey: e.target.value.trim() })}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
            />
            <button
              className="iconbtn"
              onClick={() => setShowPokemonKey(!showPokemonKey)}
              aria-label="Show key"
              aria-pressed={showPokemonKey}
            >
              <Icon name="eye" size={17} />
            </button>
          </div>
          <em className="setfield__hint">Optional — raises the Pokémon rate limit.</em>
        </div>
      </section>
      <section className="setsec">
        <h3>Data</h3>
        <div className="setrow">
          <div className="setrow__text">
            <span>Demo data</span>
            <em>Load a sample collection + deck to explore the app</em>
          </div>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              seedDemoData().then(() => toast('Demo collection loaded', 'success'))
            }}
          >
            Load
          </button>
        </div>
        <div className="setrow">
          <div className="setrow__text">
            <span>Reset scanner cache</span>
            <em>Forget recently identified frames</em>
          </div>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              clearScanCache()
              toast('Scanner cache cleared', 'success')
            }}
          >
            Clear
          </button>
        </div>
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
          A private log of counts and timings kept on this device — hit rate, how long an identification took, which
          step missed, crashes as a hash rather than a message. Never card names, never search text, never your keys.
          Sharing is off by default; switch it on and the same anonymous log is posted to our own server.
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
          {config.diagShare && (
            <div className="diag__tile">
              <span className="diag__legend">Queued</span>
              <span className="num diag__fig">{(stats?.queued ?? 0).toLocaleString()}</span>
              <span className="diag__foot">{stats?.lastFlushAt ? `Sent ${relativeAge(stats.lastFlushAt)} ago` : 'Never sent'}</span>
            </div>
          )}
        </div>
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
        <div className="setrow">
          <div className="setrow__text">
            <span>Share diagnostics</span>
            <em>Upload the anonymous log so scanning gets better — needs an ingest token</em>
          </div>
          <Toggle on={config.diagShare} onChange={(diagShare) => config.set({ diagShare })} label="Share diagnostics" />
        </div>
        {config.diagShare && (
          <>
            <div className="setfield">
              <label htmlFor="diag-endpoint">
                <span>Ingest endpoint</span>
              </label>
              <input
                id="diag-endpoint"
                className="input"
                type="url"
                inputMode="url"
                value={config.diagEndpoint}
                onChange={(e) => config.set({ diagEndpoint: e.target.value.trim() })}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div className="setfield">
              <label htmlFor="diag-token">
                <span>Ingest token</span>
                <KeyState set={!!config.diagToken} noun="Token" />
              </label>
              <div className="setfield__row">
                <input
                  id="diag-token"
                  name="diagnostics-ingest-token"
                  className={`input ${showDiagToken ? '' : 'input--masked'}`}
                  type="text"
                  value={config.diagToken}
                  placeholder="paste the ingest token"
                  onChange={(e) => config.set({ diagToken: e.target.value.trim() })}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore=""
                  data-lpignore="true"
                  data-bwignore=""
                />
                <button
                  className="iconbtn"
                  onClick={() => setShowDiagToken(!showDiagToken)}
                  aria-label="Show token"
                  aria-pressed={showDiagToken}
                >
                  <Icon name="eye" size={17} />
                </button>
              </div>
              <em className="setfield__hint">Stored on this device like your API keys. Without a token nothing is ever sent.</em>
            </div>
          </>
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

function KeyState({ set, noun = 'Key' }: { set: boolean; noun?: string }) {
  return <span className={`setfield__state ${set ? 'setfield__state--on' : ''}`}>{set ? `${noun} set` : 'Not set'}</span>
}
