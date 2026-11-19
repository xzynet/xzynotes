import type { AsrHostCommand, AsrHostSnapshot, AsrHostState, AsrModelId } from '~/core/asr';
import { send } from '../rpc';

/**
 * 面板侧的转写宿主客户端。
 *
 * 宿主是 Chrome 的 offscreen document：文件/流式转写在里面跑，关掉侧栏也不中断。
 * 这里只做两件事——下发命令、轮询快照（轮询而非事件推送的原因见 core/asr/host.ts）。
 * 命令统一包成 asr:hostCommand 交给后台拆包中继，避免面板与 SW 各跑一遍。
 * Firefox 没有 offscreen API，`HOSTED_JOBS_SUPPORTED` 为 false，转写退回面板内执行。
 */
export const HOSTED_JOBS_SUPPORTED =
  !import.meta.env.FIREFOX &&
  typeof (globalThis as { chrome?: { offscreen?: unknown } }).chrome?.offscreen !== 'undefined';

/** 经后台中继下发一条宿主命令 */
function command<T>(cmd: AsrHostCommand): Promise<T> {
  return send<T>({ type: 'asr:hostCommand', command: cmd });
}

export interface HostStartParams {
  courseId: string;
  modelId: AsrModelId;
  mode: 'file' | 'stream';
  urls: string[];
  punct: boolean;
}

/** 只准备模型：下载到缓存（断点续传、关面板不中断），完成后再由面板决定怎么转写 */
export function hostPrepare(courseId: string, modelId: AsrModelId): Promise<AsrHostSnapshot> {
  return command<AsrHostSnapshot>({ type: 'asrHost:prepare', courseId, modelId });
}

/** 启动任务；宿主不可用（浏览器不支持/文档创建失败）时抛出 */
export function hostStart(params: HostStartParams): Promise<AsrHostSnapshot> {
  return command<AsrHostSnapshot>({ type: 'asrHost:start', ...params });
}

/** 取消任务；返回取消时的最终快照（含已产出的句子，供面板决定是否落盘） */
export function hostCancel(): Promise<AsrHostSnapshot> {
  return command<AsrHostSnapshot>({ type: 'asrHost:cancel' });
}

/** 轮询快照：sinceCue 之后的新句 + 标点回填（宿主读取后清空回填） */
export function hostStatus(sinceCue: number): Promise<AsrHostSnapshot> {
  return command<AsrHostSnapshot>({ type: 'asrHost:status', sinceCue });
}

/** 改写宿主内某句文本（转写中的行内编辑） */
export function hostEdit(index: number, text: string): Promise<AsrHostSnapshot> {
  return command<AsrHostSnapshot>({ type: 'asrHost:edit', index, text });
}

/** 收起已结束的任务状态（面板重新开始时调用） */
export function hostClear(): Promise<AsrHostSnapshot> {
  return command<AsrHostSnapshot>({ type: 'asrHost:clear' });
}

/**
 * 本课程是否有宿主任务在跑（或刚失败待查看）。
 *
 * 面板重新打开时用它来决定展示哪个视图：转写任务在后台跑着，但结果还没落盘，
 * 此时若先看本地转写缓存，就会把「上一轮已完成的字幕」当成当前状态展示出来。
 * 只读状态查询，不消费句子与标点回填，不会干扰转写卡片的轮询。
 */
export async function hostJobActive(courseId: string): Promise<boolean> {
  if (!HOSTED_JOBS_SUPPORTED) return false;
  const state = await command<AsrHostState>({ type: 'asrHost:state' }).catch(() => null);
  if (!state || state.courseId !== courseId) return false;
  return state.running || state.phase === 'error';
}
