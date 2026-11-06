/**
 * 参数调优：在 dev 歌曲上做坐标下降，同时报告 test（留出）和示例歌。
 * 每个 worker 常驻持有若干条已做完谱分析的音频，主线程只下发参数、收集指标，所以一轮参数只要几秒。
 * 指标是 mir_eval 的逐帧定义（RPA/RCA/VR/VFA/OA）的 TS 实现，仅用于搜索；最终数字以 score.py 为准。
 *
 * 用法：
 *   scripts/eval/node_modules/.bin/tsx scripts/eval/tune.ts --mode clean --model model.json [--search] [--save best.json]
 *   --mode clean   评估“分离后的人声 → 提取”（缓存的分离结果），--oracle 改用干声 stem
 *   --mode mix     评估“不分离直接提取”，示例歌（合成）也在这里
 *   --model f      发声模型 JSON：{columns, coef, bias}，缺省用 pipeline.ts 里的默认
 *   --params f     其余参数 JSON（部分字段即可），作为搜索起点
 *   --search       坐标下降搜索 logitBias/switchCost/candidateWeight/jumpScale/minVoicedRun/maxGapFill
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import {
  defaultParams,
  extractFromAnalysis,
  prepareAnalysis,
  type ExtractionParams,
  type PreparedSignal,
} from '../../src/reference/pipeline';
import { readWav } from './wav';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.EVAL_DATA ?? path.join(homedir(), 'voice-pro-eval-data');

interface Item {
  id: string;
  split: string;
  variant: string;
  input: string;
  cleanVocals: boolean;
}

interface Metrics {
  id: string;
  split: string;
  notesOa: number;
  notesRpa: number;
  noteCount: number;
  rpa: number;
  rca: number;
  vr: number;
  vfa: number;
  oa: number;
}

type WorkerMessage =
  | { type: 'load'; items: Item[] }
  | { type: 'eval'; params: ExtractionParams; tag: number }
  | { type: 'exit' };

function readRef(song: string): Float32Array {
  const lines = readFileSync(path.join(DATA, 'prepared', song, 'ref.csv'), 'utf8').trim().split('\n');
  const out = new Float32Array(lines.length);
  for (let i = 0; i < lines.length; i++) out[i] = Number(lines[i].split(',')[1]);
  return out;
}

function frameMetrics(
  ref: Float32Array,
  est: (number | null)[],
): Pick<Metrics, 'rpa' | 'rca' | 'vr' | 'vfa' | 'oa'> {
  const n = Math.min(ref.length, est.length);
  let refVoiced = 0;
  let refUnvoiced = 0;
  let hit = 0;
  let chroma = 0;
  let falseAlarm = 0;
  let unvoicedOk = 0;
  for (let i = 0; i < n; i++) {
    const e = est[i];
    if (ref[i] > 0) {
      refVoiced++;
      if (e && e > 0) {
        const d = 1200 * Math.log2(e / ref[i]);
        if (Math.abs(d) < 50) hit++;
        const wrapped = ((d % 1200) + 1800) % 1200 - 600;
        if (Math.abs(wrapped) < 50) chroma++;
      }
    } else {
      refUnvoiced++;
      if (e && e > 0) falseAlarm++;
      else unvoicedOk++;
    }
  }
  const voicedHit = hit;
  return {
    rpa: refVoiced ? voicedHit / refVoiced : 0,
    rca: refVoiced ? chroma / refVoiced : 0,
    vr: 0,
    vfa: refUnvoiced ? falseAlarm / refUnvoiced : 0,
    oa: n ? (voicedHit + unvoicedOk) / n : 0,
  };
}

if (!isMainThread) {
  const loaded: { item: Item; prepared: PreparedSignal; ref: Float32Array }[] = [];
  parentPort!.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'load') {
      for (const item of msg.items) {
        const wav = readWav(item.input);
        const prepared = prepareAnalysis(
          {
            sampleRate: wav.sampleRate,
            duration: wav.channels[0].length / wav.sampleRate,
            channels: wav.channels,
            cleanVocals: item.cleanVocals,
          },
          () => {},
        );
        loaded.push({ item, prepared, ref: readRef(item.id) });
      }
      parentPort!.postMessage({ type: 'loaded' });
    } else if (msg.type === 'eval') {
      const results: Metrics[] = loaded.map(({ item, prepared, ref }) => {
        const melody = extractFromAnalysis(prepared, msg.params);
        const est = melody.frames.map((f) => f.f0);
        const m = frameMetrics(ref, est);
        // VR 单独算（RPA 的分母相同，但 VR 只要求估计有声）
        let refVoiced = 0;
        let voicedHit = 0;
        const n = Math.min(ref.length, est.length);
        for (let i = 0; i < n; i++) {
          if (ref[i] > 0) {
            refVoiced++;
            if (est[i]) voicedHit++;
          }
        }
        m.vr = refVoiced ? voicedHit / refVoiced : 0;
        // 音符按 10 ms 栅格渲染成 f0 序列，与 eval.ts 一致
        const noteEst: (number | null)[] = new Array(n);
        let cursor = 0;
        for (let i = 0; i < n; i++) {
          const time = i * 0.01;
          while (cursor < melody.notes.length && melody.notes[cursor].end <= time) cursor++;
          const note = melody.notes[cursor];
          noteEst[i] = note && note.start <= time ? 440 * 2 ** ((note.midi - 69) / 12) : null;
        }
        const nm = frameMetrics(ref, noteEst);
        return {
          id: item.id,
          split: item.split,
          ...m,
          notesOa: nm.oa,
          notesRpa: nm.rpa,
          noteCount: melody.notes.length,
        };
      });
      parentPort!.postMessage({ type: 'result', tag: msg.tag, results });
    } else {
      process.exit(0);
    }
  });
} else {
  await main();
}

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const mode = opt('mode') ?? 'clean';
  const oracle = argv.includes('--oracle');
  const manifest = JSON.parse(readFileSync(path.join(HERE, 'songs.json'), 'utf8')) as {
    songs: { id: string; split: string; skipSeparation?: boolean }[];
  };

  const items: Item[] = [];
  for (const song of manifest.songs) {
    const prepared = path.join(DATA, 'prepared', song.id);
    if (!existsSync(path.join(prepared, 'ref.csv'))) continue;
    if (mode === 'clean') {
      if (song.skipSeparation) {
        // 示例歌在 App 里没有分离这一步，直接用混音；同一套参数必须同时照顾它
        items.push({ id: song.id, split: song.split, variant: 'direct', input: path.join(prepared, 'mix.wav'), cleanVocals: false });
        continue;
      }
      const input = oracle ? path.join(prepared, 'vocals.wav') : latestSeparated(song.id);
      if (!input) continue;
      items.push({ id: song.id, split: song.split, variant: oracle ? 'oracle' : 'separated', input, cleanVocals: true });
    } else {
      items.push({ id: song.id, split: song.split, variant: 'direct', input: path.join(prepared, 'mix.wav'), cleanVocals: false });
    }
  }

  const base = defaultParams();
  let params: ExtractionParams = { ...base };
  const modelFile = opt('model');
  if (modelFile) params.voicing = JSON.parse(readFileSync(modelFile, 'utf8'));
  const paramsFile = opt('params');
  if (paramsFile) params = { ...params, ...JSON.parse(readFileSync(paramsFile, 'utf8')) };

  const workerCount = Math.min(items.length, Math.max(1, cpus().length - 2));
  const workers: Worker[] = Array.from({ length: workerCount }, () => new Worker(fileURLToPath(import.meta.url), { execArgv: process.execArgv }));
  const buckets: Item[][] = workers.map(() => []);
  items
    .map((item, i) => ({ item, i }))
    .forEach(({ item }, i) => buckets[i % workerCount].push(item));
  console.error(`加载 ${items.length} 条序列到 ${workerCount} 个 worker…`);
  await Promise.all(
    workers.map(
      (w, i) =>
        new Promise<void>((resolve, reject) => {
          w.once('message', () => resolve());
          w.once('error', reject);
          w.postMessage({ type: 'load', items: buckets[i] } satisfies WorkerMessage);
        }),
    ),
  );

  let tag = 0;
  const evaluate = async (p: ExtractionParams): Promise<Metrics[]> => {
    const myTag = ++tag;
    const parts = await Promise.all(
      workers.map(
        (w) =>
          new Promise<Metrics[]>((resolve) => {
            const handler = (m: { type: string; tag: number; results: Metrics[] }): void => {
              if (m.type === 'result' && m.tag === myTag) {
                w.off('message', handler);
                resolve(m.results);
              }
            };
            w.on('message', handler);
            w.postMessage({ type: 'eval', params: p, tag: myTag } satisfies WorkerMessage);
          }),
      ),
    );
    return parts.flat();
  };

  const mean = (rows: Metrics[], key: keyof Metrics): number =>
    rows.length ? rows.reduce((a, r) => a + (r[key] as number), 0) / rows.length : NaN;
  const summarize = (rows: Metrics[]): string => {
    const parts: string[] = [];
    for (const split of ['dev', 'test', 'demo']) {
      const sel = rows.filter((r) => r.split === split);
      if (!sel.length) continue;
      parts.push(
        `${split}(${sel.length}) OA ${(mean(sel, 'oa') * 100).toFixed(1)} 音符OA ${(mean(sel, 'notesOa') * 100).toFixed(1)} 音符数/曲 ${((sel.reduce((a, r) => a + r.noteCount, 0) / sel.length) | 0)} RPA ${(mean(sel, 'rpa') * 100).toFixed(1)} VR ${(mean(sel, 'vr') * 100).toFixed(1)} VFA ${(mean(sel, 'vfa') * 100).toFixed(1)}`,
      );
    }
    return parts.join(' | ');
  };
  const noteObjective = argv.includes('--notes-objective');
  const objective = (rows: Metrics[]): number => {
    // 搜索只看 dev；示例歌在 mix 模式下也计入且权重 ×3，保证不变差
    const sel = rows.filter((r) => r.split === 'dev' || r.split === 'demo');
    let sum = 0;
    let weight = 0;
    for (const r of sel) {
      const w = r.split === 'demo' ? 3 : 1;
      sum += w * (noteObjective ? r.notesOa : r.oa);
      weight += w;
    }
    return weight ? sum / weight : NaN;
  };

  let rows = await evaluate(params);
  console.log('起点', summarize(rows));

  if (argv.includes('--search')) {
    const grid: Record<string, number[]> = noteObjective
      ? {
          noteSmoothRadius: [3, 5, 7, 9, 12],
          noteSplitWindow: [3, 4, 5, 6, 8],
          noteSplitSemitones: [0.3, 0.4, 0.5, 0.6, 0.8, 1],
          minNoteSeconds: [0.04, 0.06, 0.08, 0.1, 0.12],
        }
      : {
      logitBias: [-1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5],
      switchCost: [0.2, 0.4, 0.6, 0.8, 1.0, 1.4, 2, 3],
      candidateWeight: [0, 0.5, 1, 2, 3, 4],
      jumpScale: [0.25, 0.5, 1, 1.5, 2.5, 4],
      minVoicedRun: [1, 2, 3, 4, 6],
      maxGapFill: [0, 2, 4, 6, 8],
    };
    let best = objective(rows);
    for (let round = 0; round < 2; round++) {
      for (const key of Object.keys(grid)) {
        for (const value of grid[key]) {
          const candidate = { ...params, [key]: value } as ExtractionParams;
          const r = await evaluate(candidate);
          const o = objective(r);
          if (o > best + 1e-5) {
            best = o;
            params = candidate;
            rows = r;
            console.log(`  ${key}=${value}  → dev/demo OA ${(o * 100).toFixed(2)}`);
          }
        }
      }
    }
    console.log('搜索结果', summarize(rows));
  }

  if (argv.includes('--grid-notes')) {
    // 音符切分的笛卡尔积：看音符 OA 与音符数的取舍（音符数不能无限制地涨，否则就是逐帧了）
    console.log('smoothR window split minSec | dev音符OA test音符OA 音符数/曲(dev)');
    for (const noteSmoothRadius of [5, 7, 9, 12])
      for (const noteSplitWindow of [4, 5, 6])
        for (const noteSplitSemitones of [0.4, 0.5, 0.6, 0.8])
          for (const minNoteSeconds of [0.06, 0.08, 0.1]) {
            const r = await evaluate({ ...params, noteSmoothRadius, noteSplitWindow, noteSplitSemitones, minNoteSeconds });
            const dev = r.filter((x) => x.split === 'dev');
            const test = r.filter((x) => x.split === 'test');
            console.log(
              `${noteSmoothRadius} ${noteSplitWindow} ${noteSplitSemitones} ${minNoteSeconds} | ${(mean(dev, 'notesOa') * 100).toFixed(2)} ${(mean(test, 'notesOa') * 100).toFixed(2)} ${(dev.reduce((a, x) => a + x.noteCount, 0) / dev.length) | 0}`,
            );
          }
  }

  console.log('参数', JSON.stringify({ ...params, voicing: undefined }));
  console.log('逐曲:');
  for (const r of rows.sort((a, b) => a.split.localeCompare(b.split) || a.id.localeCompare(b.id))) {
    console.log(
      `  ${r.split.padEnd(5)} ${r.id.padEnd(30)} OA ${(r.oa * 100).toFixed(1)} 音符OA ${(r.notesOa * 100).toFixed(1)} 音符数 ${r.noteCount} RPA ${(r.rpa * 100).toFixed(1)} VR ${(r.vr * 100).toFixed(1)} VFA ${(r.vfa * 100).toFixed(1)}`,
    );
  }
  const out = opt('save');
  if (out) writeFileSync(out, JSON.stringify(params, null, 2));
  for (const w of workers) w.postMessage({ type: 'exit' } satisfies WorkerMessage);
}
