import type { PracticeRecordMeta } from '../state/records'
import { formatTime } from '../audio/pitch'
import { ChevronRightIcon, HistoryIcon, SettingsIcon, TrashIcon } from '../ui/icons'

interface RecordsViewProps {
  records: PracticeRecordMeta[]
  loading: boolean
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onGoSongs: () => void
  onOpenSettings: () => void
}

function dateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `今天 ${time}`
  if (isYesterday) return `昨天 ${time}`
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ` ${time}`
}

function scoreTone(score: number | null): string {
  if (score == null) return 'none'
  if (score >= 80) return 'good'
  if (score >= 60) return 'warn'
  return 'low'
}

export function RecordsView({
  records,
  loading,
  onOpen,
  onDelete,
  onGoSongs,
  onOpenSettings,
}: RecordsViewProps) {
  const best = records.reduce<number | null>(
    (max, record) => (record.score == null ? max : Math.max(max ?? 0, record.score)),
    null,
  )
  const average = (() => {
    const scored = records.filter((record) => record.score != null)
    if (scored.length === 0) return null
    return Math.round(scored.reduce((sum, record) => sum + (record.score ?? 0), 0) / scored.length)
  })()

  return (
    <div className="screen records-screen">
      <header className="tab-header">
        <div>
          <p className="eyebrow">自动保存</p>
          <h1 className="tab-title">记录</h1>
        </div>
        <button type="button" className="icon-btn" aria-label="打开设置" onClick={onOpenSettings}>
          <SettingsIcon />
        </button>
      </header>

      <main className="page">
        <section className="records-summary">
          <div>
            <strong>{records.length}</strong>
            <span>次练习</span>
          </div>
          <div>
            <strong>{best ?? '—'}</strong>
            <span>最高分</span>
          </div>
          <div>
            <strong>{average ?? '—'}</strong>
            <span>平均分</span>
          </div>
        </section>

        {loading ? (
          <div className="record-skeletons" aria-label="正在加载记录">
            {[0, 1, 2].map((index) => (
              <div key={index} className="record-skeleton" />
            ))}
          </div>
        ) : records.length === 0 ? (
          <section className="card empty-card records-empty">
            <div className="empty-icon"><HistoryIcon /></div>
            <h1>还没有练习记录</h1>
            <p>每次唱完都会自动保存在这台设备上，可以随时点开回看音高曲线和录音。</p>
            <button type="button" className="btn primary" onClick={onGoSongs}>
              去练一首示例歌
            </button>
          </section>
        ) : (
          <>
          <ul className="record-list">
            {records.map((record) => (
              <li key={record.id} className="record-item">
                <button type="button" className="record-open" onClick={() => onOpen(record.id)}>
                  <span className={`record-score ${scoreTone(record.score)}`}>
                    {record.score ?? '—'}
                  </span>
                  <span className="record-copy">
                    <strong>{record.songName}</strong>
                    <span className="record-meta">
                      {dateLabel(record.createdAt)} · {formatTime(record.duration)}
                      {record.hitRate != null && ` · 命中 ${Math.round(record.hitRate * 100)}%`}
                    </span>
                    <span className="record-tags">
                      <i>{record.songKind === 'demo' ? '示例歌' : '导入歌'}</i>
                      <i>±{record.tolerance} 音分</i>
                    </span>
                  </span>
                  <span className="record-chevron"><ChevronRightIcon /></span>
                </button>
                <button
                  type="button"
                  className="icon-btn danger record-delete"
                  aria-label={`删除 ${record.songName} 的记录`}
                  onClick={() => {
                    if (window.confirm(`删除「${record.songName}」这次记录？录音也会一起删除。`)) {
                      onDelete(record.id)
                    }
                  }}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>

          <div className="records-table-block">
            <table className="records-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>歌曲</th>
                  <th>得分</th>
                  <th>时长</th>
                  <th>类型</th>
                  <th className="table-actions-head">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr
                    key={record.id}
                    tabIndex={0}
                    onClick={() => onOpen(record.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpen(record.id)
                      }
                    }}
                  >
                    <td className="table-date">{dateLabel(record.createdAt)}</td>
                    <td>
                      <span className="table-song">{record.songName}</span>
                      {record.hitRate != null && (
                        <small>命中 {Math.round(record.hitRate * 100)}%</small>
                      )}
                    </td>
                    <td>
                      <span className={`table-score ${scoreTone(record.score)}`}>
                        {record.score ?? '—'}
                      </span>
                    </td>
                    <td className="table-duration">{formatTime(record.duration)}</td>
                    <td>
                      <span className="record-kind">
                        {record.songKind === 'demo' ? '示例歌' : '导入歌'}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        <button
                          type="button"
                          className="text-btn"
                          onClick={(event) => {
                            event.stopPropagation()
                            onOpen(record.id)
                          }}
                        >
                          回看
                        </button>
                        <button
                          type="button"
                          className="icon-btn tiny danger"
                          aria-label={`删除 ${record.songName} 的记录`}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (window.confirm(`删除「${record.songName}」这次记录？录音也会一起删除。`)) {
                              onDelete(record.id)
                            }
                          }}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}

        <p className="tiny-note center records-note">
          记录只保存在本机。示例歌回看时会重新合成原唱；导入歌回看时从歌曲库读取原曲与伴奏，
          歌曲被删除后降级为只能回放你的录音。
        </p>
      </main>
    </div>
  )
}
