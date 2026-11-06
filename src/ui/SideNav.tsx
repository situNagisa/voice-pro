import type { ReactNode } from 'react'
import type { TabKey } from './BottomNav'
import { HistoryIcon, SettingsIcon, SongIcon, TunerIcon } from './icons'

interface SideNavProps {
  active: TabKey
  onNavigate: (tab: TabKey) => void
  onOpenSettings: () => void
}

interface NavItem {
  key: TabKey
  label: string
  hint: string
  icon: ReactNode
}

const ITEMS: NavItem[] = [
  { key: 'songs', label: '练歌', hint: '选歌与导入', icon: <SongIcon /> },
  { key: 'tuner', label: '音准仪', hint: '实时监听', icon: <TunerIcon /> },
  { key: 'records', label: '记录', hint: '历史与回看', icon: <HistoryIcon /> },
]

export function SideNav({ active, onNavigate, onOpenSettings }: SideNavProps) {
  return (
    <aside className="side-nav" aria-label="主导航">
      <div className="side-brand">
        <img src="/icon.svg" alt="" width={36} height={36} />
        <div>
          <strong>音准镜</strong>
          <span>看见每一个音</span>
        </div>
      </div>

      <nav className="side-nav-list">
        {ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`side-nav-item ${active === item.key ? 'active' : ''}`}
            aria-current={active === item.key ? 'page' : undefined}
            onClick={(event) => {
              // 让空格快捷键回到页面本身，而不是再次触发导航按钮
              event.currentTarget.blur()
              onNavigate(item.key)
            }}
          >
            <span className="side-nav-icon">{item.icon}</span>
            <span className="side-nav-copy">
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="side-foot">
        <button
          type="button"
          className="side-nav-item settings"
          aria-label="打开设置"
          onClick={onOpenSettings}
        >
          <span className="side-nav-icon"><SettingsIcon /></span>
          <span className="side-nav-copy">
            <strong>设置</strong>
            <small>判定、声音与本机数据</small>
          </span>
        </button>
        <p className="side-privacy">音频与录音仅在本机处理</p>
        <span className="side-version">音准镜 v0.3</span>
      </div>
    </aside>
  )
}
