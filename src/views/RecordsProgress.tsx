import { useEffect, useMemo, useState } from 'react'
import type { PracticeRecordMeta } from '../state/records'
import type {
  DiagnosisSummary,
  ProgressPeriod,
  SongGroup,
} from '../state/progress'
import {
  groupRecordsBySong,
  loadDiagnosisSummary,
  summarizePeriod,
  voiceRangeOf,
} from '../state/progress'
import { ChevronRightIcon, HistoryIcon } from '../ui/icons'
import { PianoRange } from '../ui/PianoRange'
import { TrendChart } from '../ui/TrendChart'

interface ProgressOverviewProps {
  records: PracticeRecordMeta[]
  loading: boolean
  onGoSongs: () => void
}

function formatPracticeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 秒'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

function scoreTone(score: number | null): string {
  if (score == null) return 'none'
  if (score >= 80) return 'good'
  if (score >= 60) return 'warn'
  return 'low'
}

export function ProgressOverview({ records, loading, onGoSongs }: ProgressOverviewProps) {
  const [period, setPeriod] = useState<ProgressPeriod>(7)
  const [diagnosis, setDiagnosis] = useState<DiagnosisSummary | null>(null)
  const [diagnosisLoading, setDiagnosisLoading] = useState(true)
  const [diagnosisError, setDiagnosisError] = useState(false)

  const summary = useMemo(() => summarizePeriod(records, period), [records, period])
  const voiceRange = useMemo(() => voiceRangeOf(records), [records])

  useEffect(() => {
    if (loading || records.length === 0) {
      setDiagnosis(null)
      setDiagnosisLoading(false)
      return
    }
    let active = true
    setDiagnosisLoading(true)
    setDiagnosisError(false)
    void loadDiagnosisSummary(records, period)
      .then((next) => {
        if (active) setDiagnosis(next)
      })
      .catch((error: unknown) => {
        console.warn('[voice-pro] 读取问题汇总失败', error)
        if (active) {
          setDiagnosis(null)
          setDiagnosisError(true)
        }
      })
      .finally(() => {
        if (active) setDiagnosisLoading(false)
      })
    return () => {
      active = false
    }
  }, [records, period, loading])

  if (loading) {
    return (
      <section className="card progress-overview progress-overview-loading" aria-label="正在加载我的进步">
        <div className="record-skeleton" />
        <div className="record-skeleton" />
        <div className="record-skeleton" />
      </section>
    )
  }

  if (records.length === 0) {
    return (
      <section className="card progress-overview progress-empty">
        <div className="empty-icon"><HistoryIcon /></div>
        <p className="eyebrow">我的进步</p>
        <h2>你的进步会从这里开始</h2>
        <p>
          还没有练习记录。唱完第一首，这里会出现练习次数、命中率趋势、你真正唱到的音域，
          以及最容易重复出现的问题。
        </p>
        <button type="button" className="btn primary" onClick={onGoSongs}>
          去练一首示例歌
        </button>
      </section>
    )
  }

  const trendDelta = summary.trendDelta
  const trendText =
    trendDelta == null
      ? null
      : trendDelta >= 3
        ? `最近比最早高 ${trendDelta} 个百分点`
        : trendDelta <= -3
          ? `最近比最早低 ${Math.abs(trendDelta)} 个百分点`
          : '最近与最早基本持平'

  return (
    <section className="card progress-overview">
      <div className="progress-overview-head">
        <div>
          <p className="eyebrow">我的进步</p>
          <h2>看得见的进步</h2>
        </div>
        <div className="segmented compact period-switch" role="group" aria-label="统计时间范围">
          {([7, 30] as ProgressPeriod[]).map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={period === days}
              className={period === days ? 'active' : ''}
              onClick={() => setPeriod(days)}
            >
              近 {days} 天
            </button>
          ))}
        </div>
      </div>

      <div className="progress-stats">
        <div>
          <strong>{summary.count}</strong>
          <span>次练习</span>
        </div>
        <div>
          <strong>{formatPracticeDuration(summary.seconds)}</strong>
          <span>累计时长</span>
        </div>
        <div>
          <strong>{summary.activeDays}</strong>
          <span>练习天数</span>
        </div>
        <div>
          <strong>{summary.avgScore ?? '—'}</strong>
          <span>平均分</span>
        </div>
      </div>

      <div className="progress-grid">
        <div className="progress-block trend-block">
          <div className="progress-block-head">
            <div>
              <strong>平均命中率趋势</strong>
              <small>按天平均 · 近 {period} 天</small>
            </div>
            {trendText && (
              <span className={`trend-delta ${trendDelta != null && trendDelta >= 3 ? 'good' : trendDelta != null && trendDelta <= -3 ? 'warn' : ''}`}>
                {trendText}
              </span>
            )}
          </div>
          {summary.hitTrend.length >= 2 ? (
            <TrendChart
              points={summary.hitTrend.map((point) => ({
                x: point.index,
                value: point.value,
                label: `${point.label} · 平均命中 ${point.value}%`,
              }))}
              xMax={period - 1}
              xLabels={[
                summary.daily[0] ? `${new Date(summary.daily[0].dayStart).getMonth() + 1}/${new Date(summary.daily[0].dayStart).getDate()}` : '—',
                summary.daily[summary.daily.length - 1]
                  ? `${new Date(summary.daily[summary.daily.length - 1].dayStart).getMonth() + 1}/${new Date(summary.daily[summary.daily.length - 1].dayStart).getDate()}`
                  : '今天',
              ]}
              ariaLabel={`近 ${period} 天平均命中率折线`}
            />
          ) : summary.hitTrend.length === 1 ? (
            <div className="mini-empty">
              <strong>{summary.hitTrend[0].value}%</strong>
              <span>目前只有一天有命中率数据。再练一天，就能把趋势连成线。</span>
            </div>
          ) : (
            <div className="mini-empty">
              <span>这 {period} 天还没有可用的命中率数据。完整跟唱一遍，命中率就会开始记录。</span>
            </div>
          )}
          <p className="progress-foot">
            每次练习的命中率是落在容忍度内的音高帧占比；练声小课也计入次数、时长与命中率趋势。
          </p>
        </div>

        <div className="progress-block range-block">
          <div className="progress-block-head">
            <div>
              <strong>我的音域</strong>
              <small>全部练习累计 · 实际最低到最高音</small>
            </div>
            {voiceRange && <span className="count-badge">{voiceRange.records} 次练习</span>}
          </div>
          {voiceRange ? (
            <>
              <PianoRange
                lowMidi={voiceRange.lowMidi}
                highMidi={voiceRange.highMidi}
                medianMidi={voiceRange.medianMidi}
              />
              <p className="progress-foot">
                根据 {voiceRange.records} 次有音高数据的练习、累计 {Math.round(voiceRange.seconds)} 秒练习统计，
                已按每次练习的移调还原到原调。偶尔一个滑音或气声也可能把两端拉宽，多唱几次会更稳。
                {voiceRange.approximate && ' 部分旧记录没有保存最低/最高音，这里用 10%–90% 分位近似。'}
              </p>
            </>
          ) : (
            <div className="mini-empty">
              <span>还没有足够的音高数据。唱完一首歌，这里会画出你真正唱到的音域。</span>
            </div>
          )}
        </div>

        <div className="progress-block issues-block">
          <div className="progress-block-head">
            <div>
              <strong>最常见的问题</strong>
              <small>汇总最近歌曲练习的报告诊断</small>
            </div>
            {diagnosis && !diagnosisLoading && diagnosis.usable > 0 && (
              <span className="count-badge">{diagnosis.usable} 次有效练习</span>
            )}
          </div>
          {diagnosisLoading ? (
            <div className="issue-skeletons" aria-label="正在归纳问题">
              <span />
              <span />
            </div>
          ) : diagnosisError ? (
            <div className="mini-empty">
              <span>问题汇总读取失败。刷新页面或再练一次后再看。</span>
            </div>
          ) : !diagnosis || diagnosis.usable < 2 ? (
            <div className="mini-empty">
              <strong>再积累一点数据</strong>
              <span>
                {diagnosis
                  ? `目前有 ${diagnosis.usable} 次包含足够音高数据的歌曲练习。至少 2 次，才会归纳重复出现的问题。`
                  : `这 ${period} 天还没有完整歌曲练习。练声小课不会参与问题汇总。`}
              </span>
            </div>
          ) : diagnosis.items.length === 0 ? (
            <div className="mini-empty good">
              <strong>最近没有重复出现的问题</strong>
              <span>系统只在有效音高足够时才下结论。保持现在的唱法，可以挑更严格的判定继续练。</span>
            </div>
          ) : (
            <ul className="mini-issues">
              {diagnosis.items.map((item) => (
                <li key={item.id} className={`tone-${item.tone}`}>
                  <div className="mini-issue-head">
                    <span className={`diagnosis-dot ${item.tone}`} aria-hidden="true" />
                    <strong>{item.label}</strong>
                    <span className="mini-issue-count">
                      {item.count}/{diagnosis.usable} 次提到
                    </span>
                  </div>
                  <p>{item.advice}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="progress-foot">按最近 12 次歌曲练习归纳；有效音高不足的报告不参与。</p>
        </div>
      </div>
    </section>
  )
}

interface SongSparklineProps {
  values: number[]
}

function SongSparkline({ values }: SongSparklineProps) {
  if (values.length === 0) {
    return <span className="song-sparkline empty">暂无有效得分</span>
  }
  const width = 160
  const height = 42
  const pad = 4
  const xFor = (index: number) =>
    values.length === 1 ? width / 2 : pad + (index / (values.length - 1)) * (width - pad * 2)
  const yFor = (value: number) => pad + (1 - Math.max(0, Math.min(100, value)) / 100) * (height - pad * 2)
  const path = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`)
    .join(' ')
  return (
    <svg
      className="song-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`历次得分：${values.join('、')}`}
    >
      <path d={path} />
      {values.map((value, index) => (
        <circle key={index} cx={xFor(index)} cy={yFor(value)} r={2.6} />
      ))}
    </svg>
  )
}

interface SongProgressListProps {
  records: PracticeRecordMeta[]
  onOpenSong: (songId: string, songName: string) => void
}

export function SongProgressList({ records, onOpenSong }: SongProgressListProps) {
  const groups = useMemo(() => groupRecordsBySong(records), [records])
  if (groups.length === 0) return null

  return (
    <section className="section-block song-groups">
      <div className="section-head">
        <div>
          <h2>按歌曲看进步</h2>
          <p>同一首歌的多次练习可以叠在一起对比，逐句看哪里进步、哪里退步</p>
        </div>
        <span className="count-badge">{groups.length} 首</span>
      </div>
      <div className="song-group-grid">
        {groups.map((group: SongGroup) => {
          const values = group.attempts
            .map((attempt) => attempt.score)
            .filter((score): score is number => score != null)
          const latestScore = group.latest.score
          const firstScore = values[0] ?? null
          const delta = latestScore != null && firstScore != null ? latestScore - firstScore : null
          return (
            <button
              key={group.songId}
              type="button"
              className="song-group-card"
              onClick={() => onOpenSong(group.songId, group.songName)}
            >
              <div className="song-group-head">
                <strong>{group.songName}</strong>
                <span className={`score-pill ${scoreTone(latestScore)}`}>
                  {latestScore ?? '—'}
                </span>
              </div>
              <div className="song-group-meta">
                <span>{group.songKind === 'demo' ? '示例歌' : '导入歌'} · {group.attempts.length} 次练习</span>
                <span>
                  最近 {latestScore ?? '—'} · 最高 {group.bestScore ?? '—'}
                  {delta != null && delta !== 0 && (
                    <em className={delta > 0 ? 'good' : 'warn'}>
                      {delta > 0 ? ` 较首次 +${delta}` : ` 较首次 −${Math.abs(delta)}`}
                    </em>
                  )}
                </span>
              </div>
              <SongSparkline values={values} />
              <span className="song-group-action">
                查看历次得分与对比
                <ChevronRightIcon />
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
