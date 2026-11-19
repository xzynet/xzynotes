// 与 engine.worker.ts 同理：不引用 webworker lib，避免全局类型污染。
import * as ort from 'onnxruntime-web/wasm';
// vite 构建期把 ort 的 wasm 二进制与 emscripten 胶水 mjs 发为带 hash 的静态资源，
// ?url 取回运行时 URL（比 public/ 目录直出省一份重复拷贝）。
// 注意：ort 的 wasm 后端即使 proxy=false 也要在运行时动态 import 胶水 mjs，
// 两个文件都必须显式给出（wasmPaths 对象形式），否则报 "Failed to fetch
// dynamically imported module: .../ort-wasm-simd-threaded.mjs"。
import ortWasmAssetUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortGlueAssetUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { punctuateText } from '~/core/asr';

/**
 * CT-Transformer 标点恢复 worker（onnxruntime-web WASM 后端，单线程）。
 *
 * 为什么不用 sherpa-onnx 运行时：vendored 的 sherpa WASM 构建未编入标点 API，
 * sherpa 官方也没有标点模型的 WASM 示例构建；ort-web 是同一套 ONNX Runtime
 * 内核的通用 JS 绑定，可直接跑任意 ONNX。
 *
 * 协议：
 *  → { type:'init', model, tokens }   model/tokens 为 transferable
 *  → { type:'punct', seq, text }
 *  ← { type:'ready' } | { type:'punct', seq, text } | { type:'error', fatal, message }
 * 推理经队列串行化，结果按提交顺序返回（seq 供调用方对位）。
 */

export interface PunctInitMsg {
  type: 'init';
  /** model.onnx 字节 */
  model: ArrayBuffer;
  /** tokens.json 字节（JSON 数组，下标即 token id） */
  tokens: ArrayBuffer;
}

export interface PunctRunMsg {
  type: 'punct';
  seq: number;
  text: string;
}

export type PunctRequest = PunctInitMsg | PunctRunMsg;

export type PunctEvent =
  | { type: 'ready' }
  | { type: 'punct'; seq: number; text: string }
  | { type: 'error'; fatal: boolean; message: string };

const scope = self as unknown as {
  postMessage(message: PunctEvent, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<PunctRequest>) => void) | null;
};

let session: ort.InferenceSession | null = null;
let token2id: Map<string, number> | null = null;
let unkId = 0;

/** 推理请求串行队列：ORT session 单线程执行，避免并发 run 交错 */
let queue: Promise<unknown> = Promise.resolve();

async function infer(ids: number[]): Promise<number[]> {
  const sess = session;
  if (!sess) throw new Error('asrErr.punctNotInitialized');
  const feeds: Record<string, ort.Tensor> = {
    [sess.inputNames[0]!]: new ort.Tensor('int32', Int32Array.from(ids), [1, ids.length]),
    [sess.inputNames[1]!]: new ort.Tensor('int32', new Int32Array([ids.length]), [1]),
  };
  const out = await sess.run(feeds);
  const logits = out[sess.outputNames[0]!]!;
  const data = logits.data as Float32Array;
  const seq = Number(logits.dims[1]);
  const numPunct = Number(logits.dims[2]);
  const preds: number[] = [];
  for (let s = 0; s < seq; s++) {
    let best = 0;
    let bestVal = -Infinity;
    for (let p = 0; p < numPunct; p++) {
      const v = data[s * numPunct + p]!;
      if (v > bestVal) {
        bestVal = v;
        best = p;
      }
    }
    preds.push(best);
  }
  return preds;
}

async function init(msg: PunctInitMsg): Promise<void> {
  // ort 的 wasm 后端两个运行时文件（胶水 mjs + wasm 二进制）都显式指定绝对 URL
  const abs = (u: string) => new URL(u, self.location.origin).href;
  ort.env.wasm.wasmPaths = { mjs: abs(ortGlueAssetUrl), wasm: abs(ortWasmAssetUrl) };
  ort.env.wasm.numThreads = 1;
  // 本服务自身已是专用 worker：关掉 ort 的代理 worker（其 blob: 来源会被扩展 CSP 拦截）
  ort.env.wasm.proxy = false;

  const tokens = JSON.parse(new TextDecoder().decode(msg.tokens)) as string[];
  token2id = new Map(tokens.map((t, i) => [t, i]));
  const unk = token2id.get('<unk>');
  if (unk === undefined) throw new Error('asrErr.punctTokensMissingUnk');
  unkId = unk;

  session = await ort.InferenceSession.create(new Uint8Array(msg.model), {
    executionProviders: ['wasm'],
  });
}

async function run(msg: PunctRunMsg): Promise<void> {
  if (!token2id) throw new Error('asrErr.punctNotInitialized');
  const text = await punctuateText(msg.text, token2id, unkId, infer);
  scope.postMessage({ type: 'punct', seq: msg.seq, text });
}

scope.onmessage = (e: MessageEvent<PunctRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    queue = queue
      .then(() => init(msg))
      .then(() => scope.postMessage({ type: 'ready' }))
      .catch((err: unknown) =>
        scope.postMessage({
          type: 'error',
          fatal: true,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    return;
  }
  queue = queue
    .then(() => run(msg))
    .catch((err: unknown) =>
      scope.postMessage({
        type: 'error',
        fatal: false,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
};
