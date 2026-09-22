import { useEffect, useRef, useState } from 'react'
import { TOKEN } from '../config'
import { isMock, useProtocol } from '../protocol/hooks'
import { IconTile, fmtPct } from '../ui'
import { APPS, isAppId, type AppId } from './apps'
import { dialogs } from './dialogStore'
import { Helper } from './Helper'
import { StartMenu } from './StartMenu'
import { Taskbar } from './Taskbar'
import { Wallpaper } from './Wallpaper'
import { Window } from './Window'
import { activeIdOf, useWindowStore } from './windowStore'

const hashApp = () => {
  const id = window.location.hash.replace(/^#\/?/, '')
  return isAppId(id) ? id : null
}

export function Desktop() {
  const wins = useWindowStore((s) => s.wins)
  const open = useWindowStore((s) => s.open)
  const activeId = activeIdOf(wins)
  const [startOpen, setStartOpen] = useState(false)
  const [selected, setSelected] = useState<AppId | null>(null)

  // Deep links: moass.fund/#bond opens the Bond Desk. No hash opens the overview.
  useEffect(() => {
    open(hashApp() ?? 'overview')
    const onHash = () => {
      const id = hashApp()
      if (id) open(id)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [open])

  useEffect(() => {
    if (!isMock) return
    const t = setTimeout(() => dialogs.balloon('Demo mode', 'Contracts are not live yet. Every number on this desktop is simulated, so click around and break things.'), 1800)
    return () => clearTimeout(t)
  }, [])

  // Tray balloon whenever a new epoch lands while the desktop is open.
  const { data: protocol } = useProtocol()
  const epochNo = protocol?.epoch.number
  const rebaseRate = protocol?.rebaseRate
  const lastEpoch = useRef<number | null>(null)
  useEffect(() => {
    if (epochNo == null || rebaseRate == null) return
    if (lastEpoch.current != null && epochNo > lastEpoch.current) {
      dialogs.balloon('Rebase detected', `Epoch ${epochNo} landed: +${fmtPct(rebaseRate, 3)} ${TOKEN.staked} for every staker.`, 'shrug')
    }
    lastEpoch.current = epochNo
  }, [epochNo, rebaseRate])

  const onIconClick = (id: AppId) => {
    setSelected(id)
    // touch has no double-click: a single tap launches
    if (window.matchMedia('(pointer: coarse)').matches) open(id)
  }

  return (
    <div className="desktop">
      <Wallpaper />
      <div className="desk-icons" onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null) }}>
        {APPS.map((a) => (
          <button
            key={a.id}
            type="button"
            className="desk-icon"
            aria-pressed={selected === a.id}
            onClick={() => onIconClick(a.id)}
            onDoubleClick={() => open(a.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') open(a.id) }}
          >
            <IconTile emoji={a.icon} tint={a.tint} />
            <span className="desk-label">{a.short}</span>
          </button>
        ))}
      </div>

      <div className="window-layer">
        {wins.map((w) => <Window key={w.id} win={w} active={w.id === activeId} />)}
      </div>

      {startOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9400 }} onPointerDown={() => setStartOpen(false)} />
          <StartMenu onClose={() => setStartOpen(false)} />
        </>
      )}
      <Helper />
      <Taskbar startOpen={startOpen} onToggleStart={() => setStartOpen((v) => !v)} />
    </div>
  )
}
