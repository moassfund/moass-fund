// The Kid: a desktop assistant in the classic style, standing on his sheet of legal pad, bottom right.
// - speaks every dialogs.balloon() notification: shrug for wins, pointing at anything with a title
// - offers help with clickable answers ("It looks like you're trying to...") that open windows or explain
// - waves on his first line, frowns at error boxes, lifts his shades at "are you sure?" boxes
// - throws out a line now and then, reacts to the window you just opened, answers pokes
// - ducks behind the taskbar when he has nothing to say; can be hidden from his x or the Start menu
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AppId } from './apps'
import { dialogs, useDialogStore, type BalloonOption } from './dialogStore'
import { KID_BY_APP, KID_GENERAL, KID_POKED, makeBag, resolveLine, type KidLine } from './kidLines'
import { KID_BROWS, KID_H, KID_MOUTH_OPEN, KID_PAPER, KID_RUNS, KID_W, type KidBrow, type KidPose, type PixelRun } from './kidSprite'
import { activeIdOf, useWindowStore } from './windowStore'

const QUIET_GAP_MS = 12_000 // never chatter within this long of the last thing he said
const REST_AFTER_MS = 20_000 // no bubble for this long: duck behind the taskbar
const TALK_MS = 1_600

const Pixels = ({ runs }: { runs: PixelRun[] }) => <>{runs.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />)}</>

function KidSprite({ pose, brow, talking }: { pose: KidPose; brow: KidBrow; talking: boolean }) {
  const frames = KID_RUNS[pose]
  return (
    <svg className="kid-svg" viewBox={`0 0 ${KID_W} ${KID_H}`} shapeRendering="crispEdges" aria-hidden="true">
      <Pixels runs={KID_PAPER} />
      {/* only he bobs: the paper stays put */}
      <g className="kid-body">
        {frames.length === 1 ? (
          <Pixels runs={frames[0]} />
        ) : (
          <>
            <g className="kid-f0"><Pixels runs={frames[0]} /></g>
            <g className="kid-f1"><Pixels runs={frames[1]} /></g>
          </>
        )}
        {pose !== 'shadesUp' && <Pixels runs={KID_BROWS[brow]} />}
        {talking && <g className="kid-mouth"><Pixels runs={KID_MOUTH_OPEN} /></g>}
      </g>
    </svg>
  )
}

