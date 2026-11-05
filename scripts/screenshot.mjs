import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'https://localhost:5173/'
const OUT_DIR = path.resolve('docs/screenshots')

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
]

async function settle(page, ms = 300) {
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(ms)
}

async function shot(page, profile, name) {
  const file = path.join(OUT_DIR, `${profile.name}-${name}.png`)
  await settle(page)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`saved ${path.relative(process.cwd(), file)}`)
}

async function runProfile(browser, profile) {
  const context = await browser.newContext({
    ...profile.context,
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.warn(`[${profile.name}] page error:`, error.message))

  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60_000 })

  // 练歌首页
  await page.locator('.home-screen').waitFor({ timeout: 30_000 })
  await shot(page, profile, 'home')

  // 示例歌 → 准备页
  await page.locator('.demo-card').first().click()
  await page.locator('.prep-screen').waitFor({ timeout: 90_000 })
  await shot(page, profile, 'prep')

  // 开始练唱 → 倒数 → 练唱中
  await page.locator('.start-button').click()
  await page.locator('.countdown-layer').waitFor({ timeout: 10_000 })
  await page.locator('.practice-screen').waitFor({ timeout: 30_000 })
  await page.locator('.practice-transport').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(5000) // 等曲线积累
  await shot(page, profile, 'practice')

  // 暂停回看
  await page.getByRole('button', { name: '暂停并回看' }).click()
  await page.locator('.pause-panel').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1000)
  await shot(page, profile, 'practice-paused')

  // 结束并保存，制造一条记录，再回到主页
  await page.locator('.pause-panel .end-btn').click()
  await page.locator('.report-screen').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: '返回' }).click()
  await page.locator('.home-screen').waitFor({ timeout: 15_000 })

  // 音准仪
  await page.locator('.tabbar-item', { hasText: '音准仪' }).click()
  await page.locator('.tuner-screen').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(5000)
  await shot(page, profile, 'tuner')

  // 记录页
  await page.locator('.tabbar-item', { hasText: '记录' }).click()
  await page.locator('.records-screen').waitFor({ timeout: 15_000 })
  await page.locator('.record-skeleton').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  await shot(page, profile, 'records')

  // 设置抽屉
  await page.locator('.records-screen').getByRole('button', { name: '打开设置' }).click()
  await page.locator('.settings-sheet').waitFor({ timeout: 10_000 })
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

try {
  for (const profile of PROFILES) {
    await runProfile(browser, profile)
  }
} finally {
  await browser.close()
}
