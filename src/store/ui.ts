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

export interface SearchPrefill {
  query: string
  game?: Game
}

interface UiState {
  sheet: SheetRequest | null
  openSheet: (req: SheetRequest) => void
  closeSheet: () => void
  toasts: Toast[]
  toast: (text: string, kind?: ToastKind, action?: ToastAction, ms?: number) => void
  dismissToast: (id: number) => void
  searchPrefill: SearchPrefill | null
  setSearchPrefill: (prefill: SearchPrefill | null) => void
  /** Cards handed to the AI builder to design around ("build around these"). */
  builderSeeds: Card[] | null
  setBuilderSeeds: (seeds: Card[] | null) => void
}

let toastSeq = 1

export const uiStore = createStore<UiState>((set, get) => ({
  sheet: null,
  openSheet: (sheet) => set({ sheet }),
  closeSheet: () => set({ sheet: null }),
  toasts: [],
  toast: (text, kind = 'info', action, ms) => {
    const id = toastSeq++
    set({ toasts: [...get().toasts, { id, text, kind, action }] })
    setTimeout(() => get().dismissToast(id), ms ?? (action ? 6000 : 3200))
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
  searchPrefill: null,
  setSearchPrefill: (searchPrefill) => set({ searchPrefill }),
  builderSeeds: null,
  setBuilderSeeds: (builderSeeds) => set({ builderSeeds }),
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
