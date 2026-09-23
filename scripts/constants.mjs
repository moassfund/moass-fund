/**
 * Reads the genesis terms out of Constants.sol.
 *
 * The contracts do not expose their own caps or price, so anything off-chain
 * that needs them has to get them from somewhere. Restating them in JavaScript
 * is how they go stale: `start.mjs` hardcoded a 2,000 GME wallet cap and broke
 * the whole local stack the moment the real cap moved, and the front end
 * restating them is what let the caps drift 24x in the first place.
 *
 * One reader, one source of truth.
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONSTANTS_SOL = resolve(ROOT, 'contracts', 'src', 'Constants.sol')

const SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86_400, weeks: 604_800 }

/** `625e18` and `2_000e18` both mean the same thing to Solidity. */
function wad(source, name) {
  const m = source.match(new RegExp(`${name}\\s*=\\s*([0-9_.]+)e18`))
  if (!m) throw new Error(`could not read ${name} from Constants.sol`)
  return Number(m[1].replace(/_/g, ''))
}

/** `5 days`, `10 minutes`, `1 hours`. Returned in seconds. */
function duration(source, name) {
  const m = source.match(new RegExp(`${name}\\s*=\\s*([0-9_]+)\\s*(seconds|minutes|hours|days|weeks)`))
  if (!m) throw new Error(`could not read ${name} from Constants.sol`)
  return Number(m[1].replace(/_/g, '')) * SECONDS[m[2]]
}

/**
 * Genesis terms, in whole reserve units and seconds.
 *
 * @returns {Promise<{priceGme:number, hardCapGme:number, walletCapGme:number,
 *   minRaiseGme:number, vestSeconds:number, deadlineSeconds:number}>}
 */
export async function readGenesisConstants() {
  const s = await readFile(CONSTANTS_SOL, 'utf8')
  return {
    priceGme: wad(s, 'GENESIS_PRICE_WAD'),
    hardCapGme: wad(s, 'GENESIS_HARD_CAP_WAD'),
    walletCapGme: wad(s, 'GENESIS_WALLET_CAP_WAD'),
    minRaiseGme: wad(s, 'GENESIS_MIN_RAISE_WAD'),
    vestSeconds: duration(s, 'GENESIS_VEST'),
    deadlineSeconds: duration(s, 'GENESIS_DEADLINE'),
  }
}
