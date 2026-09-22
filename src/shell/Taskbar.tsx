import { useAccount, useDisconnect } from 'wagmi'
import { QUOTE, TOKEN } from '../config'
import { isMock, useProtocol } from '../protocol/hooks'
import { fmtCountdown, fmtSignedPct, fmtUsd, shortAddr, toneOf, useNow } from '../ui'
import { APP_BY_ID } from './apps'
import { dialogs } from './dialogStore'
import { activeIdOf, useWindowStore } from './windowStore'

function Tray() {
  const { data } = useProtocol()
  const { address } = useAccount()
  const { disconnect } = useDisconnect()
  const now = useNow(1000)

  const onWallet = async () => {
    if (!address) return dialogs.openConnect()
    if (await dialogs.confirm('Wallet', `Disconnect ${shortAddr(address)}?`, 'Disconnect', 'Cancel')) disconnect()
  }

  return (
    <div className="tray">
      {isMock && (
        <span className="demo-badge" title="Demo mode: every number on this desktop is simulated. Contracts are not live yet.">
          DEMO<span className="hide-sm"> · SIMULATED DATA</span>
        </span>
      )}
      {data && (
        <>
          <span className="tray-item" title={`${TOKEN.symbol} price`}>
            <b>${TOKEN.symbol}</b> {fmtUsd(data.priceUsd)}
          </span>
          <span className="tray-item hide-sm" title={`${QUOTE.symbol} price, 24h`}>
            <b>{QUOTE.symbol}</b> {fmtUsd(data.gme.priceUsd)} <span className={toneOf(data.gme.change24hPct)}>{fmtSignedPct(data.gme.change24hPct, 1)}</span>
          </span>
          <span className="tray-item hide-sm" title="Next rebase">⏱ {fmtCountdown(data.epoch.endsAt - now)}</span>
        </>
      )}
      <button type="button" className="tray-btn" onClick={onWallet}>{address ? shortAddr(address) : 'Connect'}</button>
      <span className="tray-item hide-sm">{new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
    </div>
  )
}

export function Taskbar({ startOpen, onToggleStart }: { startOpen: boolean; onToggleStart: () => void }) {
  const wins = useWindowStore((s) => s.wins)
  const { open, minimize } = useWindowStore.getState()
  const activeId = activeIdOf(wins)

  return (
    <nav className="taskbar" aria-label="Taskbar">
      <button type="button" className="start-btn" aria-expanded={startOpen} aria-haspopup="menu" onClick={onToggleStart}>
        <span className="glyph">🚀</span>
        <span className="word">start</span>
      </button>
      <div className="task-buttons">
        {wins.map((w) => {
          const def = APP_BY_ID[w.id]
          const active = w.id === activeId
          return (
            <button key={w.id} type="button" className="task-btn" aria-pressed={active} title={def.title} onClick={() => (active ? minimize(w.id) : open(w.id))}>
              <span>{def.icon}</span>
              <span className="label">{def.short}</span>
            </button>
          )
        })}
      </div>
      <Tray />
    </nav>
  )
}
