/**
 * 本地语音转写模型注册表（纯数据 + 纯函数，core 纯净约束：不得出现浏览器 API）。
 *
 * 模型文件托管于 HuggingFace（csukuangfj 官方仓库），首次使用时按需下载；
 * 浏览器直接 fetch 依赖对方 CORS（HF 全站 ACAO 反射，hf-mirror 同样反射 Origin），
 * 下载失败时按 MODEL_BASE_URLS 顺序回退镜像。
 */

import type { MessageKey } from '~/core/i18n';

export type AsrModelId = 'paraformer-streaming' | 'sensevoice';

/** 对应 public/wasm/sherpa/ 下的运行时目录：online=流式 API，offline=离线 API */
export type AsrRuntimeSlot = 'online' | 'offline';

export interface AsrModelFile {
  /** 模型仓库内的相对路径（也作为 MEMFS 写入名与缓存键的一部分） */
  path: string;
  /** 预期字节数：用于下载总量预估与缓存完整性校验 */
  bytes: number;
}

/** 可下载模型的最小描述（ASR 模型与标点恢复模型共用下载器/缓存） */
export interface DownloadableModel {
  id: string;
  hfRepo: string;
  files: AsrModelFile[];
  totalBytes: number;
}

export interface AsrModelSpec extends DownloadableModel {
  id: AsrModelId;
  label: MessageKey;
  /** 一句话特点说明，展示在选择卡片上 */
  description: MessageKey;
  streaming: boolean;
  runtime: AsrRuntimeSlot;
  /**
   * 运行时是否依赖 SharedArrayBuffer（sherpa-onnx 的 pthread 构建）。
   * 依赖 SAB 的模型要求扩展页跨源隔离，而 COOP/COEP 只能写进 Chrome 的 manifest，
   * Firefox 扩展页拿不到 SAB —— 入口层据此把这类模型从选择列表剔除（见 sidepanel/asr/capabilities.ts）。
   */
  needsSharedArrayBuffer: boolean;
}

const sum = (files: AsrModelFile[]) => files.reduce((acc, f) => acc + f.bytes, 0);

const PARAFORMER_FILES: AsrModelFile[] = [
  { path: 'encoder.int8.onnx', bytes: 165_462_184 },
  { path: 'decoder.int8.onnx', bytes: 71_664_561 },
  { path: 'tokens.txt', bytes: 75_756 },
];

const SENSEVOICE_FILES: AsrModelFile[] = [
  { path: 'model.int8.onnx', bytes: 239_233_841 },
  { path: 'tokens.txt', bytes: 315_894 },
];

export const ASR_MODELS: Record<AsrModelId, AsrModelSpec> = {
  'paraformer-streaming': {
    id: 'paraformer-streaming',
    label: 'model.paraformer.label',
    description: 'model.paraformer.description',
    streaming: true,
    runtime: 'online',
    // online 运行时为单线程构建，不依赖 SharedArrayBuffer
    needsSharedArrayBuffer: false,
    hfRepo: 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    files: PARAFORMER_FILES,
    totalBytes: sum(PARAFORMER_FILES),
  },
  sensevoice: {
    id: 'sensevoice',
    label: 'model.sensevoice.label',
    description: 'model.sensevoice.description',
    streaming: false,
    runtime: 'offline',
    // offline 运行时为 pthread 构建（4 线程池），需要 SharedArrayBuffer → 扩展页跨源隔离
    needsSharedArrayBuffer: true,
    hfRepo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: SENSEVOICE_FILES,
    totalBytes: sum(SENSEVOICE_FILES),
  },
};

/** 下载源，按优先级顺序；huggingface.co 不可达时回退 hf-mirror.com */
export const MODEL_BASE_URLS = ['https://huggingface.co', 'https://hf-mirror.com'] as const;

/**
 * CT-Transformer 标点恢复模型（给无标点的流式 Paraformer 结果补标点）。
 * 推理不走 sherpa 运行时：由面板侧 punct.worker 用 onnxruntime-web 直接跑。
 */
export const PUNCT_MODEL: DownloadableModel = {
  id: 'ct-punct',
  hfRepo: 'csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12',
  files: [
    { path: 'model.onnx', bytes: 294_372_519 },
    { path: 'tokens.json', bytes: 4_207_480 },
  ],
  totalBytes: 294_372_519 + 4_207_480,
};

export const PUNCT_MODEL_LABEL: MessageKey = 'model.punct.label';

/** 拼接某个模型文件在某个源下的下载地址 */
export function modelFileUrl(spec: DownloadableModel, file: AsrModelFile, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${spec.hfRepo}/resolve/main/${file.path}`;
}

/** 字节数 → 人类可读（如 "226 MB"） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 缓存完整性校验：已缓存文件集合是否覆盖注册表且字节数吻合 */
export function isModelFileComplete(
  spec: DownloadableModel,
  cached: ReadonlyArray<{ path: string; bytes: number }>,
): boolean {
  const byPath = new Map(cached.map((c) => [c.path, c.bytes]));
  return spec.files.every((f) => byPath.get(f.path) === f.bytes);
}
