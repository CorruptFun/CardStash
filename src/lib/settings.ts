import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { GAMES } from './games'
import type { Game, ShareScope } from './types'

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'

/**
 * Is this device somewhere consent must be ASKED for rather than assumed?
 *
 * Read off the browser's own timezone — local, zero egress, no IP geolocation,
 * which matters because "where are you" must not itself become a network call
 * in a local-first app. It is a heuristic and deliberately a generous one: a
 * European timezone on a traveller's laptop costs us one opted-out install,
 * while the reverse mistake is a compliance problem.
 *
 * `Europe/*` covers the EEA and the UK together. Istanbul and Moscow fall in it
 * too and are outside both; that is the generous direction, so it stays.
 */
export function needsExplicitDiagConsent(): boolean {
  try {
    return /^Europe\//.test(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '')
  } catch {
    // No Intl, or a browser that will not say: assume the stricter regime.
    return true
  }
}

const defaultDiagShare = (): boolean => !needsExplicitDiagConsent()

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
  /** base64 KDF salt for the cloud vault — not secret, lets a returning
   * device re-derive its key without a round trip. */
  cloudSalt: string
  /** Non-secret fingerprint of the vault key, so a wrong passphrase is
   * caught before a large download. */
  cloudKeyCheck: string
  /** Server revision this device last saw; a stale one means merge first. */
  cloudRevision: number
  /** Last successful cloud sync. */
  cloudSyncedAt: number
  /** Sync after collection writes rather than only on demand. */
  cloudAuto: boolean
  /**
   * Powers the AI deck builder, and — only when `cloudScanRescue` is on — the
   * last-resort cloud read for a card the on-device pipeline could not identify.
   */
  geminiKey: string
  geminiModel: string
  /**
   * Send a frame the local pipeline FAILED on to Gemini, as a last resort.
   *
   * Off by default and useless without `geminiKey`, so the shipped default is
   * unchanged: scanning is on-device, works offline and on first launch, and no
   * image leaves the device. Turning this on is the user electing to send the
   * frames that already missed — never the ones that succeeded — to their own
   * API key. Two switches, deliberately: a key alone (set for the deck builder)
   * must not start uploading camera frames.
   */
  cloudScanRescue: boolean
  /**
   * Override the scan rescue's model. Empty = the pinned `CLOUD_SCAN_MODEL`,
   * which is deliberately NOT `geminiModel`: the deck builder and the scanner
   * want different models, and tuning one must not silently change the other's
   * cost per use.
   */
  cloudScanModel: string
  pokemonKey: string
  /**
   * May the anonymous log be posted. WHERE it goes is not a setting
   * (`diagconfig.ts`) — this is the only half of the question a user can
   * answer, so it is the only half stored.
   */
  diagShare: boolean
  /**
   * When the user was actually told, and 0 until they have been.
   *
   * Separate from `diagShare` because "on" and "answered" are different facts
   * and only the pair is honest. A fresh install starts on outside the EU/UK,
   * which is only defensible once the disclosure has been seen — so until this
   * is set, `flushTelemetry` holds everything. It is also the upgrade rail: an
   * install from before consent existed has a backlog collected under the old
   * off-by-default regime, and `noteDiagConsent()` buries that backlog rather
   * than shipping it retroactively.
   */
  diagConsentAt: number
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
  /**
   * First run has been dealt with — signed in, or explicitly skipped. 0 means
   * the welcome screen has never been answered. Not the same as being signed
   * in: someone who skips is onboarded and gets the nudge instead.
   */
  onboardedAt: number
  /**
   * Last time the "connect an account" nudge was shown. It returns every
   * three days until there is nothing left to connect.
   */
  accountNudgeAt: number
  /**
   * Hosted social is on: publish my binder, poll friends, drain the trade
   * inbox. Off (the default) means the app is exactly as social as it ever
   * was — links and files, nothing published anywhere.
   */
  socialOn: boolean
  /** My `@handle`, cached so the UI can render it without a round trip. */
  socialHandle: string
  /** Newest inbox row id already applied. */
  socialCursor: number
  /** Last successful social sync. */
  socialAt: number
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
      cloudSalt: '',
      cloudKeyCheck: '',
      cloudRevision: 0,
      cloudSyncedAt: 0,
      cloudAuto: true,
      geminiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      cloudScanRescue: false,
      cloudScanModel: '',
      pokemonKey: '',
      // On for a NEW install, and honest because `diagConsentAt` gates the
      // actual upload until the disclosure has been shown. In the EU/EEA/UK
      // `defaultDiagShare()` returns false instead — ePrivacy consent covers any
      // non-essential storage access, not just cookies, so opt-out is not
      // lawful there and the first-run copy asks rather than tells.
      diagShare: defaultDiagShare(),
      diagConsentAt: 0,
      profileId: '',
      profileName: '',
      profileNote: '',
      shareScope: 'trade',
      driveBackup: false,
      driveAt: 0,
      onboardedAt: 0,
      accountNudgeAt: 0,
      socialOn: false,
      socialHandle: '',
      socialCursor: 0,
      socialAt: 0,
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
        // An install from before consent existed must not be opted in by the
        // arrival of a new default. It collected its events under the old
        // off-by-default regime, so it stays off until it is asked — the
        // ConnectNudge-style disclosure sets both fields together.
        if (persisted && typeof (persisted as Partial<Settings>).diagConsentAt !== 'number') {
          merged.diagShare = false
          merged.diagConsentAt = 0
        }
        return merged
      },
    },
  ),
)

export const settings = () => useSettings.getState()
