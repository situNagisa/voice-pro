/**
 * 真实歌曲评测：混音 → [分离] → 旋律提取 → 与干声 pyin 参考对比（mir_eval）。
 *
 * 用法（在仓库根目录）：
 *   scripts/eval/node_modules/.bin/tsx scripts/eval/eval.ts [选项]
 *
 *   --run <名字>        结果目录名，默认 latest（写到 ~/voice-pro-eval-data/results/<名字>）
 *   --songs a,b         只跑指定歌曲 id，默认 songs.json 里全部已 prepare 的歌曲
 *   --variants x,y      separated（分离+提取，即 App 的真实路径）/ direct（不分离直接提取）/
 *                       oracle（用干声 stem 直接提取，作为提取算法上限）。默认 separated,direct,oracle
 *   --reseparate        忽略分离缓存，重新跑模型
 *   --overlap <秒>      分段重叠秒数（实验用），默认用 chunking.ts 的默认值；缓存按该值区分
 *   --pipeline <模块>   提取实现，默认 ../../src/reference/pipeline；对比旧版本时可用 `git show 746c455:src/reference/pipeline.ts` 导出到本目录再指定
 *   --jobs <n>          提取阶段并行线程数，默认 CPU 核数的一半
 *   --notes             表格里附带“音符序列”指标
 *   --diag              附带错误分解（漏检/高低八度/其他错音/误报）
 *
 * 复用 src/separation（stft.ts、chunking.ts）和 src/reference/pipeline.ts 的真实代码，
 * 推理引擎换成 onnxruntime-node。分离结果按源码哈希缓存，改 src/reference 不会触发重新分离。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { HOP_SECONDS } from '../../src/reference/protocol';
import { readWav, writeWav } from './wav';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATA = process.env.EVAL_DATA ?? path.join(homedir(), 'voice-pro-eval-data');
const MODEL = path.join(ROOT, 'public/models/kuielab_a_vocals.onnx');

type Variant = 'separated' | 'direct' | 'oracle';

interface ExtractJob {
  /** 提取实现的模块路径（相对 eval.ts），默认 src/reference/pipeline，调优前后对比时可指向旧版本 */
  pipeline: string;
  song: string;
  variant: Variant;
  input: string;
  cleanVocals: boolean;
  outDir: string;
}

interface SongEntry {
  id: string;
  /** 合成示例歌：App 会跳过分离，直接对混音提取 */
  skipSeparation?: boolean;
}

async function extractOne(job: ExtractJob): Promise<{ song: string; variant: Variant; seconds: number }> {
  const started = performance.now();
  const { runExtraction } = (await import(job.pipeline)) as typeof import('../../src/reference/pipeline');
  const wav = readWav(job.input);
  const duration = wav.channels[0].length / wav.sampleRate;
  const melody = runExtraction(
    {
      sampleRate: wav.sampleRate,
      duration,
      channels: wav.channels,
      cleanVocals: job.cleanVocals,
    },
    () => {},
  );

  mkdirSync(job.outDir, { recursive: true });
  const frameLines: string[] = [];
  for (let i = 0; i < melody.frames.length; i++) {
    const f0 = melody.frames[i].f0;
    frameLines.push(`${(i * HOP_SECONDS).toFixed(3)},${f0 ? f0.toFixed(3) : '0.000'}`);
  }
  writeFileSync(path.join(job.outDir, `${job.variant}.csv`), frameLines.join('\n') + '\n');

  // 音符序列：App 里谱面和打分用的是 notes，这里按 10 ms 栅格渲染后用同样的指标评估
  const noteLines: string[] = [];
  let cursor = 0;
  for (let i = 0; i < melody.frames.length; i++) {
    const t = i * HOP_SECONDS;
    while (cursor < melody.notes.length && melody.notes[cursor].end <= t) cursor++;
    const note = melody.notes[cursor];
    const hz = note && note.start <= t ? 440 * 2 ** ((note.midi - 69) / 12) : 0;
    noteLines.push(`${t.toFixed(3)},${hz.toFixed(3)}`);
  }
  writeFileSync(path.join(job.outDir, `${job.variant}.notes.csv`), noteLines.join('\n') + '\n');

  return { song: job.song, variant: job.variant, seconds: (performance.now() - started) / 1000 };
}

if (!isMainThread) {
  parentPort!.on('message', async (job: ExtractJob | 'exit') => {
    if (job === 'exit') {
      process.exit(0);
    }
    parentPort!.postMessage(await extractOne(job));
  });
} else {
  await main();
}

