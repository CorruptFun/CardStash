import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { GAMES } from './games'
import type { Game } from './types'

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
  /** Powers the AI deck builder only — scanning is fully on-device. */
  geminiKey: string
  geminiModel: string
  pokemonKey: string
  diagShare: boolean
  diagEndpoint: string
  diagToken: string
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
      geminiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      pokemonKey: '',
      diagShare: false,
      diagEndpoint: DEFAULT_DIAG_ENDPOINT,
      diagToken: '',
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
