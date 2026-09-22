import { useAccount } from 'wagmi'
import { LINKS, TOKEN } from '../config'
import { isMock } from '../protocol/hooks'
import { IconTile, shortAddr } from '../ui'
import { APPS, type AppId } from './apps'
import { dialogs, useDialogStore } from './dialogStore'
import { useWindowStore } from './windowStore'

const EXTERNAL: { label: string; href: string }[] = [
  { label: '🐦  X / Twitter', href: LINKS.x },
  { label: '✈️  Telegram', href: LINKS.telegram },
  { label: '📊  Live chart', href: LINKS.chart },
  { label: '🔁  Trade on DEX', href: LINKS.dex },
  { label: '📚  Docs', href: LINKS.docs },
]

export function StartMenu({ onClose }: { onClose: () => void }) {
  const { address } = useAccount()
  const open = useWindowStore((s) => s.open)
  const kidHidden = useDialogStore((s) => s.kidHidden)
  const launch = (id: AppId) => {
    open(id)
    onClose()
  }

  const copyContract = async () => {
    onClose()
    if (!LINKS.tokenAddress) return void dialogs.info('Contract', `${TOKEN.symbol} is not deployed yet. Anyone showing you a contract address today is not us.`)
    try {
      await navigator.clipboard.writeText(LINKS.tokenAddress)
      dialogs.balloon('Copied', LINKS.tokenAddress)
    } catch {
      void dialogs.info('Contract', LINKS.tokenAddress)
    }
  }

  return (
    <div className="start-menu" role="menu" aria-label="Start menu">
      <div className="start-head">
        <IconTile emoji={address ? '🦍' : '👤'} tint="#1c1c1c" size={42} />
        <div>
          {address ? shortAddr(address) : 'Guest Ape'}
          <small>{address ? 'Wallet connected' : isMock ? 'Demo account, simulated balances' : 'No wallet connected'}</small>
        </div>
      </div>
      <div className="start-cols">
        <div className="start-col left">
          {APPS.map((a) => (
            <button key={a.id} type="button" role="menuitem" className="start-item" onClick={() => launch(a.id)}>
              <IconTile emoji={a.icon} tint={a.tint} />
              <span><b>{a.short}</b>{a.blurb}</span>
            </button>
          ))}
        </div>
        <div className="start-col right">
          {EXTERNAL.map((l) =>
            l.href ? (
              <a key={l.label} role="menuitem" className="start-item plain" href={l.href} target="_blank" rel="noreferrer noopener" onClick={onClose}>{l.label}</a>
            ) : (
              <span key={l.label} role="menuitem" className="start-item plain" aria-disabled="true" title="Coming soon">{l.label} (soon)</span>
            ),
          )}
          <div className="start-sep" />
          <button type="button" role="menuitem" className="start-item plain" onClick={copyContract}>📋  Copy contract</button>
          <button type="button" role="menuitem" className="start-item plain" onClick={() => { onClose(); dialogs.setKidHidden(!kidHidden) }}>
            🕶️  {kidHidden ? 'Bring back the Kid' : 'Hide the Kid'}
          </button>
          <button type="button" role="menuitem" className="start-item plain" onClick={() => { onClose(); dialogs.openConnect() }}>
            🔌  {address ? 'Switch wallet' : 'Connect wallet'}
          </button>
        </div>
      </div>
      <div className="start-foot">
        <button type="button" onClick={() => { onClose(); dialogs.rsod(true) }}>
          <span>🧻</span> Turn Off (Paper Hand)
        </button>
      </div>
    </div>
  )
}
