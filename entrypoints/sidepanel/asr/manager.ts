import { browser } from 'wxt/browser';
import {
  ASR_MODELS,
  ASR_SAMPLE_RATE,
  CoverageTracker,
  PUNCT_MODEL,
  VideoTimeline,
  type AsrModelId,
  type EngineEvent,
  type EngineRequest,
} from '~/core/asr';
import type { PlaybackInfo } from '~/core/messages';
import type { SubtitleCue } from '~/core/models';
import { send } from '../rpc';
import {
  CaptureNeedsActivationError,
  startTabAudioCapture,
  type CaptureDiag,
  type CaptureHandle,
} from './capture';
import { DownloadCancelledError, ensureModelDownloaded, type DownloadProgress } from './downloader';
import { isModelCached, readModelFiles } from './model-store';
import { createPunctService, type PunctService } from './punctuation';

/**
 * 转写编排状态机（框架无关）。三种转写模式：
 *  - 文件模式：prepareModel → boot → feedBuffer（整段 PCM 快进喂入，速度远快于实时）
 *  - 流式模式：prepareModel → boot → feedStream（边下边解边喂，内存占用恒定）
 *  - 实时模式：prepareModel → boot → attachLiveCapture（tabCapture 捕获；未激活时
 *    停在「等待激活」引导，每 2s 自动重试直至用户点工具栏图标）
 * 模型未缓存时两种模式都先停在 need-download，等 confirmDownload 后继续。
 */

export type AsrPhase =
  | 'idle'
  | 'need-download'
  | 'downloading'
  | 'loading'
  | 'transcribing'
  | 'error';

export interface AsrManagerEvents {
  onPhase(phase: AsrPhase): void;
  onDownloadProgress(p: DownloadProgress): void;
  onSegment(cue: SubtitleCue): void;
  /** 流式模型的未定稿中间文本 */
  onPartial(text: string): void;
  /** 已处理的音频秒数（转写进度分子） */
  onProcessed(seconds: number): void;
  /** 实时捕获的输入音量（0..1 RMS），诊断无声捕获用 */
  onAudioLevel(rms: number): void;
  /** 捕获通道诊断（AudioContext 状态/音轨状态/标签页发声与站点静音） */
  onCaptureDiag(d: CaptureDiag): void;
  /** 实时捕获因未激活而等待用户点工具栏图标（true=等待中，自动重试） */
  onWaitingActivation?(waiting: boolean): void;
  /** 标点恢复完成：把第 index 条 cue 的文本替换为带标点版本 */
  onSegmentPunct?(index: number, text: string): void;
  /** 标点模型加载/运行失败（非致命，转写降级为无标点继续） */
  onPunctError?(message: string): void;
  /** 检测到拖动进度条/暂停恢复/变速，时间轴已重对齐（之后的句子按新位置计时） */
  onTimelineRebased?(): void;
  /** 实时模式：当前播放位置落入已转写区间，跳过/恢复喂音（不重复转写） */
  onCoverageSkip?(skipping: boolean): void;
  onError(message: string): void;
}

export interface AsrManager {
  /** 检查模型缓存：已缓存返回 true；未缓存置 need-download 并返回 false */
  prepareModel(modelId: AsrModelId): Promise<boolean>;
  /** 确认下载模型（need-download 阶段），完成回 idle */
  confirmDownload(): Promise<void>;
  cancelDownload(): void;
  /** 加载引擎（读模型 → 起 worker → 建识别器）；成功后停在 loading 尾/待接音频源 */
  boot(): Promise<void>;
  /** 开关标点恢复（boot 前设置；模型未就绪时降级为无标点，不影响转写） */
  setPunctuationEnabled(enabled: boolean): void;
  /** 实时模式：接 tabCapture 捕获，进入 transcribing（未激活则等待激活自动重试） */
  attachLiveCapture(tabId: number): Promise<void>;
  /** 文件模式：快进喂入整段 PCM → 冲刷收尾 → 回传全部 cue 并归位 idle */
  feedBuffer(samples: Float32Array): Promise<SubtitleCue[]>;
  /** 流式模式：边下边解边喂 PCM 块流；流尽后冲刷收尾 → 回传全部 cue 并归位 idle。
   *  块流中途出错（读取停滞/解封装失败）时原样上抛，worker 保留由调用方 reset；
   *  dispose（取消）后直接交还已产出 cue */
  feedStream(chunks: AsyncIterable<Float32Array>, totalSec: number): Promise<SubtitleCue[]>;
  /** 实时模式收尾：停捕获、冲刷引擎、回传定稿 cue 并归位 idle */
  finish(): Promise<SubtitleCue[]>;
  /** 暂停/恢复喂音频（仅实时模式；暂停期间的声音不会出现在转写结果里） */
  setPaused(paused: boolean): void;
  /** 编辑第 index 条 cue 的文本（字幕编辑；finish/dispose 返回的即为编辑后版本） */
  editCue(index: number, text: string): void;
  /** 回到初始态（need-download 取消、error 后重开用） */
  reset(): void;
  /** 硬销毁（组件卸载/课程切换）：立即终止 worker 与捕获 */
  dispose(): Promise<SubtitleCue[]>;
  readonly phase: AsrPhase;
}

