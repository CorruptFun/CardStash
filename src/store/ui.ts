import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { Card, CollectionItem, Game } from '../lib/types'

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
  origin?: 'scan' | 'search' | 'collection' | 'deck'
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
