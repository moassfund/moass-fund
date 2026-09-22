import { Component, Suspense, type ReactNode } from 'react'
import { APP_BY_ID } from './apps'
import { startDrag } from './drag'
import { useWindowStore, type WinState } from './windowStore'

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="window-content">
        <div className="callout warn">
          <span>❌</span>
          <div>
            <b>This program has performed an illegal operation.</b>
            <div>{this.state.error.message}</div>
          </div>
        </div>
      </div>
    )
  }
}

export function Window({ win, active }: { win: WinState; active: boolean }) {
  const def = APP_BY_ID[win.id]
  const { focus, close, minimize, toggleMax, moveBy, resizeBy } = useWindowStore.getState()
  const App = def.component
  const cls = ['window', active ? '' : 'inactive', win.maximized ? 'maximized' : '', win.minimized ? 'minimized' : ''].filter(Boolean).join(' ')

  return (
    <section
      className={cls}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
      onPointerDownCapture={() => focus(win.id)}
      aria-label={def.title}
    >
      <header
        className="title-bar"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button') || win.maximized) return
          startDrag(e, (dx, dy) => moveBy(win.id, dx, dy))
        }}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) toggleMax(win.id)
        }}
      >
        <span className="title-bar-icon">{def.icon}</span>
        <span className="title-bar-text">{def.title}</span>
        <div className="title-bar-controls">
          <button type="button" aria-label="Minimize" onClick={() => minimize(win.id)}>_</button>
          <button type="button" className="max" aria-label={win.maximized ? 'Restore' : 'Maximize'} onClick={() => toggleMax(win.id)}>
            {win.maximized ? '❐' : '□'}
          </button>
          <button type="button" className="close" aria-label="Close" onClick={() => close(win.id)}>✕</button>
        </div>
      </header>
      <div className="window-body">
        <AppErrorBoundary>
          <Suspense fallback={<div className="window-content muted">Loading {def.short}…</div>}>
            <App />
          </Suspense>
        </AppErrorBoundary>
      </div>
      <div className="resize-grip" onPointerDown={(e) => startDrag(e, (dw, dh) => resizeBy(win.id, dw, dh))} />
    </section>
  )
}
