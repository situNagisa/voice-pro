import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'https://localhost:5173/'
const OUT_DIR = path.resolve('docs/screenshots')
const PRIVACY_KEY = 'voicepro.privacy.v1'

const PROFILES = [
  {
    name: 'mobile',
    context: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  },
  {
    name: 'desktop',
    context: {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    },
  },
  {
    name: 'wide',
    context: {
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    },
  },
]

/**
 * 用振荡器模拟麦克风，按《小星星》的乐谱"唱"出音高。
 * 高音区故意低 55 音分、长音后半段下滑、每个音晚 140ms 起音，
 * 这样报告页能稳定出现"主要问题"卡片。
 * 这段函数会被序列化注入页面，不能引用外部变量。
 */
function installFakeMic() {
  const BPM = 72
  const BEAT = 60 / BPM
  const PHRASES = [
    [4, [[0, 1, 60], [1, 1, 60], [2, 1, 67], [3, 1, 67], [4, 1, 69], [5, 1, 69], [6, 2, 67]]],
    [12, [[0, 1, 65], [1, 1, 65], [2, 1, 64], [3, 1, 64], [4, 1, 62], [5, 1, 62], [6, 2, 60]]],
    [20, [[0, 1, 67], [1, 1, 67], [2, 1, 65], [3, 1, 65], [4, 1, 64], [5, 1, 64], [6, 2, 62]]],
    [28, [[0, 1, 67], [1, 1, 67], [2, 1, 65], [3, 1, 65], [4, 1, 64], [5, 1, 64], [6, 2, 62]]],
    [36, [[0, 1, 60], [1, 1, 60], [2, 1, 67], [3, 1, 67], [4, 1, 69], [5, 1, 69], [6, 2, 67]]],
    [44, [[0, 1, 65], [1, 1, 65], [2, 1, 64], [3, 1, 64], [4, 1, 62], [5, 1, 62], [6, 2, 60]]],
  ]
  const notes = []
  for (const [baseBeat, list] of PHRASES) {
    for (const [offset, beats, midi] of list) {
      const start = (baseBeat + offset) * BEAT
      notes.push({ start, end: start + beats * BEAT, midi })
    }
  }

  const freqOf = (midi, cents) => 440 * Math.pow(2, (midi + cents / 100 - 69) / 12)

  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext()
    await ctx.resume()
    const dest = ctx.createMediaStreamDestination()
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    const gain = ctx.createGain()
    gain.gain.value = 0
    osc.connect(gain)
    gain.connect(dest)

    const t0 = ctx.currentTime + 0.04
    osc.frequency.setValueAtTime(freqOf(60, 0), t0)
    osc.start()
    for (const note of notes) {
      const start = t0 + note.start + 0.14 // 起音偏晚
      const end = t0 + note.end
      const duration = note.end - note.start
      const baseCents = note.midi >= 69 ? -55 : 0 // 高音区偏低
      osc.frequency.setValueAtTime(freqOf(note.midi, baseCents), start)
      // 30ms 淡入，避免起音瞬态被检测成异常高音
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.16, start + 0.03)
      if (duration >= 1.5) {
        // 长音后半段再往下掉 70 音分
        const dropAt = start + duration * 0.5
        osc.frequency.setValueAtTime(freqOf(note.midi, baseCents), dropAt)
        osc.frequency.linearRampToValueAtTime(freqOf(note.midi, baseCents - 70), dropAt + 0.05)
      }
      gain.gain.setValueAtTime(0, end - 0.01)
      osc.frequency.setValueAtTime(freqOf(note.midi, baseCents), end)
    }
    return dest.stream
  }
}

