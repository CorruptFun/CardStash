import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Currency, Game } from './types'

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
const DEFAULT_DIAG_ENDPOINT = 'https://telemetry.corrupt.solutions/ingest/telemetry'

export interface Settings {
  gameFilter: Game | 'auto'
  currency: Currency
  /** Scan view: every confident hit is added to the collection. */
  collectMode: boolean
  haptics: boolean
  /** Powers the AI deck builder only — scanning is fully on-device. */
  geminiKey: string
  geminiModel: string
  pokemonKey: string
  diagShare: boolean
  diagEndpoint: string
  diagToken: string
  set: (patch: Partial<Settings>) => void
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      gameFilter: 'auto',
      currency: 'USD',
      collectMode: false,
      haptics: true,
      geminiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      pokemonKey: '',
      diagShare: false,
      diagEndpoint: DEFAULT_DIAG_ENDPOINT,
      diagToken: '',
      set: (patch) => set(patch),
    }),
    { name: 'cardstock-settings' },
  ),
)

export const settings = () => useSettings.getState()
