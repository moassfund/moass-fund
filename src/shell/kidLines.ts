// What the Kid says. House rules (see CLAUDE.md): jokes never promise returns, risk facts stay
// true, no real people by name, no em dashes.
import { EPOCH_HOURS, TOKEN } from '../config'
import type { AppId } from './apps'
import type { KidPose } from './kidSprite'

/** A clickable answer in his bubble: opens a window, makes him reply, or both. */
export interface KidOption {
  label: string
  open?: AppId
  reply?: KidLine
}

/**
 * A bare string gets a random pose; a tuple pins the pose that sells the joke; an object is
 * an offer of help in the classic desktop-assistant style ("It looks like you're trying to...").
 */
export type KidLine = string | [text: string, pose: KidPose] | { text: string; pose?: KidPose; options: KidOption[] }

export const KID_GENERAL: KidLine[] = [
  {
    text: "It looks like you're trying to hold. Would you like help doing absolutely nothing?",
    pose: 'shadesUp',
    options: [
      { label: 'Help me do nothing', reply: ["Done. You're a natural.", 'shrug'] },
      { label: 'I was already doing nothing', reply: 'Overachiever.' },
    ],
  },
  {
    text: "It looks like you're new here. Would you like the two minute version?",
    pose: 'wave',
    options: [
      { label: 'Open the prospectus', open: 'prospectus', reply: 'Risk section is at the bottom. It is the important part.' },
      { label: 'I only read memes', reply: ['Then I am your prospectus. God help us both.', 'shrug'] },
    ],
  },
  ['MOASS is tomorrow. It has been tomorrow since 2021.', 'shrug'],
  ['Wen moon? Top right of your screen, ser.', 'point'],
  'We like the stock. The treasury likes it three times as much.',
  'Hedgies are not invited to this desktop.',
  ['Buy high, sell never. This is not advice, it is a condition.', 'shrug'],
  "My wife's boyfriend says APY can fall. He read the prospectus. Be like him.",
  'Positions or ban.',
  'Sir, this is a treasury.',
  'No cell, no sell.',
  ["A 2x long is great until it isn't. The liquidation price lives in My Treasury.", 'point'],
  'GME up, backing up. GME down, backing down. Leverage just makes it louder.',
  ['I am not a financial advisor. I am barely a kid in a suit.', 'shadesUp'],
  'Everything I know I learned on wallstreetbets. That is the risk disclosure.',
  'GameStop sells games. We hold the ticker with leverage. Different business, same vibes.',
  ["'Can't go tits up' is what people say right before it goes tits up.", 'shrug'],
  'Diamond hands are free. Liquidations are not.',
  `Rebases pay you in ${TOKEN.symbol}, not dollars. Smooth brains forget that part.`,
  'Still here? Same. Holding is a lifestyle.',
  'Apes together strong. Apes who read the risk section, stronger.',
  ["Zoom out. No, further. Okay too far, that's the moon.", 'point'],
  "I put on the suit so you'd take the memes seriously.",
  ['Somebody out there sold the bottom today. Pour one out.', 'shadesUp'],
  'This desktop has more uptime than my attention span.',
  ['Dilution is real. So is staking. One of them is a button on your screen.', 'point'],
]

export const KID_POKED: KidLine[] = [
  "Hey. I'm holding here.",
  "Poke me again and I'm telling the mods.",
  'What? I am working. This is what working looks like.',
  'Yes, the shades stay on indoors.',
  ['You want alpha? Read Prospectus.txt. That is the alpha.', 'point'],
  'Careful. This suit is a rental.',
  'I charge 2 and 20 for pokes.',
  'Stop. You are shaking my diamond hands.',
  ['Fine. Shades off. Happy? It is still just a kid under here.', 'shadesUp'],
  'Sir, this is a taskbar.',
  ['My lawyer says I cannot comment on wen moon.', 'shrug'],
  'Ow. That was my good cufflink.',
  'You poke like a paper hand.',
  'I am not a paperclip. The paperclip sold.',
  ['Every poke delays the MOASS by one day. Think about that.', 'point'],
  ["Look, I don't know either. Nobody does. That is the whole point of a shrug.", 'shrug'],
  'Did you come here to stake or to bother a child?',
  'Bullish on poking. Bearish on my patience.',
  'If I had a tendie for every poke, the treasury would be fully backed by chicken.',
  ['Why. Just why.', 'shadesUp'],
  ['Hi! Yes, hello. Still here, still holding.', 'wave'],
  ['Up and to the right. It is the only direction I point.', 'point'],
  ['You again. Big fan of your work.', 'wave'],
  'I have been standing behind this taskbar since boot. My legs are a rumour.',
  ['Do I look like I know what the price does next?', 'shadesUp'],
]

