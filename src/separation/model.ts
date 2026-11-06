/** 模型下载与解包。单独成文件，避免主线程 bundle 因导入 engine 而带上 onnxruntime-web。 */

export type ModelProgress = (stage: string, ratio: number) => void

export async function fetchModelBuffer(
  url: string,
  report: ModelProgress,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载人声分离模型失败（HTTP ${response.status}）`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) {
    report('加载分离模型', 0.06);
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      if (total > 0) {
        report('加载分离模型', Math.min(0.08, (0.08 * loaded) / total));
      }
    }
  }

  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}
