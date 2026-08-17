import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { GAMES } from './games'
import { sanitizeSocialLinks } from './profilelinks'
import type { Game, ShareScope, SocialLink } from './types'

/**
 * Our pokemontcg.io key, compiled in. Optional: without one the app uses the
 * anonymous rate limit, which is what every user had anyway when this was a
 * Settings field nobody filled in.
 */
const POKEMON_KEY: string = ((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_POKEMON_KEY ?? ''


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
  /**
   * Send a frame the local pipeline FAILED on to be read in the cloud, as a
   * last resort.
   *
   * OFF BY DEFAULT on a free account, and it stays a switch even though the
   * key is now ours. Being signed in is not consent — but buying the
   * subscription is read as asking for the rescue, because the rescue is the
   * thing being bought: the first time this device sees an active
   * entitlement, `noteEntitlementSeen()` (billing.ts) switches this on, once,
   * and stamps `rescueAutoOnAt`. The switch still gates the IMAGE where
   * entitlement gates the BILL: turned off, nothing is uploaded, subscriber
   * or not, and no later entitlement check flips it back. Leave it off and
   * the promise is unchanged — scanning is on-device, works offline and on
   * first launch, and no image ever leaves. On, it elects to send only the
   * frames that already missed, never the ones that succeeded.
   */
  cloudScanRescue: boolean
  /**
   * Override the scan rescue's model. Empty = the pinned `CLOUD_SCAN_MODEL`.
   * No UI writes this; it survives as a local escape hatch for debugging a bad
   * model, and the hosted route pins its own model server-side regardless —
   * a client-chosen model is a client-chosen bill.
   */
  cloudScanModel: string
  /**
   * When a subscription first switched the rescue on for THIS device — 0
   * until one has. One-shot by design: `noteEntitlementSeen()` flips
   * `cloudScanRescue` the first time an active entitlement is seen and never
   * again, so a subscriber who then turns the rescue off has answered, and no
   * renewal, re-fetch or later sign-in overrules them. Per-device like every
   * setting — a second phone auto-enables once too, then obeys its own switch
   * — and deliberately NOT cleared on sign-out: this device has had its one
   * flip, whoever caused it.
   */
  rescueAutoOnAt: number
  /**
   * pokemontcg.io key. NOT user-editable any more — there is no field, and the
   * value comes from the build (`VITE_POKEMON_KEY`), the same way the PSA token
   * does. It stays on this object rather than becoming a bare import because
   * some twenty call sites already thread it through as a parameter, and
   * changing its SOURCE is a one-line edit where changing its SHAPE is not.
   */
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
  /**
   * Social accounts shown beside the shared binder, as icons a friend can tap.
   *
   * Stored here rather than on the hosted `profiles` row on purpose: these are
   * contact details, so they ride the BINDER and inherit its audience (see
   * `lib/profilelinks.ts`). That also keeps them working with no account at
   * all — they travel in a `#/x?d=…` link like the note beside them.
   */
  profileLinks: SocialLink[]
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
  /**
   * Unread messages across every conversation, cached so the nav badge is
   * right on the first frame after a cold launch instead of appearing two
   * seconds in. A cache of a server fact like `socialHandle`, never the
   * authority — every poll overwrites it, and signing out clears it.
   */
  messageUnread: number
  /**
   * The `@handle` whose link brought this install here, or ''.
   *
   * Written once, at boot, from the URL — and never overwritten, because
   * `claim_referral()` records one referrer per account for ever and a later
   * link would leave the app crediting someone the server does not.
   *
   * It is stored rather than read where it is needed because sign-in destroys
   * the URL it arrived in: the Google route returns to `origin + pathname` with
   * the query string and the fragment both gone (see `lib/referral.ts`).
   */
  referralFrom: string
  /**
   * When the server last gave a FINAL answer about that referral — recorded or
   * refused, both final. 0 means it has not been asked yet, and is the only
   * thing stopping `claim_referral()` being re-sent on every launch for the
   * rest of the install's life. Cleared on sign-out, because the next account
   * on this device has its own referral to redeem.
   */
  referralAt: number
  /**
   * May the app ask the shared card index about cards that have NO picture
   * (`cardsource.ts`)?
   *
   * On by default, and the reasoning is worth stating because the vault and
   * hosted social both default off. Those publish the user's own data; this
   * asks a question about a card id and gets a picture back — the same class
   * of request the app already makes to Scryfall and TCGplayer on every
   * search, aimed at our own project instead of theirs. It fires ONLY for
   * cards that have no image at all, never as a background sweep, and never
   * carries the session token (see rule 1 in cardsource.ts).
   */
  cardSourceLookup: boolean
  /**
   * May the pictures and details the user fills in be contributed back?
   *
   * OFF by default, and this is the switch that matters. A photo of a card is
   * a photo the user took, in their room, on their table; publishing it is a
   * decision. Same split as `socialConfigured()` vs `socialPublishing()` —
   * benefiting from the index and feeding it are separate acts, and the editor
   * asks again per card on top of this.
   */
  cardSourceShare: boolean
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
      cloudScanRescue: false,
      cloudScanModel: '',
      rescueAutoOnAt: 0,
      pokemonKey: POKEMON_KEY,
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
      profileLinks: [],
      shareScope: 'trade',
      driveBackup: false,
      driveAt: 0,
      onboardedAt: 0,
      accountNudgeAt: 0,
      socialOn: false,
      socialHandle: '',
      socialCursor: 0,
      socialAt: 0,
      messageUnread: 0,
      referralFrom: '',
      referralAt: 0,
      cardSourceLookup: true,
      cardSourceShare: false,
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
        // Build config, never the stored copy: an install that persisted an
        // empty key back when this was a text field must still pick up ours.
        merged.pokemonKey = POKEMON_KEY
        // localStorage is editable by anyone with devtools, and this list ends
        // up as `<a href>`s in other people's apps. Rehydration is the door,
        // so it gets the same sanitizer a pasted link does.
        merged.profileLinks = sanitizeSocialLinks(merged.profileLinks) ?? []
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
