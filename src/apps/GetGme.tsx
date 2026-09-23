// Bridge-and-swap into GME, so somebody holding USDC on Base can subscribe to
// the offering without leaving the desktop. Routing is LI.FI; the destination
// is fixed to the reserve asset by address and is never a choice.
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { getWalletClient, switchChain, waitForTransactionReceipt, readContract } from '@wagmi/core'
import { erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { QUOTE } from '../config'
import { isMock } from '../protocol/hooks'
import {
  GME_ADDRESS,
  quoteLandsInGme,
  quoteToGme,
  tokensOn,
  transferStatus,
  type LifiQuote,
  type LifiToken,
} from '../protocol/lifi'
import { SOURCE_CHAINS, wagmiConfig } from '../protocol/wagmi'
import { dialogs } from '../shell/dialogStore'
import { useWindowStore } from '../shell/windowStore'
import { Callout, KV, StatusBar, fmtNum, fmtUsd, parseAmount } from '../ui'
import './GetGme.css'

const NATIVE = '0x0000000000000000000000000000000000000000'

/**
 * What people actually hold, first.
 *
 * LI.FI returns its list in no order useful to a human, so an unsorted select
 * offers $COOL and sirloinUSDC above USDC. These are the assets somebody
 * funding a subscription is realistically holding; everything else keeps its
 * place behind them.
 */
const COMMON = ['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'USDG', 'WBTC', 'cbBTC', 'MATIC', 'POL']

/** Enough of a list to find what you hold, short enough to scan. */
function shortlist(tokens: LifiToken[]): LifiToken[] {
  const priced = tokens.filter((t) => t.address.toLowerCase() === NATIVE || (t.priceUSD && Number(t.priceUSD) > 0))
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
  const [fromChain, setFromChain] = useState<number>(SOURCE_CHAINS[1].id) // Base
  const [tokenAddr, setTokenAddr] = useState<string>(NATIVE)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<LifiQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [watching, setWatching] = useState<{ txHash: string; fromChain: number; tool?: string } | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  const tokens = useQuery({
    queryKey: ['lifi-tokens', fromChain],
    queryFn: () => tokensOn(fromChain),
    staleTime: 10 * 60_000,
  })

  const list = useMemo(() => shortlist(tokens.data ?? []), [tokens.data])
  const token = list.find((t) => t.address.toLowerCase() === tokenAddr.toLowerCase()) ?? list[0]

  // A new chain invalidates the chosen token and any quote priced against it.
  useEffect(() => {
    setTokenAddr(NATIVE)
    setQuote(null)
    setQuoteError(null)
  }, [fromChain])

  // Poll until the GME actually lands: the source transaction confirming only
  // means the money left, not that it arrived.
  useEffect(() => {
    if (!watching) return
    let live = true
    const tick = async () => {
      try {
        const s = await transferStatus(watching)
        if (!live) return
        if (s.status === 'DONE') {
          setWatching(null)
          setProgress(null)
          void dialogs.balloon('GME landed', `Your ${QUOTE.symbol} is on ${'Robinhood Chain'}. The offering is open.`, 'shrug')
          return
        }
        if (s.status === 'FAILED') {
          setWatching(null)
          setProgress(null)
          void dialogs.error('The transfer failed', s.message || 'LI.FI reported the route did not complete.')
          return
        }
        setProgress(s.message || 'Bridging. This usually takes under a minute.')
      } catch {
        /* a polling blip must not kill the watch */
      }
    }
    void tick()
    const id = setInterval(tick, 6_000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [watching])

  const n = parseAmount(amount)
  const decimals = token?.decimals ?? 18
  const canQuote = !!address && !!token && n > 0

  const getQuote = async () => {
    if (!canQuote || !token) return
    setQuoting(true)
    setQuoteError(null)
    setQuote(null)
    try {
      const q = await quoteToGme({
        fromChain,
        fromToken: token.address,
        fromAmount: parseUnits(String(n), decimals).toString(),
        fromAddress: address as string,
      })
      if (!quoteLandsInGme(q)) throw new Error('That route does not end in the reserve asset. Not taking it.')
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

    await dialogs.runTx({
      title: `Swapping to ${QUOTE.symbol}…`,
      text: `${fmtNum(n, 4)} ${token.symbol} in, about ${fmtNum(Number(formatUnits(BigInt(quote.estimate.toAmount), 18)), 4)} ${QUOTE.symbol} out`,
      action: async () => {
        if (walletChain !== fromChain) {
          await switchChain(wagmiConfig, { chainId: fromChain as never })
        }
        const wallet = await getWalletClient(wagmiConfig, { chainId: fromChain as never })
        if (!wallet) throw new Error('Connect a wallet first.')

        // ERC-20 legs need an allowance for the route's spender. Native does not.
        const spender = quote.estimate.approvalAddress as Address | undefined
        if (token.address.toLowerCase() !== NATIVE && spender) {
          const needed = BigInt(quote.action.fromAmount)
          const current = (await readContract(wagmiConfig, {
            chainId: fromChain as never,
            address: token.address as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address as Address, spender],
          })) as bigint
          if (current < needed) {
            const approveHash = await wallet.writeContract({
              chain: null,
              account: wallet.account,
              address: token.address as Address,
              abi: erc20Abi,
              functionName: 'approve',
              args: [spender, needed],
            })
            await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, chainId: fromChain as never })
          }
        }

        const hash = await wallet.sendTransaction({
          chain: null,
          account: wallet.account,
          to: tr.to as Address,
          data: tr.data as `0x${string}`,
          value: tr.value ? BigInt(tr.value) : undefined,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: fromChain as never })
        setWatching({ txHash: hash, fromChain, tool: quote.tool })
        setProgress('Sent. Waiting for it to arrive on the other side.')
        return { hash }
      },
      success: `Sent. ${QUOTE.symbol} arrives shortly, this window will say when.`,
    })
  }

  const out = quote ? Number(formatUnits(BigInt(quote.estimate.toAmount), 18)) : 0
  const inUsd = Number(quote?.estimate.fromAmountUSD ?? 0)
  const outUsd = Number(quote?.estimate.toAmountUSD ?? 0)
  const cost = inUsd > 0 && outUsd > 0 ? (inUsd - outUsd) / inUsd : 0

  return (
    <>
      <div className="window-content stack">
        <Callout icon="🛒">
          The offering takes {QUOTE.symbol} on Robinhood Chain. Bring anything from another chain and it
          arrives as {QUOTE.symbol}, in one transaction.
        </Callout>

        {!address && <Callout icon="🔌" warn>Connect a wallet to get a quote.</Callout>}

        <fieldset>
          <legend>You pay</legend>
          <div className="getgme-row">
            <label className="getgme-field">
              <span className="muted">Chain</span>
              <select className="field" value={fromChain} onChange={(e) => setFromChain(Number(e.target.value))}>
                {SOURCE_CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="getgme-field">
              <span className="muted">Token</span>
              <select
                className="field"
                value={token?.address ?? NATIVE}
                onChange={(e) => { setTokenAddr(e.target.value); setQuote(null) }}
                disabled={tokens.isLoading || !list.length}
              >
                {tokens.isLoading && <option>Loading…</option>}
                {list.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="getgme-field" style={{ marginTop: 8 }}>
            <span className="muted">Amount</span>
            <input
              className="field num"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setQuote(null) }}
            />
          </label>
          <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!canQuote || quoting} onClick={getQuote}>
            {quoting ? 'Finding a route…' : 'GET QUOTE'}
          </button>
        </fieldset>

        {quoteError && <Callout icon="⚠️" warn>{quoteError}</Callout>}

        {quote && (
          <fieldset>
            <legend>You receive</legend>
            <div className="getgme-out num">{fmtNum(out, 4)} {QUOTE.symbol}</div>
            <KV
              rows={[
                ['Route', quote.tool],
                ['Arrives in', `about ${quote.estimate.executionDuration}s`],
                ['Total cost', outUsd > 0 ? `${fmtUsd(inUsd - outUsd)} (${(cost * 100).toFixed(2)}%)` : 'unknown'],
                ['Lands as', `${GME_ADDRESS.slice(0, 10)}… on Robinhood Chain`],
              ]}
            />
            <button type="button" className="btn-primary" style={{ marginTop: 8 }} disabled={!!watching} onClick={execute}>
              {watching ? 'IN FLIGHT…' : `SWAP TO ${QUOTE.symbol}`}
            </button>
          </fieldset>
        )}

        {progress && <Callout icon="⏳">{progress}</Callout>}

        <Callout icon="⚠️" warn>
          Routing is LI.FI, a third party. Quotes move with the market and the amount you receive is an
          estimate, not a promise. Cross-chain transfers arrive in a second transaction you do not sign,
          so leave this window open until it says the {QUOTE.symbol} landed.
          {isMock && ' Quotes here are real even in demo mode, because they come from LI.FI rather than the simulated protocol.'}
        </Callout>
      </div>
      <StatusBar>
        <span>Destination: {QUOTE.symbol} on Robinhood Chain</span>
        <button type="button" className="btn small" onClick={() => useWindowStore.getState().open('genesis')}>
          To the offering
        </button>
      </StatusBar>
    </>
  )
}
