import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { TOKEN, QUOTE } from '../config'

export type AppId = 'genesis' | 'overview' | 'stake' | 'bond' | 'treasury' | 'calculator' | 'buy' | 'prospectus' | 'paperhands'

export interface AppDef {
  id: AppId
  /** Title bar text */
  title: string
  /** Desktop icon / taskbar label */
  short: string
  /** Start menu sub-label */
  blurb: string
  icon: string
  /** Icon tile colour */
  tint: string
  w: number
  h: number
  component: LazyExoticComponent<ComponentType>
}

// Every app is a default-exported component in src/apps, lazy-loaded on first open.
export const APPS: AppDef[] = [
  { id: 'overview', title: 'Fund Overview', short: 'Fund Overview', blurb: 'Price, backing, APY, runway', icon: '📈', tint: '#e31b23', w: 760, h: 560, component: lazy(() => import('../apps/Overview')) },
  { id: 'genesis', title: 'Founding Offering - Setup Wizard', short: 'Founding Offering', blurb: `Get in before there is a market`, icon: '📜', tint: '#c8a02c', w: 560, h: 620, component: lazy(() => import('../apps/Genesis')) },
  { id: 'stake', title: 'Stake.exe', short: 'Stake.exe', blurb: 'Compound every 8 hours', icon: '💎', tint: '#2e9e2e', w: 440, h: 590, component: lazy(() => import('../apps/Stake')) },
  { id: 'bond', title: 'Bond Desk', short: 'Bond Desk', blurb: `${TOKEN.symbol} at a discount, vested`, icon: '🏦', tint: '#f8b636', w: 720, h: 540, component: lazy(() => import('../apps/BondDesk')) },
  { id: 'treasury', title: 'My Treasury', short: 'My Treasury', blurb: `The 2x ${QUOTE.symbol} long, live`, icon: '🗄️', tint: '#3a6ea5', w: 800, h: 580, component: lazy(() => import('../apps/Treasury')) },
  { id: 'calculator', title: 'Tendies Calculator', short: 'Tendies Calc', blurb: 'Project your stack', icon: '🧮', tint: '#8a8a8a', w: 420, h: 560, component: lazy(() => import('../apps/Calculator')) },
  { id: 'buy', title: `Buy $${TOKEN.symbol} - Internet Exploder`, short: `Buy $${TOKEN.symbol}`, blurb: `Swap ${QUOTE.symbol} for ${TOKEN.symbol}`, icon: '🌐', tint: '#1e90ff', w: 640, h: 500, component: lazy(() => import('../apps/Buy')) },
  { id: 'prospectus', title: 'Prospectus.txt - Notepad', short: 'Prospectus.txt', blurb: 'How it works, and the risks', icon: '📄', tint: '#f4f4f4', w: 600, h: 560, component: lazy(() => import('../apps/Prospectus')) },
  { id: 'paperhands', title: 'Paper Hands Bin', short: 'Paper Hands', blurb: 'Where sell orders go to die', icon: '🗑️', tint: '#9aa7b4', w: 480, h: 360, component: lazy(() => import('../apps/PaperHands')) },
]

export const APP_BY_ID = Object.fromEntries(APPS.map((a) => [a.id, a])) as Record<AppId, AppDef>
export const isAppId = (s: string): s is AppId => Object.prototype.hasOwnProperty.call(APP_BY_ID, s)
