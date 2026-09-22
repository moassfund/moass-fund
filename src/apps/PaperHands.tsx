import { useState } from 'react'
import { dialogs } from '../shell/dialogStore'
import { ListView, MenuBar, StatusBar, fmtNum, type Column } from '../ui'
import './PaperHands.css'

interface BinFile {
  name: string
  icon: string
  from: string
  deleted: string
  sizeKb: number
  refusal: string
}

const FILES: BinFile[] = [
  { name: 'sell_order.txt', icon: '📄', from: 'C:\\Brain\\Lizard', deleted: '1/28/2021 9:31 AM', sizeKb: 4, refusal: 'Cannot restore sell_order.txt.\n\nThe sell button was uninstalled from this machine. Nobody remembers when.' },
  { name: 'stop_loss.cfg', icon: '⚙️', from: 'C:\\Brain\\Risk Management', deleted: '2/2/2021 3:59 PM', sizeKb: 1, refusal: 'Cannot restore stop_loss.cfg.\n\nThe folder C:\\Brain\\Risk Management no longer exists. It may never have existed.' },
  { name: 'exit_strategy.doc', icon: '📝', from: 'C:\\Documents\\Plans', deleted: '3/10/2021 12:15 PM', sizeKb: 0, refusal: 'Cannot restore exit_strategy.doc.\n\nThe file is empty. It was always empty.' },
  { name: 'fud_from_cousin.eml', icon: '✉️', from: 'C:\\Mail\\Thanksgiving', deleted: '11/25/2021 6:42 PM', sizeKb: 38, refusal: 'Cannot restore fud_from_cousin.eml.\n\nThe sender is still in index funds and has been marked as spam.' },
  { name: 'take_profits_early.xls', icon: '📊', from: 'C:\\Brain\\Lizard\\Bad Ideas', deleted: '6/2/2021 10:04 AM', sizeKb: 212, refusal: 'Cannot restore take_profits_early.xls.\n\nDiamond Hands (diamond.sys) has an exclusive lock on this file.' },
  { name: 'short_thesis.ppt', icon: '📉', from: 'C:\\Hedgies\\Decks', deleted: '1/27/2021 4:00 PM', sizeKb: 6_900, refusal: 'Cannot restore short_thesis.ppt.\n\nThe file is corrupted. So was the thesis.' },
]

const fmtSize = (kb: number) => `${fmtNum(kb, 0)} KB`
const TOTAL_KB = FILES.reduce((sum, f) => sum + f.sizeKb, 0)

const COLUMNS: Column<BinFile>[] = [
  { key: 'name', header: 'Name', render: (f) => <><span aria-hidden="true">{f.icon}</span> {f.name}</> },
  { key: 'from', header: 'Original location', render: (f) => f.from },
  { key: 'deleted', header: 'Date deleted', render: (f) => f.deleted },
  { key: 'size', header: 'Size', align: 'right', render: (f) => fmtSize(f.sizeKb) },
]

export default function PaperHands() {
  const [selected, setSelected] = useState<string | null>(null)
  const current = FILES.find((f) => f.name === selected)

  const restore = (f: BinFile) => void dialogs.error('Access denied', f.refusal)

  // click selects; double click or Enter tries to restore (touch users have the Restore button)
  const pick = (f: BinFile) => setSelected(f.name)

  const empty = async () => {
    const sure = await dialogs.confirm(
      'Confirm Multiple File Delete',
      `Are you sure you want to permanently delete these ${FILES.length} items?\n\nYou will never be able to sell again. Some would call that a feature.`,
    )
    if (!sure) return
    await dialogs.info('Cannot empty Paper Hands Bin', 'The files cannot be deleted because they are in use by your lizard brain.\n\nClose your lizard brain and try again.')
  }

  return (
    <>
      <MenuBar />
      <div className="paperhands-toolbar">
        <button type="button" className="btn small" disabled={!current} onClick={() => current && restore(current)}>↩️ Restore selected</button>
        <button type="button" className="btn small" onClick={empty}>🗑️ Empty Paper Hands Bin</button>
      </div>
      <div className="window-content flush paperhands-list">
        <ListView columns={COLUMNS} rows={FILES} rowKey={(f) => f.name} selectedKey={selected} onSelect={pick} onActivate={restore} />
      </div>
      <StatusBar>
        <span>{FILES.length} objects{current ? ', 1 selected' : ''}</span>
        <span>{fmtSize(TOTAL_KB)}</span>
      </StatusBar>
    </>
  )
}
