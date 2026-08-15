import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { Card, CollectionItem, Finish, Game } from '../lib/types'

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
  origin?: 'scan' | 'search' | 'collection' | 'deck' | 'friend'
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
}))

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(uiStore, selector)
}

/**
 * Run a DB write and surface failures as a toast instead of an unhandled
 * rejection — storage quota being the failure that actually happens on phones.
 */
export async function guarded<T>(work: () => Promise<T>, what = 'Save'): Promise<T | undefined> {
  try {
    return await work()
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
