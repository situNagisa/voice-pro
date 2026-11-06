/**
 * 由 docs/brand 下的 SVG 母版生成各平台图标与启动屏。
 * 依赖 rsvg-convert（librsvg），用法：node scripts/generate-icons.mjs
 * 生成结果：public/、android/app/src/main/res/、src-tauri/icons/、docs/brand/icon-1024.png
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = join(root, 'docs/brand')
const tmpDir = join(root, 'node_modules/.cache/voice-pro-icons')

const iconSvg = join(brandDir, 'icon.svg')
const maskableSvg = join(brandDir, 'icon-maskable.svg')
const roundSvg = join(brandDir, 'icon-round.svg')
const backgroundSvg = join(brandDir, 'icon-background.svg')
const foregroundSvg = join(brandDir, 'icon-foreground.svg')

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function render(svg, out, width, height = width) {
  ensureDir(dirname(out))
  execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), svg, '-o', out])
}

function renderBuffer(svg, width, height = width) {
  return execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), svg])
}

/** 把若干 PNG 打包成 ICO（Vista 起支持 PNG 负载）。 */
function writeIco(images, out) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach(({ size, data }, i) => {
    const p = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, p)
    dir.writeUInt8(size >= 256 ? 0 : size, p + 1)
    dir.writeUInt8(0, p + 2)
    dir.writeUInt8(0, p + 3)
    dir.writeUInt16LE(1, p + 4)
    dir.writeUInt16LE(32, p + 6)
    dir.writeUInt32LE(data.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += data.length
  })
  writeFileSync(out, Buffer.concat([header, dir, ...images.map((image) => image.data)]))
}