/** 从真实练习记录派生几条历史记录，用来展示"我的进步"和同歌对比。 */
async function seedHistory(page) {
  const created = await page.evaluate(async () => {
    const openDb = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('voicepro')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const getAll = (db, store) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

    const db = await openDb()
    const metas = await getAll(db, 'records')
    const details = await getAll(db, 'details')
    const detailById = new Map(details.map((detail) => [detail.id, detail]))
    const source = metas
      .filter((meta) => meta.songKind === 'demo')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!source) return 0
    const detail = detailById.get(source.id)
    if (!detail) return 0

    const quantile = (sorted, ratio) => {
      const index = (sorted.length - 1) * ratio
      const lo = Math.floor(index)
      const hi = Math.ceil(index)
      if (lo === hi) return sorted[lo]
      return sorted[lo] * (1 - (index - lo)) + sorted[hi] * (index - lo)
    }
    const voiceStats = (points, transpose) => {
      const values = points
        .filter((point) => point.clarity >= 0.8 && Number.isFinite(point.midi))
        .map((point) => point.midi - (typeof point.shift === 'number' ? point.shift : transpose))
        .sort((a, b) => a - b)
      if (values.length < 10) return {}
      return {
        voiceSamples: values.length,
        voiceLowMidi: quantile(values, 0.1),
        voiceMedianMidi: quantile(values, 0.5),
        voiceHighMidi: quantile(values, 0.9),
        voiceMinMidi: values[0],
        voiceMaxMidi: values[values.length - 1],
      }
    }

    const notes = detail.melodyNotes.slice().sort((a, b) => a.start - b.start)
    const refAt = (time) => {
      let lo = 0
      let hi = notes.length - 1
      let found = null
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (notes[mid].start <= time + 0.02) {
          found = notes[mid]
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return found && time <= found.end + 0.02 ? found.midi + detail.transpose : null
    }
    const centsAt = (point, shift = 0) => {
      const target = refAt(point.t + shift)
      if (target == null) return null
      const aligned =
        point.midi + (detail.octaveAlign ? Math.round((target - point.midi) / 12) * 12 : 0)
      return (aligned - target) * 100
    }
    const statsOf = (points, shift = 0) => {
      let valid = 0
      let hits = 0
      let absSum = 0
      for (const point of points) {
        if (point.clarity < 0.8) continue
        const cents = centsAt(point, shift)
        if (cents == null) continue
        valid += 1
        absSum += Math.abs(cents)
        if (Math.abs(cents) <= source.tolerance) hits += 1
      }
      if (valid === 0) return { hitRate: null, score: null }
      const hitRate = hits / valid
      const stability = Math.max(0, Math.min(100, 100 - (absSum / valid) * 0.6))
      return { hitRate, score: Math.round(hitRate * 70 + stability * 0.3) }
    }

    // 去掉参考音之外（换气、静音）和偏离过远的异常帧，避免对比图出现竖直尖刺
    const cleaned = detail.points.filter((point) => {
      if (point.clarity < 0.8) return false
      const cents = centsAt(point)
      return cents != null && Math.abs(cents) <= 250
    })
    const sourceStats = statsOf(cleaned)
    console.log(`record points ${detail.points.length} -> ${cleaned.length}, notes ${notes.length}`)

    const DAY = 86400_000
    const seeds = [
      { daysAgo: 6, offset: -0.42, timeShift: 0.08 },
      { daysAgo: 4, offset: -0.24, timeShift: 0.04 },
      { daysAgo: 2, offset: 0.32, timeShift: -0.04 },
    ]
    const tx = db.transaction(['records', 'details'], 'readwrite')
    const metaStore = tx.objectStore('records')
    const detailStore = tx.objectStore('details')
    const now = Date.now()

    // 顺手修正真实记录里的异常帧与命中率
    if (sourceStats.hitRate != null) {
      metaStore.put({ ...source, hitRate: sourceStats.hitRate })
    }
    if (cleaned.length !== detail.points.length) {
      detailStore.put({ ...detail, points: cleaned })
    }

    seeds.forEach((seed, index) => {
      const id = `seed-${source.songId}-${index}`
      const createdAt = now - seed.daysAgo * DAY
      const points = cleaned
        .map((point) => ({
          ...point,
          t: point.t + seed.timeShift,
          midi: point.midi + seed.offset + 0.06 * Math.sin(point.t * 2.1),
          clarity: Math.max(point.clarity, 0.9),
        }))
        // 时间平移后会跨到相邻音符的采样，重新按参考音筛一遍
        .filter((point) => {
          const cents = centsAt(point)
          return cents != null && Math.abs(cents) <= 250
        })
      const stats = statsOf(points)
      metaStore.put({
        id,
        createdAt,
        songId: source.songId,
        songName: source.songName,
        songKind: 'demo',
        duration: source.duration,
        practicedSeconds: source.practicedSeconds,
        score: stats.score,
        hitRate: stats.hitRate,
        tolerance: source.tolerance,
        ...voiceStats(points, detail.transpose),
      })
      detailStore.put({
        ...detail,
        id,
        points,
        segments: detail.segments.map((segment) => ({ ...segment })),
      })
    })
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return seeds.length
  })
  console.log(`seeded ${created} history records`)
}

async function openTab(page, profile, label) {
  if (profile.name === 'mobile') {
    await page.locator('.tabbar-item', { hasText: label }).click()
  } else {
    await page.locator('.side-nav .side-nav-item', { hasText: label }).click()
  }
}

async function openSettings(page, profile) {
  if (profile.name === 'mobile') {
    await page.locator('.records-screen').getByRole('button', { name: '打开设置' }).click()
  } else {
    await page.locator('.side-nav').getByRole('button', { name: '打开设置' }).click()
  }
  await page.locator('.settings-sheet').waitFor({ timeout: 10_000 })
}

async function settle(page, ms = 300) {
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(ms)
}

async function shot(page, profile, name, options = {}) {
  const file = path.join(OUT_DIR, `${profile.name}-${name}.png`)
  await settle(page)
  await page.screenshot({ path: file, fullPage: false, ...options })
  console.log(`saved ${path.relative(process.cwd(), file)}`)
}

