import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { Card, CollectionItem, Finish, Game, GradeInfo, SharedCard } from '../lib/types'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastAction {
  label: string
  fn: () => void
}

export interface Toast {
  id: number
  text: string
  kind: ToastKind
  action?: ToastAction
}

/** What the card bottom-sheet was opened on. */
export interface SheetRequest {
  card: Card
  /** Present when opened from a collection row. */
  item?: CollectionItem
  /** Present when opened from inside a deck — the add bar targets that deck. */
  deckId?: string
  /** Preselect this finish in the add bar (scanner saw a foil sheen). */
  finish?: Finish
  /** Preselect this grade in the add bar (scanner read a slab label). */
  grade?: GradeInfo
  /**
   * The scan identified the card but never read its printed code, so the
   * edition on show is the source's default rather than the one in the hand.
   * The sheet says so instead of letting an arbitrary reprint's price pass
   * for the card's — see `pinned` in identify.ts.
   */
  printingUnconfirmed?: boolean
  origin?: 'scan' | 'search' | 'collection' | 'deck' | 'friend'
  /**
   * Whose copy this is, when the sheet was opened from a friend's binder — the
   * only context in which the card can be bought rather than merely admired.
   *
   * `origin: 'friend'` already existed but is not enough: it says the sheet came
   * from a binder, not WHOSE, and the sheet is handed a reconstructed `Card`
   * rather than the `SharedCard` it came from. Buying needs the account id to
   * pay and the row to price, so both travel explicitly. Absent this, the sheet
   * shows no Buy button at all, which is the correct default everywhere else.
   */
  seller?: {
    /** Their Supabase account id — a link-imported friend has none, and cannot be paid. */
    userId: string
    name: string
    /** Their published row: the price and the number they will part with. */
    row: SharedCard
  }
}

/** A conversation about to be opened, and what it is about. */
export interface MessageDraft {
  /** Their Supabase account id — the only thing a conversation is addressed to. */
  userId: string
  /** Their name, so the screen has a heading before any fetch comes back. */
  name?: string
  handle?: string
  /** The card being discussed, if the user came from one. */
  about?: SharedCard
  /** Suggested opening line, which the user is free to replace. */
  body?: string
}

export interface SearchPrefill {
  query: string
  game?: Game
}

/**
 * What the card editor was opened on.
 *
 * Two modes, and the difference is whether a card already exists: `card` is a
 * real card being corrected (usually one with no picture), while `create` is a
 * card that exists nowhere and is about to be described from scratch. The
 * editor writes a `CardPatch` either way — see `cardpatch.ts`.
 */
export interface EditorRequest {
  /** The card being corrected. Absent when creating one from nothing. */
  card?: Card
  /** Creating: which game the new card belongs to. */
  game?: Game
  /** Creating: what the scanner or the search box read, as a starting name. */
  name?: string
  /**
   * A picture to start from, already encoded by `cardimage.ts` — the frame a
   * scan just failed on. Handing it straight to the editor is the difference
   * between "we couldn't read that" and "here's the photo you just took, tell
   * us what it is".
   */
  image?: string
}

interface UiState {
  sheet: SheetRequest | null
  openSheet: (req: SheetRequest) => void
  closeSheet: () => void
  editor: EditorRequest | null
  openEditor: (req: EditorRequest) => void
  closeEditor: () => void
  toasts: Toast[]
  toast: (text: string, kind?: ToastKind, action?: ToastAction, ms?: number) => void
  dismissToast: (id: number) => void
  searchPrefill: SearchPrefill | null
  setSearchPrefill: (prefill: SearchPrefill | null) => void
  /** Cards handed to the AI builder to design around ("build around these"). */
  builderSeeds: Card[] | null
  setBuilderSeeds: (seeds: Card[] | null) => void
  /**
   * What a conversation should open with, handed over by whatever screen sent
   * the user there — the card sheet's "Ask about this card", a want match, a
   * friend's binder.
   *
   * Routed through the store rather than the URL for the same reason
   * `builderSeeds` is: a `SharedCard` in a hash fragment would be a share
   * payload in the one place `decodeShareText` is looking for one, and the
   * draft is worthless the moment the app is reloaded anyway.
   */
  messageDraft: MessageDraft | null
  setMessageDraft: (draft: MessageDraft | null) => void
}

let toastSeq = 1

/**
 * How long a toast waits before it leaves.
 *
 * An Undo is decided in about a second — the user either meant the add or
 * did not — so six seconds of a bar parked over the tab bar was read as the
 * app being stuck rather than as a grace period. Four is still four times
 * the decision, and a swipe or the × on the toast ends it sooner (Toasts.tsx).
 */
const ACTION_TOAST_MS = 4200
const PLAIN_TOAST_MS = 3200

export const uiStore = createStore<UiState>((set, get) => ({
  sheet: null,
  openSheet: (sheet) => set({ sheet }),
  closeSheet: () => set({ sheet: null }),
  editor: null,
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),
  toasts: [],
  toast: (text, kind = 'info', action, ms) => {
    const id = toastSeq++
    set({ toasts: [...get().toasts, { id, text, kind, action }] })
    setTimeout(() => get().dismissToast(id), ms ?? (action ? ACTION_TOAST_MS : PLAIN_TOAST_MS))
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
  searchPrefill: null,
  setSearchPrefill: (searchPrefill) => set({ searchPrefill }),
  builderSeeds: null,
  setBuilderSeeds: (builderSeeds) => set({ builderSeeds }),
  messageDraft: null,
  setMessageDraft: (messageDraft) => set({ messageDraft }),
}))

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(uiStore, selector)
}

/**
 * Run a DB write and surface failures as a toast instead of an unhandled
 * rejection — storage quota being the failure that actually happens on phones.
 */
/**
 * Every DB write from the UI comes through here, which makes it the one place
 * that can notice "something changed" without thirty call sites remembering to
 * say so. A successful write asks for a backup; `scheduleBackup()` debounces,
 * so scanning a whole binder produces one push rather than one per card, and it
 * is a no-op for signed-out users.
 */
export async function guarded<T>(work: () => Promise<T>, what = 'Save'): Promise<T | undefined> {
  try {
    const result = await work()
    void import('../lib/autobackup').then((m) => m.scheduleBackup()).catch(() => {})
    return result
  } catch (err: any) {
    const message = String(err?.message ?? err)
    const quota = err?.name === 'QuotaExceededError' || /quota/i.test(message)
    uiStore
      .getState()
      .toast(
        quota ? 'Storage is full — export a backup, then remove some cards' : `${what} failed — ${message.slice(0, 90)}`,
        'error',
      )
    return undefined
  }
}
