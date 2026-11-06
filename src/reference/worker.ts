import type { ExtractRequest, WorkerResponse } from './protocol';
import { runExtraction } from './pipeline';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ExtractRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
let busy = false;

scope.onmessage = (event: MessageEvent<ExtractRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'extract' || busy) return;
  busy = true;

  let lastPost = 0;
  let lastStage = '';
  const report = (stage: string, ratio: number): void => {
    const now = performance.now();
    if (stage === lastStage && ratio < 1 && now - lastPost < 80) return;
    lastPost = now;
    lastStage = stage;
    scope.postMessage({ type: 'progress', stage, ratio });
  };

  try {
    const melody = runExtraction(
      {
        sampleRate: request.sampleRate,
        duration: request.duration,
        channels: request.channels,
        cleanVocals: request.cleanVocals,
      },
      report,
    );
    scope.postMessage({ type: 'done', melody });
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy = false;
  }
};
