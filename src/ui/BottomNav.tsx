import { HistoryIcon, SongIcon, TunerIcon } from './icons'
import type { ReactNode } from 'react'

export type TabKey = 'songs' | 'tuner' | 'records'

interface TabItem {
  key: TabKey
  label: string
  icon: ReactNode
}

const TABS: TabItem[] = [
  { key: 'songs', label: '练歌', icon: <SongIcon /> },
  { key: 'tuner', label: '音准仪', icon: <TunerIcon /> },
  { key: 'records', label: '记录', icon: <HistoryIcon /> },
]

export function BottomNav({
  active,
  onChange,
}: {
  active: TabKey
  onChange: (tab: TabKey) => void
}) {
  return (
    <nav className="tabbar" aria-label="主导航">
      <div className="tabbar-inner">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tabbar-item ${active === tab.key ? 'active' : ''}`}
            aria-current={active === tab.key ? 'page' : undefined}
            onClick={() => onChange(tab.key)}
          >
            <span className="tabbar-icon">{tab.icon}</span>
            <span className="tabbar-label">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
