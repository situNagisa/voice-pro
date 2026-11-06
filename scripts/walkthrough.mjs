import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

/**
 * 首次使用走查：按真实用户路径在手机 / 桌面两种尺寸下跑完整流程。
 * 只做检查，不改应用数据以外的内容；截图与问题清单落在 docs/walkthrough。
 */
const BASE_URL = process.env.BASE_URL ?? 'https://localhost:5173/'
const OUT_DIR = path.resolve('docs/walkthrough')
const PRIVACY_KEY = 'voicepro.privacy.v1'

const PROFILES = [
  {
    name: 'mobile',
    context: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    },
  },
  {
    name: 'desktop',
    context: {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    },
  },
]

/** 与 screenshot.mjs 相同的假麦克风：按《小星星》唱，高音偏低、长音下滑。 */
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
      const start = t0 + note.start + 0.14
      const end = t0 + note.end
      const duration = note.end - note.start
      const baseCents = note.midi >= 69 ? -55 : 0
      osc.frequency.setValueAtTime(freqOf(note.midi, baseCents), start)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.16, start + 0.03)
      if (duration >= 1.5) {
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

/**
 * 在页面里用 OfflineAudioContext 合成 20 秒“人声 + 伴奏”WAV。
 * 人声用带颤音和共振峰滤波的锯齿波，伴奏用低音量的和弦垫，便于分离模型区分。
 * 返回 base64，由 Node 写入临时文件后走文件选择框导入。
 */
async function synthesizeImportWav(page) {
  return page.evaluate(async () => {
    const seconds = 20
    const sampleRate = 44100
    const ctx = new OfflineAudioContext(2, seconds * sampleRate, sampleRate)
    const master = ctx.createGain()
    master.gain.value = 0.9
    master.connect(ctx.destination)

    // 伴奏：每 2.5 秒换一个和弦，低音量铺底。
    const chords = [
      [48, 52, 55],
      [45, 48, 52],
      [41, 45, 48],
      [43, 47, 50],
      [48, 52, 55],
      [45, 48, 52],
      [41, 45, 48],
      [43, 47, 50],
    ]
    const padGain = ctx.createGain()
    padGain.gain.value = 0.055
    padGain.connect(master)
    chords.forEach((tones, index) => {
      const start = index * 2.5
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 900
      filter.connect(padGain)
      tones.forEach((midi) => {
        const osc = ctx.createOscillator()
        osc.type = 'triangle'
        osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12)
        const gain = ctx.createGain()
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(1, start + 0.18)
        gain.gain.setValueAtTime(1, start + 2.3)
        gain.gain.linearRampToValueAtTime(0, start + 2.5)
        osc.connect(gain)
        gain.connect(filter)
        osc.start(start)
        osc.stop(start + 2.5)
      })
    })

    // 人声旋律：C4 D4 E4 G4 A4 G4 E4 D4 C4 ... 每音 2.5 秒，带 5 Hz 颤音。
    const melody = [60, 62, 64, 67, 69, 67, 64, 62]
    const voiceGain = ctx.createGain()
    voiceGain.gain.value = 0.19
    const formant = ctx.createBiquadFilter()
    formant.type = 'bandpass'
    formant.frequency.value = 1050
    formant.Q.value = 0.7
    const formant2 = ctx.createBiquadFilter()
    formant2.type = 'peaking'
    formant2.frequency.value = 2600
    formant2.gain.value = 6
    const mix = ctx.createGain()
    mix.gain.value = 0.55
    // 直接声 + 共振峰声混合，制造接近人声的谐波结构。
    const direct = ctx.createGain()
    direct.gain.value = 0.35
    melody.forEach((midi, index) => {
      const start = index * 2.5
      const duration = 2.45
      const freq = 440 * Math.pow(2, (midi - 69) / 12)
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(freq, start)
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 5.2
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = freq * 0.012
      lfo.connect(lfoGain)
      lfoGain.connect(osc.frequency)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0, start)
      env.gain.linearRampToValueAtTime(1, start + 0.12)
      env.gain.setValueAtTime(1, start + duration - 0.2)
      env.gain.linearRampToValueAtTime(0, start + duration)
      osc.connect(env)
      env.connect(direct)
      env.connect(formant)
      env.connect(formant2)
      direct.connect(mix)
      formant.connect(mix)
      formant2.connect(mix)
      mix.connect(voiceGain)
      osc.start(start)
      osc.stop(start + duration)
      lfo.start(start)
      lfo.stop(start + duration)
    })
    voiceGain.connect(master)

    const rendered = await ctx.startRendering()
    const channels = [rendered.getChannelData(0), rendered.getChannelData(1)]
    const frames = rendered.length
    const bytes = new ArrayBuffer(44 + frames * 2 * 2)
    const view = new DataView(bytes)
    const write = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    write(0, 'RIFF')
    view.setUint32(4, 36 + frames * 2 * 2, true)
    write(8, 'WAVE')
    write(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 2, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2 * 2, true)
    view.setUint16(32, 2 * 2, true)
    view.setUint16(34, 16, true)
    write(36, 'data')
    view.setUint32(40, frames * 2 * 2, true)
    let offset = 44
    for (let i = 0; i < frames; i++) {
      for (let channel = 0; channel < 2; channel++) {
        const value = Math.max(-1, Math.min(1, channels[channel][i]))
        view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
        offset += 2
      }
    }
    const blob = new Blob([bytes], { type: 'audio/wav' })
    const buffer = await blob.arrayBuffer()
    let binary = ''
    const bytesView = new Uint8Array(buffer)
    const chunk = 0x8000
    for (let i = 0; i < bytesView.length; i += chunk) {
      binary += String.fromCharCode(...bytesView.subarray(i, i + chunk))
    }
    return btoa(binary)
  })
}

