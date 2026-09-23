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
 * DESTINATION IS FIXED. Everything here routes to the tokenised GME the
 * protocol actually holds, by address, on Robinhood Chain. "GME" is a reused
 * ticker with unrelated tokens on other chains, so the destination is never
 * selected, never matched by symbol, and never taken from an API response.
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

/**
 * A quote for `fromAmount` (already in the source token's smallest units) out
 * to GME on Robinhood Chain.
 */
export async function quoteToGme(args: {
  fromChain: number
  fromToken: string
  fromAmount: string
  fromAddress: string
}): Promise<LifiQuote> {
  return get<LifiQuote>('/quote', {
    fromChain: String(args.fromChain),
    toChain: String(GME_CHAIN_ID),
    fromToken: args.fromToken,
    toToken: GME_ADDRESS,
    fromAddress: args.fromAddress,
    toAddress: args.fromAddress,
    fromAmount: args.fromAmount,
    integrator: INTEGRATOR,
  })
}

export type TransferState = 'PENDING' | 'DONE' | 'FAILED' | 'NOT_FOUND'

/**
 * Where a cross-chain transfer has got to. The source transaction confirming
 * is not the end of the story: the GME lands on Robinhood Chain in a separate
 * transaction the user never signs, so the window has to keep watching.
 */
export async function transferStatus(args: {
  txHash: string
  fromChain: number
  tool?: string
}): Promise<{ status: TransferState; receivingTxHash?: string; message?: string }> {
  const body = await get<{
    status?: string
    substatusMessage?: string
    receiving?: { txHash?: string }
  }>('/status', {
    txHash: args.txHash,
    fromChain: String(args.fromChain),
    toChain: String(GME_CHAIN_ID),
    ...(args.tool ? { bridge: args.tool } : {}),
  })
  const raw = body.status ?? 'NOT_FOUND'
  const status: TransferState =
    raw === 'DONE' ? 'DONE' : raw === 'FAILED' ? 'FAILED' : raw === 'NOT_FOUND' ? 'NOT_FOUND' : 'PENDING'
  return { status, receivingTxHash: body.receiving?.txHash, message: body.substatusMessage }
}

/** Guards against a response ever redirecting the payout somewhere else. */
export function quoteLandsInGme(q: LifiQuote): boolean {
  return (
    q.action.toToken.chainId === GME_CHAIN_ID &&
    q.action.toToken.address.toLowerCase() === GME_ADDRESS.toLowerCase()
  )
}
