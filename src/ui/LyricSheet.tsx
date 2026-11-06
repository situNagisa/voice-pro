import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { buildPhrases } from '../audio/analysis'
import { formatTime } from '../audio/pitch'
import { SongPlayer } from '../audio/player'
import type { LoadedSong } from '../state/session'
import {
  buildLyrics,
  decodeLyricFile,
  loadSongLyrics,
  normalizeLyricLines,
  saveSongLyrics,
} from '../lyrics'
import type { LyricLine, SongLyrics } from '../lyrics'
import { Notice } from './controls'
import {
  CloseIcon,
  PauseIcon,
  PlayIcon,
  UploadIcon,
} from './icons'

interface LyricSheetProps {
  song: LoadedSong
  /** undefined 表示让弹窗自己从歌曲库读；null 表示已确认没有歌词 */
  initialLyrics?: SongLyrics | null
  onClose: () => void
  onSaved: (lyrics: SongLyrics) => void
}

type SaveSource = 'lrc' | 'text'

interface SheetMessage {
  tone: 'warn' | 'error' | 'success'
  text: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatStamp(seconds: number): string {
  const value = Math.max(0, seconds)
  const minutes = Math.floor(value / 60)
  const rest = value - minutes * 60
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`
}

function cloneLines(lines: LyricLine[]): LyricLine[] {
  return lines.map((line) => ({
    ...line,
    words: line.words?.map((word) => ({ ...word })),
  }))
}

function shiftWords(line: LyricLine, delta: number): LyricLine['words'] {
  if (!line.words) return undefined
  return line.words.map((word) => ({
    ...word,
    start: Math.max(0, word.start + delta),
    end: Math.max(0.02, word.end + delta),
  }))
}

/**
 * 歌词导入与对时弹窗。
 * 纯文本先自动对齐到乐句，再允许试听歌曲、点“下一行打拍”或拖起点微调。
 */
export function LyricSheet({
  song,
  initialLyrics,
  onClose,
  onSaved,
}: LyricSheetProps) {
  const duration = Math.max(0.5, song.buffer.duration)
  const [lines, setLines] = useState<LyricLine[]>(() =>
    initialLyrics ? cloneLines(initialLyrics.lines) : [],
  )
  const [source, setSource] = useState<SaveSource>(
    initialLyrics?.source === 'lrc' ? 'lrc' : 'text',
  )
  const [title, setTitle] = useState(initialLyrics?.title ?? '')
  const [artist, setArtist] = useState(initialLyrics?.artist ?? '')
  const [offsetMs, setOffsetMs] = useState(initialLyrics?.offsetMs)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<number | null>(
    initialLyrics && initialLyrics.lines.length > 0 ? 0 : null,
  )
  const [fileName, setFileName] = useState('')
  const [message, setMessage] = useState<SheetMessage | null>(null)
  const [saving, setSaving] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [loading, setLoading] = useState(initialLyrics === undefined)

  const playerRef = useRef<SongPlayer | null>(null)
  const mountedRef = useRef(true)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  useEffect(() => {
    if (initialLyrics !== undefined) return
    let active = true
    void loadSongLyrics(song.id).then((value) => {
      if (!active) return
      if (value) {
        setLines(cloneLines(value.lines))
        setSource(value.source === 'lrc' ? 'lrc' : 'text')
        setTitle(value.title ?? '')
        setArtist(value.artist ?? '')
        setOffsetMs(value.offsetMs)
        setSelected(value.lines.length > 0 ? 0 : null)
      }
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [song.id, initialLyrics])

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (!player) return
      setPosition(player.position)
      if (!player.isPlaying) setPlaying(false)
    }, 80)
    return () => window.clearInterval(timer)
  }, [playing])

  useEffect(() => {
    if (selected == null) return
    const node = listRef.current?.querySelector<HTMLElement>('.is-selected')
    node?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  async function ensurePlayer(): Promise<SongPlayer> {
    const existing = playerRef.current
    if (existing) {
      await existing.resume()
      return existing
    }
    const player = new SongPlayer(song.buffer, {
      accompaniment: song.accompaniment ?? null,
      vocals: song.vocals ?? null,
    })
    player.setMode(song.accompaniment ? 'accompaniment' : 'original')
    player.setVolume(0.82)
    if (position > 0) player.seek(position)
    playerRef.current = player
    await player.resume()
    return player
  }

  async function togglePreview(): Promise<void> {
    const player = playerRef.current
    if (player?.isPlaying) {
      const at = player.position
      player.pause()
      setPosition(at)
      setPlaying(false)
      return
    }
    try {
      const active = player ?? (await ensurePlayer())
      const from = active.position >= duration - 0.05 ? 0 : active.position
      active.play(from)
      setPosition(from)
      setPlaying(true)
    } catch (error) {
      console.warn('[voice-pro] 歌词试听失败', error)
      setMessage({ tone: 'error', text: '无法播放这首歌的试听音频。' })
    }
  }

  async function playFrom(time: number): Promise<void> {
    try {
      const player = await ensurePlayer()
      const from = clamp(time, 0, duration - 0.05)
      player.play(from)
      setPosition(from)
      setPlaying(true)
    } catch (error) {
      console.warn('[voice-pro] 歌词试听失败', error)
      setMessage({ tone: 'error', text: '无法播放这首歌的试听音频。' })
    }
  }

  function seekTo(time: number): void {
    const next = clamp(time, 0, duration - 0.02)
    setPosition(next)
    playerRef.current?.seek(next)
  }

  function applyParsed(raw: string, label: string): void {
    if (!raw.trim()) {
      setMessage({ tone: 'error', text: '歌词内容为空，请先选择文件或粘贴文本。' })
      return
    }
    const result = buildLyrics(raw, song.id, song.melody, duration)
    if (result.lyrics.lines.length === 0) {
      setMessage({ tone: 'error', text: '没有解析出歌词行，请检查格式。' })
      return
    }
    setLines(cloneLines(result.lyrics.lines))
    setSource(result.lyrics.source === 'lrc' ? 'lrc' : 'text')
    setTitle(result.lyrics.title ?? '')
    setArtist(result.lyrics.artist ?? '')
    setOffsetMs(result.lyrics.offsetMs)
    setSelected(0)
    setPosition(0)
    playerRef.current?.stop()
    setPlaying(false)
    const phraseCount = buildPhrases(song.melody.notes).length
    if (result.autoAligned) {
      setMessage({
        tone: 'warn',
        text: `已把 ${result.lyrics.lines.length} 行纯文本按字数对齐到 ${phraseCount} 个乐句。点开试听，用“下一行打拍”或拖动起点微调。`,
      })
    } else {
      setMessage({
        tone: 'success',
        text: `${label || 'LRC'}：读到 ${result.lyrics.lines.length} 行时间标签${
          result.parsed.enhanced ? '，含逐字时间' : ''
        }${result.lyrics.offsetMs ? `，offset ${result.lyrics.offsetMs} ms` : ''}。`,
      })
    }
  }

  async function onPickFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setMessage({ tone: 'error', text: '歌词文件超过 2 MB，请检查是否选错文件。' })
      return
    }
    try {
      const text = await decodeLyricFile(file)
      setDraft(text)
      setFileName(file.name)
      applyParsed(text, file.name)
    } catch (error) {
      console.warn('[voice-pro] 读取歌词文件失败', error)
      setMessage({ tone: 'error', text: '读取失败，请换一个 .lrc 或 .txt 文件。' })
    }
  }

  function setLineStart(index: number, rawStart: number): void {
    setLines((previous) => {
      const next = cloneLines(previous)
      const line = next[index]
      if (!line) return previous
      const minStart = index > 0 ? next[index - 1].start + 0.12 : 0
      const maxStart = Math.max(minStart, duration - 0.25)
      const start = clamp(rawStart, minStart, maxStart)
      const delta = start - line.start
      line.start = start
      if (line.words) line.words = shiftWords(line, delta)
      if (index === next.length - 1) {
        line.end = clamp(line.end + delta, start + 0.2, duration)
      }
      if (index > 0) next[index - 1].end = Math.max(next[index - 1].start + 0.08, start)
      if (index + 1 < next.length) {
        let cursor = start + 0.15
        for (let i = index + 1; i < next.length; i++) {
          if (next[i].start < cursor) {
            const shift = cursor - next[i].start
            next[i].start = cursor
            if (next[i].words) next[i].words = shiftWords(next[i], shift)
          }
          next[i - 1].end = Math.max(next[i - 1].start + 0.08, next[i].start)
          cursor = next[i].start + 0.15
        }
      }
      const last = next[next.length - 1]
      if (last.end <= last.start) {
        last.end = Math.min(duration, last.start + Math.max(0.8, last.end - last.start || 1.2))
      }
      return next
    })
  }

  function tapNextLine(): void {
    if (lines.length === 0) return
    const index = clamp(selected ?? 0, 0, lines.length - 1)
    const at = playerRef.current?.isPlaying ? playerRef.current.position : position
    setLineStart(index, at)
    if (index < lines.length - 1) {
      setSelected(index + 1)
      setMessage({ tone: 'success', text: `第 ${index + 1} 行起点设为 ${formatStamp(at)}，接着唱下一行时再点一次。` })
    } else {
      setMessage({ tone: 'success', text: `最后一行起点设为 ${formatStamp(at)}。` })
    }
  }

  async function save(): Promise<void> {
    if (lines.length === 0 || saving) return
    const phrases = buildPhrases(song.melody.notes)
    const normalized = normalizeLyricLines(lines, duration, phrases)
    if (normalized.length === 0) {
      setMessage({ tone: 'error', text: '没有可保存的歌词行。' })
      return
    }
    setSaving(true)
    setMessage(null)
    const record: SongLyrics = {
      songId: song.id,
      lines: normalized,
      source,
      offsetMs,
      title: title.trim() || undefined,
      artist: artist.trim() || undefined,
      updatedAt: Date.now(),
    }
    try {
      await saveSongLyrics(record)
      setMessage({ tone: 'success', text: '歌词已保存到本机歌曲库。' })
      onSaved(record)
    } catch (error) {
      console.warn('[voice-pro] 保存歌词失败', error)
      setMessage({ tone: 'error', text: '保存失败，请检查浏览器存储空间后重试。' })
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const selectedLine = selected != null ? lines[selected] : null
  const step = 0.05

  return (
    <div className="lyrics-layer">
      <button type="button" className="sheet-backdrop" aria-label="关闭歌词编辑" onClick={onClose} />
      <div className="lyrics-sheet" role="dialog" aria-modal="true" aria-label="歌词导入与对时">
        <header className="sheet-head lyrics-head">
          <div>
            <p className="eyebrow">歌词与对时</p>
            <h2>{song.name}</h2>
            <p className="tiny-note">
              {loading
                ? '正在读取已保存的歌词…'
                : 'LRC 会直接使用时间标签；纯文本会按字数自动对齐到参考旋律的乐句。'}
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="lyrics-body">
          <section className="lyrics-import">
            <div className="lyrics-import-top">
              <button
                type="button"
                className="btn secondary small"
                onClick={() => fileRef.current?.click()}
              >
                <UploadIcon />
                选择 .lrc / .txt
              </button>
              <span className="tiny-note">
                {fileName || '支持 [mm:ss.xx]、多时间标签、[offset:]、逐字 <mm:ss.xx>'}
              </span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".lrc,.txt,text/plain"
              hidden
              onChange={(event) => void onPickFile(event)}
            />
            <textarea
              className="lyrics-textarea"
              value={draft}
              rows={4}
              spellCheck={false}
              placeholder={'粘贴 LRC 或纯文本歌词，例如：\n[00:12.00]一闪一闪亮晶晶\n[00:18.00]满天都是小星星'}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="lyrics-import-actions">
              <button
                type="button"
                className="btn primary small"
                disabled={draft.trim().length === 0}
                onClick={() => applyParsed(draft, '粘贴文本')}
              >
                解析并对时
              </button>
              <span className="tiny-note">
                {lines.length > 0
                  ? `当前 ${lines.length} 行 · ${source === 'lrc' ? 'LRC 时间轴' : '纯文本自动对时'}`
                  : '还没有歌词'}
              </span>
            </div>
            {message && <Notice tone={message.tone}>{message.text}</Notice>}
            {title || artist ? (
              <p className="tiny-note">
                {title}
                {artist ? ` · ${artist}` : ''}
                {offsetMs ? ` · offset ${offsetMs} ms` : ''}
              </p>
            ) : null}
          </section>

          {lines.length > 0 && (
            <>
              <section className="lyrics-preview">
                <div className="lyrics-preview-row">
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={() => void togglePreview()}
                  >
                    {playing ? <PauseIcon /> : <PlayIcon />}
                    {playing ? '暂停试听' : '试听歌曲'}
                  </button>
                  <input
                    type="range"
                    className="lyrics-scrubber"
                    aria-label="试听位置"
                    min={0}
                    max={duration}
                    step={0.05}
                    value={position}
                    onChange={(event) => seekTo(Number(event.target.value))}
                  />
                  <span className="lyrics-clock">
                    {formatTime(position)} / {formatTime(duration)}
                  </span>
                </div>
                <div className="lyrics-preview-row">
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={lines.length === 0}
                    onClick={tapNextLine}
                  >
                    下一行打拍
                  </button>
                  <span className="tiny-note">
                    播放歌曲，唱到下一行时点一次；也可以拖动下面选中行的起点。
                  </span>
                </div>
              </section>

              <section className="lyrics-editor">
                <div className="lyrics-editor-head">
                  <span className="eyebrow">对时列表</span>
                  <span className="tiny-note">
                    {selected != null
                      ? `第 ${selected + 1} / ${lines.length} 行`
                      : '点一行开始微调'}
                  </span>
                </div>
                <ol className="lyrics-edit-list" ref={listRef}>
                  {lines.map((line, index) => {
                    const isSelected = selected === index
                    const isCurrent =
                      playing && position >= line.start - 0.04 && position <= line.end + 0.04
                    return (
                      <li
                        key={`${index}-${line.start}`}
                        className={`lyrics-edit-line ${isSelected ? 'is-selected' : ''} ${isCurrent ? 'is-current' : ''}`}
                      >
                        <button
                          type="button"
                          className="lyrics-line-pick"
                          onClick={() => setSelected(index)}
                        >
                          <span className="lyrics-line-time">{formatStamp(line.start)}</span>
                          <span className="lyrics-line-text">{line.text}</span>
                          {line.words && line.words.length > 0 && (
                            <em className="lyrics-line-badge">逐字</em>
                          )}
                        </button>
                        {isSelected && (
                          <div className="lyrics-line-controls">
                            <input
                              type="range"
                              aria-label={`第 ${index + 1} 行起点`}
                              min={0}
                              max={duration}
                              step={step}
                              value={line.start}
                              onChange={(event) => setLineStart(index, Number(event.target.value))}
                            />
                            <div className="lyrics-line-actions">
                              <button
                                type="button"
                                className="text-btn"
                                onClick={() => void playFrom(Math.max(0, line.start - 1.2))}
                              >
                                从这句试听
                              </button>
                              <button
                                type="button"
                                className="text-btn"
                                onClick={() => setLineStart(index, position)}
                              >
                                设为当前
                              </button>
                              <span className="tiny-note">
                                {formatStamp(line.start)} – {formatStamp(line.end)}
                              </span>
                            </div>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ol>
              </section>
            </>
          )}
        </div>

        <footer className="lyrics-foot">
          <span className="tiny-note">
            {selectedLine
              ? `正在调整：${selectedLine.text.slice(0, 24)}${selectedLine.text.length > 24 ? '…' : ''}`
              : '导入后仍可随时回来微调。'}
          </span>
          <div className="lyrics-foot-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={lines.length === 0 || saving}
              onClick={() => void save()}
            >
              {saving ? '正在保存…' : '保存歌词'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
