import { create } from 'zustand'
import { APP_BY_ID, type AppId } from './apps'

export interface WinState {
  id: AppId
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized: boolean
  maximized: boolean
}

interface WindowStore {
  wins: WinState[]
  topZ: number
  open: (id: AppId) => void
  close: (id: AppId) => void
  focus: (id: AppId) => void
  minimize: (id: AppId) => void
  toggleMax: (id: AppId) => void
  moveBy: (id: AppId, dx: number, dy: number) => void
  resizeBy: (id: AppId, dw: number, dh: number) => void
}

const TASKBAR = 38
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight - TASKBAR })
const patch = (wins: WinState[], id: AppId, fn: (w: WinState) => WinState) => wins.map((w) => (w.id === id ? fn(w) : w))

export const useWindowStore = create<WindowStore>((set) => ({
  wins: [],
  topZ: 10,

  open: (id) =>
    set((s) => {
      const z = s.topZ + 1
      if (s.wins.some((w) => w.id === id)) {
        return { topZ: z, wins: patch(s.wins, id, (w) => ({ ...w, minimized: false, z })) }
      }
      const def = APP_BY_ID[id]
      const { vw, vh } = viewport()
      const w = Math.min(def.w, vw - 12)
      const h = Math.min(def.h, vh - 12)
      const offset = (s.wins.length % 6) * 26
      const x = clamp(Math.max(104, Math.round((vw - w) / 2)) + offset, 0, Math.max(0, vw - w))
      const y = clamp(Math.max(8, Math.round((vh - h) / 3)) + offset, 0, Math.max(0, vh - h))
      return { topZ: z, wins: [...s.wins, { id, x, y, w, h, z, minimized: false, maximized: false }] }
    }),

  close: (id) => set((s) => ({ wins: s.wins.filter((w) => w.id !== id) })),

  focus: (id) =>
    set((s) => {
      const top = s.wins.reduce((m, w) => Math.max(m, w.z), 0)
      const me = s.wins.find((w) => w.id === id)
      if (!me || (me.z === top && !me.minimized)) return s
      const z = s.topZ + 1
      return { topZ: z, wins: patch(s.wins, id, (w) => ({ ...w, z })) }
    }),

  minimize: (id) => set((s) => ({ wins: patch(s.wins, id, (w) => ({ ...w, minimized: true })) })),

  toggleMax: (id) => set((s) => ({ wins: patch(s.wins, id, (w) => ({ ...w, maximized: !w.maximized })) })),

  moveBy: (id, dx, dy) =>
    set((s) => ({
      wins: patch(s.wins, id, (w) => {
        const { vw, vh } = viewport()
        // keep a grabbable strip of the title bar on screen
        return { ...w, x: clamp(w.x + dx, 80 - w.w, vw - 80), y: clamp(w.y + dy, 0, vh - 30) }
      }),
    })),

  resizeBy: (id, dw, dh) =>
    set((s) => ({ wins: patch(s.wins, id, (w) => ({ ...w, w: Math.max(300, w.w + dw), h: Math.max(220, w.h + dh) })) })),
}))

/** The focused window: highest z that is not minimized. */
export const activeIdOf = (wins: WinState[]): AppId | null =>
  wins.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]?.id ?? null
