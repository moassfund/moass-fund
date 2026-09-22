// Single place for naming, chain and links. Swap placeholders before launch.
export const TOKEN = { symbol: 'MOASS', staked: 'sMOASS', name: 'Moass Fund' } as const
export const QUOTE = { symbol: 'GME', name: 'GameStop (tokenized)' } as const
export const STABLE = { symbol: 'USDG' } as const

export const EPOCH_HOURS = 8
export const EPOCHS_PER_DAY = 24 / EPOCH_HOURS

export const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  rpcUrl: (import.meta.env?.VITE_RPC_URL as string | undefined) || 'http://localhost:8545',
  explorer: 'https://robinhoodchain.blockscout.com',
} as const

export const DATA_SOURCE: 'mock' | 'chain' =
  (import.meta.env?.VITE_DATA_SOURCE as string | undefined) === 'chain' ? 'chain' : 'mock'

// Desktop wallpaper (files in /public/wallpaper).
//   sky       full-screen image WITH the RGB split baked in (design/rgb-split.cjs). Used by crt: 'static'
//   skyClean  same image, no split. Used by crt: 'animated' (channels are split live in CSS) and 'off'
//   art       optional second layer pinned top-right ('' = none)
//   focus     CSS position: which part of the image survives cropping (desktop / phone portrait)
//   crt       'animated' = drifting RGB split, crawling scanlines, flicker, rolling band
//             'static'   = baked split + still scanlines (lightest)   'off' = plain image
// The CRT layers sit over the wallpaper only: icons and windows are never filtered.
// Original vector fallback: { sky: '/wallpaper/sky.svg', skyClean: '/wallpaper/sky.svg', art: '/wallpaper/art.svg', focus: '50% 100%', focusMobile: '50% 100%', crt: 'off' }
// Safe zones: icons own the left ~110px, the taskbar the bottom 38px, windows open centre-left.
export const WALLPAPER: {
  sky: string
  skyClean: string
  art: string
  focus: string
  focusMobile: string
  crt: 'animated' | 'static' | 'off'
  /** 0 = full-strength wallpaper, 1 = black. A near-black veil over picture + CRT so the desktop stays calm. */
  dim: number
} = {
  sky: '/wallpaper/moass-bg.webp',
  skyClean: '/wallpaper/moass-bg-clean.webp',
  art: '',
  focus: '72% 40%',
  focusMobile: '80% 50%',
  crt: 'static',
  dim: 0.74,
}

// TODO: fill in at launch. Empty string = "coming soon" in the UI.
export const LINKS = {
  x: '',
  telegram: '',
  dex: '',
  chart: '',
  docs: '',
  tokenAddress: '',
} as const
