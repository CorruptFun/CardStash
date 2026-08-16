import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardImg, Empty, Modal } from '../components/basics'
import { Icon } from '../components/Icon'
import {
  MESSAGE_MAX_CHARS,
  listThreads,
  loadMessages,
  markThreadRead,
  messagingReady,
  refreshUnread,
  sendMessage,
  setThreadBlocked,
  type ChatMessage,
  type ChatThread,
} from '../lib/messaging'
import { conditionFactor } from '../lib/prices'
import { sharedCardToCard } from '../lib/social'
import { lookupProfileById, type SocialProfile } from '../lib/socialcloud'
import { currentUserId } from '../lib/authsession'
import type { SharedCard } from '../lib/types'
import { money, relativeAge } from '../lib/util'
import { useUi } from '../store/ui'

/**
 * Conversations, and one conversation.
 *
 * ROUTED BY THE OTHER PERSON, not by the thread. `#/messages/<their account
 * id>` opens the conversation with them whether or not one exists yet, so
 * "message this collector" is the same link from a binder, a card sheet and a
 * want match, and there is no separate new-thread state to get out of step
 * with the real one. The thread id is a server detail and stays one.
 *
 * Nothing here is stored locally (see `lib/messaging.ts`): a conversation is a
 * shared fact, and a copy in Dexie would ride the backup file the user hands
 * around. So these screens fetch, and they say so when they cannot.
 */
export function MessagesView({ otherId }: { otherId: string | null }) {
  return otherId ? <ThreadScreen key={otherId} otherId={otherId} /> : <ThreadList />
}

/* --------------------------------------------------------------- the list */

