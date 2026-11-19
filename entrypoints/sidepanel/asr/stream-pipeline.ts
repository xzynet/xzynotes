import { ALL_FORMATS, AudioSampleSink, Input, StreamSource } from 'mediabunny';
import { ASR_SAMPLE_RATE, mixToMono, resampleLinear } from '~/core/asr';
import { MediaDownloadCancelledError, type MediaDownloadProgress } from './file-pipeline';
import { panelAuthorizer, type CorsAuthorizer } from './permission';

/**
 * 流式转写管线（面板内与 offscreen 宿主共用）：不落地整个媒体文件——按 Range 分段拉取
 * （mediabunny 解封装 + WebCodecs 解码），产出的 16kHz 单声道 PCM 块以异步迭代器惰性吐出，
 * 消费即喂引擎。内存占用恒定（mediabunny 源缓存默认 8MiB + 在途块），与文件时长无关。
 * 依赖服务端支持 Range；不支持（回 200）或容器/编码无法处理时抛错，由调用方回退。
 */

export interface StreamingAudio {
  /** 媒体时长（秒，来自容器元数据）；未知为 0 */
  durationSec: number;
  /** 16kHz 单声道 PCM 块流（惰性：消费时才发生网络读取与解码）；取消抛 MediaDownloadCancelledError */
  chunks: AsyncGenerator<Float32Array, void, unknown>;
}

/** 单次 Range 读取在该时长内没有任何字节到达即中止（CDN 挂起的典型症状） */
const STALL_TIMEOUT_MS = 10_000;
/** 喂引擎的 PCM 块大小：0.5s @16kHz，与 feedBuffer 一致 */
const CHUNK_SAMPLES = 8000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaDownloadCancelledError();
}

interface RangeReader {
  /** 资源总字节数（0 = 未知，取自 Content-Range） */
  readonly total: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/**
 * 建立 Range 读取器。CORS 拒绝（TypeError）时按需申请该源 host 权限并带凭据重试一次
 * （同 downloadMedia 策略：面板侧弹窗申请、宿主侧只认已授权，见 permission.ts）。
 */
async function openRangeReader(
  url: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: MediaDownloadProgress) => void;
    authorize?: CorsAuthorizer;
  },
): Promise<RangeReader> {
  const host = new URL(url).hostname;
  const startedAt = Date.now();
  let withCredentials = false;
  let total = 0;
  let maxEnd = 0;

  const report = () => {
    opts.onProgress?.({
      loaded: maxEnd,
      total,
      host,
      bytesPerSec: maxEnd > 0 ? maxEnd / ((Date.now() - startedAt) / 1000) : 0,
    });
  };

  const rangeGet = async (start: number, end: number): Promise<Uint8Array> => {
    throwIfAborted(opts.signal);
    const stall = new AbortController();
    let watchdog = window.setTimeout(() => {
      console.warn(`[kedaibiao] 读取停滞（${STALL_TIMEOUT_MS / 1000} 秒无数据）：${host}`);
      stall.abort(new Error('asrErr.readStalled'));
    }, STALL_TIMEOUT_MS);
    const combined = AbortSignal.any(
      [opts.signal, stall.signal].filter((s): s is AbortSignal => !!s),
    );
    try {
      const resp = await fetch(url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        credentials: withCredentials ? 'include' : 'omit',
        signal: combined,
      });
      if (resp.status === 200) throw new Error('asrErr.rangeNotSupported');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (!resp.body) throw new Error('asrErr.noResponseBody');
      if (!total) {
        total = Number(resp.headers.get('content-range')?.split('/')[1] ?? 0) || 0;
      }
      const reader = resp.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        throwIfAborted(opts.signal);
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.byteLength;
        maxEnd = Math.max(maxEnd, start + got);
        clearTimeout(watchdog);
        watchdog = window.setTimeout(() => {
          console.warn(`[kedaibiao] 读取停滞（${STALL_TIMEOUT_MS / 1000} 秒无数据）：${host}`);
          stall.abort(new Error('asrErr.readStalled'));
        }, STALL_TIMEOUT_MS);
        report();
      }
      const out = new Uint8Array(got);
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      return out;
    } catch (e) {
      throwIfAborted(opts.signal);
      if (stall.signal.aborted) {
        if (stall.signal.reason instanceof Error) throw stall.signal.reason;
        console.warn(`[kedaibiao] 读取停滞：${host}`);
        throw new Error('asrErr.readStalled', { cause: e });
      }
      throw e;
    } finally {
      clearTimeout(watchdog);
    }
  };

  // 1 字节探测：确认 Range 支持并取总大小；CORS 拦截时申请权限后带凭据重试一次
  try {
    await rangeGet(0, 1);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    const origin = new URL(url).origin;
    const granted = await (opts.authorize ?? panelAuthorizer)(origin);
    if (!granted) {
      console.warn(`[kedaibiao] 该媒体源（${host}）未授权跨域访问`, e);
      throw new Error('asrErr.mediaSourceNotAuthorized', { cause: e });
    }
    withCredentials = true;
    await rangeGet(0, 1);
  }
  if (!total) throw new Error('asrErr.missingContentRange');

  return {
    get total() {
      return total;
    },
    read: (start, end) => rangeGet(start, end),
  };
}

/**
 * 打开流式音频源：读取容器元数据后返回惰性 PCM 块流。
 * 元数据读取只需少量 Range 请求；真正的拉取/解码发生在 chunks 被消费时。
 */
export async function openStreamingAudio(
  url: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: MediaDownloadProgress) => void;
    authorize?: CorsAuthorizer;
  } = {},
): Promise<StreamingAudio> {
  const reader = await openRangeReader(url, opts);
  const input = new Input({
    source: new StreamSource({
      getSize: () => reader.total,
      read: (start, end) => reader.read(start, end),
      prefetchProfile: 'network',
    }),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('asrErr.noAudioTrack');
    if (!(await track.canDecode())) throw new Error('asrErr.cannotDecodeAudio');
    const durationSec = await input.computeDuration().catch(() => 0);

    const chunks = (async function* (): AsyncGenerator<Float32Array, void, unknown> {
      let pending = new Float32Array(0);
      try {
        const sink = new AudioSampleSink(track);
        for await (const sample of sink.samples()) {
          throwIfAborted(opts.signal);
          const channels: Float32Array[] = [];
          for (let c = 0; c < sample.numberOfChannels; c++) {
            const buf = new Float32Array(sample.numberOfFrames);
            sample.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
            channels.push(buf);
          }
          const mono = mixToMono(channels);
          const pcm = resampleLinear(mono, sample.sampleRate, ASR_SAMPLE_RATE);
          sample.close();
          if (pcm.length === 0) continue;
          const merged = new Float32Array(pending.length + pcm.length);
          merged.set(pending);
          merged.set(pcm, pending.length);
          let offset = 0;
          while (merged.length - offset >= CHUNK_SAMPLES) {
            yield merged.slice(offset, offset + CHUNK_SAMPLES);
            offset += CHUNK_SAMPLES;
          }
          pending = merged.slice(offset);
        }
        if (pending.length > 0) yield pending;
      } finally {
        input.dispose();
      }
    })();

    return { durationSec, chunks };
  } catch (e) {
    input.dispose();
    throw e;
  }
}
