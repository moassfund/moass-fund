import { describe, expect, it } from 'vitest'
import { KID_FRAMES, KID_H, KID_PALETTE, KID_W, toRuns } from './kidSprite'

describe('kid sprite', () => {
  for (const [pose, frames] of Object.entries(KID_FRAMES)) {
    frames.forEach((rows, f) => {
      it(`${pose}[${f}]: ${KID_H} rows of ${KID_W} px, known palette chars only`, () => {
        expect(rows).toHaveLength(KID_H)
        rows.forEach((row, y) => {
          expect(row.length, `row ${y}`).toBe(KID_W)
          for (const c of row) expect(c === '.' || c in KID_PALETTE, `row ${y} char "${c}"`).toBe(true)
        })
      })
    })
  }

  // the body is drawn symmetric; this catches an arm fragment that drifts off-centre
  for (const pose of ['idle', 'shrug'] as const) {
    it(`${pose}: silhouette is left/right symmetric from the neck down`, () => {
      KID_FRAMES[pose][0].slice(20).forEach((row, i) => {
        const solid = [...row].map((c) => c !== '.')
        expect(solid, `row ${20 + i}`).toEqual([...solid].reverse())
      })
    })
  }

  it('two-frame poses actually differ between frames', () => {
    expect(KID_FRAMES.wave[0]).not.toEqual(KID_FRAMES.wave[1])
  })

  it('run-length encoding covers exactly the solid pixels', () => {
    const rows = KID_FRAMES.shrug[0]
    const solid = rows.join('').replace(/\./g, '').length
    expect(toRuns(rows).reduce((n, r) => n + r.w, 0)).toBe(solid)
  })
})
