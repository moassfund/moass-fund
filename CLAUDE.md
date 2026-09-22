# Moass Fund XP

Web app for Moass Fund: an OHM fork on Robinhood Chain, paired with tokenized $GME, treasury runs a 3x GME long. The UI is a Windows-XP desktop in a glossy "Luna Red" theme. Contracts are NOT deployed; the app runs on a simulated adapter.

Commands: `npm run dev` (port 5173) · `npm run build` (tsc + vite) · `npm run typecheck` · `npm test` (vitest, math only).

## Layout
- `src/config.ts` — ticker (`TOKEN.symbol` MOASS, `TOKEN.staked` sMOASS), `QUOTE` GME, chain, `LINKS` (empty string = not live yet).
- `src/protocol/` — `types.ts` (data shapes), `math.ts` (pure, tested), `hooks.ts`, `mockAdapter.ts`, `chainAdapter.ts` (stub).
- `src/shell/` — desktop, window manager (`windowStore.ts`), `apps.ts` registry, `dialogStore.ts`, the Kid (`Helper.tsx`, `kidSprite.ts`, `kidLines.ts`).
- `src/ui/` — the kit (`kit.tsx`, `format.ts`, `useNow.ts`, `Chart.tsx`). `src/styles/` — `tokens.css`, `luna-red.css`, `desktop.css`.
- `src/apps/` — one default-exported component per window. **`Stake.tsx` is the exemplar; copy its shape.**

## Rules for app code (`src/apps/*`)
1. Protocol data comes ONLY from `../protocol/hooks` (`useProtocol`, `useUser`, `useStake`, `useUnstake`, `useBond`, `useClaim`, `isMock`). Pure helpers from `../protocol/math` and types from `../protocol/types` are fine. Never import an adapter. Never hard-code numbers the snapshot already has.
2. All hooks first, then the loading guard (`if (!p || !user) return <div className="window-content muted">Loading…</div>`), then render. No hooks after an early return.
3. Every mutation goes through `dialogs.runTx({ title, text, action: () => m.mutateAsync(vars), success })` from `../shell/dialogStore`. Confirmations: `dialogs.confirm`, errors: `dialogs.error`, info: `dialogs.info`, notification: `dialogs.balloon(title, text, pose?)`. Notifications are spoken by the Kid (the pixel helper, bottom right); pass pose `'shrug'` for wins, `runTx` already does (poses: `idle shrug point wave shadesUp`; titled notifications point by default; a 4th argument adds clickable options to the bubble). If the user hid him they fall back to a tray balloon. Open another window with `useWindowStore.getState().open('bond')` from `../shell/windowStore` (ids are in `apps.ts`).
4. Root structure: optional `<MenuBar />`, then `<div className="window-content stack">…</div>` (add `flush` for edge-to-edge), then optional `<StatusBar>`. The Window shell supplies the title bar; do not draw one.
5. Use the kit from `../ui`: `StatTile` (variants `dark`, `red`; `tone` up/down), `KV`, `Tabs`, `AmountInput`, `ListView`, `ProgressBar` (tones `red`, `gold`; `marquee`), `Callout` (`warn`), `Countdown`, `IconTile`, `MenuBar`, `StatusBar`, `useNow`, and formatters `fmtUsd fmtNum fmtPct fmtSignedPct fmtSignedUsd fmtCompact fmtCountdown fmtDuration fmtDay toneOf shortAddr parseAmount`. Charts: `import { AreaChartXP, DonutXP } from '../ui/Chart'` (not from the barrel).
6. CSS classes available: `btn`, `btn small`, `btn-primary` (green CTA), `btn-danger`, `field`, `stack`, `row`, `row between`, `grow`, `stat-grid`, `section-title`, `chart-frame`, `callout`, `muted`, `up`, `down`, `num`, plus native `<fieldset><legend>`. Need more? Create `src/apps/<Name>.css`, import it from your component, prefix every class with your app id (`.treasury-…`), and use the CSS variables from `tokens.css` (no new hex colours except chart series). Never edit `src/styles/*`, `src/ui/*`, `src/shell/*` or `src/protocol/*` from an app task; report gaps instead.
7. Responsive: windows are full-screen under 768px and can be as narrow as 320px. No fixed widths above 280px; multi-column layouts must collapse (`flex-wrap` or a media query); wide tables live in `ListView` (it scrolls itself).
8. Fractions are fractions: `discount: 0.085`, `apy: 26.8`. Format with `fmtPct`. Timestamps are ms.

## Copy tone
Degen, self-aware, dumb-money humour (apes, tendies, diamond hands, paper hands), but mechanics and risk are stated plainly and correctly. Never promise or imply guaranteed returns; APY is "current rate projected", bonds "dilute holders to grow the treasury", the 3x long "can be liquidated". Mention "simulated"/"demo" only when `isMock`. No em dashes in UI copy.

## IP guardrails
Original assets only. No Microsoft logos, Bliss photo or sounds; no GameStop logo or wordmark as branding (the ticker GME is fine); no real people by name or likeness (no Roaring Kitty / DFV / Ryan Cohen / Keith Gill). Parody names for XP programs are fine ("Internet Exploder"). The Kid is ORIGINAL pixel art drawn in `kidSprite.ts` as a homage: never import, trace or pixelate the actual wallstreetbets mascot artwork, and do not use the wallstreetbets wordmark as branding. His desktop-assistant styling (legal pad, eyebrows, "It looks like you're trying to..." offers) borrows the genre only: never draw or name the Microsoft paperclip. His lines (`kidLines.ts`) may mention GME, GameStop, wallstreetbets and the MOASS, under the same copy rules as everything else.
