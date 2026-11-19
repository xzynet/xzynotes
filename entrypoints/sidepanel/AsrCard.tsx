import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASR_MODELS,
  ASR_SAMPLE_RATE,
  formatBytes,
  PUNCT_MODEL,
  PUNCT_MODEL_LABEL,
  type AsrHostSnapshot,
  type AsrHostState,
  type AsrModelId,
} from '~/core/asr';
import { formatTimestamp } from '~/core/export';
import { localizeError } from '~/core/i18n';
import type { CourseContext, PlaybackInfo } from '~/core/messages';
import type { SubtitleCue, Transcript } from '~/core/models';
import { useT } from '~/components/i18n';
import type { ToastItem, ToastLevel } from '~/components/Toaster';
import { createAsrManager, type AsrManager, type AsrPhase } from './asr/manager';
import { LIVE_CAPTURE_SUPPORTED, SUPPORTED_ASR_MODELS } from './asr/capabilities';
import type { CaptureDiag } from './asr/capture';
import {
  createDownloadPartials,
  DownloadCancelledError,
  ensureModelDownloaded,
  type DownloadPartials,
  type DownloadProgress,
} from './asr/downloader';
import {
  decodeToMono16k,
  downloadMedia,
  isDownloadableMediaUrl,
  MediaDownloadCancelledError,
  type MediaDownloadProgress,
} from './asr/file-pipeline';
import {
  HOSTED_JOBS_SUPPORTED,
  hostCancel,
  hostClear,
  hostEdit,
  hostPrepare,
  hostStart,
  hostStatus,
} from './asr/host-client';
import { isModelCached } from './asr/model-store';
import { requestOrigins } from './asr/permission';
import { openStreamingAudio } from './asr/stream-pipeline';
import { send } from './rpc';

/** 媒体文件阶段（模型就绪后、引擎加载前） */
type MediaStage = 'resolving' | 'downloading' | 'decoding';
type TranscribeMode = 'file' | 'live' | 'stream';

/** 宿主任务轮询节奏：本课程转写中 600ms、别的课程 2s、空闲 5s */
const HOST_POLL_ATTACHED_MS = 600;
const HOST_POLL_OTHER_MS = 2000;
const HOST_POLL_IDLE_MS = 5000;

/**
 * 本地语音转写卡片：无字幕视频的兜底字幕来源。
 * 拿到视频直链时由用户选择：「流式转写」边下边解码边喂引擎（内存占用恒定），
 * 或「文件模式」整段下载到内存后快进转写；拿不到直链时回退「实时模式」：
 * 捕获标签页音频跟随播放转写。
 * 完成后的 cue 通过 onFinished 交给 SubtitlesPanel 复用字幕视图。
 */