function toLocator(page, target) {
  return typeof target === 'string' ? page.locator(target) : target
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  const summaries = []
  const only = process.env.PROFILE
  try {
    for (const profile of PROFILES) {
      if (only && profile.name !== only) continue
      const summary = await runProfile(browser, profile)
      summaries.push(summary)
      console.log(`\n===== ${profile.name} 摘要 =====`)
      console.log(JSON.stringify(summary, null, 2))
    }
    await writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summaries, null, 2))
  } finally {
    await browser.close()
  }
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
  page.setDefaultTimeout(12_000)

  const summary = {
    profile: profile.name,
    viewport: profile.context.viewport,
    startedAt: new Date().toISOString(),
    steps: [],
    issues: [],
    console: [],
    pageErrors: [],
    dialogs: [],
    import: null,
    screenshots: [],
  }
  let stepName = '启动'
  let shotIndex = 0
  let failShotTaken = false

  page.on('pageerror', (error) => {
    summary.pageErrors.push({ step: stepName, message: error.message, stack: error.stack })
  })
  page.on('console', (message) => {
    const type = message.type()
    if (type !== 'error' && type !== 'warning') return
    const text = message.text()
    // 已知的开发环境噪音不当作产品问题
    if (text.includes('React DevTools')) return
    summary.console.push({ step: stepName, type, text })
  })
  page.on('dialog', (dialog) => {
    summary.dialogs.push({ step: stepName, type: dialog.type(), message: dialog.message() })
    void dialog.accept()
  })

  async function shot(name) {
    shotIndex += 1
    const file = path.join(OUT_DIR, `${profile.name}-${String(shotIndex).padStart(2, '0')}-${name}.png`)
    await page.evaluate(() => document.fonts?.ready).catch(() => undefined)
    await page.waitForTimeout(260)
    await page.screenshot({ path: file, fullPage: false })
    summary.screenshots.push(path.relative(process.cwd(), file))
    console.log(`[${profile.name}] 截图 ${path.basename(file)}`)
  }

  function issue(level, title, detail) {
    summary.issues.push({ level, title, detail, step: stepName })
    console.warn(`[${profile.name}] ${level}: ${title}${detail ? ` — ${detail}` : ''}`)
  }

  async function step(name, body, options = {}) {
    const { timeout = 10_000, allowLong = false } = options
    stepName = name
    const startedAt = Date.now()
    console.log(`[${profile.name}] 步骤：${name}`)
    try {
      const result = await body()
      const ms = Date.now() - startedAt
      summary.steps.push({ name, ms, ok: true, expectedLong: allowLong })
      if (ms > timeout && !allowLong) {
        issue('warn', `步骤「${name}」超过 ${Math.round(timeout / 1000)} 秒`, `${ms} ms，期间没有中断但有反馈延迟`)
      }
      return result
    } catch (error) {
      const ms = Date.now() - startedAt
      summary.steps.push({ name, ms, ok: false, expectedLong: allowLong })
      issue('error', `步骤「${name}」失败`, error instanceof Error ? error.message : String(error))
      if (!failShotTaken) {
        failShotTaken = true
        await shot('FAIL').catch(() => undefined)
      }
      throw error
    }
  }

  async function visible(target, label, timeout = 10_000) {
    const locator = toLocator(page, target)
    try {
      await locator.first().waitFor({ state: 'visible', timeout })
    } catch (error) {
      throw new Error(`等待「${label}」出现超时（${timeout} ms）`)
    }
    return locator.first()
  }

  async function hidden(target, label, timeout = 10_000) {
    const locator = toLocator(page, target)
    try {
      await locator.first().waitFor({ state: 'detached', timeout })
    } catch (error) {
      throw new Error(`等待「${label}」消失超时（${timeout} ms）`)
    }
  }

  async function waitFunction(fn, label, timeout = 10_000, arg) {
    try {
      await page.waitForFunction(fn, arg, { timeout })
    } catch (error) {
      throw new Error(`等待「${label}」超时（${timeout} ms）`)
    }
  }

  async function expectText(target, expected, label, timeout = 10_000) {
    const locator = toLocator(page, target).first()
    const started = Date.now()
    let text = ''
    while (Date.now() - started < timeout) {
      text = ((await locator.textContent().catch(() => '')) ?? '').trim()
      if (text.includes(expected)) return text
      await page.waitForTimeout(120)
    }
    throw new Error(`「${label}」没有出现「${expected}」，当前为「${text.slice(0, 80)}」`)
  }

  async function openTab(label) {
    if (profile.name === 'mobile') {
      await page.locator('.tabbar-item', { hasText: label }).first().click()
    } else {
      await page.locator('.side-nav .side-nav-item', { hasText: label }).first().click()
    }
  }

  async function openSettings() {
    if (profile.name === 'mobile') {
      await page.locator('.tab-header button[aria-label="打开设置"]:visible').first().click()
    } else {
      await page.locator('.side-nav').getByRole('button', { name: '打开设置' }).click()
    }
    await visible('.settings-sheet', '设置面板')
  }

  async function clickVisible(selector, label) {
    const locator = page.locator(selector).filter({ visible: true }).first()
    try {
      await locator.click({ timeout: 6000 })
    } catch (error) {
      throw new Error(`点击「${label}」失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function pausePractice() {
    await clickVisible('button[aria-label="暂停并回看"]', '暂停并回看')
    await visible('.practice-page.is-paused', '暂停回看面板')
  }

  async function resumePractice() {
    const pausePanelButton = page.locator('.pause-panel button', { hasText: '继续唱' }).filter({ visible: true }).first()
    if (await pausePanelButton.count()) {
      await pausePanelButton.click()
    } else {
      await clickVisible('button[aria-label="继续唱"]', '继续唱')
    }
    await waitFunction(
      () => !document.querySelector('.practice-page')?.classList.contains('is-paused'),
      '继续练唱',
      10_000,
    )
  }

  async function finishPractice() {
    const mobileEnd = page.locator('.practice-transport .end-btn').filter({ visible: true }).first()
    if (await mobileEnd.count()) {
      await mobileEnd.click()
    } else {
      await clickVisible('.desktop-transport .dock-end', '结束')
    }
    await visible('.report-screen', '练习报告', 30_000)
    await page.waitForTimeout(400)
  }

  async function backHomeFromReport() {
    await page.getByRole('button', { name: '回到练歌' }).click()
    await visible('.home-screen', '练歌首页')
  }

  async function startDemoPractice() {
    await page.locator('.demo-card').first().click()
    await visible('.prep-screen', '准备练唱', 90_000)
    await page.waitForTimeout(300)
    await page.locator('.start-button').click()
    await visible('.countdown-layer', '倒数层', 10_000)
    await waitFunction(
      () => Boolean(document.querySelector('.live-freq') && document.querySelector('.live-freq')?.textContent !== '—'),
      '实时音高出现',
      20_000,
    )
  }

  try {
    // ---------- 1. 首启隐私弹窗 ----------
    await step('首启隐私弹窗', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60_000 })
      await visible('.privacy-layer', '隐私弹窗', 30_000)
      const accept = page.getByRole('button', { name: '同意并继续' })
      const decline = page.getByRole('button', { name: '不同意，仅浏览' })
      if (!(await accept.isVisible()) || !(await decline.isVisible())) {
        throw new Error('隐私弹窗缺少同意或拒绝按钮')
      }
      await shot('privacy')
      await accept.click()
      await hidden('.privacy-layer', '隐私弹窗', 10_000)
      await visible('.home-screen', '练歌首页', 20_000)
    })

    await step('练歌首页', async () => {
      await visible('.demo-card', '示例歌卡片')
      const demoCount = await page.locator('.demo-card').count()
      if (demoCount < 1) throw new Error('首页没有示例歌')
      const libraryCount = await page.locator('.library-song').count()
      if (libraryCount !== 0) throw new Error(`首次进入歌曲库应为空，实际 ${libraryCount} 首`)
      await shot('home')
    })

    // ---------- 2. 准备页：校准提示、选调 ----------
    await step('准备页与选调', async () => {
      await page.locator('.demo-card').first().click()
      await visible('.prep-screen', '准备页', 90_000)
      await expectText('.prep-calib-row', '还没校准延迟', '校准提示')
      const startButton = page.locator('.start-button')
      await visible(startButton, '开始练唱按钮')
      await shot('prep')
      await page.getByRole('button', { name: '移调增大' }).click()
      await expectText('.tag-row', '移调 +1', '移调 +1 标签', 5000)
      await page.getByRole('button', { name: '移调减小' }).click()
      await waitFunction(
        () => !document.querySelector('.prep-screen .tag-row')?.textContent?.includes('移调'),
        '移调标签恢复',
        5000,
      )
    })

    // ---------- 3. 倒数、练唱、暂停、拖动、继续 ----------
    await step('倒数并开始练唱', async () => {
      await page.locator('.start-button').click()
      await visible('.countdown-layer', '倒数层', 10_000)
      await shot('countdown')
      await waitFunction(
        () => Boolean(document.querySelector('.live-freq') && document.querySelector('.live-freq')?.textContent !== '—'),
        '实时音高出现',
        20_000,
      )
      await page.waitForTimeout(10_000)
      await shot('practice')
      const cents = await page.locator('.live-cents').first().textContent()
      if (!cents || cents.includes('—')) throw new Error('练唱中没有显示实时音分')
    }, { timeout: 30_000, allowLong: true })

    await step('暂停、拖动回看、继续', async () => {
      await pausePractice()
      await page.waitForTimeout(600)
      await shot('practice-paused')
      await page.locator('.pause-panel, .desktop-transport').first().scrollIntoViewIfNeeded().catch(() => undefined)
      const canvas = page.locator('.practice-screen .pitch-roll canvas').first()
      const box = await canvas.boundingBox()
      if (!box) throw new Error('找不到音高卷帘画布')
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx - 110, cy, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      await page.mouse.click(cx, cy)
      await page.waitForTimeout(400)
      // 桌面端暂停面板被工具栏替代，选中信息显示在 dock-selection 里
      if (profile.name === 'mobile') {
        await visible('.selection-card', '回看选中卡片', 5000)
      } else {
        const dockText = (await page.locator('.desktop-transport .dock-selection').first().textContent()) ?? ''
        if (dockText.includes('拖动时间轴或点选')) {
          throw new Error('桌面端点选卷帘后没有出现选中信息')
        }
      }
      await shot('practice-paused-scrubbed')
      await resumePractice()
      await page.waitForTimeout(7000)
    }, { timeout: 30_000, allowLong: true })

    await step('结束并查看报告', async () => {
      await finishPractice()
      const diagnosis = page.locator('.diagnosis-item')
      const diagnosisEmpty = page.locator('.diagnosis-empty')
      if ((await diagnosis.count()) === 0 && (await diagnosisEmpty.count()) === 0) {
        throw new Error('报告页没有诊断卡内容')
      }
      const phraseTitles = await page.locator('.phrase-title').allTextContents()
      if (phraseTitles.length === 0) throw new Error('报告页没有逐句列表')
      const hasLyric = phraseTitles.some((text) => !text.trim().startsWith('第 '))
      if (!hasLyric) {
        issue('warn', '示例歌报告没有显示歌词句子', `逐句标题：${phraseTitles.slice(0, 4).join(' / ')}`)
      }
      await shot('report')
      await page.locator('.report-phrases').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await shot('report-phrases')
      if ((await page.locator('.phrase-train-btn').count()) === 0) {
        throw new Error('报告里没有单句循环入口')
      }
    })

    // ---------- 4. 单句循环、变速 ----------
    await step('单句循环与变速', async () => {
      await page.locator('.phrase-train-btn').first().click()
      await visible('.loop-screen', '单句循环页', 30_000)
      await visible('.loop-page', '循环练唱界面', 30_000)
      await page.waitForTimeout(1200)
      await shot('loop')
      await page.locator('.loop-controls .segmented button', { hasText: '0.5×' }).click()
      await expectText('.loop-screen .topbar', '0.5×', '0.5 倍速标签', 5000)
      await page.waitForTimeout(1800)
      await shot('loop-slow')
      await page.locator('.loop-controls .segmented button', { hasText: '1.0×' }).click()
      await expectText('.loop-screen .topbar', '1×', '恢复原速标签', 5000)
      await page.getByRole('button', { name: '暂停循环' }).click()
      await expectText('.loop-transport', '已暂停', '循环暂停状态', 5000)
      await page.getByRole('button', { name: '继续循环' }).click()
      await expectText('.loop-transport', '循环中', '循环继续状态', 5000)
      await page.waitForTimeout(1200)
      await page.locator('.loop-screen .topbar .icon-btn').first().click()
      await visible('.report-screen', '返回报告', 15_000)
      await page.waitForTimeout(400)
    })

    // ---------- 5. 成绩卡 ----------
    await step('成绩卡', async () => {
      await page.getByRole('button', { name: '分享成绩卡' }).click()
      await visible('.share-card-dialog', '成绩卡弹窗', 15_000)
      const image = page.locator('.share-card-preview img')
      try {
        await image.waitFor({ state: 'visible', timeout: 15_000 })
      } catch {
        const errorText = await page.locator('.share-card-preview').textContent()
        throw new Error(`成绩卡没有生成：${(errorText ?? '').trim().slice(0, 80)}`)
      }
      const natural = await image.evaluate((node) => ({
        width: node.naturalWidth,
        height: node.naturalHeight,
      }))
      if (natural.width < 100 || natural.height < 100) {
        throw new Error(`成绩卡尺寸异常：${natural.width}×${natural.height}`)
      }
      await page.waitForTimeout(500)
      await shot('share-card')
      await page.locator('.share-card-dialog .icon-btn[aria-label="关闭"]').click()
      await hidden('.share-card-dialog', '成绩卡弹窗', 10_000)
      await backHomeFromReport()
    })

    // ---------- 6. 第二次练习，制造同歌对比 ----------
    await step('同歌第二次练习', async () => {
      await startDemoPractice()
      await page.waitForTimeout(7000)
      await shot('practice-second')
      await finishPractice()
      await backHomeFromReport()
    }, { timeout: 30_000, allowLong: true })

    // ---------- 7. 记录页：进步、同歌对比、回看 ----------
    await step('记录页与进步', async () => {
      await openTab('记录')
      await visible('.records-screen', '记录页', 15_000)
      await visible('.progress-overview', '我的进步', 15_000)
      await page.locator('.record-skeleton').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined)
      await page.locator('.issue-skeletons').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
      await page.waitForTimeout(500)
      await shot('records-progress')
      const recordCount = await page.locator('.record-item, .records-table tbody tr').count()
      if (recordCount < 2) throw new Error(`应有至少 2 次记录，实际 ${recordCount}`)
      await visible('.song-group-card', '按歌曲看进步')
      await page.locator('.song-group-card').first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await shot('records-songs')
    })

    await step('同歌对比', async () => {
      await page.locator('.song-group-card').first().click()
      await visible('.song-progress-screen', '歌曲进步页', 15_000)
      await page.locator('.compare-roll canvas').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
      await page.waitForTimeout(1200)
      await shot('song-progress')
      const loadError = page.locator('.song-compare-card .mini-empty', { hasText: '读取失败' })
      if (await loadError.count()) throw new Error('同歌对比读取失败')
      await page.locator('.song-compare-card').scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      await shot('song-compare')
      const pickers = await page.locator('.compare-pickers select').count()
      if (pickers < 2) throw new Error('同歌对比缺少 A/B 选择器')
      await page.locator('.song-progress-screen .topbar .icon-btn').first().click()
      await visible('.records-screen', '返回记录页', 15_000)
    })

    await step('打开记录回看', async () => {
      await page.locator('.records-history').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      const mobileOpen = page.locator('.record-open').filter({ visible: true }).first()
      if (await mobileOpen.count()) {
        await mobileOpen.click()
      } else {
        await page.locator('.records-table tbody tr').filter({ visible: true }).first().click()
      }
      await visible('.review-screen', '回看页', 30_000)
      await page.waitForTimeout(1000)
      await shot('review')
      const reviewError = page.locator('.review-screen .notice.error, .review-screen .notice.warn')
      if (await reviewError.count()) {
        issue('warn', '回看页出现提示', (await reviewError.first().textContent())?.trim().slice(0, 120))
      }
      await page.locator('.review-screen .topbar .icon-btn').first().click()
      await visible('.records-screen', '返回记录页', 15_000)
    })

    // ---------- 8. 音准仪 + 练声小课 ----------
    await step('音准仪', async () => {
      await openTab('音准仪')
      await visible('.tuner-screen', '音准仪', 15_000)
      await page.waitForTimeout(5000)
      const note = await page.locator('.tuner-note').first().textContent()
      if (!note || note.trim() === '—') issue('warn', '音准仪没有显示音名', '假麦克风已注入 5 秒')
      await shot('tuner')
    })

    await step('练声小课', async () => {
      await page.locator('.coach-header-btn').click()
      await visible('.coach-screen', '练声小课', 15_000)
      await page.waitForTimeout(500)
      await shot('coach-list')
      await page.locator('.coach-card').first().click()
      await visible('.coach-setup', '练声准备', 15_000)
      await shot('coach-setup')
      await page.locator('.coach-start').click()
      await visible('.coach-countdown', '练声倒数', 10_000)
      await visible('.coach-live', '练声进行中', 10_000)
      await page.waitForTimeout(1500)
      await shot('coach-live')
      await visible('.coach-result-hero', '练声结果', 20_000)
      await page.waitForTimeout(600)
      await shot('coach-result')
      await page.locator('.coach-screen .topbar .icon-btn').first().click()
      await visible('.tuner-screen', '返回音准仪', 15_000)
    }, { timeout: 30_000, allowLong: true })

    // ---------- 9. 导入流程：合成 WAV、文件选择、分离与提取 ----------
    await step('导入 20 秒音频', async () => {
      await openTab('练歌')
      await visible('.home-screen', '练歌首页', 15_000)
      await page.waitForTimeout(400)
      const base64 = await synthesizeImportWav(page)
      const wavPath = path.join(os.tmpdir(), `voicepro-walkthrough-${profile.name}-${Date.now()}.wav`)
      await writeFile(wavPath, Buffer.from(base64, 'base64'))
      const fileSize = Buffer.byteLength(base64, 'base64')
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })
      await page.locator('.import-card').first().click()
      const chooser = await chooserPromise
      const startedAt = Date.now()
      await chooser.setFiles(wavPath)
      let lastFeedback = '点击导入'
      let lastFeedbackAt = Date.now()
      const stages = []
      let outcome = null
      while (Date.now() - startedAt < 180_000) {
        const state = await page.evaluate(() => {
          const section = document.querySelector('.library-section')
          const stage = section?.querySelector('.extract-progress .progress-head span:first-child')?.textContent?.trim() ?? ''
          const percent = section?.querySelector('.extract-progress .progress-head span:last-child')?.textContent?.trim() ?? ''
          const importTitle = section?.querySelector('.import-card strong')?.textContent?.trim() ?? ''
          const success = section?.querySelector('.notice.success')?.textContent?.trim() ?? ''
          const error = section?.querySelector('.notice.error')?.textContent?.trim() ?? ''
          const song = section?.querySelector('.library-song .library-copy strong')?.textContent?.trim() ?? ''
          return { stage, percent, importTitle, success, error, song }
        })
        const feedback = `${state.stage}|${state.percent}|${state.success}|${state.error}|${state.song}`
        if (feedback !== lastFeedback) {
          lastFeedback = feedback
          lastFeedbackAt = Date.now()
          const label = state.stage || state.importTitle || state.success || state.error || state.song
          if (label && !stages.some((item) => item.label === label)) {
            stages.push({ label, percent: state.percent, atMs: Date.now() - startedAt })
            console.log(`[${profile.name}] 导入阶段 ${label} ${state.percent} @${Date.now() - startedAt}ms`)
          }
        }
        if (state.error) {
          outcome = { error: state.error }
          break
        }
        if (state.success && state.song) {
          outcome = { success: state.success, song: state.song }
          break
        }
        if (Date.now() - lastFeedbackAt > 10_000) {
          issue('warn', '导入过程超过 10 秒没有新反馈', `停在：${state.stage || state.importTitle || '未知阶段'}`)
          lastFeedbackAt = Date.now()
        }
        await page.waitForTimeout(300)
      }
      const totalMs = Date.now() - startedAt
      summary.import = { fileName: path.basename(wavPath), bytes: fileSize, totalMs, stages, outcome }
      console.log(`[${profile.name}] 导入耗时 ${(totalMs / 1000).toFixed(1)} 秒`)
      if (!outcome || outcome.error) {
        throw new Error(`导入失败：${outcome?.error ?? '超过 180 秒仍未完成'}`)
      }
      await visible('.library-song', '导入后的歌曲', 10_000)
      await page.waitForTimeout(600)
      await shot('import-done')
      const jobNotice = page.locator('.notice.success', { hasText: '已分析完成' })
      if (await jobNotice.count()) {
        await page.getByRole('button', { name: '知道了' }).click()
      }
      await page.waitForTimeout(300)
    }, { timeout: 180_000, allowLong: true })

    await step('导入歌准备页', async () => {
      await page.locator('.library-song .library-open').first().click()
      await visible('.prep-screen', '导入歌准备页', 30_000)
      await page.waitForTimeout(400)
      await shot('import-prep')
      await page.locator('.prep-screen .topbar .icon-btn').first().click()
      await visible('.home-screen', '练歌首页', 15_000)
    })

    // ---------- 10. 导入纯文本歌词 ----------
    await step('导入纯文本歌词', async () => {
      await page.locator('.library-actions button[title="歌词"]').first().click()
      await visible('.lyrics-sheet', '歌词弹窗', 15_000)
      const lyrics = [
        '第一句 走查测试',
        '第二句 跟着伴奏唱',
        '第三句 音准要稳住',
        '第四句 慢慢把气送',
        '第五句 收尾不着急',
        '第六句 再来一遍',
      ].join('\n')
      await page.locator('.lyrics-textarea').fill(lyrics)
      await page.locator('.lyrics-import-actions .btn.primary').click()
      await expectText('.lyrics-import-actions', '当前 6 行', '纯文本对时结果', 10_000)
      await page.waitForTimeout(400)
      await shot('lyrics-sheet')
      const lineCount = await page.locator('.lyrics-edit-line').count()
      if (lineCount !== 6) throw new Error(`歌词应有 6 行，实际 ${lineCount}`)
      await page.locator('.lyrics-foot-actions .btn.primary').click()
      await hidden('.lyrics-sheet', '歌词弹窗', 15_000)
      // 重新打开，确认已持久化
      await page.waitForTimeout(500)
      await page.locator('.library-actions button[title="歌词"]').first().click()
      await visible('.lyrics-sheet', '歌词弹窗', 15_000)
      await page.waitForTimeout(500)
      const persisted = await page.locator('.lyrics-edit-line').count()
      if (persisted !== 6) throw new Error(`重新打开后歌词只有 ${persisted} 行`)
      await shot('lyrics-persisted')
      await page.locator('.lyrics-head .icon-btn[aria-label="关闭"]').click()
      await hidden('.lyrics-sheet', '歌词弹窗', 15_000)
    })

    await step('导入歌练唱', async () => {
      await page.locator('.library-song .library-open').first().click()
      await visible('.prep-screen', '导入歌准备页', 30_000)
      await page.locator('.start-button').click()
      await visible('.countdown-layer', '倒数层', 10_000)
      await waitFunction(
        () => Boolean(document.querySelector('.live-freq') && document.querySelector('.live-freq')?.textContent !== '—'),
        '实时音高出现',
        20_000,
      )
      await page.waitForTimeout(7000)
      await shot('import-practice')
      await finishPractice()
      await page.waitForTimeout(400)
      await shot('import-report')
      const titles = await page.locator('.phrase-title').allTextContents()
      if (titles.length === 0) {
        issue('warn', '导入歌报告没有逐句数据', '旋律可能没有提取出参考音符')
      } else if (!titles.some((text) => !text.trim().startsWith('第 '))) {
        issue('warn', '导入歌词没有关联到报告句子', `逐句标题：${titles.slice(0, 3).join(' / ')}`)
      }
      await backHomeFromReport()
    }, { timeout: 30_000, allowLong: true })

    await step('删除歌词入口', async () => {
      await page.locator('.library-actions button[title="歌词"]').first().click()
      await visible('.lyrics-sheet', '歌词弹窗', 15_000)
      const deleteButton = page.locator('.lyrics-head button[aria-label="删除歌词"]')
      await visible(deleteButton, '删除歌词按钮', 5000)
      await shot('lyrics-delete-entry')
      await deleteButton.click()
      await expectText('.lyrics-import .notice', '已删除这首歌的歌词', '删除成功提示', 10_000)
      const remain = await page.locator('.lyrics-edit-line').count()
      if (remain !== 0) throw new Error(`删除后仍显示 ${remain} 行歌词`)
      await shot('lyrics-deleted')
      await page.locator('.lyrics-head button[aria-label="关闭"]').click()
      await hidden('.lyrics-sheet', '歌词弹窗', 15_000)
    })

    // ---------- 11. 设置：校准、清缓存 ----------
    await step('设置与延迟校准', async () => {
      await openSettings()
      await expectText('.sheet-data-row', '1 首', '歌曲库占用', 10_000)
      await page.waitForTimeout(400)
      await shot('settings')
      await page.locator('.latency-calib-row .btn').click()
      await visible('.calib-layer', '延迟校准弹窗', 15_000)
      await page.waitForTimeout(500)
      await shot('calibration')
      const startButton = page.locator('.calib-actions .btn.primary').first()
      await startButton.click()
      await visible('.calib-listening', '校准进行中', 10_000)
      await page.waitForTimeout(2500)
      await shot('calibration-running')
      // 中途取消，验证能回到设置
      const cancel = page.locator('.calib-card .extract-progress .btn', { hasText: '取消' })
      if (await cancel.count()) {
        await cancel.first().click()
      }
      await visible('.calib-actions .btn.primary', '校准设置页', 10_000)
      // 再跑一次，等它给出结果或明确的失败提示（假麦克风听不到外放 click）
      await page.locator('.calib-actions .btn.primary').first().click()
      await visible('.calib-listening', '校准进行中', 10_000)
      let calibrated = false
      try {
        await Promise.race([
          page.locator('.calib-result').waitFor({ state: 'visible', timeout: 20_000 }),
          page.locator('.calib-card .notice.error').waitFor({ state: 'visible', timeout: 20_000 }),
        ])
        calibrated = (await page.locator('.calib-result').count()) > 0
      } catch {
        issue('error', '延迟校准没有结束', '20 秒内既没有结果也没有错误提示')
      }
      await page.waitForTimeout(400)
      await shot('calibration-result')
      if (!calibrated) {
        const errorText = await page.locator('.calib-card .notice.error').first().textContent().catch(() => '')
        console.log(`[${profile.name}] 外放校准未成功（假麦克风预期）：${(errorText ?? '').trim().slice(0, 100)}`)
      }
      await page.locator('.calib-head button[aria-label="关闭校准"]').click()
      await visible('.settings-sheet', '设置面板', 10_000)
    }, { timeout: 30_000, allowLong: true })

    await step('清空歌曲缓存', async () => {
      const clearButton = page.locator('.sheet-data-row', { hasText: '歌曲库' }).getByRole('button', { name: '清空缓存' })
      await clearButton.scrollIntoViewIfNeeded()
      await clearButton.click()
      await expectText('.sheet-data-row', '0 首', '歌曲库清空', 15_000)
      await page.waitForTimeout(400)
      await shot('settings-cleared')
      await page.locator('.settings-sheet .sheet-head button[aria-label="关闭设置"]').click()
      await hidden('.settings-sheet', '设置面板', 10_000)
      await visible('.home-screen', '练歌首页', 15_000)
      await page.waitForTimeout(600)
      const songs = await page.locator('.library-song').count()
      if (songs !== 0) throw new Error(`清空缓存后首页仍有 ${songs} 首导入歌`)
      await shot('home-cleared')
    })
  } catch (error) {
    issue('error', '走查提前结束', error instanceof Error ? error.message : String(error))
  } finally {
    // 整理控制台问题，过滤掉假麦克风校准的预期报错
    summary.pageErrors = summary.pageErrors.filter(
      (item) => !item.message.includes('AudioContext') && !item.message.includes('play()'),
    )
    const deduped = new Map()
    for (const item of summary.console) {
      const key = `${item.type}:${item.text}`
      if (!deduped.has(key)) deduped.set(key, { ...item, count: 1 })
      else deduped.get(key).count += 1
    }
    summary.console = [...deduped.values()]
    summary.finishedAt = new Date().toISOString()
    summary.slowSteps = summary.steps.filter((item) => item.ms > 10_000 && !item.expectedLong)
    await context.close()
  }
  return summary
}

await main()
