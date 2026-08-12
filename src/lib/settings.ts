import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Game } from './types'

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
const DEFAULT_DIAG_ENDPOINT = 'https://telemetry.corrupt.solutions/ingest/telemetry'

export interface Settings {
  gameFilter: Game | 'auto'
  /** Scan view: every confident hit is added to the collection. */
  collectMode: boolean
  haptics: boolean
  geminiKey: string
  geminiModel: string
  pokemonKey: string
  ocrFallback: boolean
  diagShare: boolean
  diagEndpoint: string
  diagToken: string
  set: (patch: Partial<Settings>) => void
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      gameFilter: 'auto',
      collectMode: false,
      haptics: true,
      geminiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      pokemonKey: '',
      ocrFallback: true,
      diagShare: false,
      diagEndpoint: DEFAULT_DIAG_ENDPOINT,
      diagToken: '',
      set: (patch) => set(patch),
    }),
    { name: 'cardstock-settings' },
  ),
)

export const settings = () => useSettings.getState()
