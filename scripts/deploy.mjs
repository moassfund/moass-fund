#!/usr/bin/env node
/**
 * `npm run deploy` — put the protocol on a public chain.
 *
 *   npm run deploy               asks which chain
 *   npm run deploy -- --testnet  Robinhood testnet (46630)
 *   npm run deploy -- --mainnet  Robinhood Chain (4663). Real money.
 *
 * Testnet has no tokenised GME and no Uniswap, so a testnet deploy brings its
 * own stand-ins. Mainnet uses the real ones. Both write
 * `contracts/deployments/<chainid>.json` and offer to update your `.env`.
 *
 * Everything is checked before anything is broadcast, because a deployment
 * cannot be half-done: every `wire()` call is restricted to the address that
 * created the contract and can only be called once, so a run that dies partway
 * leaves contracts that can never be wired. There is no resume, only redeploy.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, formatEther, http, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS = resolve(ROOT, 'contracts')

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const step = (m) => console.log(`\x1b[35m▸\x1b[0m ${m}`)
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`)

const MAINNET = {
  key: 'mainnet',
  id: 4663,
  name: 'Robinhood Chain',
  rpc: 'https://robinhood-rpc.publicnode.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  script: 'script/Launch.s.sol',
  /** Confirmed on chain 4663. */
  externals: {
    RESERVE: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', // tokenised GME, 18dp
    USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    GME_USDG_POOL: '0xE9713f453aDB9245B19559790c96F470a18F2fDF', // V3, 1% tier
    V2_FACTORY: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
    V2_ROUTER: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
    V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  },
}

const TESTNET = {
  key: 'testnet',
  id: 46630,
  name: 'Robinhood Testnet',
  rpc: 'https://rpc.testnet.chain.robinhood.com',
  explorer: 'https://explorer.testnet.chain.robinhood.com',
  faucet: 'https://faucet.testnet.chain.robinhood.com',
  // No GME and no Uniswap exist there, so the same script the local stack uses
  // deploys stand-ins alongside the protocol.
  script: 'script/LocalStack.s.sol',
  externals: null,
}

const skipConfirm = process.argv.includes('--yes')

/** Flags win; otherwise ask, because picking the wrong chain is expensive. */
async function pickTarget() {
  if (process.argv.includes('--mainnet')) return MAINNET
  if (process.argv.includes('--testnet')) return TESTNET

  console.log('')
  console.log('  Where do you want to deploy?')
  console.log('')
  console.log(`    1  ${TESTNET.name} (${TESTNET.id})`)
  console.log('       free, faucet ETH, and stand-in GME and DEX because the')
  console.log('       testnet has neither. Same mechanics, fake assets.')
  console.log('')
  console.log(`    2  ${MAINNET.name} (${MAINNET.id})  \x1b[31mREAL MONEY\x1b[0m`)
  console.log('       real tokenised GME, real Uniswap, permanent parameters.')
  console.log('')

  const answer = await ask('  1 or 2: ')
  if (answer === '1') return TESTNET
  if (answer === '2') return MAINNET
  throw new Error('pick 1 or 2, or pass --testnet / --mainnet')
}

async function loadEnv() {
  const path = resolve(ROOT, '.env')
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(question)
  rl.close()
  return answer.trim()
}

function runForge(args, env) {
  return new Promise((resolveP, reject) => {
    const p = spawn('forge', args, { cwd: CONTRACTS, env: { ...process.env, ...env }, stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolveP() : reject(new Error(`forge exited ${code}`))))
    p.on('error', reject)
  })
}

