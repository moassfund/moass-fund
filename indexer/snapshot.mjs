#!/usr/bin/env node
/**
 * Moass Fund history indexer.
 *
 * Contracts only know the present. The Overview and Treasury charts want 30
 * days, so something has to write the number down every epoch. This is that
 * something: it reads the protocol, appends one point, and rewrites
 * `public/history.json`, which ships as a static file with the site.
 *
 * It also pokes the oracle, which is not optional. A TWAP is only readable from
 * an observation aged 30 minutes to 4 hours, and `Staking.rebase()` only runs
 * every 8 hours — so without a regular checkpoint the oracle falls permanently
 * out of band, emissions mint zero and bonds refuse to price. Running this on a
 * schedule of an hour or less keeps the protocol alive.
 *
 *   node indexer/snapshot.mjs            # append a point, poke the oracle
 *   node indexer/snapshot.mjs --dry-run  # read and print, write nothing
 *   node indexer/snapshot.mjs --no-poke  # read only, never send a transaction
 *
 * Environment: the VITE_ADDR_* addresses the front end uses, plus VITE_RPC_URL.
 * INDEXER_PRIVATE_KEY enables the oracle poke; without it the run is read-only
 * and simply says so.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'public', 'history.json')

/** Keep roughly 30 days at one point per 8h epoch, with headroom. */
const MAX_POINTS = 120
const MOASS_DECIMALS = 9
const GME_DECIMALS = 18
const USDG_DECIMALS = 6

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const NO_POKE = args.has('--no-poke')

const need = (key) => {
  const v = process.env[key]
  if (!v) throw new Error(`Missing ${key}. See .env.example.`)
  return v
}

const ADDR = {
  moass: need('VITE_ADDR_MOASS'),
  sMoass: need('VITE_ADDR_SMOASS'),
  treasury: need('VITE_ADDR_TREASURY'),
  oracle: need('VITE_ADDR_ORACLE'),
  pair: need('VITE_ADDR_PAIR'),
  gme: need('VITE_ADDR_GME'),
  gmeUsdgPool: need('VITE_ADDR_GME_USDG_POOL'),
}

const chain = defineChain({
  id: Number(process.env.VITE_CHAIN_ID ?? 4663),
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.VITE_RPC_URL ?? 'https://robinhood-rpc.publicnode.com'] } },
})

const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) })

const abi = {
  totalSupply: { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  rfv: { name: 'rfv', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  backing: { name: 'backingPerToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  twap: { name: 'twapMoassUsdg', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  checkpoint: { name: 'checkpoint', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  getReserves: { name: 'getReserves', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] },
  token0: { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  slot0: {
    name: 'slot0', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }],
  },
}

const read = (address, entry, args_ = []) =>
  client.readContract({ address, abi: [entry], functionName: entry.name, args: args_ })

const num = (v, decimals) => Number(formatUnits(v, decimals))

/** USD per GME, from the V3 pool. Mirrors `gmeUsd()` in the front-end adapter. */
async function gmeUsd() {
  const [slot0, token0] = await Promise.all([
    read(ADDR.gmeUsdgPool, abi.slot0),
    read(ADDR.gmeUsdgPool, abi.token0),
  ])
  const sqrtPriceX96 = slot0[0]
  if (sqrtPriceX96 === 0n) return 0
  const raw = Number((sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n) / 1e18
  if (raw === 0) return 0
  const scale = 10 ** (GME_DECIMALS - USDG_DECIMALS)
  const gmeIsToken0 = token0.toLowerCase() === ADDR.gme.toLowerCase()
  return gmeIsToken0 ? raw * scale : (1 / raw) * scale
}

/** MOASS priced in GME. Falls back to spot when the TWAP is out of band. */
async function moassGme() {
  try {
    return num(await read(ADDR.oracle, abi.twap), 18)
  } catch {
    const [reserves, token0] = await Promise.all([
      read(ADDR.pair, abi.getReserves),
      read(ADDR.pair, abi.token0),
    ])
    const moassIsToken0 = token0.toLowerCase() === ADDR.moass.toLowerCase()
    const moassR = num(moassIsToken0 ? reserves[0] : reserves[1], MOASS_DECIMALS)
    const gmeR = num(moassIsToken0 ? reserves[1] : reserves[0], GME_DECIMALS)
    return moassR === 0 ? 0 : gmeR / moassR
  }
}

async function collect() {
  const [rfvRaw, backingRaw, usdPerGme, priceGme] = await Promise.all([
    read(ADDR.treasury, abi.rfv),
    read(ADDR.treasury, abi.backing),
    gmeUsd(),
    moassGme(),
  ])

  // Everything on chain is denominated in GME; convert once, here, exactly as
  // the front end does.
  return {
    t: Date.now(),
    price: priceGme * usdPerGme,
    backing: num(backingRaw, 18) * usdPerGme,
    treasuryUsd: num(rfvRaw, 18) * usdPerGme,
    gme: usdPerGme,
  }
}

async function loadExisting() {
  try {
    const body = JSON.parse(await readFile(OUT, 'utf8'))
    return Array.isArray(body.points) ? body.points : []
  } catch {
    return [] // first run
  }
}

/**
 * Keeps the oracle inside its validity band.
 *
 * Checkpointing is permissionless and rate-limited on chain to one every 30
 * minutes, so calling it too often is harmless — it simply returns without
 * writing.
 */
async function pokeOracle() {
  if (NO_POKE) return 'skipped (--no-poke)'
  const key = process.env.INDEXER_PRIVATE_KEY
  if (!key) return 'skipped (no INDEXER_PRIVATE_KEY): emissions will stall if nothing else checkpoints'
  if (DRY_RUN) return 'skipped (--dry-run)'

  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) })
  const hash = await wallet.writeContract({
    address: ADDR.oracle,
    abi: [abi.checkpoint],
    functionName: 'checkpoint',
  })
  await client.waitForTransactionReceipt({ hash })
  return hash
}

async function main() {
  const point = await collect()
  console.log(
    `price $${point.price.toFixed(4)}  backing $${point.backing.toFixed(4)}  ` +
      `treasury $${Math.round(point.treasuryUsd).toLocaleString()}  GME $${point.gme.toFixed(2)}`,
  )

  if (!Number.isFinite(point.price) || !Number.isFinite(point.backing)) {
    throw new Error('Refusing to record a non-finite point; the chart would break.')
  }

  const points = await loadExisting()
  points.push(point)
  const trimmed = points.slice(-MAX_POINTS)

  if (DRY_RUN) {
    console.log(`dry run: would write ${trimmed.length} points to ${OUT}`)
  } else {
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, `${JSON.stringify({ updated: point.t, points: trimmed }, null, 2)}\n`)
    console.log(`wrote ${trimmed.length} points to ${OUT}`)
  }

  console.log(`oracle checkpoint: ${await pokeOracle()}`)
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