function ThreadList() {
  const [threads, setThreads] = useState<ChatThread[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    if (!messagingReady()) {
      setThreads([])
      return
    }
    refreshUnread().then(
      (rows) => live && setThreads(rows),
      () => live && (setThreads([]), setFailed(true)),
    )
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <a className="iconbtn" href="#/friends" aria-label="Back to friends">
          <Icon name="chevronLeft" size={20} />
        </a>
        <h1>Messages</h1>
      </header>
      {!messagingReady() && (
        <Empty
          icon="message"
          title="Messages need an account"
          body="Claim a handle on the Friends screen and collectors can reach you about the cards you have up for trade — and you can reach them."
        />
      )}
      {messagingReady() && threads?.length === 0 && (
        <Empty
          icon="message"
          title={failed ? 'Could not load your messages' : 'No conversations yet'}
          body={
            failed
              ? 'You may be offline. Nothing has been lost — messages live on the server, not on this device.'
              : 'Open a friend’s binder, or a card on your want list that someone is offering, and ask them about it.'
          }
        />
      )}
      <div className="social-list">
        {(threads ?? []).map((thread) => (
          <a className="social-row" key={thread.id} href={`#/messages/${thread.otherId}`}>
            <span
              className={`social-row__avatar ${thread.unread ? 'social-row__avatar--hot' : ''}`}
              aria-hidden="true"
            >
              {thread.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="social-row__body">
              <span className="social-row__name">
                {thread.displayName}
                {thread.unread > 0 && <em className="social-row__match">{thread.unread} new</em>}
              </span>
              <span className="social-row__meta">
                <span className="handle">@{thread.handle}</span> · {relativeAge(thread.lastAt)} ago
              </span>
              {/* The preview is the server's `last_preview`, so the list costs
                  one query rather than one per conversation. */}
              <span className="threadrow__preview">{thread.lastPreview}</span>
            </span>
            <Icon name="chevronRight" size={16} className="social-row__go" />
          </a>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- one thread */

/** How often an open conversation asks for anything new. */
const THREAD_POLL_MS = 10_000

function ThreadScreen({ otherId }: { otherId: string }) {
  const draft = useUi((s) => s.messageDraft)
  const setDraft = useUi((s) => s.setMessageDraft)
  const toast = useUi((s) => s.toast)
  const me = currentUserId()

  const [thread, setThread] = useState<ChatThread | null>(null)
  const [profile, setProfile] = useState<SocialProfile | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [about, setAbout] = useState<SharedCard | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [confirmBlock, setConfirmBlock] = useState(false)
  const bottom = useRef<HTMLDivElement | null>(null)

  /**
   * The draft is consumed once and cleared, so going back and returning to a
   * conversation does not re-attach a card the user already sent or deleted.
   */
  useEffect(() => {
    if (!draft || draft.userId !== otherId) return
    setAbout(draft.about)
    setText((current) => current || draft.body || '')
    setDraft(null)
  }, [draft, otherId, setDraft])

  const drafted = draft?.userId === otherId ? draft : null
  const title = profile?.displayName ?? drafted?.name ?? 'Collector'
  const handle = profile?.handle ?? drafted?.handle ?? ''

  /**
   * Find the thread with this person among my conversations rather than
   * asking for it by id: the route carries a person, and a conversation that
   * does not exist yet is the ordinary first case, not an error.
   */
  const sync = useCallback(async () => {
    const rows = await listThreads()
    const mine = rows.find((row) => row.otherId === otherId) ?? null
    setThread(mine)
    if (!mine) {
      setMessages([])
      return
    }
    const page = await loadMessages(mine.id)
    setMessages(page)
    if (mine.unread > 0) {
      await markThreadRead(mine.id).catch(() => {})
      // The badge is a cache of a server fact; having just read the thread,
      // correct it now rather than waiting up to 25 seconds for the poll.
      void refreshUnread().catch(() => {})
    }
  }, [otherId])

  useEffect(() => {
    let live = true
    if (!messagingReady()) {
      setLoaded(true)
      return
    }
    void sync()
      .catch(() => {})
      .finally(() => live && setLoaded(true))
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void sync().catch(() => {})
    }, THREAD_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [sync])

  useEffect(() => {
    let live = true
    if (!messagingReady()) return
    void lookupProfileById(otherId).then((row) => live && row && setProfile(row))
    return () => {
      live = false
    }
  }, [otherId])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      await sendMessage(otherId, body, about)
      setText('')
      setAbout(undefined)
      await sync()
    } catch (err: any) {
      toast(err?.message ?? 'Could not send that', 'error')
    } finally {
      setSending(false)
    }
  }

  const block = async () => {
    if (!thread) return
    try {
      await setThreadBlocked(thread.id, true)
      setConfirmBlock(false)
      toast(`You will not hear from @${handle || 'them'} again`, 'info')
      location.hash = '#/messages'
    } catch (err: any) {
      toast(err?.message ?? 'Could not do that', 'error')
    }
  }

  const grouped = useMemo(() => messages, [messages])

  return (
    <div className="screen safe-top thread">
      <header className="screenhead friendhead">
        <a className="iconbtn" href="#/messages" aria-label="Back to messages">
          <Icon name="chevronLeft" size={20} />
        </a>
        <div className="friendhead__id">
          <h1>{title}</h1>
          {handle && <span className="friendhead__meta">@{handle}</span>}
        </div>
        {thread && (
          <button className="iconbtn" aria-label="Block this collector" onClick={() => setConfirmBlock(true)}>
            <Icon name="block" size={18} />
          </button>
        )}
      </header>

      {!messagingReady() && (
        <Empty
          icon="message"
          title="Messages need an account"
          body="Claim a handle on the Friends screen first — a conversation is addressed to an account, not to a device."
        />
      )}

      {messagingReady() && loaded && !grouped.length && (
        <Empty
          icon="message"
          title={`Say hello to ${title}`}
          body="Ask about a card, agree a price, or arrange a swap. They can reply from their own app."
        />
      )}

      <div className="thread__log">
        {grouped.map((message) => (
          <Bubble key={message.id} message={message} mine={message.senderId === me} />
        ))}
        <div ref={bottom} />
      </div>

      {messagingReady() && (
        <div className="msgbox">
          {about && (
            <div className="msgbox__about">
              <AboutCard row={about} />
              <button className="msgbox__drop" aria-label="Don’t attach this card" onClick={() => setAbout(undefined)}>
                <Icon name="x" size={13} />
              </button>
            </div>
          )}
          <div className="msgbox__row">
            <textarea
              className="input msgbox__input"
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, MESSAGE_MAX_CHARS))}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line — the convention
                // every other chat box on the device already taught them.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder={`Message ${title}…`}
              rows={2}
              maxLength={MESSAGE_MAX_CHARS}
              aria-label="Your message"
            />
            <button className="btn btn--primary msgbox__send" onClick={send} disabled={sending || !text.trim()}>
              <Icon name="send" size={16} />
              <span className="msgbox__sendlabel">{sending ? 'Sending…' : 'Send'}</span>
            </button>
          </div>
          <p className="msgbox__note">
            Messages are stored on our server so both of you can read them — they are not encrypted end to end. Never
            send card numbers or account details here.
          </p>
        </div>
      )}

      <Modal open={confirmBlock} onClose={() => setConfirmBlock(false)} title={`Block ${title}?`}>
        <p className="setsec__note">
          Their conversation leaves your list and they stop reaching you. They are not told, and messaging them again
          lifts it.
        </p>
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setConfirmBlock(false)}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={block}>
            Block
          </button>
        </div>
      </Modal>
    </div>
  )
}

function Bubble({ message, mine }: { message: ChatMessage; mine: boolean }) {
  return (
    <div className={`bubble ${mine ? 'bubble--mine' : ''}`}>
      {message.about && <AboutCard row={message.about} />}
      {/* Plain text, always. A message is the one place a stranger's free text
          reaches another user's screen, so it is rendered as a string and
          never as markup. */}
      <p className="bubble__body">{message.body}</p>
      <span className="bubble__at">{relativeAge(message.at)} ago</span>
    </div>
  )
}

/**
 * The card a message is about.
 *
 * Priced the way a binder row is — the published market unit with the seller's
 * condition applied — so the number in the conversation is the number both
 * people already saw, and nobody is negotiating against a different figure.
 */
function AboutCard({ row }: { row: SharedCard }) {
  const card = useMemo(() => sharedCardToCard(row), [row])
  const price = (row.price ?? 0) * conditionFactor(row.condition)
  return (
    <div className="aboutcard">
      <span className="aboutcard__img">
        <CardImg card={card} />
      </span>
      <span className="aboutcard__text">
        <span className="aboutcard__name">{row.name}</span>
        <span className="aboutcard__meta">
          {[row.setCode, row.number, row.condition].filter(Boolean).join(' · ')}
        </span>
        {price > 0 && <span className="aboutcard__price">{money(price)}</span>}
      </span>
    </div>
  )
}