function parseArgs(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function sourceHash(overlap: number | undefined): string {
  const hash = createHash('sha1');
  hash.update(`overlap=${overlap ?? 'default'}`);
  for (const file of [
    'src/separation/chunking.ts',
    'src/separation/stft.ts',
    'src/reference/dsp.ts',
  ]) {
    hash.update(readFileSync(path.join(ROOT, file)));
  }
  hash.update(readFileSync(MODEL).subarray(0, 4096));
  return hash.digest('hex').slice(0, 10);
}

async function separateSongs(
  songs: SongEntry[],
  reseparate: boolean,
  overlapSeconds: number | undefined,
): Promise<Map<string, string>> {
  const tag = sourceHash(overlapSeconds);
  const result = new Map<string, string>();
  const pending = songs.filter((song) => {
    const target = path.join(DATA, 'cache', song.id, `vocals-${tag}.wav`);
    result.set(song.id, target);
    return reseparate || !existsSync(target);
  });
  if (pending.length === 0) return result;

  const ort = await import('onnxruntime-node');
  const { separateChunked, chunkTensorShape } = await import('../../src/separation/chunking');
  const session = await ort.InferenceSession.create(MODEL, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  for (const song of pending) {
    const started = performance.now();
    const mix = readWav(path.join(DATA, 'prepared', song.id, 'mix.wav'));
    if (mix.sampleRate !== 44100) throw new Error(`${song.id} 不是 44.1 kHz`);
    const channels = mix.channels.length === 1 ? [mix.channels[0], mix.channels[0]] : mix.channels;
    let lastLog = 0;
    const vocals = await separateChunked(
      channels,
      async (input) => {
        const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {};
        feeds[inputName] = new ort.Tensor('float32', input, chunkTensorShape());
        const output = await session.run(feeds);
        return output[outputName].data as Float32Array;
      },
      (stage, ratio) => {
        if (performance.now() - lastLog > 10000) {
          lastLog = performance.now();
          console.error(`  [${song.id}] ${stage} ${(ratio * 100).toFixed(0)}%`);
        }
      },
      { overlapSeconds },
    );
    const target = result.get(song.id)!;
    mkdirSync(path.dirname(target), { recursive: true });
    writeWav(target, { sampleRate: 44100, channels: vocals });
    console.error(`分离 ${song.id} 完成，用时 ${((performance.now() - started) / 1000).toFixed(0)} s`);
  }
  return result;
}

async function runPool(jobs: ExtractJob[], size: number): Promise<void> {
  const file = fileURLToPath(import.meta.url);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, () => {
      const worker = new Worker(file, { execArgv: process.execArgv });
      return new Promise<void>((resolve, reject) => {
        const feed = (): void => {
          if (next >= jobs.length) {
            worker.postMessage('exit');
            return;
          }
          worker.postMessage(jobs[next++]);
        };
        worker.on('message', (m: { song: string; variant: string; seconds: number }) => {
          done++;
          console.error(`  提取 ${m.song} / ${m.variant}  ${m.seconds.toFixed(1)} s  (${done}/${jobs.length})`);
          feed();
        });
        worker.on('error', reject);
        worker.on('exit', () => resolve());
        feed();
      });
    }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const run = typeof args.run === 'string' ? args.run : 'latest';
  const variants = (typeof args.variants === 'string' ? args.variants : 'separated,direct,oracle').split(
    ',',
  ) as Variant[];
  const pipeline = typeof args.pipeline === 'string' ? args.pipeline : '../../src/reference/pipeline';
  const jobsCount = typeof args.jobs === 'string' ? Number(args.jobs) : Math.max(1, cpus().length >> 1);

  const manifest = JSON.parse(readFileSync(path.join(HERE, 'songs.json'), 'utf8')) as {
    songs: SongEntry[];
  };
  const wanted = typeof args.songs === 'string' ? new Set(args.songs.split(',')) : null;
  const songs = manifest.songs.filter(
    (s) => (!wanted || wanted.has(s.id)) && existsSync(path.join(DATA, 'prepared', s.id, 'ref.csv')),
  );
  if (songs.length === 0) throw new Error('没有可评测的歌曲：先运行 prepare.py');

  const resultsDir = path.join(DATA, 'results', run);
  mkdirSync(resultsDir, { recursive: true });

  const needSeparation = variants.includes('separated')
    ? songs.filter((s) => !s.skipSeparation)
    : [];
  const overlap = typeof args.overlap === 'string' ? Number(args.overlap) : undefined;
  const separated = await separateSongs(needSeparation, args.reseparate === true, overlap);

  const jobs: ExtractJob[] = [];
  for (const song of songs) {
    const prepared = path.join(DATA, 'prepared', song.id);
    const outDir = path.join(resultsDir, song.id);
    for (const variant of variants) {
      if (song.skipSeparation) {
        // App 对合成示例歌跳过分离，只有直接提取这条路径
        if (variant === 'direct') {
          jobs.push({ pipeline, song: song.id, variant, input: path.join(prepared, 'mix.wav'), cleanVocals: false, outDir });
        }
        continue;
      }
      if (variant === 'separated') {
        jobs.push({ pipeline, song: song.id, variant, input: separated.get(song.id)!, cleanVocals: true, outDir });
      } else if (variant === 'direct') {
        jobs.push({ pipeline, song: song.id, variant, input: path.join(prepared, 'mix.wav'), cleanVocals: false, outDir });
      } else if (variant === 'oracle') {
        jobs.push({ pipeline, song: song.id, variant, input: path.join(prepared, 'vocals.wav'), cleanVocals: true, outDir });
      }
    }
  }
  await runPool(jobs, jobsCount);

  const python = path.join(homedir(), 'voice-pro-eval-venv/bin/python');
  const scoreArgs = [path.join(HERE, 'score.py'), resultsDir];
  if (args.notes) scoreArgs.push('--notes');
  if (args.diag) scoreArgs.push('--diag');
  const scored = spawnSync(python, scoreArgs, { stdio: 'inherit' });
  if (scored.status !== 0) process.exit(scored.status ?? 1);
}
