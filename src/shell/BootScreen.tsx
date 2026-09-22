import { useEffect } from 'react'
import { IconTile } from '../ui'

export function BootScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2400)
    const skip = () => onDone()
    window.addEventListener('keydown', skip)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', skip)
    }
  }, [onDone])

  return (
    <div className="boot" onClick={onDone} role="presentation">
      <div className="boot-logo">
        <IconTile emoji="🚀" tint="#e31b23" />
        <div className="boot-word">
          <small>Dumb Money Corp.</small>
          Moass Fund<sup>XP</sup>
        </div>
      </div>
      <div className="boot-track"><i /></div>
      <div className="boot-foot">
        <span>Copyright © Dumb Money Corp. Not financial advice.</span>
        <span>click to skip</span>
      </div>
    </div>
  )
}
