import { readFileSync, writeFileSync } from 'node:fs';

export interface WavData {
  sampleRate: number;
  channels: Float32Array[];
}

/** 读取 PCM16/24/32 与 float32 WAV，返回逐声道 Float32。 */
export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`不是 WAV 文件：${path}`);
  }
  let pos = 12;
  let format = 1;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channelCount = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buf.length - body);
      break;
    }
    pos = body + size + (size & 1);
  }
  if (dataStart < 0 || channelCount === 0) throw new Error(`WAV 缺少 fmt/data：${path}`);

  const bytes = bits / 8;
  const frames = Math.floor(dataLength / (bytes * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const offset = dataStart + (i * channelCount + c) * bytes;
      let v: number;
      if (format === 3 && bits === 32) v = buf.readFloatLE(offset);
      else if (format === 1 && bits === 16) v = buf.readInt16LE(offset) / 32768;
      else if (format === 1 && bits === 24) v = buf.readIntLE(offset, 3) / 8388608;
      else if (format === 1 && bits === 32) v = buf.readInt32LE(offset) / 2147483648;
      else throw new Error(`不支持的 WAV 编码 format=${format} bits=${bits}：${path}`);
      channels[c][i] = v;
    }
  }
  return { sampleRate, channels };
}

/** 写 float32 WAV（用于缓存分离结果）。 */
export function writeWav(path: string, data: WavData): void {
  const channelCount = data.channels.length;
  const frames = data.channels[0].length;
  const dataBytes = frames * channelCount * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(channelCount, 22);
  buf.writeUInt32LE(data.sampleRate, 24);
  buf.writeUInt32LE(data.sampleRate * channelCount * 4, 28);
  buf.writeUInt16LE(channelCount * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      buf.writeFloatLE(data.channels[c][i], 44 + (i * channelCount + c) * 4);
    }
  }
  writeFileSync(path, buf);
}