async function main() {
  const target = await pickTarget()
  const chain = defineChain({
    id: target.id,
    name: target.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [target.rpc] } },
  })

  console.log('')
  step(`target: ${target.name} (chain ${target.id})`)

  const env = await loadEnv()

  // ── The deployer ──
  const key = process.env.DEPLOYER_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY
  if (!key) {
    throw new Error(
      'DEPLOYER_PRIVATE_KEY is not set. Put it in .env (it is gitignored).\n' +
        '  This account deploys everything and must be the only one used —\n' +
        '  every wire() is locked to whoever created the contract.',
    )
  }
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  ok(`deployer ${account.address}`)

  // ── The chain ──
  const client = createPublicClient({ chain, transport: http(target.rpc) })
  const id = await client.getChainId()
  if (id !== target.id) throw new Error(`RPC reports chain ${id}, expected ${target.id}`)
  ok(`connected to ${target.name}`)

  // ── The multisigs ──
  const guardian = env.GUARDIAN || account.address
  const teamWallet = env.TEAM_WALLET || account.address
  const deskVenue = env.DESK_VENUE || teamWallet

  for (const [label, value] of [['GUARDIAN', guardian], ['TEAM_WALLET', teamWallet]]) {
    if (!isAddress(value)) throw new Error(`${label} is not a valid address: ${value}`)
  }

  if (guardian === account.address || teamWallet === account.address) {
    warn('GUARDIAN and/or TEAM_WALLET are unset, so they default to the deployer.')
    warn('Fine for testnet. On mainnet these should be multisigs — the guardian')
    warn('can register taxed pairs, and the team wallet holds pTEAM and runs the desk.')
  }
  ok(`guardian ${guardian}`)
  ok(`team wallet ${teamWallet}`)
  ok(`desk venue ${deskVenue}`)

  // ── External contracts, on mainnet only ──
  // ── Branding ──
  // Set once at construction and permanent afterwards, so this is printed
  // loudly: a test launch under the real ticker cannot be taken back.
  const tokenName = env.TOKEN_NAME || 'Moass Fund'
  const tokenSymbol = env.TOKEN_SYMBOL || 'MOASS'
  if (!/^[A-Za-z0-9]{2,11}$/.test(tokenSymbol)) {
    throw new Error(`TOKEN_SYMBOL must be 2-11 alphanumeric characters, got "${tokenSymbol}"`)
  }
  ok(`token      ${tokenName} ($${tokenSymbol}, s${tokenSymbol})`)

  const forgeEnv = {
    PRIVATE_KEY: key.startsWith('0x') ? key : `0x${key}`,
    GUARDIAN: guardian,
    TEAM_WALLET: teamWallet,
    DESK_VENUES: deskVenue,
    TOKEN_NAME: tokenName,
    TOKEN_SYMBOL: tokenSymbol,
  }

  if (target.externals) {
    step('checking the external contracts exist')
    for (const [name, address] of Object.entries(target.externals)) {
      const code = await client.getCode({ address })
      if (!code || code === '0x') throw new Error(`${name} has no code at ${address} on ${target.name}`)
      forgeEnv[name] = address
      ok(`${name.toLowerCase().padEnd(14)} ${address}`)
    }
  } else {
    warn('testnet has no tokenised GME and no Uniswap, so stand-ins are deployed')
    warn('alongside the protocol. Mechanics are identical; the assets are not real.')
  }

  const balance = await client.getBalance({ address: account.address })
  // Measured: the full deployment costs about 0.003 ETH. Ask for headroom.
  if (balance < 10n ** 16n) {
    const hint = target.faucet ? `\n  Faucet: ${target.faucet}` : ''
    throw new Error(
      `deployer holds ${formatEther(balance)} ETH, which is not enough. ` +
        `Deployment costs roughly 0.003 ETH; fund it with at least 0.01.${hint}`,
    )
  }
  ok(`balance ${Number(formatEther(balance)).toFixed(4)} ETH`)

  // ── Last chance ──
  if (target.key === 'mainnet' && !skipConfirm) {
    console.log('')
    warn(`This deploys as "${tokenName}" ($${tokenSymbol}). The name is set at`)
    warn('construction and there is no setter: it is permanent. Set TOKEN_NAME and')
    warn('TOKEN_SYMBOL in .env if this is a test and should not use the real ticker.')
    console.log('')
    warn('This is mainnet. Parameters in Constants.sol are permanent once deployed,')
    warn('and the wiring cannot be redone. If anything is wrong you redeploy from')
    warn('scratch at a new address.')
    const answer = await ask('\nType the word deploy to continue: ')
    if (answer !== 'deploy') {
      console.log('aborted, nothing was sent')
      return
    }
  }

  // ── Go ──
  console.log('')
  step('deploying')
  await runForge(
    ['script', target.script, '--rpc-url', target.rpc, '--broadcast', '--slow'],
    forgeEnv,
  )

  const path = resolve(CONTRACTS, 'deployments', `${target.id}.json`)
  if (!existsSync(path)) throw new Error('deployment finished but wrote no address file')
  const a = JSON.parse(await readFile(path, 'utf8'))

  // ── Hand it to the front end ──
  const lines = {
    VITE_DATA_SOURCE: 'chain',
    VITE_RPC_URL: target.rpc,
    VITE_CHAIN_ID: String(target.id),
    // Must match the TOKEN_* the contracts were constructed with, or the UI
    // names a token that does not exist at these addresses.
    VITE_TOKEN_NAME: tokenName,
    VITE_TOKEN_SYMBOL: tokenSymbol,
    VITE_ADDR_MOASS: a.moass,
    VITE_ADDR_SMOASS: a.sMoass,
    VITE_ADDR_STAKING: a.staking,
    VITE_ADDR_DISTRIBUTOR: a.distributor,
    VITE_ADDR_TREASURY: a.treasury,
    VITE_ADDR_BOND_DEPOSITORY: a.bondDepository,
    VITE_ADDR_ORACLE: a.oracle,
    VITE_ADDR_GME_DESK: a.gmeDesk,
    VITE_ADDR_INVERSE_BOND: a.inverseBond,
    VITE_ADDR_PAIR: a.pair,
    VITE_ADDR_GME: a.gme,
    VITE_ADDR_USDG: a.usdg ?? target.externals?.USDG ?? '',
    VITE_ADDR_GME_USDG_POOL: a.gmeUsdgPool ?? target.externals?.GME_USDG_POOL ?? '',
  }

  const envPath = resolve(ROOT, `.env.${target.key}`)
  await writeFile(
    envPath,
    `# ${target.name} deployment, ${new Date().toISOString()}\n` +
      Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') +
      '\n',
  )

  console.log('')
  ok(`deployed. Addresses in contracts/deployments/${target.id}.json`)
  ok(`front-end config written to .env.${target.key}`)
  console.log('')
  console.log(`  token    ${a.moass}`)
  console.log(`  pair     ${a.pair}`)
  console.log(`  sale     ${a.genesisBond}`)
  console.log(`  explorer ${target.explorer}/address/${a.moass}`)
  console.log('')
  console.log('NEXT, in order:')
  console.log('  1. Copy .env.%s into .env to point the site at it.', target.key)
  console.log('  2. Run the sale: buyers call GenesisBond.purchase(). Nothing trades yet.')
  console.log('  3. GenesisBond.finalize() — the switch. Seeds the pool and turns on')
  console.log('     staking, bonds and the tax. This is when the token becomes tradeable.')
  console.log('  4. Start the keeper (npm run indexer, hourly). Without it the TWAP goes')
  console.log('     stale, emissions mint zero and bonds stop pricing.')
  console.log('')
}

main().catch((e) => {
  console.error(`\n\x1b[31m✗\x1b[0m ${e.message ?? e}\n`)
  process.exit(1)
})
