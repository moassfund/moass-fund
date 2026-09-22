// Bakes a slight CRT-style RGB split (chromatic aberration) into a wallpaper image.
// Red is pushed left + outward, blue right + inward, green stays put, so the centre is
// nearly clean and the fringing grows toward the edges like an old tube.
// Scanlines, vignette and the rolling band are NOT baked in: they are CSS (.crt in
// src/styles/desktop.css) so they stay pixel-crisp at any screen size.
//
// Usage:  npm i -D sharp
//         node design/rgb-split.cjs <input> [maxWidth=2560] [shiftPx=3] [radial=0.0016]
// Writes: public/wallpaper/moass-bg.webp  (with the split, used by the app)
//         design/moass-bg-clean.webp      (same resize, no split, for undoing it)
const path = require('path')
const sharp = require('sharp')

const [src, maxW = '2560', shiftArg = '3', radialArg = '0.0016'] = process.argv.slice(2)
if (!src) throw new Error('usage: node design/rgb-split.cjs <input> [maxWidth] [shiftPx] [radial]')
const SHIFT = Number(shiftArg)
const RADIAL = Number(radialArg)
const root = path.join(__dirname, '..')

;(async () => {
  const resized = sharp(src).resize({ width: Number(maxW), withoutEnlargement: true }).removeAlpha()
  const { data, info } = await resized.clone().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: ch } = info
  const out = Buffer.from(data)
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2

  // bilinear sample of one channel, clamped at the borders
  const sample = (x, y, c) => {
    x = Math.min(w - 1, Math.max(0, x))
    y = Math.min(h - 1, Math.max(0, y))
    const x0 = Math.floor(x), y0 = Math.floor(y)
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1)
    const fx = x - x0, fy = y - y0
    const p = (xx, yy) => data[(yy * w + xx) * ch + c]
    return (p(x0, y0) * (1 - fx) + p(x1, y0) * fx) * (1 - fy) + (p(x0, y1) * (1 - fx) + p(x1, y1) * fx) * fy
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) * RADIAL
      const dy = (y - cy) * RADIAL
      const i = (y * w + x) * ch
      out[i] = Math.round(sample(x + SHIFT - dx, y - dy, 0)) // red: left + outward
      out[i + 2] = Math.round(sample(x - SHIFT + dx, y + dy, 2)) // blue: right + inward
    }
  }

  const raw = { raw: { width: w, height: h, channels: ch } }
  await sharp(out, raw).webp({ quality: 84 }).toFile(path.join(root, 'public/wallpaper/moass-bg.webp'))
  await resized.clone().webp({ quality: 84 }).toFile(path.join(root, 'design/moass-bg-clean.webp'))
  console.log(`done: ${w}x${h}, shift ${SHIFT}px, radial ${RADIAL}`)
})()
