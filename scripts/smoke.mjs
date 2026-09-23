#!/usr/bin/env node
/**
 * Browser smoke test — opens every window and reports what rendered.
 *
 * The unit and contract suites prove the layers underneath. This is the only
 * thing that proves the desktop itself boots, that each window mounts against
 * whatever the adapter returned, and that nothing threw on the way.
 *
 * Needs the app running: `npm start` in another terminal, then `npm run smoke`.
 * Works against mock data too — point it at a `npm start -- --mock` and it
 * checks the same windows with the simulated adapter.
 */
import { chromium } from 'playwright'

const URL = process.env.SMOKE_URL ?? 'http://localhost:5173/'

/** Deep links, so windows open without depending on icon hit-boxes. */
const WINDOWS = [
  ['genesis', 'Founding Offering'],
  ['getgme', 'Swap GME'],
  ['overview', 'Fund Overview'],
  ['stake', 'Stake'],
  ['bond', 'Bond Desk'],
  ['treasury', 'Treasury'],
  ['calculator', 'Tendies Calc'],
  ['buy', 'Buy'],
  ['prospectus', 'Prospectus'],
]

/** Things that mean a number failed to format rather than being genuinely odd. */
const BROKEN = [/NaN/, /Infinity/, /undefined/, /\[object Object\]/, /\$-/]

const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 200)}`))

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(6000) // the desktop boots with an animation

const body = () => page.evaluate(() => document.body.innerText)

console.log(`\n  ${await page.title()} — ${URL}`)
const first = await body()
console.log(`  mode: ${first.toLowerCase().includes('demo') ? 'simulated (DEMO badge)' : 'live chain'}\n`)

let failures = 0

for (const [hash, label] of WINDOWS) {
  await page.goto(`${URL}#${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const text = await body()
  const loading = /Loading|Dialing up/.test(text)
  const suspects = BROKEN.filter((re) => re.test(text)).map(String)

  let verdict = 'ok'
  if (loading) {
    verdict = 'STILL LOADING'
    failures++
  } else if (suspects.length) {
    verdict = `SUSPECT VALUES ${suspects.join(' ')}`
    failures++
  }

  console.log(`  ${verdict === 'ok' ? '✓' : '✗'} ${label.padEnd(16)} ${verdict}`)

  if (verdict !== 'ok') {
    const lines = text.split('\n').filter((l) => BROKEN.some((re) => re.test(l)))
    for (const l of lines.slice(0, 4)) console.log(`      ${l.trim().slice(0, 100)}`)
  }
}

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/moass-desktop.png' })

console.log(`\n  console errors: ${errors.length ? errors.length : 'none'}`)
for (const e of errors.slice(0, 5)) console.log(`      ${e}`)

await browser.close()

if (failures || errors.length) {
  console.log(`\n  ${failures} window(s) with problems, ${errors.length} console error(s)\n`)
  process.exit(1)
}
console.log('\n  every window rendered clean\n')
