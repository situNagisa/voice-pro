/**
 * 把 src/demo 的合成示例歌用无头 Chromium（OfflineAudioContext）渲染出来，写到
 * ~/voice-pro-eval-data/demo/<id>/{mix,vocals}.wav，供 prepare.py / eval.ts 使用。
 * node 里没有 OfflineAudioContext，所以借用浏览器渲染；提取/评测本身仍在 node 里跑。
 *
 * 用法（仓库根目录）：node scripts/eval/render-demo.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const require = createRequire(path.join(here, 'package.json'))
const esbuild = require('esbuild')
const outRoot = path.join(process.env.EVAL_DATA ?? path.join(homedir(), 'voice-pro-eval-data'), 'demo')

const bundle = await esbuild.build({
  entryPoints: [path.join(root, 'src/demo/index.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Demo',
  write: false,
  target: 'es2022',
})

function floatWav(sampleRate, channels) {
  const frames = channels[0].length
  const dataBytes = frames * channels.length * 4
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVEfmt ', 8, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(3, 20)
  buf.writeUInt16LE(channels.length, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels.length * 4, 28)
  buf.writeUInt16LE(channels.length * 4, 32)
  buf.writeUInt16LE(32, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      buf.writeFloatLE(channels[c][i], 44 + (i * channels.length + c) * 4)
    }
  }
  return buf
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<html><body></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const ids = await page.evaluate(() => Demo.listDemoSongs().map((s) => s.id))
  for (const id of ids) {
    const rendered = await page.evaluate(async (songId) => {
      const toB64 = (buffer) => {
        const out = []
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const bytes = new Uint8Array(buffer.getChannelData(c).slice().buffer)
          let s = ''
          for (let i = 0; i < bytes.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          }
          out.push(btoa(s))
        }
        return { rate: buffer.sampleRate, channels: out }
      }
      const mix = await Demo.renderDemoSong(songId)
      const stems = await Demo.renderDemoStems(songId)
      return { mix: toB64(mix), vocals: toB64(stems.vocals) }
    }, id)
    const dir = path.join(outRoot, id)
    mkdirSync(dir, { recursive: true })
    for (const key of ['mix', 'vocals']) {
      const { rate, channels } = rendered[key]
      const arrays = channels.map((b64) => {
        const b = Buffer.from(b64, 'base64')
        return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
      })
      writeFileSync(path.join(dir, `${key}.wav`), floatWav(rate, arrays))
    }
    console.log('渲染完成', id)
  }
} finally {
  await browser.close()
}
