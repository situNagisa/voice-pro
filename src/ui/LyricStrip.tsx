import type { ReactNode } from 'react'
import { activeLyricAt, sungCharCount } from '../lyrics/find'
import type { LyricLine, SongLyrics } from '../lyrics/types'
import { LyricsIcon } from './icons'

interface LyricStripProps {
  lyrics: SongLyrics | null
  /** 当前歌曲时间（秒） */
  time: number
  label?: string
  /** 没有歌词时也显示导入入口；已有歌词时按钮文案为“编辑” */
  onImport?: () => void
  /** 点歌词行跳到该行开头（回看页） */
  onSeek?: (time: number) => void
}

function sourceLabel(lyrics: SongLyrics): string {
  if (lyrics.source === 'demo') return '内置歌词'
  if (lyrics.source === 'lrc') return 'LRC 时间轴'
  return '自动对时'
}

function renderLineContent(line: LyricLine, time: number, progress: number): ReactNode {
  if (line.words && line.words.length > 0) {
    return line.words.map((word, index) => {
      const state = time >= word.end ? 'sung' : time >= word.start ? 'active' : ''
      return (
        <span key={`${index}-${word.start}`} className={`lyric-word ${state}`.trim()}>
          {word.text}
        </span>
      )
    })
  }
  const chars = Array.from(line.text)
  const cut = sungCharCount(line.text, progress)
  return (
    <>
      <span className="lyric-sung">{chars.slice(0, cut).join('')}</span>
      <span className="lyric-unsung">{chars.slice(cut).join('')}</span>
    </>
  )
}

/**
 * 卷帘下方的当前句 / 下一句。放在 roll-card 内，手机上不悬浮遮挡曲线，
 * 桌面也留在卷帘下方；有逐字时间时按字点亮。
 */
export function LyricStrip({
  lyrics,
  time,
  label = '歌词',
  onImport,
  onSeek,
}: LyricStripProps) {
  if (!lyrics || lyrics.lines.length === 0) {
    if (!onImport) return null
    return (
      <div className="lyric-strip empty">
        <div className="lyric-strip-head">
          <span className="lyric-strip-label">
            <LyricsIcon />
            {label}
          </span>
          <button type="button" className="lyric-import-btn" onClick={onImport}>
            导入歌词
          </button>
        </div>
        <p className="lyric-empty-copy">
          导入 .lrc 或粘贴纯文本，跟唱时就能看到当前句和下一句。
        </p>
      </div>
    )
  }

  const active = activeLyricAt(lyrics.lines, time)
  const { current, next, progress } = active
  // 还没到第一句时，“当前”位置显示第一句，那么“下一句”应是第二句，避免重复。
  const displayNext =
    current == null
      ? next != null && active.nextIndex != null
        ? lyrics.lines[active.nextIndex + 1] ?? null
        : null
      : next
  const currentContent = current ? renderLineContent(current, time, progress) : null

  const currentLine = (
    <>
      <span className="lyric-current-tag">
        {current == null ? '准备' : active.active ? '正在唱' : '刚刚唱'}
      </span>
      <span className={`lyric-current-text ${current == null ? 'upcoming' : ''}`}>
        {current == null ? next?.text ?? '' : currentContent}
      </span>
      {current != null && (
        <i className="lyric-progress" style={{ width: `${Math.round(progress * 100)}%` }} />
      )}
    </>
  )

  const nextLine = displayNext ? (
    <>
      <span className="lyric-next-tag">下一句</span>
      <span className="lyric-next-text">{displayNext.text}</span>
    </>
  ) : current ? (
    <>
      <span className="lyric-next-tag">下一句</span>
      <span className="lyric-next-text dim">已经是最后一句</span>
    </>
  ) : null

  return (
    <div className="lyric-strip">
      <div className="lyric-strip-head">
        <span className="lyric-strip-label">
          <LyricsIcon />
          {label}
          <em>{sourceLabel(lyrics)}</em>
        </span>
        <div className="lyric-strip-tools">
          <span className="lyric-strip-count">
            {active.currentIndex != null
              ? `${active.currentIndex + 1} / ${lyrics.lines.length}`
              : `0 / ${lyrics.lines.length}`}
          </span>
          {onImport && (
            <button type="button" className="lyric-import-btn" onClick={onImport}>
              编辑
            </button>
          )}
        </div>
      </div>
      {onSeek ? (
        <button
          type="button"
          className="lyric-current lyric-line-button"
          onClick={() => onSeek(current ? current.start : next?.start ?? 0)}
          title="跳到这一句开头"
        >
          {currentLine}
        </button>
      ) : (
        <div className="lyric-current">{currentLine}</div>
      )}
      {nextLine &&
        (onSeek && displayNext ? (
          <button
            type="button"
            className="lyric-next lyric-line-button"
            onClick={() => onSeek(displayNext.start)}
            title="跳到下一句"
          >
            {nextLine}
          </button>
        ) : (
          <div className="lyric-next">{nextLine}</div>
        ))}
    </div>
  )
}
