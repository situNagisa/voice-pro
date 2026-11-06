import { MAX_LATENCY_MS } from '../audio/calibration'
import type { LatencyProfile, LatencyProfiles, OutputKind } from '../audio/calibration'
import { clamp, isMobilePlatform } from '../audio/pitch'

export type Tolerance = 25 | 50 | 75
export type SeparationMode = 'auto' | 'fast' | 'standard'

export interface Settings {
  tolerance: Tolerance
  octaveAlign: boolean
  /** 参考旋律与伴奏/原曲一起移调，-6..+6 半音（保持速度）。 */
  transpose: number
  /** 手动延迟补偿；null 表示按输出设备使用校准档案或设备估算。 */
  latencyMs: number | null
  /** 自动校准结果，按输出设备 label 或「外放/有线/蓝牙」分类保存。 */
  latencyProfiles: LatencyProfiles
  /** 最近一次校准的输出类型，label 无法区分时作为兜底。 */
  lastOutputKind: OutputKind
  /** 人声分离模式；auto = 手机快速、电脑标准。 */
  separationMode: SeparationMode
  volume: number
}

export const DEFAULT_SETTINGS: Settings = {
  tolerance: 50,
  octaveAlign: true,
  transpose: 0,
  latencyMs: null,
  latencyProfiles: {},
  lastOutputKind: 'speaker',
  separationMode: 'auto',
  volume: 0.75,
}

export function effectiveSeparationSpeed(settings: Settings): 'fast' | 'standard' {
  if (settings.separationMode === 'fast') return 'fast'
  if (settings.separationMode === 'standard') return 'standard'
  return isMobilePlatform() ? 'fast' : 'standard'
}

const STORAGE_KEY = 'voicepro.settings.v1'

function isTolerance(value: unknown): value is Tolerance {
  return value === 25 || value === 50 || value === 75
}

function isOutputKind(value: unknown): value is OutputKind {
  return value === 'speaker' || value === 'wired' || value === 'bluetooth'
}

function isSeparationMode(value: unknown): value is SeparationMode {
  return value === 'auto' || value === 'fast' || value === 'standard'
}

function parseProfiles(value: unknown): LatencyProfiles {
  if (!value || typeof value !== 'object') return {}
  const out: LatencyProfiles = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    if (
      typeof record.ms !== 'number' ||
      !Number.isFinite(record.ms) ||
      (record.method !== 'speaker' && record.method !== 'tap') ||
      !isOutputKind(record.kind)
    ) {
      continue
    }
    const profile: LatencyProfile = {
      ms: clamp(Math.round(record.ms), 0, MAX_LATENCY_MS),
      method: record.method,
      kind: record.kind,
      measuredAt:
        typeof record.measuredAt === 'number' && Number.isFinite(record.measuredAt)
          ? record.measuredAt
          : Date.now(),
      spreadMs:
        typeof record.spreadMs === 'number' && Number.isFinite(record.spreadMs)
          ? clamp(Math.round(record.spreadMs), 0, 999)
          : 0,
      samples:
        typeof record.samples === 'number' && Number.isFinite(record.samples)
          ? clamp(Math.round(record.samples), 0, 99)
          : 0,
    }
    if (typeof record.deviceLabel === 'string') profile.deviceLabel = record.deviceLabel.slice(0, 120)
    if (typeof record.deviceId === 'string') profile.deviceId = record.deviceId.slice(0, 120)
    out[key.slice(0, 160)] = profile
  }
  return out
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
          ? clamp(Math.round(record.latencyMs), 0, MAX_LATENCY_MS)
          : null,
      latencyProfiles: parseProfiles(record.latencyProfiles),
      lastOutputKind: isOutputKind(record.lastOutputKind)
        ? record.lastOutputKind
        : DEFAULT_SETTINGS.lastOutputKind,
      separationMode: isSeparationMode(record.separationMode)
        ? record.separationMode
        : DEFAULT_SETTINGS.separationMode,
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