/** 用 PNG 负载拼出 ICNS（macOS 10.7+）。 */
function writeIcns(entries, out) {
  const chunks = entries.map(([type, size]) => {
    const data = renderBuffer(iconSvg, size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  writeFileSync(out, Buffer.concat([header, body]))
}

// ---------- Web / PWA ----------
ensureDir(join(root, 'public'))
copyFileSync(iconSvg, join(root, 'public/icon.svg'))
copyFileSync(iconSvg, join(root, 'public/favicon.svg'))
copyFileSync(maskableSvg, join(root, 'public/icon-maskable.svg'))

render(iconSvg, join(root, 'public/icon-192.png'), 192)
render(iconSvg, join(root, 'public/icon-512.png'), 512)
render(maskableSvg, join(root, 'public/icon-maskable-192.png'), 192)
render(maskableSvg, join(root, 'public/icon-maskable-512.png'), 512)
// iOS 会自己裁圆角，这里用满幅版本，避免二次圆角露出黑角。
render(maskableSvg, join(root, 'public/apple-touch-icon.png'), 180)
writeIco(
  [16, 32, 48].map((size) => ({ size, data: renderBuffer(iconSvg, size) })),
  join(root, 'public/favicon.ico'),
)

// ---------- 品牌预览 ----------
render(iconSvg, join(brandDir, 'icon-1024.png'), 1024)
render(roundSvg, join(brandDir, 'icon-round-512.png'), 512)

// ---------- Android 启动图标 ----------
const densities = {
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
}
const resDir = join(root, 'android/app/src/main/res')
for (const [density, scale] of Object.entries(densities)) {
  const dir = join(resDir, `mipmap-${density}`)
  render(iconSvg, join(dir, 'ic_launcher.png'), Math.round(48 * scale))
  render(roundSvg, join(dir, 'ic_launcher_round.png'), Math.round(48 * scale))
  render(foregroundSvg, join(dir, 'ic_launcher_foreground.png'), Math.round(108 * scale))
  render(backgroundSvg, join(dir, 'ic_launcher_background.png'), Math.round(108 * scale))
}

// 单色（主题）图标：与前景同构的矢量，系统负责着色。
const mono = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:pathData="M54,29.78 A24.22,24.22 0 1,1 54,78.22 A24.22,24.22 0 1,1 54,29.78"
        android:strokeColor="#FFFFFF"
        android:strokeWidth="2.77" />
    <path
        android:pathData="M54,20.1L54,24.6M54,83.4L54,87.9M20.1,54L24.6,54M83.4,54L87.9,54"
        android:strokeColor="#FFFFFF"
        android:strokeWidth="2.08"
        android:strokeLineCap="round" />
    <path
        android:pathData="M39.12,49.15L39.12,58.85M46.56,43.62L46.56,64.38M54,37.04L54,70.96M61.44,43.62L61.44,64.38M68.88,49.15L68.88,58.85"
        android:strokeColor="#FFFFFF"
        android:strokeWidth="4.15"
        android:strokeLineCap="round" />
</vector>
`
writeFileSync(join(resDir, 'drawable/ic_launcher_monochrome.xml'), mono)

// ---------- Android 启动屏 ----------
const artMarkup = `
  <circle cx="256" cy="240" r="150" fill="url(#glow)" filter="url(#blur)" />
  <circle cx="256" cy="256" r="140" fill="none" stroke="url(#ring)" stroke-width="16" />
  <g stroke="#8f7dff" stroke-width="12" stroke-linecap="round" opacity="0.8">
    <path d="M256 84v26" />
    <path d="M256 402v26" />
    <path d="M84 256h26" />
    <path d="M402 256h26" />
  </g>
  <g fill="none" stroke="url(#bars)" stroke-width="24" stroke-linecap="round">
    <path d="M170 284v-56" />
    <path d="M213 316v-120" />
    <path d="M256 354v-196" />
    <path d="M299 316v-120" />
    <path d="M342 284v-56" />
  </g>`

function splashSvg(width, height) {
  const unit = Math.min(width, height)
  const artScale = (unit * 0.34) / 344
  const cx = width / 2
  const cy = height * 0.45
  const titleSize = unit * 0.082
  const taglineSize = unit * 0.034
  const titleY = cy + (unit * 0.34) / 2 + titleSize * 1.7
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="ring" gradientUnits="userSpaceOnUse" x1="111" y1="116" x2="401" y2="396">
      <stop offset="0" stop-color="#b3a6ff" />
      <stop offset="0.55" stop-color="#8f7dff" />
      <stop offset="1" stop-color="#2ec4a0" />
    </linearGradient>
    <linearGradient id="bars" gradientUnits="userSpaceOnUse" x1="0" y1="158" x2="0" y2="354">
      <stop offset="0" stop-color="#c6bdff" />
      <stop offset="0.5" stop-color="#9a8bff" />
      <stop offset="1" stop-color="#6d5cf0" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.5">
      <stop offset="0" stop-color="#8f7dff" stop-opacity="0.4" />
      <stop offset="1" stop-color="#8f7dff" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#8f7dff" stop-opacity="0.18" />
      <stop offset="1" stop-color="#8f7dff" stop-opacity="0" />
    </radialGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="26" />
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="#090a0e" />
  <circle cx="${cx}" cy="${cy}" r="${unit * 0.62}" fill="url(#halo)" />
  <g transform="translate(${cx} ${cy}) scale(${artScale}) translate(-256 -256)">
    ${artMarkup}
  </g>
  <text x="${cx}" y="${titleY}" text-anchor="middle" font-family="WenQuanYi Micro Hei, Noto Sans CJK SC, sans-serif" font-size="${titleSize}" font-weight="500" letter-spacing="${unit * 0.012}" fill="#f2f4f9">音准镜</text>
  <text x="${cx}" y="${titleY + taglineSize * 1.9}" text-anchor="middle" font-family="WenQuanYi Micro Hei, Noto Sans CJK SC, sans-serif" font-size="${taglineSize}" letter-spacing="${unit * 0.006}" fill="#7c8497">看见每一个音</text>
</svg>`
}

const splashes = [
  ['drawable', 480, 320],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
]
ensureDir(tmpDir)
for (const [dir, width, height] of splashes) {
  const svgPath = join(tmpDir, `${dir}-splash.svg`)
  writeFileSync(svgPath, splashSvg(width, height))
  render(svgPath, join(resDir, dir, 'splash.png'), width, height)
}

// ---------- Tauri ----------
const tauriIcons = join(root, 'src-tauri/icons')
ensureDir(tauriIcons)
render(iconSvg, join(tauriIcons, '32x32.png'), 32)
render(iconSvg, join(tauriIcons, '128x128.png'), 128)
render(iconSvg, join(tauriIcons, '128x128@2x.png'), 256)
render(iconSvg, join(tauriIcons, 'icon.png'), 512)
writeIco(
  [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: renderBuffer(iconSvg, size) })),
  join(tauriIcons, 'icon.ico'),
)
writeIcns(
  [
    ['icp4', 16],
    ['icp5', 32],
    ['ic11', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic13', 256],
    ['ic08', 256],
    ['ic14', 512],
    ['ic09', 512],
    ['ic10', 1024],
  ],
  join(tauriIcons, 'icon.icns'),
)

// Windows 商店磁贴
const storeLogos = [
  ['Square30x30Logo.png', 30],
  ['Square44x44Logo.png', 44],
  ['Square71x71Logo.png', 71],
  ['Square89x89Logo.png', 89],
  ['Square107x107Logo.png', 107],
  ['Square142x142Logo.png', 142],
  ['Square150x150Logo.png', 150],
  ['Square284x284Logo.png', 284],
  ['Square310x310Logo.png', 310],
  ['StoreLogo.png', 50],
]
for (const [name, size] of storeLogos) {
  render(iconSvg, join(tauriIcons, name), size)
}

// 启动屏里的字体缺字时给出提示
const fontCheck = execFileSync('fc-list', [':lang=zh', 'family'], { encoding: 'utf8' })
if (!fontCheck.trim()) {
  console.warn('未找到中文字体，启动屏文字可能缺失：请安装 fonts-wqy-microhei')
}

console.log('图标与启动屏已生成。')
