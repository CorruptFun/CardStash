import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Game, ShareScope } from './types'

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
const DEFAULT_DIAG_ENDPOINT = 'https://telemetry.corrupt.solutions/ingest/telemetry'

export interface Settings {
  gameFilter: Game | 'auto'
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
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      gameFilter: 'auto',
      collectMode: false,
      haptics: true,
      cameraApproved: false,
      iosCameraHintShown: false,
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
      syncUrl: '',
      syncOn: false,
      syncToken: '',
      syncCursor: 0,
      syncAt: 0,
      set: (patch) => set(patch),
    }),
    { name: 'cardstock-settings' },
  ),
)

export const settings = () => useSettings.getState()
