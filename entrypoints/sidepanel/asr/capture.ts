import { browser } from 'wxt/browser';
import { ASR_SAMPLE_RATE, resampleLinear } from '~/core/asr';

/**
 * 标签页音频捕获（Chrome tabCapture）。
 * 在侧栏上下文运行：拿到音频 MediaStream → AudioWorklet 混单声道切块 →
 * 面板侧重采样到 16kHz → 回调给引擎 worker。
 * Firefox 无对应能力（只影响实时模式；文件/流式转写不受影响），入口由
 * capabilities.ts 的 LIVE_CAPTURE_SUPPORTED 关闭，此处防御性报错。
 *
 * 为什么只有 tabCapture 一条路（本地 Playwright 实测结论）：
 * - chrome.tabCapture.getMediaStreamId 强制要求「扩展在目标标签页被激活」
 *   （点工具栏图标/快捷键）；即使声明 tabCapture 权限 + 该站 host_permissions
 *   也会抛 "Extension has not been invoked for the current page"。
 * - 内容脚本 captureStream(video) 对跨域媒体直接抛 SecurityError
 *   （"Cannot capture from element with cross-origin data"），网课 CDN 普遍跨域。
 * - getDisplayMedia 分享选择器实测反复选错/无声，已从链路移除。
 *
 * tabCapture 会接管标签页音频输出——必须把流回放到扬声器
 * （source → destination），否则转写期间视频静音。
 */

/** 扩展未在目标标签页激活（上层据此进入「等待激活」引导流程） */
export class CaptureNeedsActivationError extends Error {
  constructor() {
    super('asrErr.captureNeedsActivation');
    this.name = 'CaptureNeedsActivationError';
  }
}

interface TabCaptureApi {
  getMediaStreamId(options: { targetTabId?: number; consumerTabId?: number }): Promise<string>;
}

function getTabCapture(): TabCaptureApi {
  const api = (globalThis as { chrome?: { tabCapture?: TabCaptureApi } }).chrome?.tabCapture;
  if (!api || typeof api.getMediaStreamId !== 'function') {
    throw new Error('asrErr.tabCaptureUnsupported');
  }
  return api;
}

function isInvocationError(e: unknown): boolean {
  return e instanceof Error && e.message.includes('has not been invoked');
}

/** 底层报错 → 可执行的指引 */
function explainCaptureError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('cannot be captured')) {
    return new Error('asrErr.pageNotCapturable');
  }
  return e instanceof Error ? e : new Error(msg);
}

export interface CaptureHandle {
  /** 停止捕获并释放 AudioContext/轨道 */
  stop(): Promise<void>;
}

/** 捕获诊断信息（音量电平旁的灰字，定位无声捕获用） */
export interface CaptureDiag {
  /** AudioContext 状态（suspended = 被自动播放策略挂起，不会有任何音频） */
  ctxState: string;
  /** 音轨状态（muted=true 表示源头无声） */
  trackMuted: boolean;
  trackReadyState: string;
  /** 音轨 label（含来源描述） */
  trackLabel?: string;
  /** 目标标签页当前是否在外放声音（2s 周期刷新） */
  tabAudible?: boolean;
  /** 站点是否被浏览器级静音（标签页右键「将这个网站静音」；此时视频元素本身并不 muted） */
  tabMuted?: boolean;
}

/** 建立 AudioContext → worklet → PCM 回调管线；passthrough 控制是否回放扬声器 */
async function buildPipeline(
  stream: MediaStream,
  onPcm: (samples: Float32Array) => void,
  passthrough: boolean,
  onDiag?: (d: CaptureDiag) => void,
  diagExtra?: () => Promise<Partial<CaptureDiag>>,
): Promise<CaptureHandle> {
  const ctx = new AudioContext();
  // 浏览器自动播放策略：点击「开始转写」的手势到捕获建立可能已过期，挂起则自动重试恢复
  const resumeIfNeeded = () => {
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  };
  resumeIfNeeded();
  ctx.onstatechange = reportDiag;
  const resumeTimer = window.setInterval(resumeIfNeeded, 1000);

  const audioTrack = stream.getAudioTracks()[0];
  let extra: Partial<CaptureDiag> = diagExtra ? await diagExtra() : {};
  function reportDiag() {
    onDiag?.({
      ctxState: ctx.state,
      trackMuted: audioTrack?.muted ?? true,
      trackReadyState: audioTrack?.readyState ?? 'ended',
      trackLabel: audioTrack?.label,
      ...extra,
    });
  }
  reportDiag();

  await ctx.audioWorklet.addModule(browser.runtime.getURL('/asr/pcm-worklet.js'));

  const source = ctx.createMediaStreamSource(stream);
  // numberOfOutputs: 0 —— worklet 只取数不外放
  const node = new AudioWorkletNode(ctx, 'kedaibiao-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    onPcm(resampleLinear(e.data, ctx.sampleRate, ASR_SAMPLE_RATE));
  };
  source.connect(node);
  if (passthrough) source.connect(ctx.destination);

  // 音轨状态变化（源头静音/恢复）也上报一次
  audioTrack?.addEventListener('mute', reportDiag);
  audioTrack?.addEventListener('unmute', reportDiag);
  // 标签页 audible/站点静音状态会随播放变化，周期刷新
  const diagTimer = window.setInterval(() => {
    if (!diagExtra) return;
    void diagExtra()
      .then((next) => {
        extra = next;
        reportDiag();
      })
      .catch(() => {});
  }, 2000);
  reportDiag();

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(resumeTimer);
      clearInterval(diagTimer);
      audioTrack?.removeEventListener('mute', reportDiag);
      audioTrack?.removeEventListener('unmute', reportDiag);
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await ctx.close().catch(() => {});
    },
  };
}

/**
 * 捕获目标标签页音频。
 * 未激活抛 CaptureNeedsActivationError（上层进入激活引导 + 自动重试），
 * 其余错误转成人话后抛出。
 */
export async function startTabAudioCapture(
  tabId: number,
  onPcm: (samples: Float32Array) => void,
  onDiag?: (d: CaptureDiag) => void,
): Promise<CaptureHandle> {
  try {
    const streamId = await getTabCapture().getMediaStreamId({ targetTabId: tabId });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // tabCapture 的约束走旧版 mandatory 形式（Chrome 历史遗留）
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      } as unknown as MediaTrackConstraints,
      video: false,
    });
    // tabCapture 接管了标签页音频 → 回放给用户
    return await buildPipeline(stream, onPcm, true, onDiag, async () => {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      return { tabAudible: tab?.audible, tabMuted: tab?.mutedInfo?.muted };
    });
  } catch (e) {
    if (isInvocationError(e)) throw new CaptureNeedsActivationError();
    throw explainCaptureError(e);
  }
}
