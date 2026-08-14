import { useCallback, useEffect, useState } from 'react'
import {
  backupToDrive,
  disconnectDrive,
  isDriveConfigured,
  listDriveBackups,
  prewarmDrive,
  restoreDriveBackup,
  type DriveBackupFile,
} from '../lib/drive'
import { useSettings } from '../lib/settings'
import { dateTime, relativeAge } from '../lib/util'
import { useUi } from '../store/ui'
import { Icon } from './Icon'
import { Modal } from './basics'

/**
 * Backup to the user's own Google Drive. The whole point is that it is boring:
 * connect once, and a copy lands in your Drive every day without you thinking
 * about it. Nothing here is required — with backup off the app is exactly what
 * it was, and with the build unconfigured this renders nothing at all.
 *
 * The copy avoids the word "sync" deliberately. This is a snapshot you can
 * restore from, not two devices kept in step, and promising the latter is how
 * people lose data believing they are covered.
 */
export function DriveBackup() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [busy, setBusy] = useState<'connect' | 'backup' | 'list' | 'restore' | null>(null)
  const [files, setFiles] = useState<DriveBackupFile[] | null>(null)

  /**
   * Already connected? Then loading Google's script on mount is not an
   * uninvited contact — the user opted in long ago — and it means Back up now
   * and Restore never race the popup timer at all. First-time visitors get
   * nothing until they reach for the button.
   */
  useEffect(() => {
    if (config.driveBackup) prewarmDrive()
  }, [config.driveBackup])

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      toast((err as Error)?.message ?? fallback, 'error')
    },
    [toast],
  )

  const connect = async () => {
    setBusy('connect')
    try {
      // Connecting IS the first backup — an account linked with nothing in it
      // looks connected and protects nothing, which is the worst of both.
      await backupToDrive(true)
      config.set({ driveBackup: true })
      toast('Backed up to your Google Drive', 'success')
    } catch (err) {
      fail(err, 'Could not connect to Google Drive')
    } finally {
      setBusy(null)
    }
  }

  const backupNow = async () => {
    setBusy('backup')
    try {
      await backupToDrive(true)
      toast('Backed up', 'success')
    } catch (err) {
      fail(err, 'Backup failed')
    } finally {
      setBusy(null)
    }
  }

  const openRestore = async () => {
    setBusy('list')
    try {
      const found = await listDriveBackups(true)
      setFiles(found)
      if (!found.length) toast('No backups in your Drive yet', 'info')
    } catch (err) {
      fail(err, 'Could not read your Drive')
    } finally {
      setBusy(null)
    }
  }

  const restore = async (file: DriveBackupFile) => {
    setBusy('restore')
    try {
      await restoreDriveBackup(file.id)
      setFiles(null)
      toast('Backup restored', 'success')
    } catch (err) {
      fail(err, 'Restore failed')
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    await disconnectDrive()
    setFiles(null)
    toast('Drive backup off — your existing backups are still in your Drive', 'info')
  }

  // Dormant until the build carries an OAuth client id. No half-feature, no
  // button that cannot work.
  if (!isDriveConfigured()) return null

  return (
    <section className="setsec drivepanel">
      <h3>Backup</h3>
      {config.driveBackup ? (
        <>
          <div className="syncstate">
            <span className="syncstate__dot" />
            <span className="syncstate__text">
              {config.driveAt ? `Backed up ${relativeAge(config.driveAt)} ago` : 'No backup yet'}
            </span>
            <button className="btn btn--ghost btn--sm" onClick={backupNow} onPointerDown={prewarmDrive} disabled={busy != null}>
              <Icon name="refresh" size={14} className={busy === 'backup' ? 'spin' : ''} /> Back up now
            </button>
          </div>
          <div className="drivepanel__row">
            <button className="btn btn--ghost" onClick={openRestore} onPointerDown={prewarmDrive} disabled={busy != null}>
              {busy === 'list' ? 'Reading…' : 'Restore from Drive'}
            </button>
            <button className="btn btn--ghost" onClick={disconnect} disabled={busy != null}>
              Turn off
            </button>
          </div>
          <p className="setsec__note">
            A copy of your collection, decks, price history, friends and trades goes to your own Google Drive once a
            day. It lands in a private folder only this app can see — not in your Drive files, and not on any server of
            ours. The last five are kept.
          </p>
        </>
      ) : (
        <>
          {/* Load Google's script the moment the user reaches for the button,
              not when they land on it — a popup is only allowed while the
              click still holds transient activation, and fetching a script
              inside that window is a race we lose. Reaching for Connect IS the
              opt-in, so this keeps the never-contact-Google-uninvited rule. */}
          <button
            className="btn btn--primary"
            onClick={connect}
            onPointerDown={prewarmDrive}
            onFocus={prewarmDrive}
            disabled={busy != null}
          >
            {busy === 'connect' ? 'Connecting…' : 'Back up to Google Drive'}
          </button>
          <p className="setsec__note">
            Optional, and free. Your collection lives on this device — if you lose the phone, clear your browser, or
            (on iPhone) leave the app unopened for a week, it goes with it. This keeps a daily copy in{' '}
            <b>your own Drive</b>, in a private folder only this app can read. We never see it and store nothing.
          </p>
        </>
      )}

      <Modal open={files != null} onClose={() => setFiles(null)} title="Restore from Drive">
        <div className="datamenu">
          {(files ?? []).map((file) => (
            <button
              key={file.id}
              className="datamenu__opt"
              onClick={() => restore(file)}
              disabled={busy === 'restore'}
            >
              <Icon name="download" size={18} />
              <span>
                {dateTime(file.modifiedAt)} <em>{Math.max(1, Math.round(file.bytes / 1024))} KB</em>
              </span>
            </button>
          ))}
          {files != null && files.length === 0 && <p className="setsec__note">Nothing backed up yet.</p>}
        </div>
        <p className="datamenu__note">
          Restoring merges the backup into what is here now — it adds what is missing and the backup wins where both
          have the same row. It never empties your collection.
        </p>
      </Modal>
    </section>
  )
}
