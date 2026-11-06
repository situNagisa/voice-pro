/**
 * 导出逐帧特征与参考标签，供 fit_voicing.py 拟合发声概率模型。
 * 用法：scripts/eval/node_modules/.bin/tsx scripts/eval/features.ts [--variants separated,oracle,direct] [--songs a,b]
 * 输出：~/voice-pro-eval-data/features/<song>/<variant>.f32（帧数 × 特征数，float32）+ names.json
 * 分离结果用 eval.ts 生成的缓存（最新哈希）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_NAMES, analyzeFeatures } from '../../src/reference/pipeline';
import { readWav } from './wav';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.EVAL_DATA ?? path.join(homedir(), 'voice-pro-eval-data');
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const variants = opt('variants', 'separated,oracle,direct').split(',');
const wanted = argv.includes('--songs') ? new Set(opt('songs', '').split(',')) : null;
const manifest = JSON.parse(readFileSync(path.join(HERE, 'songs.json'), 'utf8')) as {
  songs: { id: string; skipSeparation?: boolean }[];
};

function latestSeparated(id: string): string | null {
  const dir = path.join(DATA, 'cache', id);
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('vocals-'))
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files[0] ? path.join(dir, files[0].f) : null;
  } catch {
    return null;
  }
}

mkdirSync(path.join(DATA, 'features'), { recursive: true });
writeFileSync(path.join(DATA, 'features', 'names.json'), JSON.stringify(FEATURE_NAMES));
for (const song of manifest.songs) {
  if (wanted && !wanted.has(song.id)) continue;
  if (!existsSync(path.join(DATA, 'prepared', song.id, 'ref.csv'))) continue;
  const prepared = path.join(DATA, 'prepared', song.id);
  const outDir = path.join(DATA, 'features', song.id);
  mkdirSync(outDir, { recursive: true });
  for (const variant of variants) {
    const input =
      variant === 'separated'
        ? song.skipSeparation
          ? null
          : latestSeparated(song.id)
        : path.join(prepared, variant === 'direct' ? 'mix.wav' : 'vocals.wav');
    if (!input) continue;
    const wav = readWav(input);
    const { count, data } = analyzeFeatures({
      sampleRate: wav.sampleRate,
      duration: wav.channels[0].length / wav.sampleRate,
      channels: wav.channels,
      cleanVocals: variant !== 'direct',
    });
    writeFileSync(path.join(outDir, `${variant}.f32`), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    console.error(`特征 ${song.id}/${variant}: ${count} 帧`);
  }
}
