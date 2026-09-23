// Swap into GME on Robinhood Chain so somebody holding USDG or ETH here can
// subscribe to the offering, and back out again afterwards. Both directions,
// because a window that only lets people in reads worse than one that admits
// they can leave.
//
// One chain, deliberately. LI.FI routes in from other chains too, but the
// audience for this is already on Robinhood Chain, and same-chain settles in
// the transaction they sign: no bridge, no second leg, nothing to poll.
//
// Routing is LI.FI; the destination is the reserve asset by address and is
// never a choice.
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { getWalletClient, switchChain, waitForTransactionReceipt, readContract } from '@wagmi/core'
import { erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { CHAIN, QUOTE } from '../config'
import { isMock } from '../protocol/hooks'
import {
  GME_ADDRESS,
  GME_CHAIN_ID,
  quoteHasGmeOn,
  quoteSwap,
  tokensOn,
  type LifiQuote,
  type LifiToken,
  type Side,
} from '../protocol/lifi'
import { wagmiConfig } from '../protocol/wagmi'
import { dialogs } from '../shell/dialogStore'
import { useWindowStore } from '../shell/windowStore'
import { Callout, KV, StatusBar, Tabs, fmtNum, fmtUsd, parseAmount } from '../ui'
import './GetGme.css'

const NATIVE = '0x0000000000000000000000000000000000000000'

/**
 * What people actually hold, first.
 *
 * LI.FI returns its list in no order useful to a human, so an unsorted select
 * offers $COOL and sirloinUSDC above USDG.
 */
const COMMON = ['ETH', 'WETH', 'USDG', 'USDC', 'USDT', 'DAI', 'WBTC', 'cbBTC']

function shortlist(tokens: LifiToken[]): LifiToken[] {
  const priced = tokens.filter(
    (t) => t.address.toLowerCase() === NATIVE || (t.priceUSD && Number(t.priceUSD) > 0),
  )
  const rank = (t: LifiToken) => {
    if (t.address.toLowerCase() === NATIVE) return -1
    const i = COMMON.indexOf(t.symbol.toUpperCase())
    return i === -1 ? COMMON.length : i
  }
  const seen = new Set<string>()
  return priced
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .filter((t) => {
      const k = t.symbol.toUpperCase()
      if (seen.has(k)) return false // several wrapped variants share a ticker
      seen.add(k)
      return true
    })
    .slice(0, 40)
}

export default function GetGme() {
  const { address, chainId: walletChain } = useAccount()
  const [side, setSide] = useState<Side>('buy')
  const [tokenAddr, setTokenAddr] = useState<string>(NATIVE)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<LifiQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)

  const tokens = useQuery({
    queryKey: ['lifi-tokens', GME_CHAIN_ID],
    queryFn: () => tokensOn(GME_CHAIN_ID),
    staleTime: 10 * 60_000,
  })

  const list = useMemo(() => shortlist(tokens.data ?? []), [tokens.data])
  const token = list.find((t) => t.address.toLowerCase() === tokenAddr.toLowerCase()) ?? list[0]

  // A quote is priced against one side, token and amount; any change voids it.
  useEffect(() => setQuote(null), [side, tokenAddr, amount])

  const n = parseAmount(amount)
  const buying = side === 'buy'
  /** The leg being spent, and so the one that needs an allowance. */
  const payToken = buying ? token : { address: GME_ADDRESS, symbol: QUOTE.symbol, decimals: 18 }
  const getToken = buying ? { symbol: QUOTE.symbol, decimals: 18 } : token
  const canQuote = !!address && !!token && n > 0

  const getQuote = async () => {
    if (!canQuote || !token) return
    setQuoting(true)
    setQuoteError(null)
    try {
      const q = await quoteSwap({
        side,
        otherToken: token.address,
        amount: parseUnits(String(n), side === 'buy' ? token.decimals : 18).toString(),
        fromAddress: address as string,
      })
      if (!quoteHasGmeOn(q, side)) {
        throw new Error(`That route does not ${side === 'buy' ? 'end in' : 'spend'} the reserve asset. Not taking it.`)
      }
      setQuote(q)
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'No route found.')
    } finally {
      setQuoting(false)
    }
  }

  const execute = async () => {
    if (!quote?.transactionRequest || !address || !token) return
    const tr = quote.transactionRequest
    const expected = Number(formatUnits(BigInt(quote.estimate.toAmount), getToken.decimals))

    await dialogs.runTx({
      title: `Swapping to ${getToken.symbol}…`,
      text: `${fmtNum(n, 4)} ${payToken.symbol} in, about ${fmtNum(expected, 4)} ${getToken.symbol} out`,
      action: async () => {
        if (walletChain !== GME_CHAIN_ID) {
          await switchChain(wagmiConfig, { chainId: GME_CHAIN_ID as never })
        }
        const wallet = await getWalletClient(wagmiConfig, { chainId: GME_CHAIN_ID as never })
        if (!wallet) throw new Error('Connect a wallet first.')

        // ERC-20 legs need an allowance for the route's spender. Native does not.
        const spender = quote.estimate.approvalAddress as Address | undefined
        if (payToken.address.toLowerCase() !== NATIVE && spender) {
          const needed = BigInt(quote.action.fromAmount)
          const current = (await readContract(wagmiConfig, {
            chainId: GME_CHAIN_ID as never,
            address: payToken.address as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address as Address, spender],
          })) as bigint
          if (current < needed) {
            const approveHash = await wallet.writeContract({
              chain: null,
              account: wallet.account,
              address: payToken.address as Address,
              abi: erc20Abi,
              functionName: 'approve',
              args: [spender, needed],
            })
            await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, chainId: GME_CHAIN_ID as never })
          }
        }

        const hash = await wallet.sendTransaction({
          chain: null,
          account: wallet.account,
          to: tr.to as Address,
          data: tr.data as `0x${string}`,
          value: tr.value ? BigInt(tr.value) : undefined,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: GME_CHAIN_ID as never })
        return { hash }
      },
      success: `Swapped. The ${getToken.symbol} is in your wallet.`,
    })
  }

  const out = quote ? Number(formatUnits(BigInt(quote.estimate.toAmount), getToken.decimals)) : 0
  const inUsd = Number(quote?.estimate.fromAmountUSD ?? 0)
  const outUsd = Number(quote?.estimate.toAmountUSD ?? 0)
  const cost = inUsd > 0 && outUsd > 0 ? (inUsd - outUsd) / inUsd : 0

  return (
    <>
      <div className="window-content stack">
        <Callout icon="🛒">
          {buying
            ? `The offering is priced in ${QUOTE.symbol}. Swap anything you already hold on ${CHAIN.name} into it here, in one transaction.`
            : `Turn ${QUOTE.symbol} back into whatever you would rather hold. Same chain, one transaction.`}
        </Callout>

        {!address && <Callout icon="🔌" warn>Connect a wallet to get a quote.</Callout>}

        <Tabs<Side>
          tabs={[{ id: 'buy', label: `Get ${QUOTE.symbol}` }, { id: 'sell', label: `Sell ${QUOTE.symbol}` }]}
          active={side}
          onChange={(v) => { setSide(v); setAmount('') }}
        >
        <fieldset>
          <legend>You pay {buying ? '' : QUOTE.symbol}</legend>
          <div className="getgme-row">
            <label className="getgme-field">
              <span className="muted">{buying ? 'Token' : `Receive`}</span>
              <select
                className="field"
                value={token?.address ?? NATIVE}
                onChange={(e) => setTokenAddr(e.target.value)}
                disabled={tokens.isLoading || !list.length}
              >
                {tokens.isLoading && <option>Loading…</option>}
                {list.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol}</option>
                ))}
              </select>
            </label>
            <label className="getgme-field">
              <span className="muted">Amount{buying ? '' : ` of ${QUOTE.symbol}`}</span>
              <input
                className="field num"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          </div>
          <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!canQuote || quoting} onClick={getQuote}>
            {quoting ? 'Finding a route…' : 'GET QUOTE'}
          </button>
        </fieldset>

        </Tabs>

        {quoteError && <Callout icon="⚠️" warn>{quoteError}</Callout>}

        {quote && (
          <fieldset>
            <legend>You receive</legend>
            <div className="getgme-out num">{fmtNum(out, 4)} {getToken.symbol}</div>
            <KV
              rows={[
                ['Route', quote.tool],
                ['Total cost', outUsd > 0 ? `${fmtUsd(inUsd - outUsd)} (${(cost * 100).toFixed(2)}%)` : 'unknown'],
                [buying ? 'Lands as' : 'Spends', `${GME_ADDRESS.slice(0, 10)}… on ${CHAIN.name}`],
              ]}
            />
            <button type="button" className={buying ? 'btn-primary' : 'btn-danger'} style={{ marginTop: 8 }} onClick={execute}>
              {buying ? `SWAP TO ${QUOTE.symbol}` : `SELL ${QUOTE.symbol}`}
            </button>
          </fieldset>
        )}

        <Callout icon="⚠️" warn>
          Routing is LI.FI, a third party. Quotes move with the market, so the amount you receive is an
          estimate rather than a promise, and a stale quote can fail outright.
          {isMock && ' Quotes here are real even in demo mode, because they come from LI.FI rather than the simulated protocol.'}
        </Callout>
      </div>
      <StatusBar>
        <span>{buying ? `Buying ${QUOTE.symbol}` : `Selling ${QUOTE.symbol}`} on {CHAIN.name}</span>
        <button type="button" className="btn small" onClick={() => useWindowStore.getState().open('genesis')}>
          To the offering
        </button>
      </StatusBar>
    </>
  )
}
