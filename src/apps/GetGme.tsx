// Swap into GME on Robinhood Chain, so somebody holding USDG or ETH here can
// subscribe to the offering without leaving the desktop.
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
  quoteLandsInGme,
  quoteToGme,
  tokensOn,
  type LifiQuote,
  type LifiToken,
} from '../protocol/lifi'
import { wagmiConfig } from '../protocol/wagmi'
import { dialogs } from '../shell/dialogStore'
import { useWindowStore } from '../shell/windowStore'
import { Callout, KV, StatusBar, fmtNum, fmtUsd, parseAmount } from '../ui'
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

  // A quote is priced against one token and one amount; either changing voids it.
  useEffect(() => setQuote(null), [tokenAddr, amount])

  const n = parseAmount(amount)
  const canQuote = !!address && !!token && n > 0

  const getQuote = async () => {
    if (!canQuote || !token) return
    setQuoting(true)
    setQuoteError(null)
    try {
      const q = await quoteToGme({
        fromChain: GME_CHAIN_ID,
        fromToken: token.address,
        fromAmount: parseUnits(String(n), token.decimals).toString(),
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
    const expected = Number(formatUnits(BigInt(quote.estimate.toAmount), 18))

    await dialogs.runTx({
      title: `Swapping to ${QUOTE.symbol}…`,
      text: `${fmtNum(n, 4)} ${token.symbol} in, about ${fmtNum(expected, 4)} ${QUOTE.symbol} out`,
      action: async () => {
        if (walletChain !== GME_CHAIN_ID) {
          await switchChain(wagmiConfig, { chainId: GME_CHAIN_ID as never })
        }
        const wallet = await getWalletClient(wagmiConfig, { chainId: GME_CHAIN_ID as never })
        if (!wallet) throw new Error('Connect a wallet first.')

        // ERC-20 legs need an allowance for the route's spender. Native does not.
        const spender = quote.estimate.approvalAddress as Address | undefined
        if (token.address.toLowerCase() !== NATIVE && spender) {
          const needed = BigInt(quote.action.fromAmount)
          const current = (await readContract(wagmiConfig, {
            chainId: GME_CHAIN_ID as never,
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
      success: `Swapped. The ${QUOTE.symbol} is in your wallet.`,
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
          The offering is priced in {QUOTE.symbol}. Swap anything you already hold on {CHAIN.name} into it
          here, in one transaction.
        </Callout>

        {!address && <Callout icon="🔌" warn>Connect a wallet to get a quote.</Callout>}

        <fieldset>
          <legend>You pay</legend>
          <div className="getgme-row">
            <label className="getgme-field">
              <span className="muted">Token</span>
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
              <span className="muted">Amount</span>
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

        {quoteError && <Callout icon="⚠️" warn>{quoteError}</Callout>}

        {quote && (
          <fieldset>
            <legend>You receive</legend>
            <div className="getgme-out num">{fmtNum(out, 4)} {QUOTE.symbol}</div>
            <KV
              rows={[
                ['Route', quote.tool],
                ['Total cost', outUsd > 0 ? `${fmtUsd(inUsd - outUsd)} (${(cost * 100).toFixed(2)}%)` : 'unknown'],
                ['Lands as', `${GME_ADDRESS.slice(0, 10)}… on ${CHAIN.name}`],
              ]}
            />
            <button type="button" className="btn-primary" style={{ marginTop: 8 }} onClick={execute}>
              SWAP TO {QUOTE.symbol}
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
        <span>{CHAIN.name} only</span>
        <button type="button" className="btn small" onClick={() => useWindowStore.getState().open('genesis')}>
          To the offering
        </button>
      </StatusBar>
    </>
  )
}