export function AsrCard({
  ctx,
  pushToast,
  onFinished,
  onBusyChange,
}: {
  ctx: CourseContext;
  pushToast: (text: string, level?: ToastLevel, action?: ToastItem['action']) => void;
  onFinished: (cues: SubtitleCue[]) => void;
  /** 转写任务起停上报：local=面板内任务（切页重挂会终止，面板需冻结跟随），host=宿主任务 */
  onBusyChange?: (state: { local: boolean; host: boolean }) => void;
}) {
  const { t } = useT();
  const [phase, setPhase] = useState<AsrPhase>('idle');
  const [cached, setCached] = useState<Partial<Record<AsrModelId, boolean>>>({});
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [mediaStage, setMediaStage] = useState<MediaStage | null>(null);
  const [mediaProgress, setMediaProgress] = useState<MediaDownloadProgress | null>(null);
  const [mode, setMode] = useState<TranscribeMode | null>(null);
  /** 解析到直链后等待用户确认：下载源文件快进转写，还是改用实时转写 */
  const [pendingFile, setPendingFile] = useState<{ modelId: AsrModelId; urls: string[] } | null>(
    null,
  );
  const [fileDurationSec, setFileDurationSec] = useState(0);
  const [processedSec, setProcessedSec] = useState(0);
  const [playback, setPlayback] = useState<PlaybackInfo | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [captureDiag, setCaptureDiag] = useState<CaptureDiag | null>(null);
  /** 等待用户在当前视频页激活扩展（manager 自动重试） */
  const [waitingActivation, setWaitingActivation] = useState(false);
  /** 扩展图标是否已固定到工具栏（进入等待激活时查询，决定引导文案）；null=未知 */
  const [iconOnToolbar, setIconOnToolbar] = useState<boolean | null>(null);
  /** 标点恢复开关（localStorage 持久化）、标点模型缓存状态与下载进度 */
  const [punctEnabled, setPunctEnabled] = useState(
    () => localStorage.getItem('kedaibiao-asr-punct') === '1',
  );
  const [punctCached, setPunctCached] = useState(false);
  const [punctProgress, setPunctProgress] = useState<DownloadProgress | null>(null);
  const [lines, setLines] = useState<SubtitleCue[]>([]);
  const [partial, setPartial] = useState('');
  const [paused, setPaused] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<AsrModelId | null>(null);
  /** 连续无声超过 8 秒（升级提示用），随每秒轮询刷新 */
  const [silentLong, setSilentLong] = useState(false);
  /** 当前位置落入已转写区间，正在跳过重复转写 */
  const [coverageSkip, setCoverageSkip] = useState(false);
  /** 行内编辑：正在编辑的 cue（按对象引用定位，排序显示不影响下标回写）与草稿 */
  const [editCueRef, setEditCueRef] = useState<SubtitleCue | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const managerRef = useRef<AsrManager | null>(null);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const punctAbortRef = useRef<AbortController | null>(null);
  const liveListRef = useRef<HTMLDivElement>(null);
  // 连续无声计时起点（null=当前有声/非转写中）；用于「持续无声」升级提示
  const silentSinceRef = useRef<number | null>(null);
  // pushToast 的 props 引用可能每次渲染都变，manager 事件回调用 ref 稳定访问
  const toastRef = useRef(pushToast);
  toastRef.current = pushToast;
  // t 随语言切换改变身份，常驻 manager 的事件回调经 ref 取最新翻译（同 toastRef）
  const tRef = useRef(t);
  tRef.current = t;
  // 标点开关/缓存状态的最新值，供 runPipeline 闭包读取
  const punctEnabledRef = useRef(punctEnabled);
  punctEnabledRef.current = punctEnabled;
  const punctCachedRef = useRef(punctCached);
  punctCachedRef.current = punctCached;

  /**
   * 宿主（offscreen）任务状态。文件/流式转写在宿主文档里跑，面板只是它的视图：
   * 关掉侧栏不再中断任务，重新打开本卡片时靠轮询快照接回进度。
   */
  const [hostState, setHostState] = useState<AsrHostState | null>(null);
  /** 宿主任务因媒体源未授权跨域而失败（展示「授权并重试」） */
  const [hostNeedsAuth, setHostNeedsAuth] = useState(false);
  /** 宿主快照已同步的句数（增量拉取） */
  const hostKnownCueRef = useRef(0);
  /** 本次宿主任务是否已做过收尾（轮询会反复看到同一终态） */
  const hostHandledRef = useRef(false);
  /** 最近一次下发给宿主的任务参数（授权后原样重跑） */
  const lastHostJobRef = useRef<{
    modelId: AsrModelId;
    mode: 'file' | 'stream';
    urls: string[];
  } | null>(null);
  /** 标点模型下载的断点续传缓冲（面板会话内复用；该下载仍在面板内做） */
  const punctPartialsRef = useRef<DownloadPartials | null>(null);
  /** 唤醒计数：下发宿主任务后 +1，让轮询立刻跑一次而不是等空闲间隔 */
  const [hostWake, setHostWake] = useState(0);

  // 查询模型缓存状态（卡片展示「已缓存」用）
  const refreshCached = useCallback(async () => {
    const entries = await Promise.all(
      SUPPORTED_ASR_MODELS.map(
        async (id) => [id, await isModelCached(ASR_MODELS[id]).catch(() => false)] as const,
      ),
    );
    setCached(Object.fromEntries(entries));
    setPunctCached(await isModelCached(PUNCT_MODEL).catch(() => false));
  }, []);

  useEffect(() => {
    void refreshCached();
  }, [refreshCached]);

  /**
   * 等待激活期间把该 tab 的工具栏图标临时切换为激活弹窗（activate-popup）：
   * 点图标打开 popup 是 Chrome 认可的激活手势（activeTab 语义），且弹窗给出即时反馈；
   * 离开等待状态（激活成功/取消/切课/卸载）即恢复图标的默认行为（打开侧栏）。
   * 弹窗打开后也会自我清除覆盖，双保险。
   * 图标行为切换统一经后台代劳（chrome.action 依赖 manifest 的 action 声明才可用，
   * 此前未声明时侧栏直调同步抛错、React 无错误边界直接白屏）。
   */
  useEffect(() => {
    if (!(phase === 'loading' && waitingActivation)) return;
    const tabId = ctx.tabId;
    void send({ type: 'asr:setActivationPopup', tabId, enable: true }).catch(() => {});
    return () => {
      void send({ type: 'asr:setActivationPopup', tabId, enable: false }).catch(() => {});
    };
  }, [phase, waitingActivation, ctx.tabId]);

  // 进入等待激活时查询图标固定状态，引导文案据此给出可执行的路径
  useEffect(() => {
    if (!waitingActivation) return;
    void send<boolean | null>({ type: 'asr:actionIconOnToolbar' })
      .then((v) => setIconOnToolbar(v))
      .catch(() => {});
  }, [waitingActivation]);

  /** 标点开关：勾选时若模型未缓存则立即开始下载（行内进度条），取消则中止 */
  const togglePunct = useCallback(
    async (enabled: boolean) => {
      setPunctEnabled(enabled);
      localStorage.setItem('kedaibiao-asr-punct', enabled ? '1' : '0');
      if (!enabled) {
        punctAbortRef.current?.abort();
        return;
      }
      if (await isModelCached(PUNCT_MODEL).catch(() => false)) {
        setPunctCached(true);
        return;
      }
      punctAbortRef.current?.abort();
      const abort = new AbortController();
      punctAbortRef.current = abort;
      setPunctProgress(null);
      try {
        await ensureModelDownloaded(PUNCT_MODEL, {
          onProgress: setPunctProgress,
          signal: abort.signal,
          // 失败重试可从断点续传（面板会话内有效）
          partials: (punctPartialsRef.current ??= createDownloadPartials()),
        });
        setPunctCached(true);
        toastRef.current(t('asr.punctDownloadDone'), 'success');
      } catch (e) {
        if (!(e instanceof DownloadCancelledError)) {
          toastRef.current(t('asr.punctDownloadFailed', { message: localizeError(t, e) }), 'error');
        }
      } finally {
        setPunctProgress(null);
      }
    },
    [t],
  );

  /**
   * 任务阶段（UI 用）：媒体准备 / 引擎加载 / 转写中。宿主任务的快照也映射回这些状态，
   * 因此渲染代码与本地执行共用一套。
   */
  const busy =
    mediaStage !== null ||
    phase === 'downloading' ||
    phase === 'loading' ||
    phase === 'transcribing';
  /**
   * 本卡片 UI 是否由宿主任务驱动：宿主里有本课程的任务（进行中，或刚结束的终态）时，
   * 视图归宿主——面板内任务（实时转写）只可能在宿主无任务时跑。
   * 注意不能只看 running：prepare 可能瞬间完成（模型已缓存），终态同样要接管视图。
   */
  const hostedActive = hostState !== null && hostState.courseId === ctx.course.id;
  /** 宿主正在下载模型（下载视图的取消按钮据此分流） */
  const hostPreparing =
    hostState?.mode === 'prepare' &&
    hostState.courseId === ctx.course.id &&
    hostState.running === true;
  /** 面板内任务（实时捕获 / Firefox 的文件·流式）：切页重挂会 dispose，需要冻结跟随 */
  const localBusy = busy && !hostedActive;
  const localBusyRef = useRef(false);
  localBusyRef.current = localBusy;

  /**
   * 转写任务起停上报：local = 任务跑在面板文档里（切页重挂会终止 → 外层冻结跟随），
   * host = offscreen 宿主任务（与面板无关，只用于全局状态条）。
   */
  useEffect(() => {
    onBusyChange?.({ local: localBusy, host: hostState?.running ?? false });
  }, [localBusy, hostState?.running, onBusyChange]);
  // 卸载（切课/切换面板页签/关闭面板）后解除冻结，让面板恢复正常跟随
  useEffect(() => () => onBusyChange?.({ local: false, host: false }), [onBusyChange]);

  // 卸载兜底：转写中途切课/关面板，尽力保存已产出的内容
  const modelForSave = useRef<AsrModelId | null>(null);
  const processedForSave = useRef(0);
  useEffect(() => {
    modelForSave.current = activeModel;
  }, [activeModel]);
  useEffect(() => {
    processedForSave.current = processedSec;
  }, [processedSec]);
  useEffect(() => {
    const courseId = ctx.course.id;
    return () => {
      mediaAbortRef.current?.abort();
      punctAbortRef.current?.abort();
      const manager = managerRef.current;
      managerRef.current = null;
      if (!manager) return;
      void manager.dispose().then((cues) => {
        if (cues.length > 0 && modelForSave.current) {
          void send({
            type: 'transcript:save',
            transcript: {
              id: courseId,
              courseId,
              modelId: modelForSave.current,
              cues,
              durationSec: processedForSave.current,
              updatedAt: Date.now(),
            } satisfies Transcript,
          }).catch(() => {});
        }
      });
    };
    // 仅在课程切换时触发卸载兜底保存（courseId 经由参数固化，不随闭包漂移）
  }, [ctx.course.id]);

  // 关闭面板 = 文档直接销毁，不走 React 卸载清理：在途的「面板内」转写（实时捕获 /
  // Firefox 的文件·流式）借 pagehide 把已产出内容尽力落盘，避免整段丢失。
  // 宿主（offscreen）任务不受影响，无需在这里兜底。
  const linesRef = useRef<SubtitleCue[]>([]);
  linesRef.current = lines;
  useEffect(() => {
    const courseId = ctx.course.id;
    const onPageHide = () => {
      const cues = linesRef.current;
      if (!localBusyRef.current || !managerRef.current || cues.length === 0) return;
      void send({
        type: 'transcript:save',
        transcript: {
          id: courseId,
          courseId,
          modelId: modelForSave.current ?? 'paraformer-streaming',
          cues: [...cues].sort((a, b) => a.start - b.start),
          durationSec: processedForSave.current,
          updatedAt: Date.now(),
        } satisfies Transcript,
      }).catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [ctx.course.id]);

  const getManager = useCallback((): AsrManager => {
    if (!managerRef.current) {
      managerRef.current = createAsrManager({
        onPhase: setPhase,
        onDownloadProgress: setProgress,
        onSegment: (cue) => setLines((prev) => [...prev, cue]),
        onPartial: setPartial,
        onProcessed: setProcessedSec,
        onAudioLevel: setAudioLevel,
        onCaptureDiag: setCaptureDiag,
        onWaitingActivation: setWaitingActivation,
        onSegmentPunct: (index, text) =>
          setLines((prev) => prev.map((c, i) => (i === index ? { ...c, text } : c))),
        onPunctError: (message) => toastRef.current(localizeError(tRef.current, message), 'error'),
        onTimelineRebased: () => toastRef.current(tRef.current('asr.timelineRebased'), 'info'),
        onCoverageSkip: (skipping) => {
          setCoverageSkip(skipping);
          if (skipping) toastRef.current(tRef.current('asr.coverageSkipToast'), 'info');
        },
        onError: (message) => setErrorMsg(message),
      });
    }
    return managerRef.current;
  }, []);

  // 实时模式转写中轮询播放信息：进度分母（总时长）与暂停/静音提示
  useEffect(() => {
    if (phase !== 'transcribing' || mode !== 'live') {
      setSilentLong(false);
      return;
    }
    let cancelled = false;
    const tick = () => {
      send<PlaybackInfo>({ type: 'video:getPlaybackInfo', tabId: ctx.tabId })
        .then((info) => {
          if (!cancelled) setPlayback(info);
        })
        .catch(() => {});
      const since = silentSinceRef.current;
      setSilentLong(since !== null && Date.now() - since > 8000);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, mode, ctx.tabId]);

  // 新句滚动到底部
  useEffect(() => {
    liveListRef.current?.scrollTo({ top: liveListRef.current.scrollHeight });
  }, [lines, partial]);

  // 跟踪连续无声时长：有声/非实时转写/暂停时清零
  useEffect(() => {
    if (phase !== 'transcribing' || mode !== 'live' || paused || audioLevel > 0.001) {
      silentSinceRef.current = null;
    } else if (silentSinceRef.current === null) {
      silentSinceRef.current = Date.now();
    }
  }, [audioLevel, phase, mode, paused]);

  /** 提交行内编辑：同步 UI 与真正的转写持有方（宿主任务改在宿主里，最终落盘的才是编辑后版本） */
  const commitEdit = useCallback(() => {
    const ref = editCueRef;
    setEditCueRef(null);
    const text = editDraft.trim();
    if (!ref || !text) return;
    setLines((prev) => {
      // 显示层按时间排序，manager/host 内为识别顺序——用对象引用找回真实下标
      const idx = prev.indexOf(ref);
      if (idx < 0) return prev;
      if (hostedActive) void hostEdit(idx, text).catch(() => {});
      else managerRef.current?.editCue(idx, text);
      return prev.map((c, i) => (i === idx ? { ...c, text } : c));
    });
  }, [editCueRef, editDraft, hostedActive]);

  /** 显示用：按视频时间排序（回拖续转的句子按识别顺序追加在 lines 尾部） */
  const sortedLines = useMemo(() => [...lines].sort((a, b) => a.start - b.start), [lines]);

  /** 保存转写结果并交回主视图 */
  const saveAndFinish = useCallback(
    async (cues: SubtitleCue[], modelId: AsrModelId, durationSec: number) => {
      if (cues.length === 0) {
        pushToast(t('asr.noSpeech'), 'error');
        return;
      }
      await send({
        type: 'transcript:save',
        transcript: {
          id: ctx.course.id,
          courseId: ctx.course.id,
          modelId,
          cues,
          durationSec,
          updatedAt: Date.now(),
        } satisfies Transcript,
      }).catch(() => {});
      pushToast(t('asr.transcribeDone', { count: cues.length }), 'success');
      onFinished(cues);
    },
    [ctx.course.id, onFinished, pushToast, t],
  );

  /** 文件模式：解析直链 → 下载 → 解码 → 快进转写 */
  const runFilePipeline = useCallback(
    async (manager: AsrManager, modelId: AsrModelId, urls: string[]) => {
      setMediaStage('downloading');
      mediaAbortRef.current = new AbortController();
      let blob: Blob | null = null;
      let lastError: unknown = null;
      for (const url of urls) {
        try {
          blob = await downloadMedia(url, {
            signal: mediaAbortRef.current.signal,
            onProgress: setMediaProgress,
          });
          break;
        } catch (e) {
          if (e instanceof MediaDownloadCancelledError) throw e;
          lastError = e;
        }
      }
      if (!blob) throw lastError ?? new Error('asr.err.mediaDownloadFailed');

      setMediaStage('decoding');
      const samples = await decodeToMono16k(blob);
      setMediaStage(null);
      setFileDurationSec(samples.length / ASR_SAMPLE_RATE);

      await manager.boot();
      if (manager.phase !== 'loading') throw new Error('asr.err.engineLoadFailed');
      const cues = await manager.feedBuffer(samples);
      await saveAndFinish(cues, modelId, samples.length / ASR_SAMPLE_RATE);
    },
    [saveAndFinish],
  );

  /** 实时模式：引擎加载 → 捕获标签页音频 */
  const runLivePipeline = useCallback(
    async (manager: AsrManager) => {
      setMediaStage(null);
      setMediaProgress(null);
      setMode('live');
      await manager.boot();
      if (manager.phase !== 'loading') return; // boot 失败已由 onError 呈现
      await manager.attachLiveCapture(ctx.tabId);
    },
    [ctx.tabId],
  );

  /**
   * 启动宿主任务。宿主不可用（浏览器不支持/文档创建失败）时返回 false，
   * 由调用方回落面板内管线（Firefox 与异常场景都不会丢功能）。
   */
  const startHostedJob = useCallback(
    async (modelId: AsrModelId, mode: 'file' | 'stream', urls: string[]): Promise<boolean> => {
      lastHostJobRef.current = { modelId, mode, urls };
      hostHandledRef.current = false;
      hostKnownCueRef.current = 0;
      setHostNeedsAuth(false);
      setLines([]);
      setPartial('');
      setProcessedSec(0);
      setFileDurationSec(0);
      setErrorMsg(null);
      setMode(mode);
      setMediaStage('resolving');
      setActiveModel(modelId);
      try {
        await hostStart({
          courseId: ctx.course.id,
          modelId,
          mode,
          urls,
          // 标点恢复仅对流式 Paraformer 有意义，且模型需已缓存
          punct:
            modelId === 'paraformer-streaming' && punctEnabledRef.current && punctCachedRef.current,
        });
        setHostWake((n) => n + 1); // 立刻轮询一次，别让进度/状态等到空闲间隔才出现
        return true;
      } catch (e) {
        console.warn('[kedaibiao] 转写宿主不可用，回退面板内执行：', e);
        setMediaStage(null);
        return false;
      }
    },
    [ctx.course.id],
  );

  /**
   * 把模型下载也交给宿主：237MB 的下载关掉面板不该中断，失败还能从断点续传。
   * 宿主不可用时返回 false，由调用方回落面板内下载。
   */
  const startHostPrepare = useCallback(
    async (modelId: AsrModelId): Promise<boolean> => {
      hostHandledRef.current = false;
      hostKnownCueRef.current = 0;
      setHostNeedsAuth(false);
      setErrorMsg(null);
      setProgress(null);
      setActiveModel(modelId);
      try {
        await hostPrepare(ctx.course.id, modelId);
        setHostWake((n) => n + 1); // 立刻轮询一次，下载进度/完成不必等空闲间隔
        return true;
      } catch (e) {
        console.warn('[kedaibiao] 转写宿主不可用，回退面板内下载：', e);
        return false;
      }
    },
    [ctx.course.id],
  );

  /** 授权媒体源后原样重跑宿主任务（permissions.request 必须在点击链路里调用） */
  const authorizeAndRetry = useCallback(async () => {
    const job = lastHostJobRef.current;
    if (!job) return;
    const origins = [
      ...new Set(
        job.urls
          .map((u) => {
            try {
              return new URL(u).origin;
            } catch {
              return '';
            }
          })
          .filter(Boolean),
      ),
    ];
    const granted = await requestOrigins(origins);
    if (!granted) {
      pushToast(t('asr.authorizeDenied'), 'error');
      return;
    }
    setHostNeedsAuth(false);
    void hostClear().catch(() => {});
    await startHostedJob(job.modelId, job.mode, job.urls);
  }, [pushToast, startHostedJob, t]);

  /**
   * 文件模式（用户在确认卡片点「下载并转写」后执行）。
   * 失败时按能力回退：有 tabCapture 的浏览器切实时模式，否则留在卡片让用户重试。
   */
  const runFileMode = useCallback(
    async (manager: AsrManager, modelId: AsrModelId, urls: string[]) => {
      setMode('file');
      pushToast(t('asr.fileModeStarted'), 'info');
      try {
        // 有宿主就交给宿主：下载/解码/引擎都在独立文档里，关侧栏也不中断
        if (HOSTED_JOBS_SUPPORTED && (await startHostedJob(modelId, 'file', urls))) return;
        await runFilePipeline(manager, modelId, urls);
      } catch (e) {
        if (e instanceof MediaDownloadCancelledError) {
          manager.reset();
          setMode(null);
          setMediaStage(null);
          setMediaProgress(null);
          return;
        }
        // 文件模式失败 → 有实时捕获能力时回退实时模式（必须清掉 mediaStage，否则下载视图盖住后续界面）
        setMediaStage(null);
        setMediaProgress(null);
        pushToast(
          t(LIVE_CAPTURE_SUPPORTED ? 'asr.fileExtractFailed' : 'asr.fileExtractFailedNoLive', {
            message: localizeError(t, e),
          }),
          'error',
        );
        manager.reset();
        if (!LIVE_CAPTURE_SUPPORTED) {
          // 无 tabCapture 的浏览器没有实时转写可回退：留在卡片，由用户改选其他来源
          setMode(null);
          return;
        }
        await runLivePipeline(manager);
      }
    },
    [runFilePipeline, runLivePipeline, startHostedJob, pushToast, t],
  );

  /**
   * 主管线：模型就绪后先解析直链，拿到则请用户确认文件/流式模式；
   * 拿不到时只有支持 tabCapture 的浏览器能切实时模式，否则提示无法转写。
   */
  const runPipeline = useCallback(
    async (modelId: AsrModelId) => {
      const manager = getManager();
      // 标点恢复仅对流式 Paraformer 有意义（SenseVoice 自带标点）
      const wantPunct = modelId === 'paraformer-streaming' && punctEnabledRef.current;
      manager.setPunctuationEnabled(wantPunct && punctCachedRef.current);
      if (wantPunct && !punctCachedRef.current) {
        toastRef.current(t('asr.punctNotReady'), 'info');
      }
      setMediaStage('resolving');
      const rawUrls = await send<string[] | null>({
        type: 'media:resolveAudio',
        tabId: ctx.tabId,
      }).catch(() => null);
      setMediaStage(null);
      // HLS/DASH 清单（m3u8/mpd）解不了码，直接判为无直链
      const urls = rawUrls?.filter(isDownloadableMediaUrl) ?? null;
      if (urls && urls.length > 0) {
        // 源文件可能几百 MB，下载前先经用户确认（见 pendingFile 视图）
        setPendingFile({ modelId, urls });
        return;
      }
      if (!LIVE_CAPTURE_SUPPORTED) {
        // 无 tabCapture 的浏览器：解析不到直链就没有可用管线（实时转写不可用）
        manager.reset();
        setMode(null);
        setErrorMsg('asr.err.noDirectSource');
        return;
      }
      await runLivePipeline(manager);
    },
    [ctx.tabId, getManager, runLivePipeline, t],
  );

  /** 确认卡片「下载并转写」 */
  const confirmFileMode = useCallback(async () => {
    const pending = pendingFile;
    if (!pending) return;
    setPendingFile(null);
    await runFileMode(getManager(), pending.modelId, pending.urls);
  }, [pendingFile, getManager, runFileMode]);

  /** 确认卡片「改用实时转写」 */
  const declineFileMode = useCallback(async () => {
    setPendingFile(null);
    await runLivePipeline(getManager());
  }, [getManager, runLivePipeline]);

  /**
   * 确认卡片「流式转写」：边下边解码边喂引擎。
   * 全部源失败时按能力回退：有 tabCapture 的浏览器切实时模式；
   * 否则退回确认卡片（流式失败多为 WebCodecs 不支持该编码，整段下载仍可能可用）。
   */
  const confirmStreamMode = useCallback(async () => {
    const pending = pendingFile;
    if (!pending) return;
    setPendingFile(null);
    const manager = getManager();
    // 有宿主就交给宿主流式转写（边下边解边喂全在独立文档里，关侧栏也不中断）
    if (HOSTED_JOBS_SUPPORTED && (await startHostedJob(pending.modelId, 'stream', pending.urls))) {
      return;
    }
    setMode('stream');
    setMediaProgress(null);
    setMediaStage('resolving');
    mediaAbortRef.current = new AbortController();
    const signal = mediaAbortRef.current.signal;
    let lastError: unknown = null;
    for (const url of pending.urls) {
      try {
        const stream = await openStreamingAudio(url, { signal, onProgress: setMediaProgress });
        setMediaStage(null);
        setFileDurationSec(stream.durationSec);
        await manager.boot();
        if (manager.phase !== 'loading') throw new Error('asr.err.engineLoadFailed');
        const cues = await manager.feedStream(stream.chunks, stream.durationSec);
        // 取消路径（cancelFileMode）已负责保存结果，避免重复保存
        if (managerRef.current !== manager) return;
        await saveAndFinish(cues, pending.modelId, stream.durationSec);
        return;
      } catch (e) {
        if (e instanceof MediaDownloadCancelledError) {
          manager.reset();
          setMode(null);
          setMediaStage(null);
          setMediaProgress(null);
          return;
        }
        lastError = e;
        manager.reset();
      }
    }
    setMediaStage(null);
    setMediaProgress(null);
    setMode(null);
    if (LIVE_CAPTURE_SUPPORTED) {
      pushToast(t('asr.streamExtractFailed', { message: localizeError(t, lastError) }), 'error');
      await runLivePipeline(manager);
      return;
    }
    // 无 tabCapture 的浏览器没有实时转写可回退：退回源文件确认卡片，由用户决定是否整段下载
    // （流式失败多为 WebCodecs 不支持该编码，整段下载走 decodeAudioData，仍可能成功）
    pushToast(
      t('asr.streamExtractFailedKeepFile', { message: localizeError(t, lastError) }),
      'error',
    );
    setPendingFile({ modelId: pending.modelId, urls: pending.urls });
  }, [pendingFile, getManager, runLivePipeline, startHostedJob, saveAndFinish, pushToast, t]);

  // ---------- 宿主（offscreen）任务：关侧栏也不中断的文件/流式转写 ----------

  /** 宿主任务完成收尾：从库里取回最终转写（含标点与宿主侧编辑）再交回主视图 */
  const finishHostedJob = useCallback(async () => {
    const saved = await send<Transcript | null>({
      type: 'transcript:get',
      courseId: ctx.course.id,
    }).catch(() => null);
    void hostClear().catch(() => {});
    const cues = saved?.cues ?? [];
    if (cues.length === 0) {
      pushToast(t('asr.noSpeech'), 'error');
      return;
    }
    pushToast(t('asr.transcribeDone', { count: cues.length }), 'success');
    onFinished(cues);
  }, [ctx.course.id, onFinished, pushToast, t]);

  /** 宿主快照 → 本卡片视图状态（与面板内执行同构，渲染代码完全复用） */
  const applyHostSnapshot = useCallback(
    (snap: AsrHostSnapshot) => {
      const st = snap.state;
      setHostState(st);
      // 别的课程在转写：只喂全局状态条，本课程视图不动（句子丢弃但推进游标，避免反复重拉）
      if (st.courseId !== ctx.course.id) {
        hostKnownCueRef.current += snap.cues.length;
        return;
      }

      // ── prepare（模型下载）任务：映射到卡片既有的下载进度视图。
      // 放在 localBusy 判断之前：模型下载与面板内实时转写不会并存，
      // 且 prepare 可能瞬间完成（缓存已命中）——那时不能因为卡片还在下载视图就把它挡掉。
      if (st.mode === 'prepare') {
        if (hostHandledRef.current) return; // 终态已处理过：别用旧快照盖住当前视图
        if (st.phase === 'error') {
          hostHandledRef.current = true;
          const message = st.error ?? 'asrErr.modelFileDownloadFailed';
          setPhase('error');
          setProgress(null);
          setErrorMsg(message);
          pushToast(localizeError(t, message), 'error');
          void hostClear().catch(() => {});
          return;
        }
        if (st.phase === 'done') {
          hostHandledRef.current = true;
          setProgress(null);
          setPhase('idle'); // 下载视图收起：接着走主管线（解析直链 → 用户选模式）
          void hostClear().catch(() => {});
          void (async () => {
            await refreshCached();
            await runPipeline(st.modelId);
          })();
          return;
        }
        setPhase(st.phase === 'loading' ? 'downloading' : 'idle');
        setProgress({
          file: st.modelFile,
          fileLoaded: st.modelLoaded,
          fileTotal: st.modelTotal || ASR_MODELS[st.modelId].totalBytes,
          loaded: st.modelLoaded,
          total: st.modelTotal || ASR_MODELS[st.modelId].totalBytes,
        });
        return;
      }

      // 面板内任务（实时转写）在跑时，本卡片 UI 归它，宿主快照只更新状态条
      if (localBusyRef.current) return;

      if (snap.cues.length > 0) {
        hostKnownCueRef.current += snap.cues.length;
        setLines((prev) => [...prev, ...snap.cues]);
      }
      const punctUpdates = snap.updates;
      if (Object.keys(punctUpdates).length > 0) {
        setLines((prev) =>
          prev.map((c, i) => (punctUpdates[i] !== undefined ? { ...c, text: punctUpdates[i]! } : c)),
        );
      }
      setMode(st.mode);
      setActiveModel(st.modelId);
      setPartial(st.partial);
      setProcessedSec(st.processedSec);
      if (st.durationSec > 0) setFileDurationSec(st.durationSec);
      setMediaStage(st.mediaStage);
      setMediaProgress(
        st.mediaStage
          ? {
              loaded: st.mediaLoaded,
              total: st.mediaTotal,
              host: st.mediaHost,
              bytesPerSec: st.mediaBytesPerSec,
            }
          : null,
      );
      setPhase(st.phase === 'done' || st.phase === 'idle' ? 'idle' : st.phase);
      if (st.phase === 'error') setErrorMsg(st.error ?? 'asr.err.engineLoadFailed');

      if (hostHandledRef.current) return;
      if (st.phase === 'done') {
        hostHandledRef.current = true;
        void finishHostedJob();
      } else if (st.phase === 'error') {
        hostHandledRef.current = true;
        const message = st.error ?? 'asr.err.engineLoadFailed';
        if (message === 'asrErr.mediaSourceNotAuthorized') {
          // 宿主不能弹授权窗：由面板在用户点击后申请该源权限，再原样重跑
          setHostNeedsAuth(true);
          pushToast(t('asr.mediaSourceNeedsAuth'), 'info');
        } else if (LIVE_CAPTURE_SUPPORTED) {
          pushToast(
            t(st.mode === 'file' ? 'asr.fileExtractFailed' : 'asr.streamExtractFailed', {
              message: localizeError(t, message),
            }),
            'error',
          );
          managerRef.current?.reset();
          void runLivePipeline(getManager());
        } else {
          pushToast(localizeError(t, message), 'error');
        }
      }
    },
    [ctx.course.id, finishHostedJob, refreshCached, runLivePipeline, runPipeline, getManager, pushToast, t],
  );

  /**
   * 轮询宿主任务。任务跑在 offscreen 文档里，面板只是它的视图：
   * 关掉侧栏任务照跑，重开卡片后第一次轮询就把进度接回来（句子增量拉取）。
   */
  useEffect(() => {
    if (!HOSTED_JOBS_SUPPORTED) return;
    let cancelled = false;
    let timer: number | undefined;
    const schedule = (ms: number) => {
      timer = window.setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      const snap = await hostStatus(hostKnownCueRef.current).catch(() => null);
      if (cancelled) return;
      if (!snap) {
        schedule(HOST_POLL_IDLE_MS);
        return;
      }
      applyHostSnapshot(snap);
      const st = snap.state;
      if (!st.running) {
        schedule(HOST_POLL_IDLE_MS);
        return;
      }
      schedule(st.courseId === ctx.course.id ? HOST_POLL_ATTACHED_MS : HOST_POLL_OTHER_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyHostSnapshot, ctx.course.id, hostWake]);

  const start = useCallback(
    async (modelId: AsrModelId) => {
      setErrorMsg(null);
      setLines([]);
      setPartial('');
      setProcessedSec(0);
      setProgress(null);
      setMediaProgress(null);
      setMediaStage(null);
      setPendingFile(null);
      setAudioLevel(0);
      setCaptureDiag(null);
      setWaitingActivation(false);
      silentSinceRef.current = null;
      setSilentLong(false);
      setPaused(false);
      setActiveModel(modelId);
      // 收起宿主里上一个任务的终态：否则轮询会把旧状态又贴回视图
      // （任务仍在跑时宿主会忽略 clear，不会误伤在途任务）
      hostHandledRef.current = false;
      hostKnownCueRef.current = 0;
      setHostNeedsAuth(false);
      setHostState(null);
      if (HOSTED_JOBS_SUPPORTED) void hostClear().catch(() => {});
      const manager = getManager();
      const cached = await manager.prepareModel(modelId);
      if (!cached) return; // → need-download 视图
      await runPipeline(modelId);
    },
    [getManager, runPipeline],
  );

  /**
   * 「下载并开始」：模型下载完成后继续主管线。
   * 有宿主时把下载交给宿主——237MB 关掉面板不该中断，失败还能从断点续传；
   * 进度与完成由轮询回填（见 applyHostSnapshot 的 prepare 分支）。
   */
  const confirmAndContinue = useCallback(async () => {
    if (HOSTED_JOBS_SUPPORTED && activeModel && (await startHostPrepare(activeModel))) {
      setPhase('downloading'); // 立刻切到下载视图，不等第一次轮询
      return;
    }
    const manager = getManager();
    await manager.confirmDownload();
    if (manager.phase !== 'idle' || !activeModel) return;
    await runPipeline(activeModel);
  }, [activeModel, getManager, runPipeline, startHostPrepare]);

  /** 实时模式「停止并保存」 */
  const stopAndSave = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;
    const cues = await manager.finish();
    await saveAndFinish(cues, activeModel ?? 'paraformer-streaming', processedSec);
  }, [activeModel, processedSec, saveAndFinish]);

  /** 文件/流式模式「取消」：终止喂入，已产出的部分仍然保存（宿主任务同时取消宿主侧） */
  const cancelFileMode = useCallback(async () => {
    // 宿主任务：取消宿主任务并取回最终快照（含宿主侧编辑），由面板落盘
    if (hostedActive) {
      mediaAbortRef.current?.abort();
      const snap = await hostCancel().catch(() => null);
      hostHandledRef.current = true; // 关闭后续轮询的终态收尾
      setHostNeedsAuth(false);
      const cues = snap?.cues ?? [];
      if (cues.length > 0) {
        await saveAndFinish(
          cues,
          activeModel ?? 'paraformer-streaming',
          snap?.state.durationSec ?? processedSec,
        );
        return;
      }
      setPhase('idle');
      setMode(null);
      setHostState(null);
      return;
    }
    const manager = managerRef.current;
    if (!manager) return;
    mediaAbortRef.current?.abort();
    const cues = await manager.dispose();
    managerRef.current = null;
    if (cues.length > 0) {
      await saveAndFinish(cues, activeModel ?? 'paraformer-streaming', processedSec);
      return;
    }
    setPhase('idle');
    setMode(null);
  }, [hostedActive, activeModel, processedSec, saveAndFinish]);

  // ---------- 各阶段视图 ----------

  // 媒体阶段视图必须先于 phase 判断：文件模式的解析/下载/解码期间 phase 仍是 idle，
  // 否则 idle 视图会把下载进度界面盖住
  if (mediaStage === 'resolving') {
    return (
      <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
        <p className="text-xs text-gray-500">
          {t(mode === 'stream' ? 'asr.connectingSource' : 'asr.resolvingSource')}
        </p>
      </div>
    );
  }

  if (mediaStage === 'downloading' || mediaStage === 'decoding') {
    const pct =
      mediaProgress && mediaProgress.total > 0
        ? Math.min(100, (mediaProgress.loaded / mediaProgress.total) * 100)
        : null;
    // 预计剩余时间：已知总大小且已有吞吐数据时按平均速度估算
    const etaSec =
      mediaProgress && mediaProgress.total > 0 && mediaProgress.bytesPerSec > 0
        ? (mediaProgress.total - mediaProgress.loaded) / mediaProgress.bytesPerSec
        : null;
    return (
      <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
        <p className="mb-1 text-xs font-medium text-gray-700">
          {t(mediaStage === 'downloading' ? 'asr.downloadingMedia' : 'asr.decodingAudio')}
        </p>
        {mediaStage === 'downloading' ? (
          <p className="mb-1 text-xs text-gray-400">{t('asr.downloadMediaHint')}</p>
        ) : null}
        {mediaStage === 'downloading' ? (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-gray-200">
              <div
                className={`h-full bg-blue-500 transition-all ${pct === null ? 'w-full animate-pulse' : ''}`}
                style={pct === null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {mediaProgress
                ? mediaProgress.loaded > 0
                  ? pct !== null
                    ? t('asr.mediaProgress', {
                        pct: pct.toFixed(1),
                        loaded: formatBytes(mediaProgress.loaded),
                        total: formatBytes(mediaProgress.total),
                        speed: formatBytes(mediaProgress.bytesPerSec),
                        eta:
                          etaSec !== null ? t('asr.mediaEta', { time: formatTimestamp(etaSec) }) : '',
                        host: mediaProgress.host,
                      })
                    : t('asr.mediaProgressNoTotal', {
                        loaded: formatBytes(mediaProgress.loaded),
                        speed: formatBytes(mediaProgress.bytesPerSec),
                        host: mediaProgress.host,
                      })
                  : t('asr.mediaConnecting', { host: mediaProgress.host })
                : t('asr.preparingDownload')}
            </p>
            {mediaProgress?.loaded === 0 ? (
              <p className="mt-1 text-xs text-gray-400">
                {t(LIVE_CAPTURE_SUPPORTED ? 'asr.stallHint' : 'asr.stallHintNoLive')}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-gray-400">{t('asr.decodingHint')}</p>
        )}
        <button
          type="button"
          onClick={() => {
            mediaAbortRef.current?.abort();
            setMediaStage(null);
            setMediaProgress(null);
            setMode(null);
            setPhase('idle');
          }}
          className="mt-2 rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
        >
          {t('common.cancel')}
        </button>
      </div>
    );
  }

  // 解析到直链后的确认卡片：源文件可能很大，下载与否由用户决定
  if (pendingFile) {
    const hosts = [
      ...new Set(
        pendingFile.urls.map((u) => {
          try {
            return new URL(u).hostname;
          } catch {
            return u;
          }
        }),
      ),
    ];
    return (
      <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
        <p className="mb-1 text-xs font-medium text-gray-700">{t('asr.sourceDetected')}</p>
        <p className="mb-1 text-xs leading-relaxed text-gray-500">
          {t('asr.sourceHosts', { hosts: hosts.join(t('asr.listSeparator')) })}
        </p>
        <p className="mb-2 text-xs leading-relaxed text-gray-400">
          {t(LIVE_CAPTURE_SUPPORTED ? 'asr.sourceChoices' : 'asr.sourceChoicesNoLive')}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void confirmStreamMode()}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            {t('asr.streamMode')}
          </button>
          <button
            type="button"
            onClick={() => void confirmFileMode()}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
          >
            {t('asr.downloadAndTranscribe')}
          </button>
          {LIVE_CAPTURE_SUPPORTED ? (
            <button
              type="button"
              onClick={() => void declineFileMode()}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
            >
              {t('asr.useLiveMode')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPendingFile(null)}
            className="rounded-md px-2 py-1 text-xs text-gray-400 hover:text-gray-600"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'idle' || phase === 'error') {
    return (
      <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
        <p className="mb-1 text-xs font-medium text-gray-700">{t('asr.cardTitle')}</p>
        <p className="mb-2 text-xs text-gray-400">
          {t(LIVE_CAPTURE_SUPPORTED ? 'asr.cardDesc' : 'asr.cardDescNoLive')}
        </p>
        {errorMsg ? (
          <p className="mb-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-600">
            {localizeError(t, errorMsg)}
          </p>
        ) : null}
        {/* 宿主无法弹权限窗：失败后由面板在用户点击链路里申请该源 host 权限，再原样重跑 */}
        {hostNeedsAuth ? (
          <div className="mb-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
            <p className="mb-1">{t('asr.mediaSourceNeedsAuth')}</p>
            <button
              type="button"
              onClick={() => void authorizeAndRetry()}
              className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
            >
              {t('asr.authorizeAndRetry')}
            </button>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {SUPPORTED_ASR_MODELS.map((id) => {
            const spec = ASR_MODELS[id];
            return (
              <div key={id} className="flex flex-col rounded-md border border-gray-200 p-2">
                <p className="text-xs font-medium text-gray-800">{t(spec.label)}</p>
                <p className="mt-0.5 flex-1 text-xs text-gray-400">{t(spec.description)}</p>
                <p className="mt-1 text-xs text-gray-400">
                  {formatBytes(spec.totalBytes)}
                  {cached[id] ? (
                    <span className="ml-1 rounded bg-emerald-50 px-1 py-0.5 text-emerald-600">
                      {t('asr.cached')}
                    </span>
                  ) : (
                    <span className="ml-1 rounded bg-gray-100 px-1 py-0.5 text-gray-500">
                      {t('asr.needsDownload')}
                    </span>
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => void start(id)}
                  className="mt-2 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                >
                  {t('asr.start')}
                </button>
              </div>
            );
          })}
        </div>
        {/* 标点恢复（可选增强，仅作用于流式 Paraformer；SenseVoice 自带标点） */}
        <div className="mt-2 rounded-md border border-gray-100 bg-gray-50 p-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={punctEnabled}
              onChange={(e) => void togglePunct(e.target.checked)}
              disabled={punctProgress !== null}
            />
            {t('asr.punctToggle')}
          </label>
          <p className="mt-0.5 text-[10px] leading-4 text-gray-400">
            {t('asr.punctDesc', {
              label: t(PUNCT_MODEL_LABEL),
              size: formatBytes(PUNCT_MODEL.totalBytes),
              status: punctCached
                ? t('asr.cached')
                : punctProgress
                  ? t('asr.statusDownloading')
                  : t('asr.punctWillDownload'),
            })}
          </p>
          {punctProgress ? (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{
                    width: `${
                      punctProgress.total > 0
                        ? Math.min(100, (punctProgress.loaded / punctProgress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <span className="text-[10px] text-gray-400">
                {formatBytes(punctProgress.loaded)} / {formatBytes(punctProgress.total)}
              </span>
              <button
                type="button"
                onClick={() => punctAbortRef.current?.abort()}
                className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100"
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (phase === 'need-download' && activeModel) {
    const spec = ASR_MODELS[activeModel];
    return (
      <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
        <p className="mb-1 text-xs font-medium text-gray-700">{t('asr.firstDownloadTitle')}</p>
        <p className="mb-2 text-xs text-gray-400">
          {t('asr.firstDownloadDesc', {
            label: t(spec.label),
            size: formatBytes(spec.totalBytes),
          })}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void confirmAndContinue()}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            {t('asr.downloadAndStart')}
          </button>
          <button
            type="button"
            onClick={() => {
              getManager().reset();
              setActiveModel(null);
            }}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'downloading') {
    const pct =
      progress && progress.total > 0
        ? Math.min(100, (progress.loaded / progress.total) * 100)
        : 0;
    return (
      <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
        <p className="mb-1 text-xs font-medium text-gray-700">{t('asr.downloadingModel')}</p>
        <div className="h-2 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {progress
            ? t('asr.modelProgress', {
                pct: pct.toFixed(1),
                loaded: formatBytes(progress.loaded),
                total: formatBytes(progress.total),
                file: progress.file,
              })
            : t('asr.preparingDownload')}
        </p>
        <button
          type="button"
          onClick={() => {
            // 宿主下载：取消宿主任务并回到「需下载」视图（宿主的续传缓冲保留，下次接着下）
            if (hostPreparing) {
              hostHandledRef.current = true;
              void hostCancel().catch(() => {});
              setProgress(null);
              setPhase('need-download');
              return;
            }
            getManager().cancelDownload();
          }}
          className="mt-2 rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
        >
          {t('asr.cancelDownload')}
        </button>
      </div>
    );
  }

  if (phase === 'loading' && waitingActivation) {
    return (
      <div className="mt-2 w-full rounded-md border border-amber-200 bg-amber-50 p-3 text-left">
        <p className="mb-1 text-xs font-medium text-amber-800">{t('asr.activationTitle')}</p>
        <p className="mb-1 text-xs leading-relaxed text-amber-700">{t('asr.activationDesc')}</p>
        <ol className="mb-1 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-amber-700">
          <li>
            <span className="font-medium">{t('asr.activationRecommended')}</span>
            {t('asr.activationStep1', {
              brand: t('brand.name'),
              notPinned: iconOnToolbar === false ? t('asr.activationNotPinned') : '',
            })}
          </li>
          <li>{t('asr.activationStep2', { brand: t('brand.name') })}</li>
        </ol>
        <p className="mb-2 text-xs leading-relaxed text-amber-600">{t('asr.activationPolling')}</p>
        <button
          type="button"
          onClick={() => {
            getManager().reset();
            setWaitingActivation(false);
            setMode(null);
          }}
          className="rounded-md border border-amber-300 bg-white px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
        >
          {t('common.cancel')}
        </button>
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
        <p className="text-xs text-gray-500">{t('asr.engineLoading')}</p>
      </div>
    );
  }

  // transcribing
  const liveDuration = playback && playback.duration > 0 ? playback.duration : 0;
  const totalSec = mode === 'live' ? liveDuration : fileDurationSec;
  const pct = totalSec > 0 ? Math.min(100, (processedSec / totalSec) * 100) : null;
  return (
    <div className="mt-2 w-full rounded-md border border-gray-200 bg-white p-3 text-left">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-gray-700">
          {t(mode === 'live' ? 'asr.modeLive' : mode === 'stream' ? 'asr.modeStream' : 'asr.modeFile')}{' '}
          · {activeModel ? t(ASR_MODELS[activeModel].label) : ''}
        </p>
        <p className="text-xs text-gray-400">
          {formatTimestamp(processedSec)}
          {totalSec > 0 ? ` / ${formatTimestamp(totalSec)}` : ''} ·{' '}
          {t('asr.lineCount', { count: lines.length })}
        </p>
      </div>
      {/* 宿主任务：面板只是视图，关掉也不会中断（这是它与实时转写的关键差别） */}
      {hostedActive ? (
        <p className="mb-1 rounded bg-sky-50 px-2 py-1 text-xs leading-relaxed text-sky-700">
          {t('asr.hostedHint')}
        </p>
      ) : null}
      {pct !== null ? (
        <div className="h-2 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {mode === 'live' ? (
        <>
          {/* 输入音量电平：诊断「捕获到的是不是无声」 */}
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xs text-gray-400">{t('asr.inputVolume')}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
              <div
                className={`h-full transition-all ${audioLevel > 0.005 ? 'bg-emerald-500' : 'bg-gray-300'}`}
                style={{ width: `${Math.min(100, Math.round(audioLevel * 300))}%` }}
              />
            </div>
            {audioLevel <= 0.0001 ? (
              <span className="text-xs text-amber-600">{t('asr.noAudioInput')}</span>
            ) : null}
          </div>
          {captureDiag ? (
            <p className="mt-0.5 text-[10px] leading-4 text-gray-400">
              {t('asr.diag', {
                state: captureDiag.ctxState,
                track: captureDiag.trackMuted ? t('asr.diagMuted') : t('asr.diagUnmuted'),
                ready: captureDiag.trackReadyState,
              })}
              {captureDiag.tabAudible !== undefined
                ? t('asr.diagTab', {
                    audible: captureDiag.tabAudible ? t('asr.diagAudible') : t('asr.diagSilent'),
                  })
                : ''}
              {captureDiag.tabMuted ? t('asr.diagSiteMuted') : ''}
              {playback
                ? t('asr.diagVideo', {
                    volume:
                      playback.muted || playback.volume === 0
                        ? t('asr.diagMuted')
                        : t('asr.diagVideoVolume', { percent: Math.round(playback.volume * 100) }),
                    state: playback.paused ? t('asr.diagPaused') : t('asr.diagPlaying'),
                  })
                : ''}
            </p>
          ) : null}
          {captureDiag?.tabMuted ? (
            <p className="mt-1 text-xs font-medium text-red-600">{t('asr.siteMutedWarning')}</p>
          ) : null}
          {playback && (playback.muted || playback.volume === 0) ? (
            <p className="mt-1 text-xs font-medium text-red-600">{t('asr.videoMutedWarning')}</p>
          ) : null}
          {silentLong &&
          !captureDiag?.tabMuted &&
          !(playback && (playback.muted || playback.volume === 0)) ? (
            <p className="mt-1 text-xs font-medium text-amber-600">
              {captureDiag?.tabAudible === false
                ? t('asr.silentTabInaudible')
                : t('asr.silentCaptureFailed')}
            </p>
          ) : null}
          {playback?.paused ? (
            <p className="mt-1 text-xs text-amber-600">{t('asr.videoPaused')}</p>
          ) : coverageSkip ? (
            <p className="mt-1 text-xs font-medium text-sky-600">{t('asr.coverageSkipping')}</p>
          ) : (
            <p className="mt-1 text-xs text-gray-400">
              {t('asr.liveHint', {
                suffix: activeModel === 'sensevoice' ? t('asr.liveHintSenseVoice') : '',
              })}
            </p>
          )}
        </>
      ) : mode === 'stream' ? (
        <p className="mt-1 text-xs text-gray-400">
          {t('asr.streamHint', {
            progress: mediaProgress
              ? t('asr.streamProgress', {
                  loaded: formatBytes(mediaProgress.loaded),
                  total: mediaProgress.total > 0 ? ` / ${formatBytes(mediaProgress.total)}` : '',
                })
              : '',
          })}
        </p>
      ) : (
        <p className="mt-1 text-xs text-gray-400">{t('asr.fileHint')}</p>
      )}
      <div
        ref={liveListRef}
        className="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-md bg-gray-50 p-2"
      >
        {sortedLines.length === 0 && !partial ? (
          <p className="text-xs text-gray-400">{t('asr.waitingSpeech')}</p>
        ) : (
          sortedLines.map((cue, i) => (
            <p key={`${cue.start}-${i}`} className="text-xs leading-relaxed text-gray-700">
              <span className="mr-1 rounded bg-gray-200 px-1 font-mono text-gray-500">
                {formatTimestamp(cue.start)}
              </span>
              {editCueRef === cue ? (
                <textarea
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === 'Escape') {
                      setEditCueRef(null);
                    }
                  }}
                  rows={Math.max(2, Math.ceil(editDraft.length / 30))}
                  className="mt-0.5 w-full rounded border border-blue-300 px-1 py-0.5 text-xs outline-none focus:border-blue-500"
                />
              ) : (
                <span
                  role="button"
                  tabIndex={0}
                  title={t('asr.editTitle')}
                  className="cursor-text rounded px-0.5 hover:bg-amber-50"
                  onClick={() => {
                    setEditCueRef(cue);
                    setEditDraft(cue.text);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setEditCueRef(cue);
                      setEditDraft(cue.text);
                    }
                  }}
                >
                  {cue.text}
                </span>
              )}
            </p>
          ))
        )}
        {partial ? <p className="text-xs italic leading-relaxed text-gray-400">{partial}…</p> : null}
      </div>
      <div className="mt-2 flex gap-2">
        {mode === 'live' ? (
          <>
            <button
              type="button"
              onClick={() => {
                const next = !paused;
                setPaused(next);
                managerRef.current?.setPaused(next);
              }}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
            >
              {t(paused ? 'asr.resumeTranscribe' : 'asr.pauseTranscribe')}
            </button>
            <button
              type="button"
              onClick={() => void stopAndSave()}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
            >
              {t('asr.stopAndSave')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void cancelFileMode()}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
          >
            {t('asr.cancelKeep')}
          </button>
        )}
      </div>
    </div>
  );
}
