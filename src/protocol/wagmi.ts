import { createConfig, http, type CreateConnectorFn } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { defineChain } from 'viem'
import { CHAIN } from '../config'

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CHAIN.rpcUrl] } },
  blockExplorers: { default: { name: 'Explorer', url: CHAIN.explorer } },
})

const projectId = (import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? ''

/**
 * Runs a connector's `setup()` once the browser is idle rather than during
 * hydration.
 *
 * `createConfig` calls `connector.setup?.()` the moment the config is built,
 * which is while the desktop is still booting. WalletConnect's implementation
 * pulls down and initialises its provider — roughly a megabyte, plus network
 * calls — before anyone has clicked Connect. That lands on the main thread at
 * exactly the moment the windows are trying to become interactive.
 *
 * Nothing on screen depends on it: `setup()` only attaches listeners, and both
 * connecting and reconnecting fetch the provider themselves. Deferring costs no
 * functionality.
 */
function deferSetup(factory: CreateConnectorFn): CreateConnectorFn {
  return (config) => {
    const connector = factory(config)
    if (typeof connector.setup !== 'function') return connector
    const eager = connector.setup

    return {
      ...connector,
      // Resolves immediately; the real work happens on the idle callback.
      async setup() {
        whenIdle(() => {
          // A connector that cannot set itself up must not take the page with
          // it. It will simply fail again at connect time, where the user can
          // see it.
          void Promise.resolve(eager.call(this)).catch(() => {})
        })
      },
    }
  }
}

function whenIdle(run: () => void): void {
  if (typeof window === 'undefined') {
    run()
    return
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 3_000 })
  } else {
    window.setTimeout(run, 300)
  }
}

/**
 * Injected wallets are always available via EIP-6963 discovery, which lists
 * each installed wallet separately — the connect dialog renders one XP button
 * per connector, so nothing else is needed to support them.
 *
 * WalletConnect brings mobile wallets and needs a free project id from
 * cloud.reown.com. Rather than break the build without one, it is added only
 * when configured; until then the dialog simply shows fewer options.
 */
const connectors: CreateConnectorFn[] = [injected()]

if (projectId) {
  connectors.push(
    deferSetup(
      walletConnect({
        projectId,
        showQrModal: true,
        metadata: {
          name: 'Moass Fund',
          description: 'An OHM-style reserve protocol paired with GME.',
          url: typeof window !== 'undefined' ? window.location.origin : 'https://moass.fund',
          icons: [],
        },
      }),
    ),
  )
} else if (import.meta.env?.DEV) {
  console.info(
    'VITE_WALLETCONNECT_PROJECT_ID is not set, so mobile wallets cannot connect. ' +
      'Get a free id at https://cloud.reown.com and put it in .env.',
  )
}

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors,
  transports: { [robinhoodChain.id]: http(CHAIN.rpcUrl) },
})
