import { clamp } from '../audio/pitch'

export type Tolerance = 25 | 50 | 75

export interface Settings {
  tolerance: Tolerance
  octaveAlign: boolean
  /** 参考旋律与伴奏/原曲一起移调，-6..+6 半音（保持速度）。 */
  transpose: number
  /** null 表示使用启动时按设备延迟自动估算的值。 */
  latencyMs: number | null
  volume: number
}

export const DEFAULT_SETTINGS: Settings = {
  tolerance: 50,
  octaveAlign: true,
  transpose: 0,
  latencyMs: null,
  volume: 0.75,
}

const STORAGE_KEY = 'voicepro.settings.v1'

function isTolerance(value: unknown): value is Tolerance {
  return value === 25 || value === 50 || value === 75
}

export function loadSettings(): Settings {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return { ...DEFAULT_SETTINGS }
    const raw: unknown = JSON.parse(text)
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
    const record = raw as Record<string, unknown>
    return {
      tolerance: isTolerance(record.tolerance) ? record.tolerance : DEFAULT_SETTINGS.tolerance,
      octaveAlign:
        typeof record.octaveAlign === 'boolean'
          ? record.octaveAlign
          : DEFAULT_SETTINGS.octaveAlign,
      transpose:
        typeof record.transpose === 'number' && Number.isFinite(record.transpose)
          ? clamp(Math.round(record.transpose), -6, 6)
          : DEFAULT_SETTINGS.transpose,
      latencyMs:
        typeof record.latencyMs === 'number' && Number.isFinite(record.latencyMs)
          ? clamp(Math.round(record.latencyMs), 0, 300)
          : null,
      volume:
        typeof record.volume === 'number' && Number.isFinite(record.volume)
          ? clamp(record.volume, 0, 1)
          : DEFAULT_SETTINGS.volume,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 隐私模式 / 存储配额不足时静默失败
  }
}
