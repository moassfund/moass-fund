#!/usr/bin/env node
/**
 * `npm start` — the whole thing, locally, in one command.
 *
 * Brings up a throwaway chain, deploys the protocol onto it, runs the genesis
 * sale so the machine is actually switched on, and serves the desktop pointed
 * at it. What you get is the real contracts, real transactions and a real
 * wallet flow, with no testnet, no faucet and no network.
 *
 *   npm start              full local stack
 *   npm start -- --mock    just the UI on simulated data
 *
 * Ctrl-C stops everything it started.
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readGenesisConstants } from './constants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS = resolve(ROOT, 'contracts')
const RPC = 'http://127.0.0.1:8545'
const ENV_FILE = resolve(ROOT, '.env.local')

/** Anvil's first account. Well known, worthless, and never used anywhere else. */
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** Anvil's second, third and fourth, used to fill the genesis sale. */
const BUYER_KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]

const MOCK_ONLY = process.argv.includes('--mock')
const children = []
let shuttingDown = false

const log = (msg) => console.log(`\x1b[35m▸\x1b[0m ${msg}`)
const warn = (msg) => console.log(`\x1b[33m!\x1b[0m ${msg}`)

const chain = defineChain({
  id: 31337,
  name: 'Moass Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

const abi = parseAbi([
  'function mint(address to, uint256 value)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function purchase(uint256 amount)',
  'function finalize()',
  'function claim() returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function checkpoint()',
  'function totalSupply() view returns (uint256)',
  'function backingPerToken() view returns (uint256)',
  'function epoch() view returns (uint64, uint64, uint64, uint256)',
  'function rebase()',
  'function setReserves(uint112 reserve0, uint112 reserve1)',
])

// ── Process plumbing ─────────────────────────────────────────────────────────

function track(child, name) {
  children.push({ child, name })
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      warn(`${name} exited with code ${code}`)
      shutdown(1)
    }
  })
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => {
  console.log('')
  log('stopping')
  shutdown(0)
})
process.on('SIGTERM', () => shutdown(0))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForRpc(timeoutMs = 20_000) {
  const started = Date.now()
  const client = createPublicClient({ chain, transport: http(RPC) })
  while (Date.now() - started < timeoutMs) {
    try {
      await client.getChainId()
      return client
    } catch {
      await sleep(200)
    }
  }
  throw new Error('anvil did not come up in time')
}

/**
 * A port left busy by a previous run is the most likely way this fails, and
 * anvil's own message for it ("exited with code 1") says nothing useful. Check
 * first and say what to do about it.
 */
function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function requirePorts(ports) {
  const busy = []
  for (const port of ports) {
    if (!(await portFree(port))) busy.push(port)
  }
  if (busy.length) {
    throw new Error(
      `port ${busy.join(' and ')} already in use — most likely a previous run.\n` +
        `  Stop it with:  kill $(lsof -ti :${busy.join(' -ti :')})`,
    )
  }
}

function requireTool(bin, hint) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
  } catch {
    throw new Error(`${bin} is not installed. ${hint}`)
  }
}

// ── The stack ────────────────────────────────────────────────────────────────

async function deployProtocol() {
  log('deploying the protocol')
  await new Promise((ok, fail) => {
    const p = spawn(
      'forge',
      ['script', 'script/LocalStack.s.sol', '--rpc-url', RPC, '--broadcast', '--silent'],
      { cwd: CONTRACTS, env: { ...process.env, PRIVATE_KEY: DEPLOYER_KEY }, stdio: 'inherit' },
    )
    // forge script can linger after broadcasting; the deployment file is the
    // real signal that it finished its job.
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`forge script exited ${code}`))))
    p.on('error', fail)
  })

  const path = resolve(CONTRACTS, 'deployments', '31337.json')
  if (!existsSync(path)) throw new Error('deployment file was not written')
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Advances the chain's clock. Genesis needs a deadline to pass. */
async function timeTravel(client, seconds) {
  await client.request({ method: 'evm_increaseTime', params: [seconds] })
  await client.request({ method: 'evm_mine', params: [] })
}

