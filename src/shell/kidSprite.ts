// "The Kid": original pixel art for the desktop helper. Waist-up, he stands behind the taskbar.
// Authored as text rows, one char per pixel, then run-length encoded into SVG rects.
//
// Head and torso are drawn on a 25-col base grid (centre col 12) and padded by PAD on each
// side to KID_W, leaving room for arms. Arms and hands are fragments in KID_W coordinates,
// always drawn for HIS RIGHT arm (viewer's left) and mirrored when placed on the other side.

export type KidPose = 'idle' | 'shrug' | 'point' | 'wave' | 'shadesUp'
/** Eyebrows that pop up above the shades when he reacts. They do the acting, the shades stay on. */
export type KidBrow = 'none' | 'up' | 'skeptic' | 'worried'

const PAD = 15
export const KID_W = 25 + PAD * 2 // 55
export const KID_H = 34

export const KID_PALETTE: Record<string, string> = {
  K: '#121212', // outline + shades
  H: '#f6c21c', // hair
  h: '#d4920a', // hair shadow, eyebrows
  L: '#ffe27a', // hair highlight
  S: '#f7c9a3', // skin
  s: '#dc9f78', // skin shadow
  W: '#ffffff', // shirt, cuffs, lens glint, eye whites
  J: '#22303f', // jacket
  j: '#141d28', // jacket seams
  R: '#e31b23', // tie
  r: '#9c0f16', // tie tip, open mouth
  C: '#f8b636', // cufflink, button
  M: '#8a4030', // closed mouth
}

// 20 rows. Taller than wide on purpose: a 15px face under a 5-row quiff.
const HEAD = [
  '.......KKKKK.............',
  '.....KKHHLLKKKKKK........',
  '....KHHLLHHHHHLHHKK......',
  '...KHLLHHHhHHHHHHHHKK....',
  '..KHLHHHhHHHHHhHHHHHHK...',
  '..KHHHhHHHHhhHHHHhHHHK...',
  '..KHHhhhhhhhhhhhhhhhHHK..',
  '..KKHhSSSSSSSSSSSSSShHK..',
  '...KhSSSSSSSSSSSSSSShK...',
  '...KKKKKKKKKKKKKKKKKKK...',
  '.KSKKKWWKKKKKKWWKKKKKK...',
  '.KSKKKKWKKKKKKKWKKKKKK...',
  '.KsKKKKKKKKKSKKKKKKKKK...',
  '.KKKKSKKKKKSSSKKKKKSK....',
  '....KSSSSSSSsSSSSSSSK....',
  '....KSSSSSSSSSSSSSSSK....',
  '....KSSSSSSSSMMMSSSSK....',
  '....KSSSSSSSSSSSSSSSK....',
  '.....KSSSSSSSSSSSSSK.....',
  '......KKsssssssssKK......',
]

// rows 5..13 with the shades pushed up into his hair: just a kid under there
const SHADES_UP_FROM = 5
// Big round eyes and thick brows: the goofy-assistant look, only when the shades come off.
// Shades ride high in the hair so a row of forehead separates them from the brows.
const SHADES_UP = [
  '..KKKKKKKKKKKKKKKKKKKK...',
  '..KKKKWWKKKKKKWWKKKKKKK..',
  '..KKHhSSSSSSSSSSSSSShHK..',
  '...KhSKKKKSSSSSKKKKShK...',
  '....KSSSSSSSSSSSSSSSK....',
  '.KSSKSWWWWSSSSSWWWWSK....',
  '.KSsKSWKKWSSSSSWKKWSK....',
  '.KSsKSWKKWSSSSSWKKWSK....',
  '..KKKSWWWWSSSSSWWWWSK....',
]

// 14 rows: neck, shoulders, torso. No arms: every pose adds its own.
const TORSO = [
  '.........KsssssK.........',
  '.....KKKKKWWsWWKKKKK.....',
  '...KKJJJJJWWRWWJJJJJKK...',
  '..KJJJJJJJWRRRWJJJJJJJK..',
  '.....KJJJJJWRWJJJJJK.....',
  '.....KJJJJJJRJJJJJJK.....',
  '.....KJJJJJJRJJJJJJK.....',
  '.....KJJJJJJrJJJJJJK.....',
  '.....KJJJJJJjJJJJJJK.....',
  '.....KJJJJJJCJJJJJJK.....',
  '.....KJJJJJJjJJJJJJK.....',
  '.....KJJJJJJjJJJJJJK.....',
  '.....KJJJJJJjJJJJJJK.....',
  '.....KJJJJJJjJJJJJJK.....',
]

// ---- arm + hand fragments: [first row, rows]. Space = leave the pixel alone. ----
type Fragment = [top: number, rows: string[]]
const at = (col: number, s: string) => ' '.repeat(col) + s

const ARM_DOWN: Fragment = [24, [
  ...Array<string>(7).fill(at(17, 'KJJj')),
  at(17, 'KWWj'),
  at(17, 'KSSK'),
  at(18, 'KK'),
]]

// held straight out, palm up, finger nubs on top: THE pose
const ARM_OUT: Fragment = [17, [
  ' K K K',
  'KSKSKSK',
  'KSSSSSSKKKK',
  'KSSSSSSWWCJKKKKK',
  ' KSSSSSWWWJJJJJJKKKK',
  '  KKKKKKWWJJJJJJJJJJ',
  '        KKKJJJJJJJ',
  '           KKKKKKKKK',
]]

