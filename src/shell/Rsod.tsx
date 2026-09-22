import { useEffect } from 'react'
import { dialogs, useDialogStore } from './dialogStore'

const TEXT = `A problem has been detected and Moass Fund has been shut down to prevent damage to your portfolio.

PAPER_HANDS_EXCEPTION

If this is the first time you have seen this red screen, take a deep breath and zoom out. If this screen appears again, follow these steps:

 * Check that your hands are made of diamond.
 * Disable any newly installed fear, uncertainty or doubt.
 * Remember that nobody here promised you anything. This is a meme fund running a leveraged position. It can go to zero.

Technical information:

*** STOP: 0x0000DEAD (0x00000420, 0x00000069, 0x00741741, 0x00000000)
*** tendies.sys - Address 0xD1A30D42 base at 0xD1A40000

Click anywhere or press any key to go back to holding.`

export function Rsod() {
  const on = useDialogStore((s) => s.rsod)
  useEffect(() => {
    if (!on) return
    const off = () => dialogs.rsod(false)
    window.addEventListener('keydown', off)
    return () => window.removeEventListener('keydown', off)
  }, [on])
  if (!on) return null
  return <div className="rsod" role="alertdialog" aria-label="Red screen of death" onClick={() => dialogs.rsod(false)}>{TEXT}</div>
}
