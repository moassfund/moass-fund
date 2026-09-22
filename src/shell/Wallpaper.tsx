import type { CSSProperties } from 'react'
import { WALLPAPER } from '../config'

// Layers, back to front: picture -> optional art (pinned top-right) -> optional CRT glass.
// Everything here sits behind the icons and windows, so UI text is never filtered.
//
// crt 'animated': the clean image is drawn three times, each multiplied down to one colour
// channel and screen-blended back together. Disjoint channels screen to the exact original, so
// nudging red and blue apart gives a true RGB split that can move (transform only, GPU cheap).
export function Wallpaper() {
  const { crt } = WALLPAPER
  const vars = {
    '--wp-img': `url("${WALLPAPER.skyClean}")`,
    '--wp-focus': WALLPAPER.focus,
    '--wp-focus-sm': WALLPAPER.focusMobile,
  } as CSSProperties

  return (
    <>
      {crt === 'animated' ? (
        <div className="wallpaper-rgb" style={vars} aria-hidden="true">
          <i className="ch ch-g" />
          <i className="ch ch-r" />
          <i className="ch ch-b" />
        </div>
      ) : (
        <img className="wallpaper" style={vars} src={crt === 'static' ? WALLPAPER.sky : WALLPAPER.skyClean} alt="" aria-hidden="true" draggable={false} />
      )}
      {WALLPAPER.art && <img className="wallpaper-art" src={WALLPAPER.art} alt="" aria-hidden="true" draggable={false} />}
      {crt !== 'off' && (
        <div className={crt === 'animated' ? 'crt crt-live' : 'crt'} aria-hidden="true">
          <i className="crt-lines" />
        </div>
      )}
      {WALLPAPER.dim > 0 && <div className="wallpaper-dim" style={{ opacity: WALLPAPER.dim }} aria-hidden="true" />}
    </>
  )
}
