import type { SubtitleCue } from '../models/subtitle';
import type { AsrModelId } from './models';

/**
 * 转写引擎 worker 的消息协议。
 * 引擎跑在专用 Web Worker 里（importScripts 加载 Emscripten 胶水），
 * 面板侧 manager 与该 worker 通过 postMessage 通信；
 * 音频样本走 transferable ArrayBuffer，零拷贝。
 */

/** 面板 → worker：初始化（加载 wasm 运行时 + 写入模型文件 + 建识别器） */
export interface EngineInitMsg {
  type: 'init';
  modelId: AsrModelId;
  /** wasm 运行时资源 URL（面板侧 getURL 算好传入；worker 内无扩展 API） */
  wasmUrls: { mainJs: string; mainWasm: string; glueJs: string };
  /** 模型文件内容：MEMFS 路径 → 字节。ArrayBuffer 以 transferable 传入 */
  files: Record<string, ArrayBuffer>;
}

/** 面板 → worker：一批 16kHz 单声道 PCM（Float32， transferable） */
export interface EngineAudioMsg {
  type: 'audio';
  samples: Float32Array;
}

/** 面板 → worker：音频结束，冲刷残余缓冲出最后一句 */
export interface EngineFlushMsg {
  type: 'flush';
}

/**
 * 面板 → worker：立即强制切句（拖动进度条/暂停/跳过已转写区间等音频断点）。
 * 把当前未达端点的残句立即出句并重置流，避免断点两侧的音频混进同一句。
 */
export interface EngineCutMsg {
  type: 'cut';
}

export type EngineRequest = EngineInitMsg | EngineAudioMsg | EngineFlushMsg | EngineCutMsg;

/** worker → 面板 */
export type EngineEvent =
  /** 初始化完成，可以开始喂音频 */
  | { type: 'ready' }
  /** 一句定稿（时间轴已按喂入样本数换算为秒） */
  | { type: 'segment'; cue: SubtitleCue }
  /** 流式模型的中间结果（未定稿，灰字展示） */
  | { type: 'partial'; text: string }
  /** 已累计处理的音频秒数（转写进度分子） */
  | { type: 'processed'; seconds: number }
  /** flush 完成信号：所有积压音频已处理完、末句已出。快进喂入时音频块的 processed 事件会先于它到达，收尾必须等它 */
  | { type: 'flushed' }
  | { type: 'error'; message: string };
