/**
 * LI.FI, over its REST API.
 *
 * Not the SDK and not the widget. The widget renders its own layout, which
 * cannot be reshaped into a Luna Red window, and the SDK's client setup buys
 * nothing here: every call below is one GET. Going direct keeps the bundle to
 * this file rather than MUI and an i18n stack, and leaves the window ours.
 *
 * The endpoints are public and unauthenticated. `integrator` is attribution,
 * not a key.
 *
 * THE GME SIDE IS FIXED. Whichever way the swap runs, the GME leg is the
 * tokenised GME the protocol actually holds, by address, on Robinhood Chain.
 * "GME" is a reused ticker with unrelated tokens on other chains, so it is
 * never selected, never matched by symbol, and never taken from an API
 * response. Only the other side is a choice.
 *
 * Source and destination are the same chain, so there is no bridge and no
 * second leg: the swap settles in the transaction the user signs. LI.FI can
 * route in from other chains, and did in an earlier version of this window,
 * but that needed a status poll and five more wagmi transports for an audience
 * that is already here.
 */
import { CHAIN } from '../config'

const BASE = 'https://li.quest/v1'
const INTEGRATOR = 'moassfund'

/** The reserve asset, by address. Not a choice the UI offers. */
export const GME_ADDRESS = '0x1b0E319c6A659F002271B69dB8A7df2F911c153E'
export const GME_CHAIN_ID = CHAIN.id

export interface LifiToken {
  address: string
  symbol: string
  decimals: number
  name?: string
  logoURI?: string
  priceUSD?: string
  chainId: number
}

export interface LifiQuote {
  /** The bridge or exchange that won the route, e.g. "across". */
  tool: string
  action: { fromToken: LifiToken; toToken: LifiToken; fromAmount: string }
  estimate: {
    fromAmount: string
    toAmount: string
    toAmountMin: string
    fromAmountUSD?: string
    toAmountUSD?: string
    executionDuration: number
    approvalAddress?: string
  }
  transactionRequest?: {
    to: string
    data: string
    value?: string
    gasLimit?: string
    gasPrice?: string
    chainId?: number
  }
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`
  const res = await fetch(url)
  const body = (await res.json().catch(() => ({}))) as { message?: string }
  if (!res.ok) {
    throw new Error(body.message || `LI.FI request failed (${res.status})`)
  }
  return body as T
}

/** Tokens LI.FI can route from on a chain, newest list each session. */
export async function tokensOn(chainId: number): Promise<LifiToken[]> {
  const body = await get<{ tokens: Record<string, LifiToken[]> }>('/tokens', {
    chains: String(chainId),
  })
  return body.tokens?.[String(chainId)] ?? []
}

/** `buy` ends in GME; `sell` starts from it. */
export type Side = 'buy' | 'sell'

/**
 * A quote for `amount` (in the source token's smallest units), with GME pinned
 * to whichever side `side` says.
 */
export async function quoteSwap(args: {
  side: Side
  /** The leg that is not GME. */
  otherToken: string
  amount: string
  fromAddress: string
}): Promise<LifiQuote> {
  const buying = args.side === 'buy'
  return get<LifiQuote>('/quote', {
    fromChain: String(GME_CHAIN_ID),
    toChain: String(GME_CHAIN_ID),
    fromToken: buying ? args.otherToken : GME_ADDRESS,
    toToken: buying ? GME_ADDRESS : args.otherToken,
    fromAddress: args.fromAddress,
    toAddress: args.fromAddress,
    fromAmount: args.amount,
    integrator: INTEGRATOR,
  })
}

/**
 * Guards against a response quietly swapping a leg for something else. Buying
 * must land in GME; selling must spend it.
 */
export function quoteHasGmeOn(q: LifiQuote, side: Side): boolean {
  const leg = side === 'buy' ? q.action.toToken : q.action.fromToken
  return leg.chainId === GME_CHAIN_ID && leg.address.toLowerCase() === GME_ADDRESS.toLowerCase()
}
