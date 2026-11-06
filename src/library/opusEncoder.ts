/**
 * WebCodecs Opus 编码 + 最小 Ogg 封装。
 *
 * WebCodecs 的 AudioEncoder 只吐裸 Opus 包，没有 Ogg 头；这里自己写
 * OpusHead / OpusTags 和 Ogg 页（含 CRC），存成 decodeAudioData 能识别的
 * Ogg Opus。Android WebView / Chrome / Firefox 支持这条链路；Safari 目前
 * 不保证能解码 Ogg Opus，调用方会用一次真实解码来验证，失败就回退 WAV。
 */

export const OPUS_RATE = 48000
const PRE_SKIP = 312
const VENDOR = 'voice-pro'

export interface EncodedOpus {
  blob: Blob
  frames: number
}

interface OpusPacket {
  data: Uint8Array
  frames: number
}

export async function isOpusEncodingSupported(
  channels: number,
  bitrate: number,
): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return false
  }
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: 'opus',
      sampleRate: OPUS_RATE,
      numberOfChannels: channels,
      bitrate,
    })
    return Boolean(support.supported)
  } catch {
    return false
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i << 24
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function oggCrc(data: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0
  }
  return crc
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

function makePage(
  serial: number,
  sequence: number,
  headerType: number,
  granule: number,
  packets: Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const segments: number[] = []
  let dataLength = 0
  for (const packet of packets) {
    let remaining = packet.length
    while (remaining >= 255) {
      segments.push(255)
      remaining -= 255
    }
    segments.push(remaining)
    dataLength += packet.length
  }
  if (segments.length > 255) throw new Error('Ogg 页过大')
  const page = new Uint8Array(27 + segments.length + dataLength)
  const view = new DataView(page.buffer)
  writeAscii(view, 0, 'OggS')
  view.setUint8(4, 0)
  view.setUint8(5, headerType)
  view.setUint32(6, granule >>> 0, true)
  view.setUint32(10, Math.floor(granule / 0x100000000) >>> 0, true)
  view.setUint32(14, serial, true)
  view.setUint32(18, sequence, true)
  view.setUint32(22, 0, true)
  view.setUint8(26, segments.length)
  let offset = 27
  for (const segment of segments) page[offset++] = segment
  for (const packet of packets) {
    page.set(packet, offset)
    offset += packet.length
  }
  const crc = oggCrc(page)
  view.setUint32(22, crc, true)
  return page
}

function opusHead(channels: number): Uint8Array {
  const head = new Uint8Array(19)
  const view = new DataView(head.buffer)
  writeAscii(view, 0, 'OpusHead')
  view.setUint8(8, 1)
  view.setUint8(9, channels)
  view.setUint16(10, PRE_SKIP, true)
  view.setUint32(12, OPUS_RATE, true)
  view.setInt16(16, 0, true)
  view.setUint8(18, 0)
  return head
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode(VENDOR)
  const tags = new Uint8Array(16 + vendor.length)
  const view = new DataView(tags.buffer)
  writeAscii(view, 0, 'OpusTags')
  view.setUint32(8, vendor.length, true)
  tags.set(vendor, 12)
  view.setUint32(12 + vendor.length, 0, true)
  return tags
}

function muxOggOpus(
  packets: OpusPacket[],
  channels: number,
  finalFrames: number,
): Blob {
  const serial = (Math.random() * 0xffffffff) >>> 0
  const pages: Uint8Array<ArrayBuffer>[] = []
  let sequence = 0
  pages.push(makePage(serial, sequence++, 0x02, 0, [opusHead(channels)]))
  pages.push(makePage(serial, sequence++, 0, 0, [opusTags()]))

  let pagePackets: Uint8Array[] = []
  let pageSegments = 0
  let cumulative = 0
  let flushedGranule = 0

  const flush = (eos: boolean, granule: number): void => {
    if (pagePackets.length === 0) return
    pages.push(
      makePage(serial, sequence++, eos ? 0x04 : 0, granule, pagePackets),
    )
    flushedGranule = granule
    pagePackets = []
    pageSegments = 0
  }

  for (const packet of packets) {
    const lacing = Math.floor(packet.data.length / 255) + 1
    if (
      pagePackets.length > 0 &&
      (pageSegments + lacing > 255 || pagePackets.length >= 50)
    ) {
      flush(false, PRE_SKIP + cumulative)
    }
    pagePackets.push(packet.data)
    pageSegments += lacing
    cumulative += packet.frames
  }

  const target = Math.max(flushedGranule, PRE_SKIP + Math.min(finalFrames, cumulative))
  flush(true, target)
  return new Blob(pages, { type: 'audio/ogg; codecs=opus' })
}

export class OggOpusEncoder {
  private readonly channels: number
  private readonly encoder: AudioEncoder
  private packets: OpusPacket[] = []
  private encodedFrames = 0
  private failure: Error | null = null
  private done = false

  private constructor(channels: number, bitrate: number) {
    this.channels = channels
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        const frames =
          chunk.duration != null && chunk.duration > 0
            ? Math.round((chunk.duration * OPUS_RATE) / 1_000_000)
            : 960
        this.packets.push({ data, frames })
        this.encodedFrames += frames
      },
      error: (error) => {
        this.failure = error
      },
    })
    this.encoder.configure({
      codec: 'opus',
      sampleRate: OPUS_RATE,
      numberOfChannels: channels,
      bitrate,
    })
  }

  static async create(channels: number, bitrate: number): Promise<OggOpusEncoder | null> {
    if (!(await isOpusEncodingSupported(channels, bitrate))) return null
    try {
      return new OggOpusEncoder(channels, bitrate)
    } catch (error) {
      console.warn('[voice-pro] Opus 编码器初始化失败', error)
      return null
    }
  }

  get queueSize(): number {
    return this.encoder.encodeQueueSize
  }

  encode(planes: Float32Array[], frameCount: number, timestampUs: number): void {
    if (this.failure) throw this.failure
    const merged = new Float32Array(frameCount * this.channels)
    for (let channel = 0; channel < this.channels; channel++) {
      const plane = planes[channel] ?? planes[0]
      merged.set(plane.subarray(0, frameCount), channel * frameCount)
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_RATE,
      numberOfFrames: frameCount,
      numberOfChannels: this.channels,
      timestamp: timestampUs,
      data: merged,
    })
    try {
      this.encoder.encode(audioData)
    } finally {
      audioData.close()
    }
  }

  abort(): void {
    if (this.done) return
    this.done = true
    this.packets = []
    try {
      this.encoder.close()
    } catch {
      // 已经关闭
    }
  }

  async finish(totalFrames: number): Promise<EncodedOpus> {
    if (this.done) throw new Error('Opus 编码已经结束')
    this.done = true
    try {
      await this.encoder.flush()
    } finally {
      this.encoder.close()
    }
    if (this.failure) throw this.failure
    if (this.encodedFrames <= 0) throw new Error('Opus 编码没有输出')
    const blob = muxOggOpus(
      this.packets,
      this.channels,
      Math.min(totalFrames, this.encodedFrames),
    )
    this.packets = []
    return { blob, frames: this.encodedFrames }
  }
}
