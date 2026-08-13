import { useState } from 'react'
import { track } from '../lib/analytics'
import { downloadFile } from '../lib/csv'
import { LONG_LINK_CHARS } from '../lib/social'
import { useUi } from '../store/ui'
import { Icon } from './Icon'

/** Everything needed to hand a payload to a friend: link, file, share sheet. */
export interface SharePack {
  /** Full app link carrying the payload — opening it lands on the import screen. */
  url: string
  /** Pretty JSON file body (the same payload; import reads either). */
  fileText: string
  fileName: string
  /** Share-sheet title. */
  title: string
  /** Short human line sent along with the link. */
  text?: string
  kind: 'profile' | 'trade' | 'reply'
}

export function ShareActions({ pack }: { pack: SharePack }) {
  const toast = useUi((s) => s.toast)
  const [copied, setCopied] = useState(false)
  const longLink = pack.url.length > LONG_LINK_CHARS
  const canNative = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pack.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
      track('social_share', { kind: pack.kind, method: 'copy', chars: pack.url.length })
    } catch {
      toast('Could not copy the link', 'error')
    }
  }

  const native = async () => {
    const file = new File([pack.fileText], pack.fileName, { type: 'application/json' })
    try {
      // Big binders make absurd links — hand the share sheet a file instead.
      if (longLink && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: pack.title, files: [file] })
      } else {
        await navigator.share({ title: pack.title, text: pack.text, url: pack.url })
      }
      track('social_share', { kind: pack.kind, method: 'native', chars: pack.url.length })
    } catch (err: any) {
      if (err?.name !== 'AbortError') toast('Sharing failed — try Copy link or Save file', 'error')
    }
  }

  const save = () => {
    downloadFile(pack.fileName, pack.fileText, 'application/json')
    track('social_share', { kind: pack.kind, method: 'file', chars: pack.fileText.length })
  }

  return (
    <div className="shareacts">
      <div className="shareacts__btns">
        {canNative && (
          <button className="btn btn--primary" onClick={native}>
            <Icon name="share" size={16} /> Share
          </button>
        )}
        <button className={canNative ? 'btn btn--ghost' : 'btn btn--primary'} onClick={copy}>
          <Icon name={copied ? 'check' : 'link'} size={16} /> {copied ? 'Copied' : 'Copy link'}
        </button>
        <button className="btn btn--ghost" onClick={save}>
          <Icon name="download" size={16} /> Save file
        </button>
      </div>
      {longLink && (
        <p className="shareacts__hint">
          This link is huge ({Math.round(pack.url.length / 1000)}k characters) — chat apps may choke on it. Send the
          file instead, or host the file somewhere with a stable link (a GitHub Gist works) so friends can refresh from
          it.
        </p>
      )}
    </div>
  )
}
