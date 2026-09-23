// The founding offering. Three states, and the window is whichever one applies:
// open (subscribe), failed (refund), finalized (claim your vested shares).
import { useState } from 'react'
import { QUOTE, TOKEN } from '../config'
import { isMock, useGenesisClaim, useGenesisPurchase, useGenesisRefund, useProtocol, useUser } from '../protocol/hooks'
import { dialogs } from '../shell/dialogStore'
import { useWindowStore } from '../shell/windowStore'
import { AmountInput, Callout, Countdown, KV, ProgressBar, StatTile, StatusBar, fmtNum, fmtPct, fmtUsd, parseAmount } from '../ui'

export default function Genesis() {
  const { data: p } = useProtocol()
  const { data: user } = useUser()
  const purchase = useGenesisPurchase()
  const claim = useGenesisClaim()
  const refund = useGenesisRefund()
  const [amount, setAmount] = useState('')

  if (!p || !user) return <div className="window-content muted">Loading the offering…</div>

  const g = p.genesis
  if (!g) {
    return (
      <div className="window-content stack">
        <Callout icon="📜">
          The founding offering is over. The fund is live, so the way in now is the open market or a bond.
        </Callout>
        <button type="button" className="btn-primary" onClick={() => useWindowStore.getState().open('buy')}>
          BUY {TOKEN.symbol}
        </button>
      </div>
    )
  }

  const gmeUsd = p.gme.priceUsd
  const mine = user.genesis
  const progress = g.hardCapGme > 0 ? g.raisedGme / g.hardCapGme : 0
  const minProgress = g.hardCapGme > 0 ? g.minRaiseGme / g.hardCapGme : 0
  const metMinimum = g.raisedGme >= g.minRaiseGme
  const roomLeft = Math.max(0, Math.min(g.walletCapGme - mine.contributedGme, g.hardCapGme - g.raisedGme))

  const n = parseAmount(amount)
  const overCap = n > roomLeft
  /** Short of balance is a missing prerequisite, not a failed transaction. */
  const short = Math.max(0, Math.min(n, roomLeft) - user.balances.GME)
  const tooMuch = n > Math.min(user.balances.GME, roomLeft)
  const priceUsd = g.priceGme * gmeUsd
  const youGet = g.priceGme > 0 ? n / g.priceGme : 0

  const subscribe = async () => {
    const ok = await dialogs.runTx({
      title: 'Subscribing…',
      text: `Committing ${fmtNum(n, 3)} ${QUOTE.symbol} for ${fmtNum(youGet, 4)} ${TOKEN.symbol}`,
      action: () => purchase.mutateAsync(n),
      success: `You are on the founding register for ${fmtNum(youGet, 4)} ${TOKEN.symbol}. Certificate minted.`,
    })
    if (ok) setAmount('')
  }

  const doClaim = async () => {
    await dialogs.runTx({
      title: 'Claiming…',
      text: `Releasing ${fmtNum(mine.claimableMoass, 4)} ${TOKEN.symbol} from the vest`,
      action: () => claim.mutateAsync(),
      success: `Claimed ${fmtNum(mine.claimableMoass, 4)} ${TOKEN.symbol}. Go stake it.`,
    })
  }

  const doRefund = async () => {
    const sure = await dialogs.confirm(
      'Take the refund',
      `The offering missed its minimum, so nothing launched. This returns your ${fmtNum(mine.contributedGme, 3)} ${QUOTE.symbol} in full.`,
      'Refund me',
      'Wait',
    )
    if (!sure) return
    await dialogs.runTx({
      title: 'Refunding…',
      text: `Returning ${fmtNum(mine.contributedGme, 3)} ${QUOTE.symbol}`,
      action: () => refund.mutateAsync(),
      success: 'Refunded in full. No harm done.',
    })
  }

  return (
    <>
      <div className="window-content stack">
        <div className="stat-grid">
          <StatTile variant="dark" label="Price" value={fmtUsd(priceUsd)} sub={`${fmtNum(g.priceGme, 3)} ${QUOTE.symbol} per ${TOKEN.symbol}`} />
          <StatTile variant="red" label={g.finalized ? 'Closed' : 'Closes in'} value={g.finalized ? 'Funded' : <Countdown to={g.deadline} />} sub={`${g.shareholders} on the register`} />
          <StatTile label="Raised" value={fmtUsd(g.raisedGme * gmeUsd)} sub={`${fmtNum(g.raisedGme, 0)} of ${fmtNum(g.hardCapGme, 0)} ${QUOTE.symbol}`} tone={metMinimum ? 'up' : undefined} />
        </div>

        <fieldset>
          <legend>Subscription</legend>
          <ProgressBar value={progress} tone={metMinimum ? 'gold' : 'red'} label={`${fmtPct(progress, 0)} of the hard cap`} />
          <div className="row between muted" style={{ marginTop: 4 }}>
            <span>Minimum to launch: {fmtNum(g.minRaiseGme, 0)} {QUOTE.symbol} ({fmtPct(minProgress, 0)})</span>
            <b className={metMinimum ? 'up' : 'down'}>{metMinimum ? 'Minimum met' : `${fmtNum(g.minRaiseGme - g.raisedGme, 0)} ${QUOTE.symbol} short`}</b>
          </div>
        </fieldset>

        {mine.contributedGme > 0 && (
          <fieldset>
            <legend>Your position</legend>
            <KV
              rows={[
                ['Subscribed', `${fmtNum(mine.contributedGme, 3)} ${QUOTE.symbol} (${fmtUsd(mine.contributedGme * gmeUsd)})`],
                ['Founding shares', `${fmtNum(mine.purchasedMoass, 4)} ${TOKEN.symbol}`],
                ['Claimable now', `${fmtNum(mine.claimableMoass, 4)} ${TOKEN.symbol}`],
              ]}
            />
          </fieldset>
        )}

        {g.failed ? (
          <>
            <Callout icon="⚠️" warn>
              The offering closed below its minimum of {fmtNum(g.minRaiseGme, 0)} {QUOTE.symbol}, so the fund never started. Every wallet takes its own money back. Nothing was minted and nothing was spent.
            </Callout>
            <button type="button" className="btn-danger" disabled={mine.contributedGme <= 0} onClick={doRefund}>
              {mine.contributedGme > 0 ? 'CLAIM REFUND' : 'NOTHING TO REFUND'}
            </button>
          </>
        ) : g.finalized ? (
          <>
            <Callout icon="🎉">
              Funded and live. Founding shares release evenly over {g.vestDays} days from close, so claim as often as you like.
            </Callout>
            <button type="button" className="btn-primary" disabled={mine.claimableMoass <= 0} onClick={doClaim}>
              {mine.claimableMoass > 0 ? `CLAIM ${fmtNum(mine.claimableMoass, 4)} ${TOKEN.symbol}` : 'NOTHING VESTED YET'}
            </button>
          </>
        ) : (
          <div className="stack">
            <AmountInput label={`Amount to subscribe`} value={amount} onChange={setAmount} symbol={QUOTE.symbol} max={Math.min(user.balances.GME, roomLeft)} />
            <KV
              rows={[
                ['You receive', `${fmtNum(youGet, 4)} ${TOKEN.symbol}`],
                ['Vesting', `${g.vestDays} days, linear, from the day it closes`],
                ['Wallet cap', `${fmtNum(g.walletCapGme, 0)} ${QUOTE.symbol}, you have ${fmtNum(roomLeft, 3)} left`],
                ['Also minted', 'A founding shareholder certificate, non transferable'],
              ]}
            />
            {short > 0 && (
              <Callout icon="🛒" warn>
                You are {fmtNum(short, 3)} {QUOTE.symbol} short of that ({fmtUsd(short * gmeUsd)}). You can bring
                funds from another chain and they arrive as {QUOTE.symbol}.
                <div style={{ marginTop: 6 }}>
                  <button type="button" className="btn small" onClick={() => useWindowStore.getState().open('getgme')}>
                    GET {QUOTE.symbol}
                  </button>
                </div>
              </Callout>
            )}
            <button type="button" className="btn-primary" disabled={n <= 0 || tooMuch} onClick={subscribe}>
              {overCap ? 'Over your wallet cap' : short > 0 ? `Need ${fmtNum(short, 3)} more ${QUOTE.symbol}` : `SUBSCRIBE ${fmtNum(n, 3)} ${QUOTE.symbol}`}
            </button>
          </div>
        )}

        <Callout icon="⚠️" warn>
          You are buying before there is a market. Nothing trades until the offering closes and the pool is seeded, and the price is fixed, not discovered. If the raise misses {fmtNum(g.minRaiseGme, 0)} {QUOTE.symbol} you get refunded and nothing launches. If it succeeds, {fmtPct(0.7, 0)} of the money becomes treasury and the rest becomes liquidity you do not own. The treasury runs a 2x {QUOTE.symbol} long that <b>can be liquidated</b>.
          {isMock && ' This is a simulated offering, so none of it is real.'}
        </Callout>
      </div>
      <StatusBar>
        <span>{g.shareholders} founding shareholders</span>
        <span>{fmtPct(progress, 0)} subscribed</span>
        <span>{QUOTE.symbol} {fmtUsd(gmeUsd)}</span>
      </StatusBar>
    </>
  )
}