// elbow out, forearm straight up. The hand is a separate fragment on top.
const ARM_RAISED: Fragment = [13, [
  at(7, 'KWWWK'),
  at(7, 'KCWWK'),
  at(7, 'KJJJK'),
  at(7, 'KJJJK'),
  at(7, 'KJJJK'),
  at(7, 'KJJJJK'),
  at(7, 'KJJJJJK'),
  at(8, 'KJJJJJK'),
  at(9, 'KJJJJJKKKKK'),
  at(10, 'KKJJJJJJJJ'),
  at(12, 'KKKKKJJJ'),
  at(17, 'KKK'),
]]
const HAND_OPEN: Fragment = [8, [at(7, 'K K K'), at(6, 'KSKSKSK'), at(6, 'KSSSSSK'), at(6, 'KSSSSSK'), at(7, 'KSSSK')]]
const HAND_POINT: Fragment = [7, [at(8, 'K'), at(7, 'KSK'), at(7, 'KSK'), at(7, 'KSKKKK'), at(7, 'KSSSSSK'), at(7, 'KSSSSK')]]

// talking frame: only the pixels that differ from the closed mouth, KID_W coordinates
const MOUTH_OPEN: [x: number, y: number, c: string][] = [
  [PAD + 13, 16, 'K'], [PAD + 14, 16, 'K'], [PAD + 15, 16, 'K'],
  [PAD + 13, 17, 'r'], [PAD + 14, 17, 'r'], [PAD + 15, 17, 'r'],
]

type Side = 'left' | 'right' | 'both'
type Grid = string[][]

const body = (head: string[]): Grid => [...head, ...TORSO].map((row) => `${'.'.repeat(PAD)}${row}${'.'.repeat(PAD)}`.split(''))

function place(grid: Grid, [top, rows]: Fragment, side: Side, dx = 0): Grid {
  rows.forEach((frag, i) => {
    frag.split('').forEach((c, x) => {
      if (c === ' ') return
      if (side !== 'right') grid[top + i][x + dx] = c
      if (side !== 'left') grid[top + i][KID_W - 1 - x - dx] = c
    })
  })
  return grid
}

const headShadesUp = HEAD.map((row, y) => SHADES_UP[y - SHADES_UP_FROM] ?? row)
const done = (grid: Grid) => grid.map((r) => r.join(''))
const raised = (hand: Fragment, dx = 0) => done(place(place(place(body(HEAD), ARM_DOWN, 'right'), ARM_RAISED, 'left'), hand, 'left', dx))

/** One entry per pose; two frames = a looping two-frame animation. */
export const KID_FRAMES: Record<KidPose, string[][]> = {
  idle: [done(place(body(HEAD), ARM_DOWN, 'both'))],
  shrug: [done(place(body(HEAD), ARM_OUT, 'both'))],
  point: [raised(HAND_POINT)],
  wave: [raised(HAND_OPEN), raised(HAND_OPEN, -1)],
  shadesUp: [done(place(body(headShadesUp), ARM_DOWN, 'both'))],
}

export interface PixelRun {
  x: number
  y: number
  w: number
  fill: string
}

/** Horizontal run-length encoding: one rect per run of same-coloured pixels. */
export function toRuns(rows: string[]): PixelRun[] {
  const runs: PixelRun[] = []
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = row[x]
      let w = 1
      while (x + w < row.length && row[x + w] === c) w++
      if (c !== '.') runs.push({ x, y, w, fill: KID_PALETTE[c] })
      x += w
    }
  })
  return runs
}

export const KID_RUNS = Object.fromEntries(
  Object.entries(KID_FRAMES).map(([pose, frames]) => [pose, frames.map(toRuns)]),
) as Record<KidPose, PixelRun[][]>
export const KID_MOUTH_OPEN: PixelRun[] = MOUTH_OPEN.map(([x, y, c]) => ({ x, y, w: 1, fill: KID_PALETTE[c] }))

// Brows sit on the two forehead rows (7 and 8) above each lens. Not drawn for shadesUp, which has its own.
const brow = (x: number, y: number, w: number): PixelRun => ({ x: PAD + x, y, w, fill: KID_PALETTE.K })
export const KID_BROWS: Record<KidBrow, PixelRun[]> = {
  none: [],
  up: [brow(6, 7, 4), brow(15, 7, 4)],
  skeptic: [brow(6, 7, 4), brow(15, 8, 4)],
  worried: [brow(6, 8, 2), brow(8, 7, 2), brow(15, 7, 2), brow(17, 8, 2)],
}

// His stage: a sheet of yellow legal pad leaning behind him, the classic desktop-assistant prop.
// Generic stationery, drawn procedurally on the same pixel grid: ruled every third row, red margin.
const PAPER = { top: 6, left: 13, width: 31, lean: 4 }
export const KID_PAPER: PixelRun[] = (() => {
  const runs: PixelRun[] = []
  for (let y = PAPER.top; y < KID_H; y++) {
    const x = PAPER.left + Math.floor((KID_H - 1 - y) / PAPER.lean) // leans right toward the top
    const ruled = (y - PAPER.top) % 3 === 2
    runs.push({ x, y, w: PAPER.width, fill: y === PAPER.top ? '#d8cc74' : ruled ? '#bccb9a' : '#f7ee9f' })
    runs.push({ x: x + 4, y, w: 1, fill: '#e79b88' }) // margin rule
    runs.push({ x, y, w: 1, fill: '#d8cc74' }, { x: x + PAPER.width - 1, y, w: 1, fill: '#b9ab52' }) // lit and shaded edges
  }
  return runs
})()
