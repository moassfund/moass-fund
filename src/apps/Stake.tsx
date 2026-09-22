// EXEMPLAR APP. New windows should copy this shape: hooks in, kit components out,
// dialogs.runTx around every mutation, loading guard first, StatusBar last.
import { useState } from 'react'
import { TOKEN } from '../config'
import { useProtocol, useStake, useUnstake, useUser } from '../protocol/hooks'
import { dialogs } from '../shell/dialogStore'
import { AmountInput, Callout, Countdown, KV, ProgressBar, StatTile, StatusBar, Tabs, fmtNum, fmtPct, fmtUsd, parseAmount, useNow } from '../ui'

type Mode = 'stake' | 'unstake'

export default function Stake() {
  const { data: p } = useProtocol()
  const { data: user } = useUser()
  const stake = useStake()
  const unstake = useUnstake()
  const now = useNow(1000)
  const [mode, setMode] = useState<Mode>('stake')
  const [amount, setAmount] = useState('')

  if (!p || !user) return <div className="window-content muted">Loading staking data…</div>

  const staking = mode === 'stake'
  const balance = staking ? user.balances.MOASS : user.balances.sMOASS
  const n = parseAmount(amount)
  const tooMuch = n > balance
  const epochLength = p.epoch.endsAt - p.epoch.startedAt
  // Zero-length before the first epoch is set, which would be 0/0.
  const epochProgress = epochLength > 0 ? (now - p.epoch.startedAt) / epochLength : 0
  const nextReward = user.balances.sMOASS * p.rebaseRate

  const submit = async () => {
    if (!staking) {
      const sure = await dialogs.confirm(
        'Paper hands detected',
        `Unstake ${fmtNum(n)} ${TOKEN.staked}?\n\nYou stop compounding the moment you do. The next rebase is close.`,
        'Unstake anyway',
        'Keep holding',
      )
      if (!sure) return
    }
    const ok = await dialogs.runTx({
      title: staking ? 'Staking…' : 'Unstaking…',
      text: staking ? `Copying ${fmtNum(n)} ${TOKEN.symbol} into the staking contract` : `Moving ${fmtNum(n)} ${TOKEN.staked} back to your wallet`,
      action: () => (staking ? stake.mutateAsync(n) : unstake.mutateAsync(n)),
      success: staking ? `Staked ${fmtNum(n)} ${TOKEN.symbol}. Now touch nothing.` : `Unstaked ${fmtNum(n)} ${TOKEN.symbol}.`,
    })
    if (ok) setAmount('')
  }

  return (
    <>
      <div className="window-content stack">
        <div className="stat-grid">
          <StatTile variant="dark" label="APY" value={fmtPct(p.apy, 0)} sub={`${fmtPct(p.rebaseRate, 3)} per rebase`} tone="up" />
          <StatTile variant="red" label="Next rebase" value={<Countdown to={p.epoch.endsAt} />} sub={`Epoch ${p.epoch.number}`} />
          <StatTile label="5-day ROI" value={fmtPct(p.roi5d)} sub="15 rebases, compounded" tone="up" />
        </div>

        <fieldset>
          <legend>This epoch</legend>
          <ProgressBar value={epochProgress} label="Epoch progress" />
          <div className="row between muted" style={{ marginTop: 4 }}>
            <span>Your next reward</span>
            <b className="num up">+{fmtNum(nextReward, 4)} {TOKEN.staked}</b>
          </div>
        </fieldset>

        <Tabs<Mode>
          tabs={[{ id: 'stake', label: 'Stake' }, { id: 'unstake', label: 'Unstake' }]}
          active={mode}
          onChange={(m) => { setMode(m); setAmount('') }}
        >
          <div className="stack">
            <AmountInput label={staking ? 'Amount to stake' : 'Amount to unstake'} value={amount} onChange={setAmount} symbol={staking ? TOKEN.symbol : TOKEN.staked} max={balance} />
            <KV
              rows={[
                ['You receive', `${fmtNum(n, 4)} ${staking ? TOKEN.staked : TOKEN.symbol}`],
                ['Exchange rate', '1 : 1, no fee, no lockup'],
                [`Your ${TOKEN.staked}`, `${fmtNum(user.balances.sMOASS, 4)} (${fmtUsd(user.balances.sMOASS * p.priceUsd)})`],
              ]}
            />
            <button type="button" className={staking ? 'btn-primary' : 'btn-danger'} disabled={n <= 0 || tooMuch} onClick={submit}>
              {tooMuch ? 'Insufficient balance' : staking ? `STAKE ${TOKEN.symbol}` : 'UNSTAKE'}
            </button>
          </div>
        </Tabs>

        <Callout icon="⚠️">
          APY is the current rebase rate projected over a year. The rate follows the premium to backing and <b>can fall</b>. Rebases pay you in newly minted {TOKEN.symbol}, which is not the same thing as dollars.
        </Callout>
      </div>
      <StatusBar>
        <span>Staked: {fmtPct(p.stakedPct, 0)} of supply</span>
        <span>Index {fmtNum(p.index, 3)}</span>
        <span>{TOKEN.symbol} {fmtUsd(p.priceUsd)}</span>
      </StatusBar>
    </>
  )
}
