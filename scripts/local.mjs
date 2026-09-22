#!/usr/bin/env node
/**
 * Helpers for poking at the local stack while it runs.
 *
 * The protocol moves on an 8-hour clock and vests bonds over 2 days, so on a
 * fresh chain nothing visibly happens no matter how long you sit there. These
 * push it forward.
 *
 *   npm run local fund <address>    give an account MOASS, GME and gas
 *   npm run local advance [n]       skip n epochs (default 1) and rebase
 *   npm run local vest              skip 2 days so bonds are claimable
 *   npm run local open              open a 3x desk position
 *   npm run local close [pnl]       close it, optionally with a profit or loss
 *   npm run local gme <price>       move the GME price, e.g. 30 or 12.5
 *   npm run local status            print what the protocol currently thinks
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RPC = 'http://127.0.0.1:8545'
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const EPOCH = 8 * 3600
const CHECKPOINT_INTERVAL = 30 * 60

const chain = defineChain({
  id: 31337,
  name: 'Moass Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

const abi = parseAbi([
  'function mint(address to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function checkpoint()',
  'function rebase()',
  'function epoch() view returns (uint64, uint64, uint64, uint256)',
  'function backingPerToken() view returns (uint256)',
  'function rfv() view returns (uint256)',
  'function twapMoassUsdg() view returns (uint256)',
  'function circulatingSupply() view returns (uint256)',
  'function openPosition(address venue, uint256 collateral, uint256 sizeUnits, uint256 entryPriceWad, uint256 debtQuoteWad)',
  'function settlePosition() returns (int256)',
  'function rebalanceToMorpho(uint256 assetsRaw)',
  'function liquidAssets() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function setSqrtPriceX96(uint160 v)',
  'function transfer(address to, uint256 value) returns (bool)',
])

const log = (m) => console.log(`\x1b[35m▸\x1b[0m ${m}`)

const client = createPublicClient({ chain, transport: http(RPC) })
const deployer = createWalletClient({
  account: privateKeyToAccount(DEPLOYER_KEY),
  chain,
  transport: http(RPC),
})

const send = async (address, functionName, args = []) => {
  const hash = await deployer.writeContract({ address, abi, functionName, args })
  await client.waitForTransactionReceipt({ hash })
}
const read = (address, functionName, args = []) =>
  client.readContract({ address, abi, functionName, args })

async function addresses() {
  try {
    return JSON.parse(await readFile(resolve(ROOT, 'contracts/deployments/31337.json'), 'utf8'))
  } catch {
    throw new Error('no local deployment found — is `npm start` running?')
  }
}

/** Moves the clock, keeping the oracle inside its 30min–4h validity band. */
async function travel(seconds) {
  const a = await addresses()
  let left = seconds
  while (left > 0) {
    const step = Math.min(left, CHECKPOINT_INTERVAL)
    await client.request({ method: 'evm_increaseTime', params: [step] })
    await client.request({ method: 'evm_mine', params: [] })
    await send(a.oracle, 'checkpoint')
    left -= step
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function fund(target) {
  if (!target) throw new Error('usage: npm run local fund <address>')
  const a = await addresses()

  await client.request({ method: 'anvil_setBalance', params: [target, '0x56BC75E2D63100000'] })
  await send(a.gme, 'mint', [target, parseUnits('500', 18)])
  await send(a.usdg, 'mint', [target, parseUnits('10000', 6)])

  // MOASS cannot be minted freely — the treasury is the only minter — so send
  // some of the deployer's own genesis allocation instead.
  const held = await read(a.moass, 'balanceOf', [deployer.account.address])
  if (held > 0n) {
    await send(a.moass, 'transfer', [target, held / 2n])
  }

  log(`funded ${target}`)
  await status()
}

/** The contract advances one epoch per call, so a late clock needs several. */
async function catchUp(a) {
  for (let i = 0; i < 60; i++) {
    const [, , end] = await read(a.staking, 'epoch')
    const { timestamp } = await client.getBlock()
    if (BigInt(end) > timestamp) return i
    await send(a.staking, 'rebase')
  }
  return 60
}

async function advance(n = 1) {
  const a = await addresses()
  await catchUp(a)
  for (let i = 0; i < n; i++) {
    await travel(EPOCH)
    await send(a.staking, 'rebase')
  }
  const [, number] = await read(a.staking, 'epoch')
  log(`advanced ${n} epoch(s) — now epoch ${number}`)
  log('reload the app; the Kid should announce the rebase')
}

async function vest() {
  const a = await addresses()
  await travel(2 * 24 * 3600 + 60)
  await catchUp(a)
  log('skipped 2 days — bonds bought before now are fully vested and claimable')
}

async function open_() {
  const a = await addresses()

  // Push a quarter of reserves into the desk if it is empty, then lever it 3x.
  let liquid = await read(a.gmeDesk, 'liquidAssets')
  if (liquid === 0n) {
    const reserves = await read(a.gme, 'balanceOf', [a.treasury])
    await send(a.treasury, 'rebalanceToMorpho', [reserves / 4n])
    liquid = await read(a.gmeDesk, 'liquidAssets')
  }

  const entry = parseUnits('23.34', 18)
  await send(a.gmeDesk, 'openPosition', [
    deployer.account.address, // the venue, fixed at deploy in the local stack
    liquid,
    liquid * 3n,
    entry,
    (liquid * 2n * 2334n) / 100n,
  ])
  log(`opened a 3x position with ${formatUnits(liquid, 18)} GME of collateral`)
  log('open the Treasury window to see it')
}

async function close(pnlPercent = '0') {
  const a = await addresses()
  const collateral = await read(a.gmeDesk, 'totalAssets')
  const deployed = collateral - (await read(a.gmeDesk, 'liquidAssets'))
  if (deployed === 0n) throw new Error('no position is open')

  // The venue returns the collateral adjusted by the requested result.
  const pct = BigInt(Math.round(Number(pnlPercent) * 100))
  const returned = (deployed * (10_000n + pct)) / 10_000n
  await send(a.gme, 'mint', [a.gmeDesk, returned])
  await send(a.gmeDesk, 'settlePosition')

  log(`closed the position at ${pnlPercent}% — backing moved with it`)
  await status()
}

async function gmePrice(price) {
  if (!price) throw new Error('usage: npm run local gme <price>, e.g. 30')
  const a = await addresses()
  // price = (sqrtPriceX96 / 2^96)^2 × 10^12, so invert for sqrtPriceX96.
  const ratio = Number(price) / 10 ** 12
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(ratio) * 2 ** 96))
  await send(a.gmeUsdgPool, 'setSqrtPriceX96', [sqrtPriceX96])
  log(`GME is now about $${price} — every dollar figure in the app moves with it`)
}

