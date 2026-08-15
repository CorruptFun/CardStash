import { useEffect, useMemo, useRef, useState } from 'react'
import { Sheet } from './Sheet'
import { Icon } from './Icon'
import { Toggle } from './basics'
import { track } from '../lib/analytics'
import { cardImageFromFile, imageWeight } from '../lib/cardimage'
import {
  baseFields,
  customCard,
  customCardId,
  customPatch,
  fieldsDiff,
  fieldsFromCard,
  imageHash,
  isCustomCard,
  patchIsEmpty,
  unmergePatch,
} from '../lib/cardpatch'
import { cardSourceAvailable, cardSourceSharing, contributePatch, flagCardData } from '../lib/cardsource'
import { isSignedIn } from '../lib/authsession'
import { deletePatch, patchFor, savePatch } from '../lib/db'
import { GAME_LABEL } from '../lib/games'
import { useSettings } from '../lib/settings'
import type { CardFields, CardPatch, Game } from '../lib/types'
import { guarded, useUi } from '../store/ui'

/**
 * The editor for a card the catalogs got wrong or never had.
 *
 * Two jobs in one sheet, because to a user they are the same job — "this card
 * is not right, let me fix it":
 *
 *   * **Correct a card.** Attach the picture the catalog is missing, fix a set
 *     name, add the rules text nobody indexed. Saved as an overlay, so prices
 *     keep refreshing underneath it and one tap puts the original back.
 *   * **Create a card.** For a card in no catalog at all, the fields ARE the
 *     card: `cardpatch.ts` mints a stable id from what was typed and
 *     synthesizes a `Card` from it, priceless in the literal sense — there is
 *     no feed for a card nobody lists, and inventing a number would be worse
 *     than showing none.
 *
 * The share row is the one genuinely outward-facing control in this file, so
 * it says exactly what leaves the device and never appears when a build has no
 * project to send to.
 */

/** What the sheet asks for, in the order a person would fill it in. */
const FIELD_ROWS: { key: keyof CardFields; label: string; placeholder: string; long?: boolean }[] = [
  { key: 'name', label: 'Card name', placeholder: 'What the card is called' },
  { key: 'setName', label: 'Set', placeholder: 'Set or product name' },
  { key: 'setCode', label: 'Set code', placeholder: 'e.g. SV4' },
  { key: 'number', label: 'Number', placeholder: 'Collector number' },
  { key: 'rarity', label: 'Rarity', placeholder: 'e.g. Rare, Promo' },
  { key: 'releasedAt', label: 'Released', placeholder: 'YYYY or YYYY-MM-DD' },
  { key: 'typeLine', label: 'Type', placeholder: 'e.g. Creature — Elf Druid' },
  { key: 'subtext', label: 'Card text', placeholder: 'Rules or flavour text', long: true },
]

export function CardEditorHost() {
  const editor = useUi((s) => s.editor)
  const close = useUi((s) => s.closeEditor)
  return (
    <Sheet open={editor != null} onClose={close} tall>
      {editor && <CardEditor key={editor.card?.id ?? `new:${editor.game ?? ''}`} />}
    </Sheet>
  )
}

