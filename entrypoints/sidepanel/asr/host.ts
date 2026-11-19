import { browser } from 'wxt/browser';
import {
  ASR_MODELS,
  ASR_SAMPLE_RATE,
  type AsrHostCommand,
  type AsrHostSnapshot,
  type AsrHostState,
  type AsrJobMode,
  type AsrModelId,
} from '~/core/asr';
import type { ApiResponse, RequestMessage } from '~/core/messages';
import type { SubtitleCue, Transcript } from '~/core/models';
import {
  createDownloadPartials,
  DownloadCancelledError,
  ensureModelDownloaded,
} from './downloader';
import {
  decodeToMono16k,
  downloadMedia,
  MediaDownloadCancelledError,
  type MediaDownloadProgress,
} from './file-pipeline';
import { createAsrManager, type AsrManager, type AsrManagerEvents } from './manager';
import { hostAuthorizer } from './permission';
import { openStreamingAudio } from './stream-pipeline';

/**
 * 转写任务宿主（offscreen document 侧）。
 *
 * 面板负责「模型缓存检查/下载」与「用户选择模式」，随后把任务交给这里：
 * 宿主自己下载/解码媒体、跑引擎、完成后落盘，全程不依赖侧栏是否开着。
 * 面板通过后台中继下发命令、轮询快照（见 core/asr/host.ts 的协议说明）。
 */

const idleState = (): AsrHostState => ({
  courseId: null,
  mode: 'stream',
  modelId: 'paraformer-streaming',
  phase: 'idle',
  mediaStage: null,
  modelLoaded: 0,
  modelTotal: 0,
  modelFile: '',
  mediaLoaded: 0,
  mediaTotal: 0,
  mediaHost: '',
  mediaBytesPerSec: 0,
  durationSec: 0,
  processedSec: 0,
  partial: '',
  cueCount: 0,
  error: null,
  running: false,
});

