import { ASR_SAMPLE_RATE, mixToMono } from '~/core/asr';
import { panelAuthorizer, type CorsAuthorizer } from './permission';

/**
 * 文件模式转写的媒体管线（面板内与 offscreen 宿主共用）：
 *   下载媒体文件（带进度/取消/停滞看门狗/CORS 授权回退）→ decodeAudioData 解码为 16kHz 单声道 PCM。
 * 下载发生在扩展页上下文：CDN 反射 Origin 时直连；不反射时经 authorize 授权后带凭据重试
 * （optional_host_permissions 已覆盖 <all_urls>）。
 */

export interface MediaDownloadProgress {
  loaded: number;
  /** 0 = 未知（无 Content-Length） */
  total: number;
  /** 当前下载来源主机名（诊断用） */
  host: string;
  /** 平均速度（字节/秒），连接中为 0 */
  bytesPerSec: number;
}

export class MediaDownloadCancelledError extends Error {
  constructor() {
    super('asrErr.downloadCancelled');
    this.name = 'MediaDownloadCancelledError';
  }
}

/** 连续 N 毫秒没有任何字节到达判定为停滞（CDN 防盗链挂起/僵尸连接的典型症状） */
const STALL_TIMEOUT_MS = 10_000;
/** 防盗链 CDN 的另一种症状：连接不断但持续滴流（平均速度低于阈值即放弃） */
const CRAWL_MIN_BYTES_PER_SEC = 32 * 1024;
const CRAWL_GRACE_MS = 30_000;

/** HLS/DASH 清单地址 decodeAudioData 解不了，文件模式直接跳过 */
export function isDownloadableMediaUrl(url: string): boolean {
  return !/\.(m3u8|mpd)(\?|#|$)/i.test(url);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaDownloadCancelledError();
}

async function fetchMediaOnce(
  url: string,
  withCredentials: boolean,
  onProgress: ((p: MediaDownloadProgress) => void) | undefined,
  signal?: AbortSignal,
): Promise<Blob> {
  const host = new URL(url).hostname;
  const startedAt = Date.now();
  const report = (loaded: number, total: number) =>
    onProgress?.({
      loaded,
      total,
      host,
      bytesPerSec: loaded > 0 ? loaded / ((Date.now() - startedAt) / 1000) : 0,
    });

  // 停滞看门狗：任何字节到达都重置计时；超时未动则中止本源
  const stall = new AbortController();
  let watchdog = 0;
  const resetWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      console.warn(`[kedaibiao] 下载停滞（${STALL_TIMEOUT_MS / 1000} 秒无数据）：${host}`);
      stall.abort(new Error('asrErr.downloadStalled'));
    }, STALL_TIMEOUT_MS);
  };
  // 滴流看门狗：宽限期结束时平均速度仍低于阈值 → 防盗链 CDN 在拖死下载，中止
  const crawlTimer = window.setTimeout(() => {
    if (lastLoaded / (CRAWL_GRACE_MS / 1000) < CRAWL_MIN_BYTES_PER_SEC) {
      console.warn(`[kedaibiao] 下载速度过低（防盗链限速）：${host}`);
      stall.abort(new Error('asrErr.downloadTooSlow'));
    }
  }, CRAWL_GRACE_MS);
  let lastLoaded = 0;
  const combinedSignals = [signal, stall.signal].filter((s): s is AbortSignal => !!s);
  const combined = AbortSignal.any(combinedSignals);

  report(0, 0);
  resetWatchdog();
  try {
    const resp = await fetch(url, {
      signal: combined,
      credentials: withCredentials ? 'include' : 'omit',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!resp.body) throw new Error('asrErr.noResponseBody');
    const total = Number(resp.headers.get('content-length') ?? 0);
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      lastLoaded = loaded;
      resetWatchdog();
      report(loaded, total);
      // 宽限期后每次心跳都做速度检查
      const elapsed = Date.now() - startedAt;
      if (
        elapsed > CRAWL_GRACE_MS &&
        total > 0 &&
        loaded < total &&
        loaded / (elapsed / 1000) < CRAWL_MIN_BYTES_PER_SEC
      ) {
        console.warn(`[kedaibiao] 下载速度过低（防盗链限速）：${host}`);
        stall.abort(new Error('asrErr.downloadTooSlow'));
      }
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    const type = resp.headers.get('content-type') ?? '';
    return new Blob([merged.buffer as ArrayBuffer], { type: type.split(';')[0] || 'video/mp4' });
  } catch (e) {
    // 用户主动取消优先；看门狗中止带原因
    throwIfAborted(signal);
    if (stall.signal.aborted) {
      if (stall.signal.reason instanceof Error) throw stall.signal.reason;
      console.warn(`[kedaibiao] 下载停滞：${host}`);
      throw new Error('asrErr.downloadStalled', { cause: e });
    }
    throw e;
  } finally {
    clearTimeout(watchdog);
    clearTimeout(crawlTimer);
  }
}

/**
 * 下载媒体文件。CORS 拒绝（TypeError）时按需申请该源 host 权限并带凭据重试一次。
 * 权限申请需在用户手势有效期内——本函数只在下载按钮点击链路上首次失败时触发；
 * 宿主（offscreen）侧传 authorize = hostAuthorizer（不能弹窗，只认已授权）。
 */
export async function downloadMedia(
  url: string,
  opts: {
    onProgress?: (p: MediaDownloadProgress) => void;
    signal?: AbortSignal;
    authorize?: CorsAuthorizer;
  } = {},
): Promise<Blob> {
  try {
    return await fetchMediaOnce(url, false, opts.onProgress, opts.signal);
  } catch (e) {
    // CORS 拦截表现为 TypeError: Failed to fetch；其余错误直接上抛
    if (!(e instanceof TypeError)) throw e;
    const origin = new URL(url).origin;
    const granted = await (opts.authorize ?? panelAuthorizer)(origin);
    if (!granted) {
      console.warn(`[kedaibiao] 该媒体源（${new URL(url).hostname}）未授权跨域访问`, e);
      throw new Error('asrErr.mediaSourceNotAuthorized', { cause: e });
    }
    return fetchMediaOnce(url, true, opts.onProgress, opts.signal);
  }
}

/**
 * 解码为 16kHz 单声道 PCM。
 * OfflineAudioContext 的 decodeAudioData 会按上下文采样率重采样；
 * 多声道由 mixToMono 平均混合。
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, ASR_SAMPLE_RATE);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let i = 0; i < buf.numberOfChannels; i++) channels.push(buf.getChannelData(i));
  return mixToMono(channels);
}