export function Helper() {
  const balloon = useDialogStore((s) => s.balloon)
  const hidden = useDialogStore((s) => s.kidHidden)
  const boxIcon = useDialogStore((s) => s.boxes[s.boxes.length - 1]?.icon)
  const activeId = activeIdOf(useWindowStore((s) => s.wins))
  const [talking, setTalking] = useState(false)
  const [resting, setResting] = useState(false)
  const [peeking, setPeeking] = useState(false) // shades lifted for a moment, unprompted
  const [greetId, setGreetId] = useState<number | null>(null)
  const lastSpoke = useRef(0)
  const lastApp = useRef<AppId | null>(null)
  const bags = useMemo(() => ({ general: makeBag(KID_GENERAL), poked: makeBag(KID_POKED) }), [])

  /** Says a line unless something more important is on screen. Pokes and answers pass force. */
  const say = useCallback((line: KidLine, force = false) => {
    const s = useDialogStore.getState()
    if (s.kidHidden || document.hidden) return
    if (!force && (s.balloon || s.boxes.length > 0 || s.tx || s.rsod || Date.now() - lastSpoke.current < QUIET_GAP_MS)) return
    const { text, pose, options } = resolveLine(line)
    const answers: BalloonOption[] = options.map((o) => ({
      label: o.label,
      run: () => {
        dialogs.dismissBalloon()
        if (o.open) useWindowStore.getState().open(o.open)
        if (o.reply) say(o.reply, true)
      },
    }))
    dialogs.balloon('', text, pose, answers)
  }, [])

  // every bubble: pop up, move the mouth for a moment, then clear it after a read-time
  useEffect(() => {
    if (!balloon || hidden) return
    lastSpoke.current = Date.now()
    setGreetId((g) => g ?? balloon.id) // the first thing he ever says gets a wave
    setResting(false)
    setPeeking(false)
    setTalking(true)
    const stopTalking = setTimeout(() => setTalking(false), TALK_MS)
    const readTime = balloon.options.length > 0 ? 16_000 : Math.min(11_000, Math.max(5_000, 3_000 + balloon.text.length * 55))
    const clear = setTimeout(dialogs.dismissBalloon, readTime)
    return () => {
      clearTimeout(stopTalking)
      clearTimeout(clear)
    }
  }, [balloon, hidden])

  // bubble gone: maybe lift the shades for a second, then duck down (almost at once on phones)
  useEffect(() => {
    if (balloon) return
    const timers: ReturnType<typeof setTimeout>[] = []
    if (Math.random() < 0.35) {
      timers.push(setTimeout(() => setPeeking(true), 4_000), setTimeout(() => setPeeking(false), 6_500))
    }
    const delay = window.matchMedia('(max-width: 767px)').matches ? 1_500 : REST_AFTER_MS
    timers.push(setTimeout(() => setResting(true), delay))
    return () => timers.forEach(clearTimeout)
  }, [balloon])

  // a modal he reacts to (error, confirm) brings him back up
  useEffect(() => {
    if (boxIcon === 'error' || boxIcon === 'question') setResting(false)
  }, [boxIcon])

  // unprompted lines, every 45 to 90 seconds
  useEffect(() => {
    if (hidden) return
    let t: ReturnType<typeof setTimeout>
    const loop = () => {
      t = setTimeout(() => {
        say(bags.general())
        loop()
      }, 45_000 + Math.random() * 45_000)
    }
    loop()
    return () => clearTimeout(t)
  }, [hidden, say, bags])

  // a comment on the window you just brought up, sometimes
  useEffect(() => {
    const previous = lastApp.current
    lastApp.current = activeId
    if (!activeId || activeId === previous || previous === null) return // stay quiet for the boot window
    if (Math.random() < 0.45) {
      const lines = KID_BY_APP[activeId]
      say(lines[Math.floor(Math.random() * lines.length)])
    }
  }, [activeId, say])

  if (hidden) return null

  // what he is doing right now, most urgent first
  let pose: KidPose = peeking ? 'shadesUp' : 'idle'
  let brow: KidBrow = 'none'
  if (balloon) {
    pose = balloon.pose
    if (pose === 'idle' && balloon.id === greetId) pose = 'wave'
    else if (pose === 'idle' && balloon.title) pose = 'point' // a real notification: point at it
    brow = pose === 'idle' ? (balloon.id % 2 ? 'skeptic' : 'none') : 'up'
  }
  if (boxIcon === 'question') pose = 'shadesUp'
  if (boxIcon === 'error') {
    pose = 'idle'
    brow = 'worried'
  }

  return (
    <>
      {balloon && (
        <div className="kid-bubble" role="status">
          <button type="button" className="x" aria-label="Dismiss" onClick={dialogs.dismissBalloon}>✕</button>
          {balloon.title && <b>{balloon.title}</b>}
          <span>{balloon.text}</span>
          {balloon.options.length > 0 && (
            <div className="kid-options">
              {balloon.options.map((o) => <button key={o.label} type="button" onClick={o.run}>{o.label}</button>)}
            </div>
          )}
        </div>
      )}
      <div className={`kid ${resting ? 'resting' : ''}`}>
        <KidSprite pose={pose} brow={brow} talking={talking} />
        <button type="button" className="kid-hit" aria-label="The Kid. Poke him for wisdom." onClick={() => say(bags.poked(), true)} />
        <button type="button" className="kid-close" aria-label="Hide the Kid" title="Hide the Kid (bring him back from the Start menu)" onClick={() => { dialogs.dismissBalloon(); dialogs.setKidHidden(true) }}>✕</button>
      </div>
    </>
  )
}
