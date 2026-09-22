import { useEffect, type ReactNode } from 'react'
import { useConnect } from 'wagmi'
import { isMock } from '../protocol/hooks'
import { ProgressBar } from '../ui'
import { dialogs, useDialogStore, type DialogIcon } from './dialogStore'
import { TOKEN } from '../config'

const ICONS: Record<DialogIcon, string> = { info: 'ℹ️', warn: '⚠️', error: '❌', question: '❓' }

function DialogWindow({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  return (
    <div className="modal-layer">
      <section className="window dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="title-bar">
          <span className="title-bar-text">{title}</span>
          {onClose && (
            <div className="title-bar-controls">
              <button type="button" className="close" aria-label="Close" onClick={onClose}>✕</button>
            </div>
          )}
        </header>
        <div className="window-body">{children}</div>
      </section>
    </div>
  )
}

function ConnectWallet() {
  const { connectors, connect, isPending, error } = useConnect()
  const hasProvider = typeof window !== 'undefined' && 'ethereum' in window
  // EIP-6963 wallets show up by name; hide the generic fallback when we have real ones
  const list = connectors.length > 1 ? connectors.filter((c) => c.id !== 'injected') : connectors
  const none = !hasProvider && connectors.every((c) => c.id === 'injected')

  return (
    <DialogWindow title="Connect Wallet" onClose={dialogs.closeConnect}>
      <div className="dialog-body">
        <span className="dialog-icon">🔌</span>
        <div className="dialog-text stack">
          {none ? (
            <p>No wallet detected in this browser. Install one, or open this page inside your wallet app's browser.</p>
          ) : (
            <>
              <p>Pick a wallet to log on to {TOKEN.name} XP.</p>
              {list.map((c) => (
                <button key={c.uid} type="button" className="btn" disabled={isPending} onClick={() => connect({ connector: c }, { onSuccess: dialogs.closeConnect })}>
                  {c.name === 'Injected' ? 'Browser wallet' : c.name}
                </button>
              ))}
            </>
          )}
          {error && <p className="down">{error.message.split('\n')[0]}</p>}
          {isMock && <p className="muted">Demo mode works without a wallet. Nothing here touches real funds.</p>}
        </div>
      </div>
      <div className="dialog-buttons">
        <button type="button" className="btn" onClick={dialogs.closeConnect}>{none ? 'OK' : 'Cancel'}</button>
      </div>
    </DialogWindow>
  )
}

function Balloon({ id, title, text }: { id: number; title: string; text: string }) {
  useEffect(() => {
    const t = setTimeout(dialogs.dismissBalloon, 7000)
    return () => clearTimeout(t)
  }, [id])
  return (
    <div className="balloon" role="status">
      <button type="button" className="x" aria-label="Dismiss" onClick={dialogs.dismissBalloon}>✕</button>
      {title && <b>ℹ️ {title}</b>}
      <span style={{ whiteSpace: 'pre-line' }}>{text}</span>
    </div>
  )
}

export function Dialogs() {
  const { boxes, tx, balloon, connectOpen, kidHidden } = useDialogStore()
  const box = boxes[boxes.length - 1]
  return (
    <>
      {balloon && kidHidden && <Balloon id={balloon.id} title={balloon.title} text={balloon.text} />}
      {connectOpen && <ConnectWallet />}
      {tx && (
        <DialogWindow title={tx.title}>
          <div className="dialog-body">
            <span className="dialog-icon">📨</span>
            <div className="dialog-text stack">
              <p>{tx.text}</p>
              <ProgressBar marquee label="Transaction pending" />
              <p className="muted">{isMock ? 'Simulating transaction…' : 'Confirm in your wallet, then wait for the block.'}</p>
            </div>
          </div>
        </DialogWindow>
      )}
      {box && (
        <DialogWindow title={box.title} onClose={() => dialogs.closeBox(box.id, box.buttons[box.buttons.length - 1])}>
          <div className="dialog-body">
            <span className="dialog-icon">{ICONS[box.icon]}</span>
            <p className="dialog-text">{box.text}</p>
          </div>
          <div className="dialog-buttons">
            {box.buttons.map((b, i) => (
              <button key={b} type="button" className="btn" autoFocus={i === 0} onClick={() => dialogs.closeBox(box.id, b)}>{b}</button>
            ))}
          </div>
        </DialogWindow>
      )}
    </>
  )
}
