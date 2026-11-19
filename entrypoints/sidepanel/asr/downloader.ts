import {
  MODEL_BASE_URLS,
  modelFileUrl,
  type AsrModelFile,
  type DownloadableModel,
} from '~/core/asr';
import { isModelCached, putModelFile } from './model-store';

/**
 * 模型下载器：逐文件 fetch + ReadableStream 读进度，整文件落 IndexedDB。
 * 每个文件按 MODEL_BASE_URLS 顺序尝试镜像；半成品不写入缓存，
 * 取消/失败后重试以文件为粒度续传（已完成的文件直接跳过）。
 *
 * 断点续传：传入 partials 后，当前文件的已收字节会留在内存里，
 * 换源/失败重试时带 `Range: bytes=<已收>-` 续传，不必从 0 重下
 * （模型单个文件上百 MB，重下代价过高）。服务端不支持 Range（回 200）时自动从头来。
 */

export interface DownloadProgress {
  /** 当前正在下载的文件路径 */
  file: string;
  /** 当前文件已下载字节 */
  fileLoaded: number;
  fileTotal: number;
  /** 整个模型累计已下载字节（含先前完成的文件） */
  loaded: number;
  /** 整个模型总字节（注册表预估值） */
  total: number;
}

export interface DownloadOptions {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** 断点续传缓冲（跨调用复用；见 createDownloadPartials） */
  partials?: DownloadPartials;
}

/** 单个文件的未完成字节（内存态：宿主/面板进程存活期间有效） */
export interface PartialDownload {
  chunks: Uint8Array[];
  received: number;
}

export type DownloadPartials = Map<string, PartialDownload>;

/** 建一份续传缓冲（同一次会话内的多次重试共用） */
export function createDownloadPartials(): DownloadPartials {
  return new Map();
}

export class DownloadCancelledError extends Error {
  constructor() {
    super('asrErr.downloadCancelled');
    this.name = 'DownloadCancelledError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DownloadCancelledError();
}

/**
 * 单文件单源下载（可续传），返回完整字节；失败抛错交给上层换源。
 * partial 里的已收字节会被追加保留，换源后可直接续，故这里只在「从 0 重来」时清空它。
 */
async function fetchFile(
  url: string,
  expectedBytes: number,
  file: AsrModelFile,
  partial: PartialDownload | undefined,
  baseProgress: DownloadProgress,
  onProgress: ((p: DownloadProgress) => void) | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const resumeFrom = partial?.received ?? 0;
  const resp = await fetch(url, {
    signal,
    headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!resp.body) throw new Error('asrErr.noResponseBody');

  // 只有服务端确认按 Range 续传（206）才认已收字节；回 200 说明不支持，从头开始
  const resuming = resumeFrom > 0 && resp.status === 206;
  // 浅拷贝一份「续传头」，避免与随后继续增长的 partial.chunks 别名导致重复拼接
  const head = resuming ? [...(partial?.chunks ?? [])] : [];
  if (partial && !resuming && partial.received > 0) {
    partial.chunks = [];
    partial.received = 0;
  }
  let fileLoaded = head.reduce((acc, c) => acc + c.byteLength, 0);

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    fileLoaded += value.byteLength;
    // 边下边留在续传缓冲里，换源/重试可从这里接上
    if (partial) {
      partial.chunks.push(value);
      partial.received += value.byteLength;
    }
    onProgress?.({
      ...baseProgress,
      fileLoaded,
      loaded: baseProgress.loaded + fileLoaded,
    });
  }

  const merged = new Uint8Array(fileLoaded);
  let offset = 0;
  for (const c of head) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  if (expectedBytes > 0 && merged.byteLength !== expectedBytes) {
    console.warn(`[kedaibiao] 文件大小校验失败：预期 ${expectedBytes}，实际 ${merged.byteLength}`);
    if (partial) {
      // 字节对不上（镜像不一致/续传错位）：丢弃缓冲，下次从 0 重来
      partial.chunks = [];
      partial.received = 0;
    }
    throw new Error('asrErr.fileSizeMismatch');
  }
  return merged;
}

/**
 * 确保模型文件全部就绪（已缓存的跳过）。
 * 失败抛 Error（DownloadCancelledError 表示用户取消）。
 */
export async function ensureModelDownloaded(
  spec: DownloadableModel,
  opts: DownloadOptions = {},
): Promise<void> {
  if (await isModelCached(spec)) return;

  const { onProgress, signal, partials } = opts;
  let finishedBytes = 0;

  for (const file of spec.files) {
    throwIfAborted(signal);
    // 续传缓冲要在下载前就挂到 map 上，否则收满的字节没人接住（换源就没得续）
    let partial = partials?.get(file.path);
    if (partials && !partial) {
      partial = { chunks: [], received: 0 };
      partials.set(file.path, partial);
    }
    const base: DownloadProgress = {
      file: file.path,
      fileLoaded: partial?.received ?? 0,
      fileTotal: file.bytes,
      loaded: finishedBytes + (partial?.received ?? 0),
      total: spec.totalBytes,
    };
    onProgress?.(base);

    let bytes: Uint8Array | null = null;
    let lastError: unknown = null;
    for (const baseUrl of MODEL_BASE_URLS) {
      try {
        bytes = await fetchFile(
          modelFileUrl(spec, file, baseUrl),
          file.bytes,
          file,
          partial,
          base,
          onProgress,
          signal,
        );
        break;
      } catch (e) {
        if (e instanceof DownloadCancelledError) throw e;
        lastError = e;
        // 换源：保留续传缓冲（下次带 Range 从断点接着下）
        onProgress?.({ ...base, fileLoaded: partial?.received ?? 0, loaded: finishedBytes });
      }
    }
    if (!bytes) {
      console.warn(
        `[kedaibiao] 模型文件 ${file.path} 下载失败：`,
        lastError instanceof Error ? lastError.message : String(lastError),
      );
      throw new Error('asrErr.modelFileDownloadFailed');
    }

    await putModelFile(spec.id, file.path, new Blob([bytes.buffer as ArrayBuffer]));
    partials?.delete(file.path);
    finishedBytes += file.bytes;
    onProgress?.({
      ...base,
      fileLoaded: file.bytes,
      loaded: finishedBytes,
    });
  }
}
