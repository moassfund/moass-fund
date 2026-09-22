import { Component, useCallback, useState, type ReactNode } from 'react'
import { BootScreen } from './shell/BootScreen'
import { Desktop } from './shell/Desktop'
import { Dialogs } from './shell/Dialogs'
import { Rsod } from './shell/Rsod'

/**
 * Desktop and Taskbar both read the protocol query, so a failure with no
 * cached data escapes above every window's own boundary. Without this the
 * page renders nothing at all, which is worse than any error message.
 */
class FatalBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="window-content" style={{ margin: '10vh auto', maxWidth: 520 }}>
        <div className="callout warn">
          <span>❌</span>
          <div>
            <b>The desktop could not start.</b>
            <div>{this.state.error.message}</div>
          </div>
        </div>
      </div>
    )
  }
}

const BOOT_KEY = 'moass.booted'

function shouldBoot() {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    return sessionStorage.getItem(BOOT_KEY) !== '1'
  } catch {
    return false
  }
}

export default function App() {
  const [booting, setBooting] = useState(shouldBoot)
  const finishBoot = useCallback(() => {
    try { sessionStorage.setItem(BOOT_KEY, '1') } catch { /* private mode */ }
    setBooting(false)
  }, [])

  return (
    <>
      <FatalBoundary>
        <Desktop />
        <Dialogs />
        <Rsod />
      </FatalBoundary>
      {booting && <BootScreen onDone={finishBoot} />}
    </>
  )
}
