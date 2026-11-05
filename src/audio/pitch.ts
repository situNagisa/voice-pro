/** 音高、音名与设备能力相关的小工具。 */

export const A4_FREQ = 440
export const A4_MIDI = 69

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function freqToMidi(freq: number): number {
  return A4_MIDI + 12 * Math.log2(freq / A4_FREQ)
}

export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12)
}

export interface NoteName {
  name: string
  octave: number
  label: string
}

export function midiToNoteName(midi: number): NoteName {
  const rounded = Math.round(midi)
  const pitchClass = ((rounded % 12) + 12) % 12
  const octave = Math.floor(rounded / 12) - 1
  const name = NOTE_NAMES[pitchClass]
  return { name, octave, label: `${name}${octave}` }
}

/** 相对十二平均律最近半音的音分偏差，范围 -50..50。 */
export function centsFromNearestNote(midi: number): number {
  return (midi - Math.round(midi)) * 100
}

export function formatCents(cents: number | null, digits = 0): string {
  if (cents == null) return '—'
  const rounded = Math.abs(cents) < 0.5 ? 0 : cents
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded.toFixed(digits)}`
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (s === 60) return `${m + 1} 分`
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

export function isMobilePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/Android|iPhone|iPod|Mobile|Windows Phone/i.test(ua)) return true
  if (/iPad/i.test(ua)) return true
  // iPadOS 13+ 默认使用桌面版 UA
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true
  return false
}

/** 桌面浏览器才允许用 getDisplayMedia 捕获标签页 / 系统声音。 */
export function canCaptureDisplayAudio(): boolean {
  if (typeof navigator === 'undefined') return false
  if (isMobilePlatform()) return false
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

export function isSecureAudioContext(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext || location.hostname === 'localhost'
}

export function describeMediaError(error: unknown, source: 'mic' | 'display'): string {
  const err = error instanceof Error ? error : null
  const name = err && 'name' in err ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return source === 'display'
        ? '共享被取消，或浏览器没有授予音频捕获权限。请重新选择并勾选“分享标签页音频/系统声音”。'
        : '麦克风权限被拒绝。请在浏览器地址栏的权限设置里允许麦克风，然后重试。'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到可用的麦克风。请检查设备连接。'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被其他应用占用，或系统拒绝了访问。关闭占用麦克风的应用后再试。'
    case 'OverconstrainedError':
      return '当前麦克风不支持所需的音频设置，请换一个输入设备。'
    case 'SecurityError':
      return '当前页面不是安全上下文。请用 https 或 localhost 打开（手机通过局域网访问时需要 https）。'
    case 'AbortError':
      return '音频输入已取消。'
    default:
      break
  }
  if (err?.message) return err.message
  return source === 'display'
    ? '无法捕获共享声音，请确认选择窗口时勾选了音频。'
    : '无法启动麦克风，请检查系统权限与设备。'
}
