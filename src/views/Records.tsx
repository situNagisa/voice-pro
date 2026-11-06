import type { PracticeRecordMeta } from '../state/records'
import { formatTime } from '../audio/pitch'
import { practiceSeconds } from '../state/progress'
import { ChevronRightIcon, SettingsIcon, TrashIcon } from '../ui/icons'
import { ProgressOverview, SongProgressList } from './RecordsProgress'

interface RecordsViewProps {
  records: PracticeRecordMeta[]
  loading: boolean
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onOpenSong: (songId: string, songName: string) => void
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

function kindLabel(record: PracticeRecordMeta): string {
  if (record.songKind === 'exercise') return '练声'
  return record.songKind === 'demo' ? '示例歌' : '导入歌'
}

export function RecordsView({
  records,
  loading,
  onOpen,
  onDelete,
  onOpenSong,
  onGoSongs,
  onOpenSettings,
}: RecordsViewProps) {
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
        <ProgressOverview records={records} loading={loading} onGoSongs={onGoSongs} />

        {!loading && records.length > 0 && (
          <>
            <SongProgressList records={records} onOpenSong={onOpenSong} />

            <section className="section-block records-history">
              <div className="section-head">
                <div>
                  <h2>全部练习</h2>
                  <p>点开任意一次回看音高曲线、录音与逐句表现</p>
                </div>
                <span className="count-badge">{records.length} 次</span>
              </div>

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
                          {dateLabel(record.createdAt)} · {formatTime(practiceSeconds(record))}
                          {record.hitRate != null && ` · 命中 ${Math.round(record.hitRate * 100)}%`}
                        </span>
                        <span className="record-tags">
                          <i>{kindLabel(record)}</i>
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
                        <td className="table-duration">{formatTime(practiceSeconds(record))}</td>
                        <td>
                          <span className="record-kind">
                            {kindLabel(record)}
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
            </section>
          </>
        )}

        <p className="tiny-note center records-note">
          记录只保存在本机。示例歌回看时会重新合成原唱；导入歌回看时从歌曲库读取原曲与伴奏，
          歌曲被删除后降级为只能回放你的录音；练声记录只有参考音目标与你的音高曲线。
        </p>
      </main>
    </div>
  )
}