export const KID_BY_APP: Record<AppId, KidLine[]> = {
  genesis: [
    'Getting in before there is a chart. Brave, or early. Usually both.',
    ['No market yet, so no slippage and no bots. Just a fixed price and your nerve.', 'shadesUp'],
    'Miss the minimum and everyone gets refunded. That is the one bit with a safety net.',
    {
      text: "It looks like you're trying to become a founding shareholder. Would you like help?",
      options: [
        { label: 'Why is there no price?', reply: ['Because nothing trades yet. The pool does not exist until this offering closes and pays for it. You are the liquidity, ape.', 'point'] },
        { label: 'What if nobody shows up?', reply: ['Then the minimum is missed, the fund never starts, and you pull your own money back out. Nothing minted, nothing lost but time.', 'shrug'] },
        { label: 'Read the terms properly', open: 'prospectus' },
      ],
    },
  ],
  getgme: [
    'Bring whatever you have. It comes out the other side as GME.',
    ['It goes the other way too. Nobody is locked in, which is the only reason to stay.', 'shadesUp'],
    ['Cross-chain means it arrives in a second transaction you never sign. Leave the window open.', 'point'],
    {
      text: "It looks like you're trying to fund a subscription. Would you like help?",
      options: [
        { label: 'Why do I need GME?', reply: ['The offering is priced in GME and the treasury holds GME. Dollars do not enter into it.', 'point'] },
        { label: 'Take me to the offering', open: 'genesis' },
        { label: 'I already have some', reply: 'Then you are ahead of most people here.' },
      ],
    },
  ],
  overview: [
    'Backing is what the treasury holds per token. Premium is vibes on top.',
    'Green numbers are a privilege, not a right.',
    {
      text: "It looks like you're trying to work out what this is. Would you like help?",
      options: [
        { label: 'Show me the treasury', open: 'treasury' },
        { label: 'Read the prospectus', open: 'prospectus' },
        { label: 'Just vibes, thanks', reply: ['Vibes are not backing. But okay.', 'shrug'] },
      ],
    },
  ],
  stake: [
    `Stake it and leave it. A rebase lands every ${EPOCH_HOURS} hours.`,
    {
      text: "It looks like you're trying to compound. Would you like help?",
      options: [
        { label: 'How does staking work?', reply: [`You stake ${TOKEN.symbol} 1:1 for ${TOKEN.staked}. Every ${EPOCH_HOURS} hours your balance rebases up by the current rate. The rate follows the premium and can fall. No lockup.`, 'point'] },
        { label: 'Show me the maths', open: 'calculator' },
        { label: 'Just let me stake', reply: 'Godspeed.' },
      ],
    },
  ],
  bond: [
    'Bonds: cheaper tokens, but you wait for them. Patience is a position.',
    ['Sometimes the discount goes red. Red means you are overpaying, ape.', 'point'],
    {
      text: "It looks like you're trying to buy at a discount. Want the short version?",
      options: [
        { label: 'Yes', reply: [`You pay with GME, LP or USDG. You get ${TOKEN.symbol} below market, vested over a few days. What you pay goes to the treasury, and the new tokens dilute holders.`, 'point'] },
        { label: 'No, I like surprises', reply: ['Bold strategy.', 'shrug'] },
      ],
    },
  ],
  treasury: [
    ['That liquidation price is not decoration.', 'point'],
    'Three times the GME, three times the feelings.',
    {
      text: "It looks like you're staring at a liquidation price. Would you like help?",
      pose: 'shadesUp',
      options: [
        { label: 'What happens if it hits?', reply: ['That slice of the backing is gone and backing per token drops. The spot GME, USDG and LP stay. Leverage cuts both ways.', 'point'] },
        { label: 'I prefer not to know', reply: ['Ignorance is a position too.', 'shrug'] },
      ],
    },
  ],
  calculator: [['Calculator says lambo. Calculator has never met a bear market.', 'shrug'], 'Napkin math only. APY will not sit still for a year.'],
  buy: ['Internet Exploder: the most secure browser of 2003.', ['Check the contract address twice. Scammers love a ticker.', 'point']],
  prospectus: [['Reading the docs? In this economy?', 'shadesUp'], 'The risk section is the good part. No, really.'],
  paperhands: [
    ["We don't do that here.", 'shadesUp'],
    ['Nothing in this bin has ever been restored. Proud of you.', 'shrug'],
    {
      text: "It looks like you're trying to sell. Would you like help?",
      pose: 'shadesUp',
      options: [
        { label: 'Yes', reply: ['No.', 'shrug'] },
        { label: 'No', reply: 'Correct.' },
      ],
    },
  ],
}

/** Poses a line gets when it did not pin one. Weighted toward standing still. */
const LOOSE_POSES: KidPose[] = ['idle', 'idle', 'idle', 'point', 'point', 'shrug', 'shadesUp']

const loosePose = () => LOOSE_POSES[Math.floor(Math.random() * LOOSE_POSES.length)]

export function resolveLine(line: KidLine): { text: string; pose: KidPose; options: KidOption[] } {
  if (typeof line === 'string') return { text: line, pose: loosePose(), options: [] }
  if (Array.isArray(line)) return { text: line[0], pose: line[1], options: [] }
  return { text: line.text, pose: line.pose ?? 'point', options: line.options }
}

/** Shuffle bag: every line once before any repeats. */
export function makeBag<T>(lines: T[]) {
  let bag: T[] = []
  return () => {
    if (bag.length === 0) bag = [...lines].sort(() => Math.random() - 0.5)
    return bag.pop() as T
  }
}
