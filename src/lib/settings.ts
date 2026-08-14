import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { GAMES } from './games'
import type { Game, ShareScope } from './types'

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
const DEFAULT_DIAG_ENDPOINT = 'https://telemetry.corrupt.solutions/ingest/telemetry'

export interface Settings {
  gameFilter: Game | 'auto'
  /**
   * The games this user plays. Everything else disappears from search, scan
   * and deck pickers, and its catalog is never downloaded. Kept in GAMES
   * order and never empty; `gameFilter` always stays inside this list.
   * Collection/deck data of a turned-off game remains untouched and visible.
   */
  enabledGames: Game[]
  /** Scan view: every confident hit is added to the collection. */
  collectMode: boolean
  haptics: boolean
  /**
   * The camera has been approved here before — skip the start gate and open
   * it silently on the next launch (cleared again if the browser revokes).
   */
  cameraApproved: boolean
  /**
   * The one-time iOS camera-permission note has been shown (Safari tab: allow
   * permanently via aA → Website Settings; Home-Screen app: iOS re-asks each
   * launch and nothing can persist it). The OS prompt itself is by design and
   * no app flag can suppress it.
   */
  iosCameraHintShown: boolean
  /**
   * The "install this to keep your collection" banner has been dismissed.
   * Separate from actually installing: a user who dismisses it is never
   * asked again, but `IS_STANDALONE` suppresses the banner regardless, so
   * installing by any other route also ends it.
   */
  installHintDismissed: boolean
  /** Powers the AI deck builder only — scanning is fully on-device. */
  geminiKey: string
  geminiModel: string
  pokemonKey: string
  diagShare: boolean
  diagEndpoint: string
  diagToken: string
  /** Stable id this device shares binders/trades under — minted on first share. */
  profileId: string
  /** Display name on shared binders and trade proposals. */
  profileName: string
  /** Short blurb on the shared binder ("DM @rae on Discord to trade"). */
  profileNote: string
  /** What a profile share includes: the trade binder, or the whole collection. */
  shareScope: ShareScope
  /**
   * Backup to the user's own Google Drive is switched on. No token lives here:
   * the access token is memory-only and re-minted silently (see lib/drive.ts),
   * so this flag plus a live Google session is the whole persisted state.
   */
  driveBackup: boolean
  /** Last successful Drive backup, epoch ms. 0 = never. */
  driveAt: number
  /** Optional sync server origin; empty = link-sharing only (the default). */
  syncUrl: string
  syncOn: boolean
  /** Proves this device owns its profile id on the sync server. */
  syncToken: string
  /** Newest inbox item already applied, as a server timestamp. */
  syncCursor: number
  /** Last successful sync. */
  syncAt: number
  set: (patch: Partial<Settings>) => void
  toggleGame: (game: Game) => void
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      gameFilter: 'auto',
      enabledGames: [...GAMES],
      collectMode: false,
      haptics: true,
      cameraApproved: false,
      iosCameraHintShown: false,
      installHintDismissed: false,
      geminiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      pokemonKey: '',
      diagShare: false,
      diagEndpoint: DEFAULT_DIAG_ENDPOINT,
      diagToken: '',
      profileId: '',
      profileName: '',
      profileNote: '',
      shareScope: 'trade',
      driveBackup: false,
      driveAt: 0,
      syncUrl: '',
      syncOn: false,
      syncToken: '',
      syncCursor: 0,
      syncAt: 0,
      set: (patch) => set(patch),
      toggleGame: (game) =>
        set((state) => {
          const turningOff = state.enabledGames.includes(game)
          const enabledGames = GAMES.filter((g) => (g === game ? !turningOff : state.enabledGames.includes(g)))
          // Never empty — the settings UI blocks turning off the last game.
          if (!enabledGames.length) return {}
          const patch: Partial<Settings> = { enabledGames }
          if (turningOff && state.gameFilter === game) patch.gameFilter = 'auto'
          return patch
        }),
    }),
    {
      name: 'cardstock-settings',
      // Sanitize what rehydrates: installs predating enabledGames get the
      // full list, stored lists drop games this build doesn't know, and a
      // gameFilter pointing outside the list falls back to auto.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<Settings> | undefined) }
        const stored = Array.isArray(merged.enabledGames) ? merged.enabledGames : GAMES
        merged.enabledGames = GAMES.filter((game) => stored.includes(game))
        if (!merged.enabledGames.length) merged.enabledGames = [...GAMES]
        if (merged.gameFilter !== 'auto' && !merged.enabledGames.includes(merged.gameFilter)) merged.gameFilter = 'auto'
        return merged
      },
    },
  ),
)

export const settings = () => useSettings.getState()