function CardEditor() {
  const request = useUi((s) => s.editor)!
  const close = useUi((s) => s.closeEditor)
  const toast = useUi((s) => s.toast)
  const openSheet = useUi((s) => s.openSheet)
  const shareOn = useSettings((s) => s.cardSourceShare)
  const setSettings = useSettings((s) => s.set)

  const card = request.card
  const creating = !card
  const game: Game = card?.game ?? request.game ?? 'mtg'
  const existing = card ? patchFor(card.id) : undefined

  const [fields, setFields] = useState<CardFields>(() => {
    if (card) return { ...fieldsFromCard(card), ...(existing?.fields ?? {}) }
    return request.name ? { name: request.name } : {}
  })
  const [image, setImage] = useState<string | undefined>(request.image ?? existing?.image ?? undefined)
  const [busy, setBusy] = useState(false)
  const [share, setShare] = useState(() => cardSourceSharing())
  const fileRef = useRef<HTMLInputElement | null>(null)

  /* The picture the card currently shows, so "Replace" is honest about what it
   * is replacing — the catalog's art, not an empty box. */
  const catalogImage = card?.imageLarge ?? card?.imageSmall
  const preview = image ?? (existing?.image ? undefined : catalogImage)

  const set = (key: keyof CardFields, value: string) => setFields((prev) => ({ ...prev, [key]: value }))

  const pickImage = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const encoded = await cardImageFromFile(file)
      setImage(encoded.dataUrl)
    } catch (err: any) {
      toast(err?.message?.slice(0, 90) ?? "That image couldn't be read", 'error')
    } finally {
      setBusy(false)
      // Let the same file be picked again after a cancel or a failure.
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /** What would be written — computed here so Save can refuse an empty edit. */
  const draft: CardPatch | null = useMemo(() => {
    if (creating) {
      const patch = customPatch(game, fields, image)
      return patch.fields.name ? patch : null
    }
    /* The card as the catalog gave it, with any existing patch lifted off —
     * so editing a card twice records the ORIGINAL as what undo restores,
     * rather than the user's own first attempt. */
    const base = existing ? unmergePatch(card!, existing) : card!
    const diff = fieldsDiff(base, fields)
    const patch: CardPatch = {
      cardId: card!.id,
      game: card!.game,
      image,
      imageHash: image ? imageHash(image) : undefined,
      fields: diff,
      // What undo will put back. Recorded from the card BEHIND any existing
      // patch, so editing twice does not make the first edit the "original".
      base: baseFields(base, diff),
      baseImage: base.imageSmall,
      baseImageLarge: base.imageLarge,
      // A custom card stays custom through an edit: its id was minted from the
      // fields, so dropping the flag would orphan it from its own patch.
      custom: isCustomCard(card!) || undefined,
      origin: 'local',
      updatedAt: Date.now(),
    }
    return patchIsEmpty(patch) ? null : patch
  }, [card, creating, existing, fields, game, image])

  const save = async () => {
    if (!draft) return
    setBusy(true)
    const saved = await guarded(() => savePatch(draft), 'Card details')
    if (saved === undefined) {
      setBusy(false)
      return
    }
    track('card_patch', { game, image: !!image, custom: !!draft.custom, creating })

    /**
     * A card created from nothing has no sheet behind this one to return to,
     * so the toast carries the way to it.
     *
     * Deliberately an action rather than opening the sheet automatically: both
     * live in the same `Sheet` host, which owns a history entry, and closing
     * one while opening the other makes the editor's unwind pop the sheet that
     * just opened. A tap happens after everything has settled, and leaves the
     * user in the search results they were already reading.
     */
    const open =
      creating && saved
        ? { label: 'Open', fn: () => openSheet({ card: customCard(saved.game, saved.fields, saved.image), origin: 'search' }) }
        : undefined

    if (share && saved) {
      try {
        await contributePatch(saved)
        toast('Saved, and shared with the card index', 'success', open)
      } catch (err: any) {
        // The local save already worked; only the contribution failed, and
        // saying so is more useful than a generic error over the whole action.
        toast(err?.message?.slice(0, 90) ?? "Saved here, but couldn't be shared", 'info', open)
      }
    } else {
      toast(creating ? 'Card added' : 'Card updated', 'success', open)
    }
    setBusy(false)
    close()
  }

  const revert = async () => {
    if (!card) return
    setBusy(true)
    await guarded(() => deletePatch(card.id), 'Card details')
    setBusy(false)
    toast('Your changes were removed', 'success')
    close()
  }

  const reportWrong = async () => {
    if (!card) return
    setBusy(true)
    await flagCardData(card.id).catch(() => {})
    setBusy(false)
    toast('Thanks — that picture will stop being shown here', 'success')
    close()
  }

  const fromCommunity = existing?.origin === 'community'
  const canShare = cardSourceAvailable()
  const newId = creating ? customCardId(game, fields) : card!.id

  useEffect(() => {
    // Turning the per-card switch on is also how someone opts in for good;
    // asking twice for the same permission is how a control gets ignored.
    if (share && !shareOn && isSignedIn()) setSettings({ cardSourceShare: true })
  }, [share, shareOn, setSettings])

  return (
    <div className="cardedit">
      <header className="cardedit__head">
        <h2>{creating ? 'Add a card' : 'Fix this card'}</h2>
        <p className="cardedit__sub">
          {creating
            ? `A ${GAME_LABEL[game]} card no catalog lists. What you type here becomes the card — it will have no prices, so set its value on the card itself.`
            : 'Your version is kept on top of the catalog, so prices keep updating and you can undo it any time.'}
        </p>
      </header>

      <section className="cardedit__art">
        <div className="cardedit__preview">
          {preview ? (
            <img src={preview} alt="" />
          ) : (
            <div className="cardedit__placeholder">
              <Icon name="camera" size={22} />
              <span>No picture yet</span>
            </div>
          )}
        </div>
        <div className="cardedit__artactions">
          <button className="btn btn--primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Icon name="camera" size={16} /> {image || catalogImage ? 'Replace picture' : 'Add a picture'}
          </button>
          {image && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => setImage(undefined)}>
              Remove
            </button>
          )}
          {image && <span className="cardedit__weight">{imageWeight(image)}</span>}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => pickImage(event.target.files?.[0] ?? undefined)}
          />
          <p className="cardedit__hint">
            Photograph the card flat, filling the frame. It is resized on this device and never leaves it unless you
            share it below.
          </p>
        </div>
      </section>

      <section className="cardedit__fields">
        {FIELD_ROWS.map((row) =>
          row.long ? (
            <label key={row.key} className="cardedit__row cardedit__row--long">
              <span>{row.label}</span>
              <textarea
                rows={3}
                value={fields[row.key] ?? ''}
                placeholder={row.placeholder}
                onChange={(event) => set(row.key, event.target.value)}
              />
            </label>
          ) : (
            <label key={row.key} className="cardedit__row">
              <span>{row.label}</span>
              <input
                type="text"
                value={fields[row.key] ?? ''}
                placeholder={row.placeholder}
                autoComplete="off"
                onChange={(event) => set(row.key, event.target.value)}
              />
            </label>
          ),
        )}
        {creating && (
          <p className="cardedit__id">
            Saved as <code>{newId}</code>
          </p>
        )}
      </section>

      {canShare && (
        <section className="cardedit__share">
          <div className="cardedit__sharerow">
            <div>
              <strong>Share this with other collectors</strong>
              <p>
                Sends the picture and details to Cardstock's card index, so the next person scanning this card sees it
                too. Your name and collection are not included.
              </p>
            </div>
            <Toggle on={share} onChange={setShare} label="Share this card's details" />
          </div>
          {share && !isSignedIn() && <p className="cardedit__warn">Sign in first — contributions are attributed so bad ones can be removed.</p>}
        </section>
      )}

      {fromCommunity && (
        <section className="cardedit__community">
          <p>This picture came from another collector.</p>
          <button className="btn btn--ghost" disabled={busy} onClick={reportWrong}>
            <Icon name="alert" size={15} /> It's the wrong card
          </button>
        </section>
      )}

      <footer className="cardedit__foot">
        {existing && !creating && (
          <button className="btn btn--ghost" disabled={busy} onClick={revert}>
            Undo my changes
          </button>
        )}
        <button className="btn btn--primary btn--wide" disabled={busy || !draft} onClick={save}>
          {creating ? 'Add card' : 'Save'}
        </button>
      </footer>
    </div>
  )
}
