# Moass Fund XP

Moass Fund: an OHM-style reserve protocol on Robinhood Chain (id 4663), token
MOASS / sMOASS, paired with tokenised GME, treasury running a leveraged GME
position. The UI is a Windows-XP desktop.

The contracts are written and tested but **not deployed to any public network
yet**. Run them locally in one command, or start the desktop on simulated data
and it shows a DEMO badge while it does.

```
npm run bootstrap    # once: checks the toolchain, installs, compiles, makes .env
npm start            # local chain + protocol deployed + desktop, all of it
```

`npm start` brings up a throwaway chain, deploys the contracts onto it, runs the
genesis sale so the protocol is actually switched on, and serves the desktop
pointed at it. Real contracts, real transactions, real wallet flow — no testnet,
no faucet, no network. It prints a funded private key to import. Ctrl-C stops
everything it started.

```
npm start -- --mock  # just the desktop on simulated data
npm run check        # typecheck, both test suites, ABI drift check, build
npm run indexer:dry  # read the chain and print, writing nothing
```

## Deploying

```
npm run deploy               asks which chain
npm run deploy -- --testnet  Robinhood testnet (46630)
npm run deploy -- --mainnet  Robinhood Chain (4663)
```

It checks everything before broadcasting anything — the deployer key, the chain,
the multisig addresses, that all six external contracts really exist, and that
there is enough ETH. Mainnet additionally makes you type the word `deploy`.

Afterwards it writes `contracts/deployments/<chainid>.json` and a ready-made
`.env.testnet` or `.env.mainnet` to copy over `.env`.

**Testnet has no tokenised GME and no Uniswap**, so a testnet deploy brings its
own stand-ins. Mechanics are identical, the assets are not real. Mainnet uses
the live ones, which are checked on chain before the run starts.

Set these in `.env` first:

```
DEPLOYER_PRIVATE_KEY=   the ONLY account used; wiring is locked to it
GUARDIAN=               multisig that may register taxed pairs
TEAM_WALLET=            multisig holding pTEAM and running the desk
DESK_VENUE=             where the desk may send GME. IMMUTABLE after deploy
```

The deployment is all-or-nothing on purpose: every `wire()` call is restricted
to the address that created the contract and can be called exactly once, so a
run that dies halfway leaves contracts that can never be wired. There is no
resume, only redeploy at fresh addresses. Deployment costs about **0.003 ETH**.

Then, in order: run the sale, call `GenesisBond.finalize()` (the switch that
seeds the pool and turns on staking, bonds and the tax — this is when the token
becomes tradeable), and start the keeper.

## Poking at the local stack

The protocol runs on an 8-hour clock and vests bonds over two days, so on a
fresh chain nothing visibly happens no matter how long you wait. These push it
along while `npm start` is running:

```
npm run local fund <address>   give any account MOASS, GME, USDG and gas
npm run local advance [n]      skip n epochs and rebase — watch staking balances grow
npm run local vest             skip 2 days so bonds become claimable
npm run local open             open a 3x position so the Treasury window has something in it
npm run local close [pnl]      close it, e.g. `close 30` for +30%, `close -100` for a wipeout
npm run local gme <price>      move the GME price, e.g. `gme 40` — every dollar figure follows
npm run local status           what the protocol currently thinks
```

`fund` is the quickest way in: connect whatever wallet you already use, add the
network (chain id 31337, RPC `http://127.0.0.1:8545`), then run
`npm run local fund 0xYourAddress`.

Worth knowing while testing: **stakers earn far more than the emission rate**
when little is staked, because each epoch's reward is minted against total
supply but shared only among the staked float. With 500 of 6,500 MOASS staked,
a 0.145%/epoch emission shows up as roughly 1.9%/epoch for the staker. That is
real OHM behaviour, not a bug, and it is why the adapter derives the rate from
`epoch.distribute / circulatingSupply` rather than reading the distributor.

Stack: Vite, React 18, TypeScript, zustand, wagmi 2 + viem, TanStack Query, recharts. No CSS framework: `src/styles/*` is hand-written and driven by the variables in `tokens.css`.

## The contracts

They live in [`contracts/`](contracts/) and they are written. `forge test` runs
339 tests across 15 suites, including a fork test that deploys the whole
protocol against **live Robinhood Chain** using the real tokenised GME, the real
USDG and the real Uniswap V2 factory.

Moass Fund is a fork of **NetNet Capital ($NET)**, whose contracts are verified
on Sourcify with exact matches. `contracts/reference/` holds their source
untouched; `contracts/src/` is ours. `diff -r contracts/reference/src
contracts/src` is the complete statement of everything we changed, and it is the
right thing to hand an auditor. See [`contracts/SOURCE.md`](contracts/SOURCE.md)
for provenance and the AGPL obligation — **our contracts must be published**.

```
contracts/
  reference/   NetNet's source, verified byte-identical to what is deployed
  src/         our fork: the same contracts renamed, plus GmeDesk
  test/        336 tests, including fork tests against chain 4663
  script/      Deploy.s.sol (the wiring) and Launch.s.sol (the runner)
  tools/       fetch, verify-upstream, verify-rename, check-abis
```

