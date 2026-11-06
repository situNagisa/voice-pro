/**
 * 歌曲内容指纹：文件大小 + 前 8 MB 的 SHA-256。
 * 4 分钟的 mp3 通常不到 10 MB，前 8 MB 已经覆盖绝大部分内容；
 * 完整读一遍 10 MB 文件在手机上也要几百毫秒，没必要。
 */
const HASH_PREFIX_BYTES = 8 * 1024 * 1024

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

export async function hashFile(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前环境不支持内容哈希，请通过 https 或 localhost 打开应用。')
  }
  const header = new ArrayBuffer(8)
  new DataView(header).setBigUint64(0, BigInt(file.size), true)
  const prefix = new Uint8Array(
    await file.slice(0, Math.min(HASH_PREFIX_BYTES, file.size)).arrayBuffer(),
  )
  const data = new Uint8Array(header.byteLength + prefix.byteLength)
  data.set(new Uint8Array(header), 0)
  data.set(prefix, header.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toHex(digest)
}
