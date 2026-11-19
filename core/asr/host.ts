import type { SubtitleCue } from '../models/subtitle';
import type { AsrModelId } from './models';

/**
 * 转写任务宿主（offscreen document）协议。
 *
 * 为什么要宿主：文件/流式转写要从「下载 → 解码 → 引擎」跑几分钟到几十分钟，
 * 任务跑在侧栏文档里时，关掉侧栏就等于把任务销毁（文档没了，worker/媒体流一并消失）。
 * Chrome 的 offscreen document 不吃 SW 与侧栏的生命周期，任务搬过去就能「关面板继续转写」，
 * 面板退化成它的一个视图；Firefox 没有 offscreen API，退回面板内执行（逻辑不变）。
 *
 * 为什么用轮询而不是事件推送：面板可能在任何时刻被关掉或重开（事件无人收）、
 * 重开后又要立刻对齐进度。快照天然幂等——句子按 sinceCue 增量取、标点回填走
 * updates（读取即清空），轮询成本与已转写句数无关。
 */

/**
 * 任务类型：
 *  - prepare：只把模型下载到缓存（可断点续传；关面板不中断）
 *  - file/stream：下载/解码媒体并跑引擎转写
 */
export type AsrJobMode = 'prepare' | 'file' | 'stream';

/** 宿主任务阶段（idle=无任务；loading=下载/装引擎；transcribing=出句；done/error=终态） */
export type AsrJobPhase = 'idle' | 'loading' | 'transcribing' | 'error' | 'done';

/** 任务状态快照（面板据此渲染，字段与 AsrCard 的视图状态一一对应） */
export interface AsrHostState {
  /** 任务归属课程；null = 从未启动过任务 */
  courseId: string | null;
  mode: AsrJobMode;
  modelId: AsrModelId;
  phase: AsrJobPhase;
  /** 媒体准备子阶段；null = 已进入引擎阶段 */
  mediaStage: 'downloading' | 'decoding' | null;
  /** 模型下载进度（mode='prepare' 期间有意义） */
  modelLoaded: number;
  modelTotal: number;
  /** 正在下载的模型文件名 */
  modelFile: string;
  mediaLoaded: number;
  /** 0 = 未知（响应无 Content-Length） */
  mediaTotal: number;
  /** 当前下载来源主机名（诊断用） */
  mediaHost: string;
  mediaBytesPerSec: number;
  /** 媒体总时长（秒；未知为 0） */
  durationSec: number;
  processedSec: number;
  /** 未定稿的中间文本 */
  partial: string;
  cueCount: number;
  /** 失败原因（文案 key 或原文，面板侧 localizeError 翻译） */
  error: string | null;
  running: boolean;
}

export interface AsrHostSnapshot {
  state: AsrHostState;
  /** 自 sinceCue 起的新句（追加顺序，按下标与 updates 对齐） */
  cues: SubtitleCue[];
  /** 标点回填：cue 下标 → 新文本（读取后清空，面板按下标替换） */
  updates: Record<number, string>;
}

/** 面板 → 宿主命令（经后台中继；面板与宿主不直连，避免与 SW 抢答） */
export type AsrHostCommand =
  /** 只准备模型：下载到缓存（可断点续传），完成后面板再决定怎么转写 */
  | { type: 'asrHost:prepare'; courseId: string; modelId: AsrModelId }
  | {
      type: 'asrHost:start';
      courseId: string;
      modelId: AsrModelId;
      mode: 'file' | 'stream';
      /** 候选媒体直链，宿主按顺序尝试 */
      urls: string[];
      /** 是否启用标点恢复（模型已缓存时宿主才会加载） */
      punct: boolean;
    }
  | { type: 'asrHost:cancel' }
  | { type: 'asrHost:status'; sinceCue: number }
  /** 只读任务状态（不取句子、不清标点回填）：面板别处判断「本课程是否有任务」用 */
  | { type: 'asrHost:state' }
  /** 改写宿主内某句文本（转写中的行内编辑；宿主持有的是最终落盘版本） */
  | { type: 'asrHost:edit'; index: number; text: string }
  | { type: 'asrHost:clear' };