Only one contract is new: **`GmeDesk`**, the leveraged sleeve. It occupies the
slot NetNet used for a Morpho lending vault, presents the same ERC-4626 surface,
and so needs no change to the Treasury at all.

### The one thing to understand: everything is denominated in GME

NetNet's reserve is USDG, a stablecoin, so one reserve unit is one dollar and
backing per token is a floor that only moves up.

**Our reserve is GME.** The contracts did not need changing for that — they
derive every decimal factor from `decimals()` at construction and treat the
reserve asset, not the dollar, as the unit of account. But the consequences are
real and the UI states them:

- `backingPerToken()` is **GME per MOASS**, not dollars. Every dollar figure on
  screen is that number converted at the live GME price, which the adapter reads
  from the GME/USDG Uniswap **V3** pool (the deep GME market on this chain is
  V3, not V2 — this caught us once).
- **There is no floor in the OHM sense.** When GME falls, backing falls with it.
  A liquidated desk position takes its collateral with it.

### The protocol needs a keeper

This is not optional and it is easy to miss. A TWAP is only readable from an
observation aged **30 minutes to 4 hours**, but `Staking.rebase()` only runs
every 8 hours. Left alone, the newest observation is always 8 hours old —
permanently out of band — so **emissions mint zero and bonds refuse to price.**

Something must call `PairOracle.checkpoint()` at least every 4 hours. It is
permissionless and rate-limited on chain, so calling it too often is harmless.
`indexer/snapshot.mjs` does it hourly, alongside writing chart history.

### Deploying

```
cd contracts
forge test                                    # everything, including fork tests
forge script script/Launch.s.sol --rpc-url robinhood            # dry run
forge script script/Launch.s.sol --rpc-url robinhood --broadcast
```

The script prints the `VITE_ADDR_*` block to paste into `.env`. A full
deployment costs roughly **0.003 ETH**. Then run the sale, call
`GenesisBond.finalize()` — the single switch that enables staking, bonds and the
tax at once — and start the keeper.

## Data the contracts cannot provide

Two things have no on-chain source, and both are handled without a server:

- **Chart history.** `ProtocolSnapshot.history` wants one point per epoch for 30
  days; contracts only know the present. `indexer/snapshot.mjs` appends a point
  and `.github/workflows/history.yml` runs it hourly and commits
  `public/history.json`, which ships as a static file. If it stops, the charts
  say "no history yet" and everything else keeps working.
- **The desk's mark, PnL, liquidation price and health.** `GmeDesk` stores the
  position's terms but values itself **at cost**, deliberately: backing must not
  move with a price feed. The adapter derives the live figures from those stored
  terms plus the GME price.

## Parameters still to decide

Every tunable lives in one file, [`contracts/src/Constants.sol`](contracts/src/Constants.sol),
marked `TUNE`. The values inherited from NetNet work but are denominated in GME
now, which changes what they mean:

| Constant | Inherited | What it means with a GME reserve |
|---|---|---|
| `GENESIS_PRICE_WAD` | 3 | 3 GME per MOASS, so roughly $70 a token at launch |
| `GENESIS_HARD_CAP_WAD` | 50,000 | 50,000 GME, roughly $1.2M |
| `GENESIS_MIN_RAISE_WAD` | 15,000 | 15,000 GME, roughly $350k |
| `PTEAM_STRIKE_WAD` | 1 | team pays 1 GME per MOASS, not $1 |
| `MORPHO_CAP_BPS` | 7000 | **70% of reserves can sit in a 3x position.** Sized for a lending vault, not leverage — this one deserves a hard look |
| `MORPHO_HAIRCUT_BPS` | 200 | 2% prudence markdown, likewise sized for lending |
| `BOND_VEST` / `BOND_DISCOUNT_BPS` | 2 days / 3% | the UI copy now matches these |

Also open: whether to keep `InverseBond` (the buyback bid at backing × 0.985),
the size of the pTEAM allocation, and the tax split — which **starts at 80% to
the team wallet** and decays to zero over 30 days.

## Assumptions the UI had, and how they turned out

The front end was built before the contracts existed. Most guesses were right:
8-hour epochs, no staking warm-up, multiple simultaneous bonds per user. These
did not survive and have been fixed:

- **The 5% trading tax** was mentioned nowhere. It is now a real field on
  `ProtocolSnapshot` and appears in Buy and the Prospectus.
- **Bond capacity is per epoch**, not per day. "Left today" is now "Left this
  epoch".
- **`redeem()` sweeps every ripe note.** There is no per-note redemption on
  chain, so "Claim selected" is gone and one honest "Claim all vested" remains.
- **Bonds are floored at backing**, so the discount can vanish. Bonding at or
  above market now warns instead of showing a green CTA.
- `ProgressBar` rendered `width: "NaN%"` against a zeroed genesis epoch.
- Empty charts rendered as blank boxes rather than saying there is no data yet.

## Still not built

- WalletConnect works but needs a project id in `VITE_WALLETCONNECT_PROJECT_ID`;
  without one, injected browser wallets still work and mobile wallets do not
  appear.
