import type { PointerEvent as ReactPointerEvent } from 'react'

/** Pointer-capture drag. Call from onPointerDown; `onDrag` receives per-move deltas. */
export function startDrag(e: ReactPointerEvent<HTMLElement>, onDrag: (dx: number, dy: number) => void) {
  if (e.button !== 0) return
  const el = e.currentTarget
  el.setPointerCapture(e.pointerId)
  let lastX = e.clientX
  let lastY = e.clientY
  const move = (ev: PointerEvent) => {
    onDrag(ev.clientX - lastX, ev.clientY - lastY)
    lastX = ev.clientX
    lastY = ev.clientY
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}
