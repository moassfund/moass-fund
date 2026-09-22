import { useState } from 'react'
import { LINKS, QUOTE, TOKEN } from '../config'
import { isMock, useProtocol, useUser } from '../protocol/hooks'
import { dialogs } from '../shell/dialogStore'
import { useWindowStore } from '../shell/windowStore'
import { AmountInput, Callout, KV, MenuBar, StatusBar, fmtNum, fmtPct, fmtUsd, parseAmount } from '../ui'
import './Buy.css'

const NAV = ['⬅️ Back', '➡️ Forward', '🛑 Stop', '🔄 Refresh', '🏠 Home']
// Widened on purpose: LINKS is `as const`, so the empty placeholders would narrow to never.
const DEX_URL: string = LINKS.dex
const TOKEN_ADDRESS: string = LINKS.tokenAddress

export default function Buy() {
  const { data: p } = useProtocol()
  const { data: user } = useUser()
  const [amount, setAmount] = useState('')

  if (!p || !user) return <div className="window-content muted">Dialing up…</div>

  const pay = parseAmount(amount)
  const gross = p.priceGme > 0 ? pay / p.priceGme : 0
  // Buying from the pool is a taxed leg, so the tokens that actually land are
  // net of it.
  const tax = gross * p.tradingTax
  const receive = gross - tax
  const bestBond = p.bonds
    .filter((b) => b.discount > 0 && b.remainingMoass > 0)
    .sort((a, b) => b.discount - a.discount)[0]

  const swap = () => {
    if (DEX_URL) {
      window.open(DEX_URL, '_blank', 'noopener,noreferrer')
      return
    }
    void dialogs.info(
      'The page cannot be displayed',
      `The ${TOKEN.symbol} / ${QUOTE.symbol} pool is not live yet, so there is nothing to swap against.\n\nWhen it launches, this button opens the real DEX in a new tab. Until then, anyone selling you ${TOKEN.symbol} is selling you something else.`,
    )
  }

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(TOKEN_ADDRESS)
      dialogs.balloon('Copied', 'Contract address is on your clipboard. Check it twice anyway.')
    } catch {
      void dialogs.error('Copy failed', 'Your browser blocked clipboard access. Select the address and copy it by hand.')
    }
  }

  return (
    <>
      <MenuBar items={['File', 'Edit', 'View', 'Favorites', 'Tools', 'Help']} />
      <div className="buy-toolbar" aria-hidden="true">
        {NAV.map((n) => <button key={n} type="button" className="btn small" disabled tabIndex={-1}>{n}</button>)}
      </div>
      <div className="buy-address">
        <span className="muted">Address</span>
        <input className="field" readOnly aria-label="Address" value={DEX_URL || 'about:pool-not-live-yet'} />
        <button type="button" className="btn small" onClick={swap}>Go</button>
      </div>

      <div className="window-content flush buy-page">
        <div className="buy-page-inner">
          <div className="buy-banner">
            <h2>Buy ${TOKEN.symbol} with {QUOTE.symbol}</h2>
            <div className="muted">Best viewed in Internet Exploder at 800x600. This page only estimates. It never moves your balances.</div>
          </div>

          <div className="buy-card stack">
            <AmountInput label="You pay" value={amount} onChange={setAmount} symbol={QUOTE.symbol} max={user.balances.GME} />
            <div className="buy-receive">
              <span className="muted">You receive (estimate)</span>
              <b>{fmtNum(receive, 4)} {TOKEN.symbol}</b>
            </div>
            <KV
              rows={[
                ['Pool price', `${fmtNum(p.priceGme, 6)} ${QUOTE.symbol} (${fmtUsd(p.priceUsd)})`],
                ...(p.tradingTax > 0
                  ? [[`Trading tax (${fmtPct(p.tradingTax, 0)})`, `-${fmtNum(tax, 4)} ${TOKEN.symbol}`] as [string, string]]
                  : []),
                ['Worth about', fmtUsd(receive * p.priceUsd)],
              ]}
            />
            <button type="button" className="btn-primary" onClick={swap}>SWAP ON DEX</button>
            <div className="muted">
              {p.tradingTax > 0 ? (
                <>Every buy and sell through the pool pays a {fmtPct(p.tradingTax, 0)} tax, already subtracted above. It goes to the treasury, not to us. Moving {TOKEN.symbol} between wallets is free. On top of that, AMM buys move the price against you and pay the pool fee: bigger order, worse fill.</>
              ) : (
                <>AMM buys move the price against you, and an ordinary buy pays the pool fee. Bigger order, worse fill. The number above ignores both.</>
              )}
            </div>
          </div>

          <div className="stack">
            <fieldset className="stack">
              <legend>Cheaper route</legend>
              {bestBond ? (
                <div>
                  Bond Desk is <b className="up">{fmtPct(bestBond.discount)}</b> below market right now ({bestBond.icon} {bestBond.label}), vested over {bestBond.vestDays} days. Your money goes to the treasury instead of the pool, and the new {TOKEN.symbol} dilutes holders to grow the backing.
                </div>
              ) : (
                <div className="muted">No bond is below market right now. The pool is the only route, ape responsibly.</div>
              )}
              <button type="button" className="btn" onClick={() => useWindowStore.getState().open('bond')}>🏦 Open Bond Desk</button>
            </fieldset>

            <fieldset className="stack">
              <legend>Contract</legend>
              {TOKEN_ADDRESS ? (
                <div className="row">
                  <span className="grow buy-contract">{TOKEN_ADDRESS}</span>
                  <button type="button" className="btn small" onClick={copyAddress}>Copy</button>
                </div>
              ) : (
                <Callout icon="🚨" warn>Not deployed yet. Anyone showing you a contract address today is not us.</Callout>
              )}
            </fieldset>

            {isMock && <div className="muted">Demo mode: prices and balances here are simulated.</div>}
          </div>
        </div>
      </div>
      <StatusBar>
        <span>Done</span>
        <span>🌐 Internet zone</span>
      </StatusBar>
    </>
  )
}
