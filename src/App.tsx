import { useCallback, useState } from 'react'
import { BootScreen } from './shell/BootScreen'
import { Desktop } from './shell/Desktop'
import { Dialogs } from './shell/Dialogs'
import { Rsod } from './shell/Rsod'

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
      <Desktop />
      <Dialogs />
      <Rsod />
      {booting && <BootScreen onDone={finishBoot} />}
    </>
  )
}