async function runProfile(browser, profile) {
  const context = await browser.newContext({
    ...profile.context,
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  await context.addInitScript(installFakeMic)
  const page = await context.newPage()
  page.on('pageerror', (error) => console.warn(`[${profile.name}] page error:`, error.message))

  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60_000 })

  // 首启隐私弹窗：先截弹窗，再预置同意状态重新进入
  await page.locator('.privacy-layer').waitFor({ timeout: 30_000 })
  await settle(page, 400)
  await shot(page, profile, 'privacy')

  await page.evaluate((key) => localStorage.setItem(key, 'accepted'), PRIVACY_KEY)
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
  await page.locator('.home-screen').waitFor({ timeout: 30_000 })
  await page.locator('.privacy-layer').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})

  // 练歌首页
  await shot(page, profile, 'home')

  // 示例歌 → 准备页
  await page.locator('.demo-card').first().click()
  await page.locator('.prep-screen').waitFor({ timeout: 90_000 })
  await shot(page, profile, 'prep')

  // 开始练唱 → 倒数 → 练唱中
  await page.locator('.start-button').click()
  await page.locator('.countdown-layer').waitFor({ timeout: 10_000 })
  await page.locator('.practice-screen').waitFor({ timeout: 30_000 })
  await page.locator('.practice-screen .pitch-roll').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(12_000) // 等曲线积累
  await shot(page, profile, 'practice')

  // 唱到 30 秒左右再暂停，保证长音与高音区都有足够采样
  await page.waitForTimeout(16_000)
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: '暂停并回看' }).click()
  await page.locator('.practice-page.is-paused').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1000)
  await shot(page, profile, 'practice-paused')

  // 结束并保存，得到一条带诊断的报告
  if (profile.name === 'mobile') {
    await page.locator('.pause-panel .end-btn').click()
  } else {
    await page.locator('.desktop-transport .dock-end').click()
  }
  await page.locator('.report-screen').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(800)
  await shot(page, profile, 'report')

  // 成绩卡对话框
  await page.getByRole('button', { name: '分享成绩卡' }).click()
  await page.locator('.share-card-dialog').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1500)
  await shot(page, profile, 'share-card')
  await page.locator('.share-card-dialog .icon-btn[aria-label="关闭"]').click()
  await page.locator('.share-card-dialog').waitFor({ state: 'detached', timeout: 10_000 })

  // 报告里的单句循环练习
  await page.locator('.phrase-train-btn').first().click()
  await page.locator('.loop-screen').waitFor({ timeout: 30_000 })
  await page.locator('.loop-screen .pitch-roll').waitFor({ timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(6000)
  await shot(page, profile, 'loop')
  await page.locator('.loop-screen .topbar .icon-btn').first().click()
  await page.locator('.report-screen').waitFor({ timeout: 15_000 })

  // 回到练歌
  await page.getByRole('button', { name: '回到练歌' }).click()
  await page.locator('.home-screen').waitFor({ timeout: 15_000 })

  // 派生历史记录，让"我的进步"和同歌对比有数据
  await seedHistory(page)
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
  await page.locator('.home-screen').waitFor({ timeout: 30_000 })

  // 音准仪
  await openTab(page, profile, '音准仪')
  await page.locator('.tuner-screen').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(5000)
  await shot(page, profile, 'tuner')

  // 音准仪 → 练声小课
  await page.locator('.coach-header-btn').click()
  await page.locator('.coach-screen').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(600)
  await shot(page, profile, 'coach')
  await page.locator('.coach-screen .topbar .icon-btn').first().click()
  await page.locator('.tuner-screen').waitFor({ timeout: 15_000 })

  // 记录页 → 我的进步
  await openTab(page, profile, '记录')
  await page.locator('.records-screen').waitFor({ timeout: 15_000 })
  await page.locator('.record-skeleton').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  await page.locator('.issue-skeletons').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(1000)
  await shot(page, profile, 'records-progress')

  // 全部练习列表
  await page.locator('.records-history').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await shot(page, profile, 'records')

  // 同歌进步页
  await page.locator('.song-group-card').first().scrollIntoViewIfNeeded()
  await page.locator('.song-group-card').first().click()
  await page.locator('.song-progress-screen').waitFor({ timeout: 15_000 })
  await page.locator('.compare-roll canvas').waitFor({ timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2000)
  await shot(page, profile, 'song-progress')
  await page.locator('.song-compare-card').scrollIntoViewIfNeeded()
  await page.waitForTimeout(800)
  await shot(page, profile, 'song-progress-compare')
  await page.locator('.song-progress-screen .topbar .icon-btn').first().click()
  await page.locator('.records-screen').waitFor({ timeout: 15_000 })

  // 打开记录 → 回看页
  await page.locator('.records-history').scrollIntoViewIfNeeded()
  if (profile.name === 'mobile') {
    await page.locator('.record-open').first().click()
  } else {
    await page.locator('.records-table tbody tr').first().click()
  }
  await page.locator('.review-screen').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1200)
  await shot(page, profile, 'review')
  await page.locator('.review-screen .topbar .icon-btn').click()
  await page.locator('.records-screen').waitFor({ timeout: 15_000 })

  // 设置
  await openSettings(page, profile)
  await page.waitForTimeout(500)
  await shot(page, profile, 'settings')

  await context.close()
}

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const only = process.env.PROFILE

try {
  for (const profile of PROFILES) {
    if (only && profile.name !== only) continue
    await runProfile(browser, profile)
  }
} finally {
  await browser.close()
}
