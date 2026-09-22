import { CHAIN, QUOTE, STABLE, TOKEN } from '../config'
import { isMock, useProtocol } from '../protocol/hooks'
import type { ProtocolSnapshot } from '../protocol/types'
import { MenuBar, StatusBar, fmtNum, fmtPct, fmtUsd } from '../ui'
import './Prospectus.css'

const M = TOKEN.symbol
const S = TOKEN.staked
const G = QUOTE.symbol

/** Heading as a .txt file would do it: caps line with a rule underneath. */
const h = (title: string, rule = '=') => `${title}\n${rule.repeat(title.length)}`

function buildText(p: ProtocolSnapshot) {
  const epochHours = p.epoch.lengthSec / 3600
  const lev = p.treasury.long.leverage
  const vest = [...new Set(p.bonds.map((b) => b.vestDays))].sort((a, b) => a - b)
  const vestText = vest.length > 1 ? `${vest[0]} to ${vest[vest.length - 1]} days` : `${vest[0] ?? 'a few'} days`
  const payWith = [...new Set(p.bonds.map((b) => b.asset))].join(', ') || `${G}, LP, ${STABLE.symbol}`
  const holdings = p.treasury.positions.map((x) => `  - ${x.label}: ${fmtUsd(x.valueUsd)}`).join('\n')

  return `${h(`${TOKEN.name.toUpperCase()} PROSPECTUS.TXT`)}
Read this before you ape. It is short on purpose.${isMock ? '\nDemo build: every number below is simulated.' : ''}

${h('WHAT THIS IS')}
${TOKEN.name} is an OHM fork on ${CHAIN.name}. ${M} is paired with tokenized ${G}, and the treasury runs a ${lev}x ${G} long.

Why: every other ${G}-paired coin is the same meme playing the same PvP for the same exit liquidity. A reserve protocol is a different game. It mints supply, sells some of it for assets, and ends up backed by a treasury instead of only its own LP.

${h('EMISSIONS')}
New ${M} is minted every epoch. One epoch is ${fmtNum(epochHours, 0)} hours. The new supply goes two places: staking rewards and bonds. That is the whole machine.

${h('STAKING')}
Stake ${M} 1:1 for ${S}. No fee, no lockup. Every epoch your ${S} balance rebases up by the reward rate. Right now that is ${fmtPct(p.rebaseRate, 3)} per epoch, which projects to ${fmtPct(p.apy, 0)} APY if it held for a year. It will not hold. The rate is dynamic and follows the premium: fat premium, more emissions; thin premium, fewer.

${h('BONDING')}
Bonds sell ${M} below market. You pay with ${payWith}. The payout vests linearly over ${vestText}, claimable as it vests. What you pay goes to the treasury, not the LP. Be clear on the trade: bonds dilute current holders to grow the treasury. Stakers get rebases that offset it. Unstaked bags just get diluted.

${h('TRADING TAX')}
Every buy and sell through a registered pool pays ${fmtPct(p.tradingTax, 0)}, taken in ${M}. Wallet-to-wallet transfers are free, and so is staking, bonding and claiming. The tax is swapped and sent to the treasury, which means trading volume grows backing. Early on a share of it also goes to the team wallet, decaying to zero over the first thirty days, after which all of it goes to the treasury. The rate is fixed in the contract and there is no function to raise it.

${h('THE TREASURY')}
Total ${fmtUsd(p.treasury.totalUsd)}. It holds:
${holdings}

The core position is the ${lev}x ${G} long. ${G} up 10% means position equity up roughly ${fmtNum(10 * lev, 0)}%. ${G} down 10% means down roughly ${fmtNum(10 * lev, 0)}%. If ${G} falls to the liquidation price (now ${fmtUsd(p.treasury.long.liqPrice)}, mark ${fmtUsd(p.treasury.long.markPrice)}) the position is closed and its collateral is gone.

Who runs it: the team multisig, not an algorithm. The desk contract can only send funds to venues fixed when it was deployed, and can only return them to the treasury, so nobody can withdraw it elsewhere. Within that, a bad trade still loses the sleeve. The treasury also caps how much of reserves can sit there at all. Backing counts that collateral at what it cost, never at what it is currently worth, so a winning position does not inflate backing until it is closed, and a losing one shows up the moment it is.

  Backing per ${M} = treasury / supply = ${fmtUsd(p.backingUsd)}
  Premium = price / backing = ${fmtNum(p.premium, 2)}x
  Runway = days the treasury can cover the current reward rate = ${fmtNum(p.runwayDays, 0)} days

${h('RISKS')}
1. Liquidation. A sharp ${G} drop can erase the leveraged slice of backing fast, faster than anyone can react.
2. Dilution. Emissions never stop. If you hold ${M} without staking, your share of supply shrinks every epoch.
3. APY is a projection of the current rate, not a promise. It falls as supply grows and as the premium shrinks.
4. Price. ${M} can trade far below where you bought, including below backing. Backing is an accounting number, not a redemption right.
5. Smart contract and chain risk. Forked code can still have bugs. ${CHAIN.name} is new. Funds can be lost.
6. Issuer risk. Tokenized ${G} is a claim on its issuer, not a share in your name. If the issuer fails or freezes, the treasury takes the hit.
7. This is a meme fund. Size accordingly. Only put in what you can lose entirely.
8. Nothing here is financial advice.

${h('FAQ')}
Q: Is the APY real?
A: The rebases are real ${M}. Whether ${M} is worth anything in dollars is up to the market.

Q: Can I redeem ${M} for backing?
A: No. Backing tells you what the treasury holds per token. It is not a floor. The protocol does stand a buyback bid slightly below backing, but it is capped per epoch and can be withdrawn, so do not treat it as an exit.

Q: Is backing in dollars?
A: No. The treasury holds ${G}, so backing is ${G} per ${M}. The dollar figures on these screens are that number converted at the current ${G} price. When ${G} falls, backing falls with it. An ordinary reserve currency is backed by stablecoins and has a floor that only moves up. This one does not.

Q: Bond or stake?
A: Bond when the discount beats what staking would pay over the vesting period. Otherwise stake.

Q: What happens if the long gets liquidated?
A: Backing drops by that position's equity. The rest of the treasury and the protocol keep running.

${h('END OF FILE', '-')}
`
}

export default function Prospectus() {
  const { data: p } = useProtocol()

  if (!p) return <div className="window-content muted">Opening Prospectus.txt…</div>

  const text = buildText(p)

  return (
    <>
      <MenuBar items={['File', 'Edit', 'Format', 'View', 'Help']} />
      <div className="window-content flush">
        <article className="prospectus-page">{text}</article>
      </div>
      <StatusBar>
        <span>Ln 1, Col 1</span>
        <span>{fmtNum(text.split(/\s+/).filter(Boolean).length, 0)} words</span>
        <span>Word Wrap: On</span>
      </StatusBar>
    </>
  )
}
