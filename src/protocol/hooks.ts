// The ONLY protocol surface UI code may import. Swap the adapter, keep the UI.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { CHAIN, DATA_SOURCE } from '../config'
import { chainAdapter } from './chainAdapter'
import { mockAdapter } from './mockAdapter'
import type { ProtocolAdapter, TxResult } from './types'

export const adapter: ProtocolAdapter = DATA_SOURCE === 'chain' ? chainAdapter : mockAdapter
export const isMock = adapter.kind === 'mock'

/**
 * A window whose data never arrives is indistinguishable from one that is
 * still loading, so every read goes through here: connection failures get a
 * message that says what to do, and are thrown at the Window error boundary
 * instead of leaving the app on "Loading" forever.
 */
const UNREACHABLE = /fetch|timeout|timed out|network|request failed|ECONN|Failed to fetch/i

async function read<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!isMock && UNREACHABLE.test(message)) {
      throw new Error(
        `Cannot reach the chain at ${CHAIN.rpcUrl}. Check that you are online and on ${CHAIN.name}, or set VITE_DATA_SOURCE=mock to run on simulated data.`,
      )
    }
    throw e
  }
}

/**
 * Throw only when nothing ever loaded. Once a window has data, a later blip
 * keeps the last good numbers on screen rather than replacing a working
 * window with an error.
 */
const surfaceFirstFailure = { throwOnError: (_e: Error, q: { state: { data: unknown } }) => q.state.data === undefined }

/** Protocol-wide numbers. Polls every 15s. */
export function useProtocol() {
  return useQuery({
    queryKey: ['protocol'],
    queryFn: () => read(() => adapter.getSnapshot()),
    refetchInterval: 15_000,
    ...surfaceFirstFailure,
  })
}

/** Connected wallet, or the guest demo account in mock mode. */
export function useUser() {
  const { address } = useAccount()
  const who = address ?? null
  return useQuery({
    queryKey: ['user', who ?? 'guest'],
    queryFn: () => read(() => adapter.getUser(who)),
    refetchInterval: 15_000,
    ...surfaceFirstFailure,
  })
}

function useTx<V>(fn: (address: string | null, vars: V) => Promise<TxResult>) {
  const { address } = useAccount()
  const qc = useQueryClient()
  return useMutation<TxResult, Error, V>({
    mutationFn: (vars) => fn(address ?? null, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['protocol'] })
      void qc.invalidateQueries({ queryKey: ['user'] })
    },
  })
}

export const useStake = () => useTx<number>((a, amount) => adapter.stake(a, amount))
export const useUnstake = () => useTx<number>((a, amount) => adapter.unstake(a, amount))
export const useBond = () =>
  useTx<{ marketId: string; amount: number }>((a, v) => adapter.bond(a, v.marketId, v.amount))
export const useClaim = () => useTx<string[]>((a, bondIds) => adapter.claim(a, bondIds))

export const useGenesisPurchase = () => useTx<number>((a, amount) => adapter.genesisPurchase(a, amount))
export const useGenesisClaim = () => useTx<void>((a) => adapter.genesisClaim(a))
export const useGenesisRefund = () => useTx<void>((a) => adapter.genesisRefund(a))
