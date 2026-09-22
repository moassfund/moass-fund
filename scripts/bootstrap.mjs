#!/usr/bin/env node
/**
 * `npm run bootstrap` — everything a fresh clone needs, once.
 *
 * Checks the toolchain, installs both halves of the project (node modules and
 * the Solidity dependency), compiles the contracts and creates a .env. Safe to
 * re-run: nothing here overwrites work.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS = resolve(ROOT, 'contracts')

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const step = (m) => console.log(`\x1b[35m▸\x1b[0m ${m}`)
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

function has(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function main() {
  console.log('')
  step('checking the toolchain')

  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) throw new Error(`Node ${process.versions.node} is too old. Need 20 or newer.`)
  ok(`node ${process.versions.node}`)

  const foundry = has('forge') && has('anvil')
  if (foundry) {
    ok('foundry')
  } else {
    warn('foundry is missing. The app still runs on simulated data, but the')
    warn('contracts will not build and `npm start` cannot bring up a chain.')
    warn('Install it with:  curl -L https://foundry.paradigm.xyz | bash && foundryup')
  }

  step('installing node dependencies')
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT })
  ok('node modules')

  if (foundry) {
    // forge-std is vendored rather than a submodule, so a fresh clone may not
    // have it. Cloning without .git keeps it out of the way of the repo.
    const forgeStd = resolve(CONTRACTS, 'lib', 'forge-std')
    if (!existsSync(resolve(forgeStd, 'src', 'Test.sol'))) {
      step('installing forge-std')
      run('git', ['clone', '--quiet', '--depth', '1', 'https://github.com/foundry-rs/forge-std', forgeStd])
      run('rm', ['-rf', resolve(forgeStd, '.git')])
    }
    ok('forge-std')

    step('compiling contracts')
    run('forge', ['build'], { cwd: CONTRACTS })
    ok('contracts compiled')
  }

  const env = resolve(ROOT, '.env')
  if (!existsSync(env)) {
    await copyFile(resolve(ROOT, '.env.example'), env)
    ok('created .env from .env.example')
  } else {
    ok('.env already exists, left alone')
  }

  console.log('')
  console.log('\x1b[32mReady.\x1b[0m')
  console.log('')
  console.log('  npm start              local chain + protocol + desktop')
  console.log('  npm start -- --mock    just the desktop, simulated data')
  console.log('  npm run check          typecheck, both test suites, build')
  console.log('')
}

main().catch((e) => {
  console.error(`\x1b[31m✗\x1b[0m ${e.message ?? e}`)
  process.exit(1)
})