- No windows for `InverseBond` (sell back at the floor) or `GenesisBond` (the
  launch sale). Both are live contracts with no UI.
- No OG image. The tags are in `index.html` and ship a text card; drop a
  1200x630 `public/og.png` in and uncomment two lines for the full-width one.
- `LINKS` in `src/config.ts` is still empty, so socials render as "(soon)".
- No external audit of our diff against NetNet's originals.

## App structure
- `src/shell/`  desktop, window manager (`windowStore.ts`), app registry (`apps.ts`), dialogs (`dialogStore.ts`)
- `src/apps/`   one default-exported component per window; `Stake.tsx` is the reference pattern
- `src/ui/`     UI kit (`kit.tsx`), formatters, chart wrappers
- `CLAUDE.md`   the conventions the windows were built against (useful for humans too)

Deep links: `/#stake`, `/#bond`, `/#treasury`, `/#calculator`, `/#buy`, `/#prospectus`, `/#overview`.

## The Kid (helper)
A pixel desktop assistant in the classic style, standing on a sheet of yellow legal pad at the bottom right (`src/shell/Helper.tsx`). He speaks every `dialogs.balloon()` notification, throws out a line every 45 to 90 seconds, sometimes comments on the window you just opened, answers pokes, and ducks behind the taskbar when quiet. He also offers help the old-assistant way ("It looks like you're trying to...") with clickable answers that open a window or make him explain the mechanic. Five poses (`design/kid-poses.png`): `idle`, `shrug` (wins: stake, bond, claim, rebase), `point` (any notification with a title), `wave` (his first line; two frames), `shadesUp` (big eyes; confirm dialogs, and now and then on his own). Eyebrows pop up above the shades when he reacts (`up`, `skeptic`, `worried` for error dialogs). Users can hide him from his x or the Start menu (remembered in localStorage); notifications then fall back to a classic tray balloon.
- Art: `kidSprite.ts`, text rows of one char per pixel, rendered as SVG rects. Original artwork, see the IP note. A head, a torso, and arm/hand fragments that are placed on either side (mirrored automatically). New pose = a fragment or two + an entry in `KidPose` and `KID_FRAMES` (two frames = a looping animation). `kidSprite.test.ts` checks every frame's dimensions, palette and symmetry, so a miscounted row fails the build instead of shipping a bent sprite.
- Lines: `kidLines.ts`. A bare string gets a random pose, `[text, pose]` pins one, `{ text, pose, options }` is an offer whose options can `open` a window and/or `reply` with another line. Same copy rules as the rest of the app: no promised returns, risk facts stay true, no real people.

## Wallpaper
Configured by `WALLPAPER` in `src/config.ts`. `WALLPAPER.crt` picks the treatment:
- **`'animated'`** (built, currently off: it read as distracting behind the windows): `moass-bg-clean.webp` is painted three times, each multiplied down to one colour channel and screen-blended back together (`.wallpaper-rgb` in `src/styles/desktop.css`). Disjoint channels rebuild the exact picture, so nudging red and blue apart is a true RGB split that drifts and occasionally glitches. Plus crawling scanlines, a sub-3% flicker and a rolling band. Only `transform` / `opacity` animate, in discrete steps, so it is compositor-only; all of it is disabled under `prefers-reduced-motion`. If a low-end phone struggles, switch to `'static'`.
- **`'static'` (current):** `moass-bg.webp`, which has the split baked in by `design/rgb-split.cjs` (`npm i -D sharp`, then `node design/rgb-split.cjs <source image> [maxWidth] [shiftPx] [radial]`), with still scanlines.
- **`'off'`:** the plain image.

`WALLPAPER.dim` (0 to 1, currently 0.74) lays a near-black veil over picture and CRT so the artwork is a faint presence rather than competing with the windows. Lower it to bring the rocket and moon forward.

The wallpaper layers sit behind everything: icons and windows are never filtered or dimmed.

`WALLPAPER.focus` / `focusMobile` are CSS `object-position` values: which part of the image survives cropping on wide screens and on phones. The original vector wallpaper (`sky.svg` + `art.svg`, flattened copies in `design/`) is still there as a fallback; the config comment shows the values. Safe zones for any new artwork: icons own the left ~110px, the taskbar the bottom 38px, windows open centre-left, so keep focal art right of centre.

## Deploy

Static site, no server and no database. [`vercel.json`](vercel.json) is set up:
connect the repo, set the environment variables from `.env.example`, deploy.
Cloudflare Pages, Netlify and IPFS work identically.

Deep links are hash-based (`/#stake`), so no SPA rewrite is strictly needed —
the config includes one anyway, plus cache headers so hashed assets cache for a
year while `index.html` never goes stale.

## IP note
All artwork is original. Do not add Microsoft logos / Bliss / sounds, the GameStop logo or wordmark, or real people's names or likenesses. The Kid is a hand-drawn homage: do not swap in the actual wallstreetbets mascot image or use that wordmark as branding. His assistant styling (legal pad, eyebrows, offer bubbles) borrows a genre, not a character: do not add the Microsoft paperclip or its name.