/** 注册宿主监听（offscreen 文档启动时调用一次） */
export function createAsrJobHost(): void {
  let state = idleState();
  let cues: SubtitleCue[] = [];
  /** 标点回填：cue 下标 → 文本（面板每次读取后清空） */
  const updates = new Map<number, string>();
  /** 模型下载的断点续传缓冲：宿主存活期间一直保留，换源/重试都能接着下 */
  const partials = createDownloadPartials();
  let manager: AsrManager | null = null;
  let abort: AbortController | null = null;
  /** 代数：取消/新任务会递增，使在途的旧任务收尾时不写回状态 */
  let generation = 0;

  const applyMediaProgress = (p: MediaDownloadProgress): void => {
    state.mediaLoaded = p.loaded;
    state.mediaTotal = p.total;
    state.mediaHost = p.host;
    state.mediaBytesPerSec = p.bytesPerSec;
  };

  const events: AsrManagerEvents = {
    onPhase: (phase) => {
      if (phase === 'error') return; // 错误统一由 onError 落 message
      // 面板侧只关心 loading/transcribing；idle/done 由任务收尾逻辑显式设置
      if (phase === 'loading' || phase === 'transcribing') state.phase = phase;
      if (phase === 'idle' && state.running) state.phase = 'transcribing';
    },
    onDownloadProgress: () => {},
    onSegment: (cue) => {
      cues.push(cue);
      state.cueCount = cues.length;
    },
    onPartial: (text) => {
      state.partial = text;
    },
    onProcessed: (seconds) => {
      state.processedSec = seconds;
    },
    onAudioLevel: () => {},
    onCaptureDiag: () => {},
    onSegmentPunct: (index, text) => {
      const cue = cues[index];
      if (!cue) return;
      cues[index] = { ...cue, text };
      updates.set(index, text);
    },
    onPunctError: (message) => {
      // 标点失败是非致命降级：面板不在也照常转写
      pushToast(message, 'error');
    },
    onError: (message) => {
      state.error = message;
      state.phase = 'error';
      state.running = false;
      state.mediaStage = null;
    },
  };

  function pushToast(text: string, level: 'info' | 'success' | 'error'): void {
    // 面板未打开时无人接收，静默丢弃（与后台 push 同策略）
    void browser.runtime.sendMessage({ type: 'toast', level, text }).catch(() => {});
  }

  async function saveTranscript(modelId: AsrModelId, durationSec: number): Promise<void> {
    if (cues.length === 0) return;
    const transcript: Transcript = {
      id: state.courseId ?? '',
      courseId: state.courseId ?? '',
      modelId,
      cues: [...cues].sort((a, b) => a.start - b.start),
      durationSec,
      updatedAt: Date.now(),
    };
    await browser.runtime
      .sendMessage({ type: 'transcript:save', transcript } satisfies RequestMessage)
      .catch(() => {});
  }

  /** 打开媒体源：按候选直链顺序尝试；全部失败抛出最后一次错误 */
  async function startMedia(
    mode: AsrJobMode,
    urls: string[],
    signal: AbortSignal,
  ): Promise<() => Promise<SubtitleCue[]>> {
    const mgr = manager!;
    let lastError: unknown = null;
    if (mode === 'file') {
      let blob: Blob | null = null;
      state.mediaStage = 'downloading';
      for (const url of urls) {
        try {
          blob = await downloadMedia(url, {
            signal,
            onProgress: applyMediaProgress,
            authorize: hostAuthorizer,
          });
          break;
        } catch (e) {
          if (e instanceof MediaDownloadCancelledError) throw e;
          lastError = e;
        }
      }
      if (!blob) throw lastError ?? new Error('asr.err.mediaDownloadFailed');
      state.mediaStage = 'decoding';
      const samples = await decodeToMono16k(blob);
      state.mediaStage = null;
      state.durationSec = samples.length / ASR_SAMPLE_RATE;
      return () => mgr.feedBuffer(samples);
    }

    let stream: Awaited<ReturnType<typeof openStreamingAudio>> | null = null;
    for (const url of urls) {
      try {
        stream = await openStreamingAudio(url, {
          signal,
          onProgress: applyMediaProgress,
          authorize: hostAuthorizer,
        });
        break;
      } catch (e) {
        if (e instanceof MediaDownloadCancelledError) throw e;
        lastError = e;
      }
    }
    if (!stream) throw lastError ?? new Error('asr.err.noAudioTrack');
    state.mediaStage = null;
    state.durationSec = stream.durationSec;
    return () => mgr.feedStream(stream!.chunks, stream!.durationSec);
  }

  /**
   * 停掉当前任务（同步让位）：递增代数使在途收尾不再写回状态、释放引擎与媒体。
   * 必须同步完成——runJob 要先切状态再执行，命令回执才能立刻看到新任务。
   */
  function stopJobNow(): void {
    generation++;
    abort?.abort();
    abort = null;
    const previous = manager;
    manager = null;
    state.running = false;
    state.mediaStage = null;
    if (previous) void previous.dispose().catch(() => {});
  }

  /**
   * 任务同步起步：让位旧任务并切到新任务的状态。
   * 必须同步完成——命令回执要立刻看到新任务（见 handle 的 start/prepare 分支）。
   */
  function beginJob(
    courseId: string,
    modelId: AsrModelId,
    mode: AsrJobMode,
  ): { gen: number; ctrl: AbortController } {
    stopJobNow();
    const ctrl = new AbortController();
    abort = ctrl;
    cues = [];
    updates.clear();
    state = { ...idleState(), courseId, modelId, mode, phase: 'loading', running: true };
    return { gen: generation, ctrl };
  }

  /** 任务收尾：代数未变（没被取消/顶替）才写回状态并释放引擎 */
  function endJob(gen: number, mgr: AsrManager | null): void {
    if (gen !== generation) return;
    state.running = false;
    state.mediaStage = null;
    abort = null;
    if (mgr) void mgr.dispose().catch(() => {});
    if (manager === mgr) manager = null;
  }

  /** 只准备模型：下载到缓存（断点续传），不装引擎 */
  async function runPrepare(cmd: Extract<AsrHostCommand, { type: 'asrHost:prepare' }>): Promise<void> {
    const { gen, ctrl } = beginJob(cmd.courseId, cmd.modelId, 'prepare');
    try {
      await ensureModelDownloaded(ASR_MODELS[cmd.modelId], {
        signal: ctrl.signal,
        partials,
        onProgress: (p) => {
          state.modelLoaded = p.loaded;
          state.modelTotal = p.total;
          state.modelFile = p.file;
        },
      });
      if (gen !== generation) return;
      state.modelLoaded = state.modelTotal;
      state.phase = 'done';
    } catch (e) {
      if (gen !== generation) return;
      if (e instanceof DownloadCancelledError) {
        state.phase = 'idle';
      } else {
        state.error = e instanceof Error ? e.message : String(e);
        state.phase = 'error';
      }
    } finally {
      endJob(gen, null);
    }
  }

  /** 下载/解码媒体并跑引擎转写，完成后自己落盘 */
  async function runTranscribe(cmd: Extract<AsrHostCommand, { type: 'asrHost:start' }>): Promise<void> {
    const { gen, ctrl } = beginJob(cmd.courseId, cmd.modelId, cmd.mode);
    const mgr = createAsrManager(events);
    mgr.setPunctuationEnabled(cmd.punct);
    manager = mgr;
    try {
      await mgr.boot();
      if (gen !== generation) return;
      if (state.phase === 'error') return;
      const feed = await startMedia(cmd.mode, cmd.urls, ctrl.signal);
      if (gen !== generation) return;
      await feed();
      if (gen !== generation) return;
      await saveTranscript(cmd.modelId, state.durationSec);
      state.phase = 'done';
      state.partial = '';
      // 面板可能没开着（这正是搬到宿主的意义）：请后台在图标上打完成标记
      void browser.runtime
        .sendMessage({ type: 'asr:jobDone', cueCount: cues.length } satisfies RequestMessage)
        .catch(() => {});
    } catch (e) {
      if (gen !== generation) return; // 已被取消/顶替：状态归新任务所有
      if (e instanceof MediaDownloadCancelledError) {
        state.phase = 'idle';
      } else {
        state.error = e instanceof Error ? e.message : String(e);
        state.phase = 'error';
      }
    } finally {
      endJob(gen, mgr);
    }
  }

  function snapshot(sinceCue: number): AsrHostSnapshot {
    const since = Math.max(0, Math.min(sinceCue, cues.length));
    const payload: AsrHostSnapshot = {
      state: { ...state },
      cues: cues.slice(since),
      updates: Object.fromEntries(updates),
    };
    updates.clear();
    return payload;
  }

  async function handle(cmd: AsrHostCommand): Promise<ApiResponse<unknown>> {
    switch (cmd.type) {
      case 'asrHost:prepare':
        // 不 await 整个任务：先回执，下载在后台继续（面板靠轮询跟进）
        void runPrepare(cmd);
        return { ok: true, data: snapshot(0) };
      case 'asrHost:start':
        // 同上：beginJob 的同步段已把状态切成新任务，故回执即为新任务的初始快照
        void runTranscribe(cmd);
        return { ok: true, data: snapshot(0) };
      case 'asrHost:cancel':
        // 引擎里已出的句子都经 onSegment 落进 cues，同步让位后直接回快照
        stopJobNow();
        state.phase = 'idle';
        state.partial = '';
        return { ok: true, data: snapshot(0) };
      case 'asrHost:status':
        return { ok: true, data: snapshot(cmd.sinceCue) };
      case 'asrHost:state':
        // 只读：不返回句子、不清标点回填，避免和卡片轮询互相抢消费
        return { ok: true, data: { ...state } };
      case 'asrHost:edit':
        // 行内编辑落在宿主：面板关闭/重开后最终落盘的仍是编辑后版本
        manager?.editCue(cmd.index, cmd.text);
        if (cues[cmd.index]) cues[cmd.index] = { ...cues[cmd.index]!, text: cmd.text.trim() };
        return { ok: true, data: snapshot(cues.length) };
      case 'asrHost:clear':
        // 运行中的任务不清理（面板重新点「开始转写」时会调到这里）
        if (state.running) return { ok: true, data: snapshot(0) };
        state = idleState();
        cues = [];
        updates.clear();
        return { ok: true, data: snapshot(0) };
      default:
        return { ok: false, error: 'bg.err.unknownMessage' };
    }
  }

  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as AsrHostCommand | null;
    // 只认自己的命令：其余消息（后台路由的请求、其他页面的广播）一律不回应，避免抢答
    if (!msg || typeof msg !== 'object' || !String(msg.type).startsWith('asrHost:')) return;
    handle(msg as AsrHostCommand)
      .then(sendResponse)
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}
