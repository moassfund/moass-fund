// The ONLY protocol surface UI code may import. Swap the adapter, keep the UI.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { DATA_SOURCE } from '../config'
import { chainAdapter } from './chainAdapter'
import { mockAdapter } from './mockAdapter'
import type { ProtocolAdapter, TxResult } from './types'

export const adapter: ProtocolAdapter = DATA_SOURCE === 'chain' ? chainAdapter : mockAdapter
export const isMock = adapter.kind === 'mock'

/** Protocol-wide numbers. Polls every 15s. */
export function useProtocol() {
  return useQuery({ queryKey: ['protocol'], queryFn: () => adapter.getSnapshot(), refetchInterval: 15_000 })
}

/** Connected wallet, or the guest demo account in mock mode. */
export function useUser() {
  const { address } = useAccount()
  const who = address ?? null
  return useQuery({ queryKey: ['user', who ?? 'guest'], queryFn: () => adapter.getUser(who), refetchInterval: 15_000 })
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