export function createAsrManager(events: AsrManagerEvents): AsrManager {
  let phase: AsrPhase = 'idle';
  let modelId: AsrModelId = 'paraformer-streaming';
  let worker: Worker | null = null;
  let capture: CaptureHandle | null = null;
  let downloadAbort: AbortController | null = null;
  let paused = false;
  let disposed = false;
  // attachLiveCapture 的代数：reset/dispose 时递增，使「等待激活」重试循环失效
  let attachSeq = 0;
  // 标点恢复（CT-Transformer）：仅在 UI 开启且模型已缓存时于 boot 后加载
  let punctEnabled = false;
  let punct: PunctService | null = null;
  const cues: SubtitleCue[] = [];
  // 视频时间轴锚定（仅实时模式）：音频时钟 → 视频时钟的分段映射
  let timeline: VideoTimeline | null = null;
  let fedSamples = 0;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  // 已转写覆盖区间（视频时钟）：回拖进已覆盖区时跳过喂音，驶出后自动续转
  const coverage = new CoverageTracker();
  let skipping = false;

  const setPhase = (p: AsrPhase) => {
    if (disposed) return;
    phase = p;
    events.onPhase(p);
  };

  /** 释放运行期资源（worker / 捕获 / 下载 / 标点服务），不改动 phase */
  function releaseRuntime(): void {
    downloadAbort?.abort();
    downloadAbort = null;
    worker?.terminate();
    worker = null;
    punct?.dispose();
    punct = null;
    stopVideoClock();
    if (capture) {
      const c = capture;
      capture = null;
      void c.stop().catch(() => {});
    }
  }

  /** 停掉视频时钟采样并复位（cue 时间换算随之退回音频时钟） */
  function stopVideoClock(): void {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
    timeline = null;
    fedSamples = 0;
    skipping = false;
  }

  /** 引擎 cue 的音频时钟 → 视频时钟（无时间轴时原样返回） */
  function mapCue(cue: SubtitleCue): SubtitleCue {
    const tl = timeline;
    if (!tl) return cue;
    const start = tl.toVideoSec(cue.start);
    // 跨越重对齐边界的句尾钳制在边界处：残句属于拖动前的内容，
    // 句尾不能跳到拖动后的位置
    const boundary = tl.boundaryVideoSec(cue.start, cue.end);
    const end = Math.max(start, Math.min(tl.toVideoSec(cue.end), boundary ?? Infinity));
    return { ...cue, start, end };
  }

  /** 输出统一按视频时间排序：回拖续转的句子按识别顺序追加在尾部，交付前重排 */
  function sortedCues(): SubtitleCue[] {
    return [...cues].sort((a, b) => a.start - b.start);
  }

  /** 音频断点强制切句：残句立即出句，断点后新句从新位置起算 */
  function cutEngine(): void {
    worker?.postMessage({ type: 'cut' } satisfies EngineRequest);
  }

  /**
   * 启动视频时钟锚定（实时模式）：以当前播放位置为基准，每秒采样 currentTime，
   * 检测拖动/暂停恢复/变速后重对齐。拿不到播放信息（无视频元素等）则放弃锚定，
   * cue 时间退回音频时钟（从 0 计时的旧行为）。
   * 采样时把「转写暂停」视作视频暂停：暂停期间的声音不入引擎，恢复时统一重对齐。
   */
  function startVideoClock(tabId: number): void {
    stopVideoClock();
    const tl = new VideoTimeline();
    let prevPaused = false;
    const sample = async (first: boolean) => {
      const info = await send<PlaybackInfo>({ type: 'video:getPlaybackInfo', tabId });
      if (disposed || timeline !== tl) return;
      // 转写暂停/跳过已转写区间时视作视频暂停：对应声音不入引擎，恢复时统一重对齐
      const s = {
        videoSec: info.currentTime,
        paused: info.paused || paused || skipping,
        rate: info.playbackRate || 1,
      };
      if (first) {
        tl.reset(s.videoSec, s.rate);
        prevPaused = s.paused;
        return;
      }
      const reason = tl.update(fedSamples / ASR_SAMPLE_RATE, s);
      if (reason) {
        events.onTimelineRebased?.();
        // 音频断点（拖动/暂停恢复）立即强制切句；变速时音频连续，无需切
        if (reason !== 'rate') cutEngine();
      }
      // 跳过判定先于覆盖推进，且只认「深度落入旧区间」——
      // 否则刚推进的覆盖前沿会被误判成重复内容（正常转写也会反复提示已转写过）
      const nowCovered = coverage.isCoveredForSkip(s.videoSec);
      if (nowCovered !== skipping) {
        skipping = nowCovered;
        events.onCoverageSkip?.(nowCovered);
        // 进入已转写区间：残句按旧时间轴落盘后停喂
        if (nowCovered) cutEngine();
      }
      // 刚进入暂停（视频暂停/转写暂停）：残句立即落盘，句尾停在暂停点
      if (s.paused && !prevPaused) cutEngine();
      prevPaused = s.paused;
      // 覆盖跟踪：喂入中把当前位置并入已转写区间
      if (!s.paused) coverage.extend(s.videoSec);
    };
    void sample(true)
      .then(() => {
        if (disposed || timeline !== tl) return;
        clockTimer = setInterval(() => {
          void sample(false).catch(() => {});
        }, 500);
      })
      .catch(() => {
        if (timeline === tl) timeline = null;
      });
    timeline = tl;
  }

  const fail = (message: string) => {
    releaseRuntime();
    events.onError(message);
    setPhase('error');
  };

  const wasmUrls = (runtime: 'online' | 'offline') => ({
    mainJs: browser.runtime.getURL(
      runtime === 'online'
        ? '/wasm/sherpa/online/sherpa-onnx-wasm-main-asr.js'
        : '/wasm/sherpa/offline/sherpa-onnx-wasm-main-vad-asr.js',
    ),
    mainWasm: browser.runtime.getURL(
      runtime === 'online'
        ? '/wasm/sherpa/online/sherpa-onnx-wasm-main-asr.wasm'
        : '/wasm/sherpa/offline/sherpa-onnx-wasm-main-vad-asr.wasm',
    ),
    glueJs: browser.runtime.getURL(`/wasm/sherpa/${runtime}/sherpa-onnx-asr.js`),
  });

  /** 读模型 → 起 worker → 等 ready → 接事件（不含任何音频源） */
  async function bootEngine(): Promise<void> {
    const spec = ASR_MODELS[modelId];
    const blobs = await readModelFiles(spec.id);
    const files: Record<string, ArrayBuffer> = {};
    const transfer: ArrayBuffer[] = [];
    for (const f of spec.files) {
      const blob = blobs[f.path];
      if (!blob) {
        console.warn(`[kedaibiao] 模型缓存缺少文件：${f.path}`);
        throw new Error('asrErr.modelCacheIncomplete');
      }
      const buf = await blob.arrayBuffer();
      files[f.path] = buf;
      transfer.push(buf);
    }

    const w = new Worker(new URL('./engine.worker.ts', import.meta.url));
    worker = w;

    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const onMessage = (e: MessageEvent<EngineEvent>) => {
        const ev = e.data;
        if (ev.type === 'ready') {
          w.removeEventListener('message', onMessage);
          resolveReady();
        } else if (ev.type === 'error') {
          w.removeEventListener('message', onMessage);
          rejectReady(new Error(ev.message));
        }
      };
      w.addEventListener('message', onMessage);
    });

    const initMsg: EngineRequest = {
      type: 'init',
      modelId: spec.id,
      wasmUrls: wasmUrls(spec.runtime),
      files,
    };
    w.postMessage(initMsg, transfer);
    await ready;

    w.onmessage = (e: MessageEvent<EngineEvent>) => {
      const ev = e.data;
      if (ev.type === 'segment') {
        const cue = mapCue(ev.cue);
        cues.push(cue);
        const index = cues.length - 1;
        events.onSegment(cue);
        // 标点恢复：出句后异步补标点，完成时按索引替换并通知 UI 刷新该行
        const service = punct;
        if (service?.ready && cue.text.trim()) {
          void service
            .punctuate(cue.text)
            .then((text) => {
              if (disposed || !cues[index]) return;
              cues[index] = { ...cues[index]!, text };
              events.onSegmentPunct?.(index, text);
            })
            .catch(() => {});
        }
      } else if (ev.type === 'partial') {
        events.onPartial(ev.text);
      } else if (ev.type === 'processed') {
        events.onProcessed(timeline ? timeline.toVideoSec(ev.seconds) : ev.seconds);
      } else if (ev.type === 'error') {
        // worker 的错误 message 已是文案 key（展示端 localizeError）；非 key 原文透传
        fail(ev.message);
      }
    };
  }

  /**
   * 冲刷引擎并把残余出句收完。
   * 必须等 flush 自己的完成信号（'flushed'），不能等 'processed'——快进喂入时
   * 大量音频块积压在 worker 队列，每块都回 'processed'，误等它会立即返回并
   * terminate，丢掉所有未处理音频（文件模式 0 句的回归源头）。error 时也放行，
   * 避免引擎已失败还干等超时。超时按音频长度放宽：积压解码最坏接近 1x 实时。
   */
  async function flushEngine(timeoutMs = 20_000): Promise<void> {
    const w = worker;
    if (!w || disposed) return;
    const flushed = new Promise<void>((resolveFlush) => {
      const handler = (e: MessageEvent<EngineEvent>) => {
        if (e.data.type === 'flushed' || e.data.type === 'error') {
          w.removeEventListener('message', handler);
          resolveFlush();
        }
      };
      w.addEventListener('message', handler);
      setTimeout(() => {
        w.removeEventListener('message', handler);
        resolveFlush();
      }, timeoutMs);
    });
    w.postMessage({ type: 'flush' } satisfies EngineRequest);
    await flushed;
  }

  return {
    get phase() {
      return phase;
    },

    async prepareModel(id) {
      if (phase === 'error' || phase === 'need-download') {
        releaseRuntime();
        phase = 'idle';
      }
      if (phase !== 'idle') return false;
      modelId = id;
      const cached = await isModelCached(ASR_MODELS[id]).catch(() => false);
      if (!cached) {
        setPhase('need-download');
        return false;
      }
      return true;
    },

    async confirmDownload() {
      if (phase !== 'need-download') return;
      setPhase('downloading');
      downloadAbort = new AbortController();
      try {
        await ensureModelDownloaded(ASR_MODELS[modelId], {
          onProgress: (p) => events.onDownloadProgress(p),
          signal: downloadAbort.signal,
        });
      } catch (e) {
        if (e instanceof DownloadCancelledError) {
          setPhase('need-download');
          return;
        }
        fail(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        downloadAbort = null;
      }
      setPhase('idle');
    },

    cancelDownload() {
      downloadAbort?.abort();
    },

    async boot() {
      if (phase !== 'idle') return;
      setPhase('loading');
      try {
        await bootEngine();
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        return;
      }
      // 标点恢复为增强项：加载失败只提示降级，不阻断转写
      if (punctEnabled && !disposed) {
        try {
          const blobs = await readModelFiles(PUNCT_MODEL.id);
          const modelBlob = blobs['model.onnx'];
          const tokensBlob = blobs['tokens.json'];
          if (!modelBlob || !tokensBlob) throw new Error('asrErr.punctModelCacheIncomplete');
          const service = createPunctService((message) => {
            console.warn(`[kedaibiao] 标点恢复已停用：${message}`);
            events.onPunctError?.('asrErr.punctDisabled');
          });
          await service.init(await modelBlob.arrayBuffer(), await tokensBlob.arrayBuffer());
          punct = service;
        } catch (e) {
          console.warn('[kedaibiao] 标点模型加载失败：', e);
          events.onPunctError?.('asrErr.punctLoadFailed');
        }
      }
    },

    setPunctuationEnabled(enabled) {
      punctEnabled = enabled;
    },

    async attachLiveCapture(tabId) {
      if (!worker) return;
      const seq = ++attachSeq;
      try {
        // 未激活时进入「等待激活」循环：UI 引导用户点工具栏图标，每 2s 自动重试，
        // 激活成功后无需任何操作直接续上；reset/dispose 通过 attachSeq 令循环退出
        for (;;) {
          try {
            let lastLevelAt = 0;
            capture = await startTabAudioCapture(
              tabId,
              (samples) => {
                const now = Date.now();
                if (now - lastLevelAt >= 200) {
                  lastLevelAt = now;
                  let sum = 0;
                  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
                  events.onAudioLevel(Math.sqrt(sum / samples.length));
                }
                if (paused || skipping || !worker) return;
                fedSamples += samples.length;
                worker.postMessage({ type: 'audio', samples } satisfies EngineRequest, [
                  samples.buffer,
                ]);
              },
              (d) => events.onCaptureDiag(d),
            );
            break;
          } catch (e) {
            if (!(e instanceof CaptureNeedsActivationError)) throw e;
            if (disposed || seq !== attachSeq) return;
            events.onWaitingActivation?.(true);
            await new Promise((r) => setTimeout(r, 2000));
            if (disposed || seq !== attachSeq) return;
          }
        }
        events.onWaitingActivation?.(false);
        startVideoClock(tabId);
        setPhase('transcribing');
      } catch (e) {
        events.onWaitingActivation?.(false);
        fail(e instanceof Error ? e.message : String(e));
      }
    },

    async feedBuffer(samples) {
      const w = worker;
      if (!w) return [];
      setPhase('transcribing');
      // 快进喂入：0.5s 一块 transferable 零拷贝；周期性让出事件循环保 UI 响应
      const CHUNK = 8000; // 0.5s @16kHz
      for (let offset = 0; offset < samples.length && !disposed; offset += CHUNK) {
        const chunk = samples.slice(offset, offset + CHUNK);
        w.postMessage({ type: 'audio', samples: chunk } satisfies EngineRequest, [chunk.buffer]);
        if ((offset / CHUNK) % 8 === 7) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      // 积压解码最坏接近 1x 实时，超时随音频长度放宽（短音频维持 20s 默认）
      await flushEngine(Math.max(20_000, (samples.length / ASR_SAMPLE_RATE) * 1000));
      // 收尾前等在途标点推理，保证返回的 cues 是带标点版本
      await punct?.drain().catch(() => {});
      w.terminate();
      worker = null;
      if (phase === 'transcribing') setPhase('idle');
      return sortedCues();
    },

    async feedStream(chunks, totalSec) {
      const w = worker;
      if (!w) return [];
      setPhase('transcribing');
      let streamError: unknown = null;
      try {
        for await (const chunk of chunks) {
          if (disposed) break;
          w.postMessage({ type: 'audio', samples: chunk } satisfies EngineRequest, [
            chunk.buffer,
          ]);
        }
      } catch (e) {
        streamError = e;
      }
      // dispose（取消）后 worker 已终止：直接交还已产出 cue，由 UI 负责保存
      if (disposed) return sortedCues();
      // 流中途失败：保留 worker 现场交调用方处置（reset 后回退其他模式）
      if (streamError) throw streamError;
      // 积压解码最坏接近 1x 实时，超时随音频长度放宽（同 feedBuffer）
      await flushEngine(Math.max(20_000, totalSec * 1000));
      // 收尾前等在途标点推理，保证返回的 cues 是带标点版本
      await punct?.drain().catch(() => {});
      w.terminate();
      worker = null;
      if (phase === 'transcribing') setPhase('idle');
      return sortedCues();
    },

    async finish() {
      if (capture) {
        const c = capture;
        capture = null;
        await c.stop().catch(() => {});
      }
      // 先冲刷再停时钟：末句 cue 仍需经时间轴换算
      await flushEngine();
      stopVideoClock();
      // 收尾前等在途标点推理，保证返回的 cues 是带标点版本
      await punct?.drain().catch(() => {});
      if (worker) {
        worker.terminate();
        worker = null;
      }
      if (phase === 'transcribing') setPhase('idle');
      return sortedCues();
    },

    setPaused(p) {
      paused = p;
      // 暂停转写也是音频断点：残句立即落盘，句尾停在暂停点
      if (p) cutEngine();
    },

    editCue(index, text) {
      const cue = cues[index];
      if (!cue || !text.trim()) return;
      cues[index] = { ...cue, text: text.trim() };
    },

    reset() {
      attachSeq++; // 令进行中的「等待激活」重试循环退出
      events.onWaitingActivation?.(false);
      if (phase === 'downloading') {
        downloadAbort?.abort();
        return; // 取消后 downloader 会把状态带回 need-download
      }
      if (phase === 'need-download' || phase === 'error' || phase === 'idle' || phase === 'loading') {
        releaseRuntime();
        setPhase('idle');
      }
    },

    async dispose() {
      disposed = true;
      attachSeq++;
      releaseRuntime();
      return sortedCues();
    },
  };
}