async function status() {
  const a = await addresses()
  const [, number, end, distribute] = await read(a.staking, 'epoch')
  const [supply, staked, backing, rfv] = await Promise.all([
    read(a.moass, 'totalSupply'),
    read(a.sMoass, 'circulatingSupply'),
    read(a.treasury, 'backingPerToken'),
    read(a.treasury, 'rfv'),
  ])
  let twap = 'out of band'
  try {
    twap = `${Number(formatUnits(await read(a.oracle, 'twapMoassUsdg'), 18)).toFixed(4)} GME`
  } catch {
    /* the oracle needs a checkpoint */
  }

  console.log('')
  console.log(`  epoch           ${number}, ends ${new Date(Number(end) * 1000).toLocaleString()}`)
  console.log(`  queued reward   ${Number(formatUnits(distribute, 9)).toFixed(4)} MOASS`)
  console.log(`  supply          ${Number(formatUnits(supply, 9)).toFixed(2)} MOASS`)
  console.log(`  staked          ${Number(formatUnits(staked, 9)).toFixed(2)} sMOASS`)
  console.log(`  price (TWAP)    ${twap}`)
  console.log(`  backing         ${Number(formatUnits(backing, 18)).toFixed(4)} GME per MOASS`)
  console.log(`  treasury        ${Number(formatUnits(rfv, 18)).toFixed(0)} GME`)
  console.log('')
}

const [cmd, arg] = process.argv.slice(2)
const commands = {
  fund: () => fund(arg),
  advance: () => advance(Number(arg) || 1),
  vest,
  open: open_,
  close: () => close(arg ?? '0'),
  gme: () => gmePrice(arg),
  status,
}

const run = commands[cmd]
if (!run) {
  console.log(await readFile(new URL(import.meta.url)).then((b) => b.toString().split('*/')[0]))
  process.exit(cmd ? 1 : 0)
}

run().catch((e) => {
  console.error(`\x1b[31m✗\x1b[0m ${e.shortMessage ?? e.message ?? e}`)
  process.exit(1)
})