async function runGenesis(client, a) {
  log('running the genesis sale')

  const wallet = (key) =>
    createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) })
  const deployer = wallet(DEPLOYER_KEY)

  const send = async (w, address, functionName, args = []) => {
    const hash = await w.writeContract({ address, abi, functionName, args })
    await client.waitForTransactionReceipt({ hash })
  }

  // Read from Constants.sol rather than restated here: these used to be
  // hardcoded at the old 2,000 / 15,000 and broke the entire local stack the
  // moment the real caps moved.
  const genesis = await readGenesisConstants()
  const walletCap = parseUnits(String(genesis.walletCapGme), 18)
  const minRaise = parseUnits(String(genesis.minRaiseGme), 18)

  let raised = 0n
  const buyers = [...BUYER_KEYS.map(wallet), deployer]

  for (const w of buyers) {
    if (raised >= minRaise) break
    const remaining = minRaise - raised
    const amount = remaining < walletCap ? remaining : walletCap
    await send(deployer, a.gme, 'mint', [w.account.address, amount])
    await send(w, a.gme, 'approve', [a.genesisBond, amount])
    await send(w, a.genesisBond, 'purchase', [amount])
    raised += amount
  }

  if (raised < minRaise) {
    // Anvil's named accounts may not cover the floor at the current wallet
    // cap, so mint through extra throwaway accounts until it is met.
    let i = 0
    while (raised < minRaise) {
      const key = `0x${(BigInt(DEPLOYER_KEY) + BigInt(1000 + i++)).toString(16).padStart(64, '0')}`
      const w = wallet(key)
      // Fund gas for the fresh account.
      await client.request({
        method: 'anvil_setBalance',
        params: [w.account.address, '0xDE0B6B3A7640000'],
      })
      const remaining = minRaise - raised
      const amount = remaining < walletCap ? remaining : walletCap
      await send(deployer, a.gme, 'mint', [w.account.address, amount])
      await send(w, a.gme, 'approve', [a.genesisBond, amount])
      await send(w, a.genesisBond, 'purchase', [amount])
      raised += amount
    }
  }

  log(`raised ${raised / 10n ** 18n} GME, closing the sale`)
  await timeTravel(client, genesis.deadlineSeconds + 60) // past GENESIS_DEADLINE
  await send(deployer, a.genesisBond, 'finalize')

  // Buyers' MOASS vests over GENESIS_VEST and their GME all went into the sale, so
  // without this the test wallets are empty and there is nothing to click.
  // Skip the vest, claim for everyone, and hand out GME to bond with.
  log('vesting the genesis allocation and funding the test wallets')
  await timeTravel(client, genesis.vestSeconds + 60) // past GENESIS_VEST
  for (const w of BUYER_KEYS.map(wallet)) {
    await send(w, a.genesisBond, 'claim')
    await send(deployer, a.gme, 'mint', [w.account.address, parseUnits('200', 18)])
  }

  // The oracle needs an observation at least 30 minutes old before anything can
  // price, and the time travel above invalidated any earlier one. This has to
  // come last.
  log('priming the oracle')
  await send(deployer, a.oracle, 'checkpoint')
  await timeTravel(client, 31 * 60)
  await send(deployer, a.oracle, 'checkpoint')

  // Skipping the sale deadline and the vest left the 8-hour epoch clock days
  // behind, and the contract only advances one epoch per call — so the app
  // would open on a countdown frozen at zero. Turn the crank until it is
  // current.
  log('catching the epoch clock up')
  for (let i = 0; i < 60; i++) {
    const [, , end] = await client.readContract({ address: a.staking, abi, functionName: 'epoch' })
    const { timestamp } = await client.getBlock()
    if (BigInt(end) > timestamp) break
    await send(deployer, a.staking, 'rebase')
  }

  const supply = await client.readContract({ address: a.moass, abi, functionName: 'totalSupply' })
  const backing = await client.readContract({
    address: a.treasury,
    abi,
    functionName: 'backingPerToken',
  })
  log(
    `protocol live: ${(Number(supply) / 1e9).toFixed(0)} MOASS in existence, ` +
      `backing ${(Number(backing) / 1e18).toFixed(3)} GME each`,
  )
}

async function writeEnv(a) {
  const body = [
    '# Generated by `npm start`. Throwaway local addresses — safe to delete.',
    'VITE_DATA_SOURCE=chain',
    `VITE_RPC_URL=${RPC}`,
    'VITE_CHAIN_ID=31337',
    `VITE_ADDR_MOASS=${a.moass}`,
    `VITE_ADDR_SMOASS=${a.sMoass}`,
    `VITE_ADDR_STAKING=${a.staking}`,
    `VITE_ADDR_DISTRIBUTOR=${a.distributor}`,
    `VITE_ADDR_TREASURY=${a.treasury}`,
    `VITE_ADDR_BOND_DEPOSITORY=${a.bondDepository}`,
    `VITE_ADDR_ORACLE=${a.oracle}`,
    `VITE_ADDR_GME_DESK=${a.gmeDesk}`,
    `VITE_ADDR_INVERSE_BOND=${a.inverseBond}`,
    `VITE_ADDR_PAIR=${a.pair}`,
    `VITE_ADDR_GME=${a.gme}`,
    `VITE_ADDR_USDG=${a.usdg}`,
    `VITE_ADDR_GME_USDG_POOL=${a.gmeUsdgPool}`,
    '',
  ].join('\n')
  await writeFile(ENV_FILE, body)
  log('wrote .env.local')
}

function startVite() {
  log('starting the desktop')
  console.log('')
  track(spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: 'inherit' }), 'vite')
}

async function main() {
  if (MOCK_ONLY) {
    log('simulated data (--mock)')
    await rm(ENV_FILE, { force: true })
    startVite()
    return
  }

  requireTool('anvil', 'Install Foundry: https://getfoundry.sh')
  requireTool('forge', 'Install Foundry: https://getfoundry.sh')
  await requirePorts([8545, 5173])

  log('starting a local chain')
  track(
    spawn('anvil', ['--silent', '--port', '8545', '--chain-id', '31337'], { stdio: 'ignore' }),
    'anvil',
  )
  const client = await waitForRpc()

  const addresses = await deployProtocol()
  await runGenesis(client, addresses)
  await writeEnv(addresses)

  const account = privateKeyToAccount(BUYER_KEYS[0])
  const client2 = createPublicClient({ chain, transport: http(RPC) })
  const moassBal = await client2.readContract({
    address: addresses.moass, abi, functionName: 'balanceOf', args: [account.address],
  })
  const gmeBal = await client2.readContract({
    address: addresses.gme, abi, functionName: 'balanceOf', args: [account.address],
  })

  console.log('')
  log('ready — http://localhost:5173')
  console.log('')
  console.log('  Import this account to click through the app for real:')
  console.log(`    address      ${account.address}`)
  console.log(`    private key  ${BUYER_KEYS[0]}`)
  console.log(`    network      Moass Local · chain id 31337 · ${RPC}`)
  console.log('')
  console.log(`  It holds ${(Number(moassBal) / 1e9).toFixed(2)} MOASS and ${(Number(gmeBal) / 1e18).toFixed(0)} GME.`)
  console.log('  Stake the MOASS, bond the GME. Both are real transactions.')

  startVite()
}

main().catch((e) => {
  console.error(`\x1b[31m✗\x1b[0m ${e.message ?? e}`)
  shutdown(1)
})
