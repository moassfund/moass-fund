// Imperative XP dialogs. Apps call `dialogs.*`; <Dialogs /> renders whatever is queued.
import { create } from 'zustand'
import type { TxResult } from '../protocol/types'
import type { KidPose } from './kidSprite'

export type DialogIcon = 'info' | 'warn' | 'error' | 'question'

const KID_HIDDEN_KEY = 'moass.kid.hidden'
const readKidHidden = () => {
  try { return localStorage.getItem(KID_HIDDEN_KEY) === '1' } catch { return false }
}

export interface MessageBoxSpec {
  id: number
  title: string
  icon: DialogIcon
  text: string
  buttons: string[]
  resolve: (label: string) => void
}

/** A clickable answer inside the Kid's bubble. */
export interface BalloonOption {
  label: string
  run: () => void
}

interface DialogState {
  boxes: MessageBoxSpec[]
  tx: { title: string; text: string } | null
  /** One notification at a time. The Kid speaks it; if he is hidden it shows as a classic tray balloon. */
  balloon: { id: number; title: string; text: string; pose: KidPose; options: BalloonOption[] } | null
  connectOpen: boolean
  rsod: boolean
  kidHidden: boolean
}

export const useDialogStore = create<DialogState>(() => ({ boxes: [], tx: null, balloon: null, connectOpen: false, rsod: false, kidHidden: readKidHidden() }))
const { setState, getState } = useDialogStore
let seq = 0

export const dialogs = {
  /** Resolves with the label of the button that was clicked. */
  messageBox(opts: { title: string; text: string; icon?: DialogIcon; buttons?: string[] }): Promise<string> {
    return new Promise((resolve) => {
      const box: MessageBoxSpec = { id: ++seq, title: opts.title, text: opts.text, icon: opts.icon ?? 'info', buttons: opts.buttons ?? ['OK'], resolve }
      setState((s) => ({ boxes: [...s.boxes, box] }))
    })
  },
  async confirm(title: string, text: string, yes = 'Yes', no = 'No') {
    return (await dialogs.messageBox({ title, text, icon: 'question', buttons: [yes, no] })) === yes
  },
  error: (title: string, text: string) => dialogs.messageBox({ title, text, icon: 'error' }),
  info: (title: string, text: string) => dialogs.messageBox({ title, text, icon: 'info' }),

  closeBox(id: number, label: string) {
    const box = getState().boxes.find((b) => b.id === id)
    setState((s) => ({ boxes: s.boxes.filter((b) => b.id !== id) }))
    box?.resolve(label)
  },

  /** Notification, auto-dismisses. `pose` is how the Kid delivers it: 'shrug' is his victory pose. */
  balloon: (title: string, text: string, pose: KidPose = 'idle', options: BalloonOption[] = []) =>
    setState({ balloon: { id: ++seq, title, text, pose, options } }),
  dismissBalloon: () => setState({ balloon: null }),
  setKidHidden(hidden: boolean) {
    try { localStorage.setItem(KID_HIDDEN_KEY, hidden ? '1' : '0') } catch { /* private mode */ }
    setState({ kidHidden: hidden })
  },

  openConnect: () => setState({ connectOpen: true }),
  closeConnect: () => setState({ connectOpen: false }),
  rsod: (on: boolean) => setState({ rsod: on }),

  /**
   * Wrap any protocol mutation: shows the progress dialog while pending, a
   * balloon on success, an error box on failure. Returns true on success.
   */
  async runTx(opts: { title: string; text: string; action: () => Promise<TxResult>; success: string }): Promise<boolean> {
    setState({ tx: { title: opts.title, text: opts.text } })
    try {
      const tx = await opts.action()
      setState({ tx: null })
      dialogs.balloon('Transaction confirmed', `${opts.success}\n${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`, 'shrug')
      return true
    } catch (e) {
      setState({ tx: null })
      await dialogs.error(opts.title, e instanceof Error ? e.message : 'Something went wrong.')
      return false
    }
  },
}
