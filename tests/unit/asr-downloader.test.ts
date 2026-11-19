import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadableModel } from '../../core/asr';
import {
  createDownloadPartials,
  DownloadCancelledError,
  ensureModelDownloaded,
  type DownloadProgress,
} from '../../entrypoints/sidepanel/asr/downloader';
import { isModelCached, listCachedFiles } from '../../entrypoints/sidepanel/asr/model-store';

/**
 * 模型下载器的断点续传：模型单个文件上百 MB，换源/失败重试必须能从断点接着下，
 * 否则每次失败都要从 0 重来。这里用假 fetch 精确控制「半途中断 → 换源续传」的字节流。
 */

const SPEC: DownloadableModel = {
  id: 'test-model',
  hfRepo: 'test/repo',
  files: [
    { path: 'a.bin', bytes: 6 },
    { path: 'b.bin', bytes: 4 },
  ],
  totalBytes: 10,
};

/** 镜像 1 / 镜像 2 的地址（与 MODEL_BASE_URLS 顺序一致） */
const FILE_A_PRIMARY = `https://huggingface.co/${SPEC.hfRepo}/resolve/main/a.bin`;
const FILE_A_MIRROR = `https://hf-mirror.com/${SPEC.hfRepo}/resolve/main/a.bin`;

const bytesOf = (n: number, fill: number) => new Uint8Array(n).fill(fill);

function bodyOf(bytes: Uint8Array, chunks?: Uint8Array[]): ReadableStream<Uint8Array> {
  const parts = chunks ?? [bytes];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

/** 先吐一半再断流：模拟下载中途网络中断（读取方抛错，不是正常收尾） */
function brokenHalfBody(half: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(half);
      // 异步报错：让已入队的一半先被读走，下一次 read 才抛（真机是连接中断）
      setTimeout(() => controller.error(new Error('network reset')), 0);
    },
  });
}

const ok = (bytes: Uint8Array, status = 200) => new Response(bodyOf(bytes), { status });

beforeEach(async () => {
  // 每次测试都从空缓存开始
  const { deleteModelFiles } = await import('../../entrypoints/sidepanel/asr/model-store');
  await deleteModelFiles(SPEC.id).catch(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asr/downloader · 模型下载与断点续传', () => {
  it('正常下载：逐文件落库，进度按累计字节推进', async () => {
    const a = bytesOf(6, 1);
    const b = bytesOf(4, 2);
    const fetchMock = vi.fn(async (url: string) => (url.includes('a.bin') ? ok(a) : ok(b)));
    vi.stubGlobal('fetch', fetchMock);

    const progress: DownloadProgress[] = [];
    await ensureModelDownloaded(SPEC, { onProgress: (p) => progress.push(p) });

    expect(await isModelCached(SPEC)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ loaded: 10, total: 10, file: 'b.bin' });
  });

  it('中途中断 → 换源时带 Range 从断点续传，最终字节完整', async () => {
    const a = bytesOf(6, 1);
    const b = bytesOf(4, 2);
    const headers: Array<Record<string, string> | undefined> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string> | undefined);
      if (url === FILE_A_PRIMARY) return new Response(brokenHalfBody(a.slice(0, 3)), { status: 200 });
      if (url === FILE_A_MIRROR) return ok(a.slice(3), 206); // 镜像按 Range 只回剩余字节
      return ok(b);
    });
    vi.stubGlobal('fetch', fetchMock);

    const partials = createDownloadPartials();
    await ensureModelDownloaded(SPEC, { partials });

    // 换源那次必须带 Range: bytes=3-
    expect(headers[0]).toBeUndefined();
    expect(headers[1]).toEqual({ Range: 'bytes=3-' });
    // 续传缓冲在文件完成后清掉
    expect(partials.size).toBe(0);
    expect(await isModelCached(SPEC)).toBe(true);
    const cached = await listCachedFiles(SPEC.id);
    expect(cached.find((f) => f.path === 'a.bin')?.bytes).toBe(6);
  });

  it('服务端不支持 Range（回 200）时自动从头下，结果仍正确', async () => {
    const a = bytesOf(6, 1);
    const b = bytesOf(4, 2);
    const headers: Array<Record<string, string> | undefined> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string> | undefined);
      if (url === FILE_A_PRIMARY) return new Response(brokenHalfBody(a.slice(0, 3)), { status: 200 });
      if (url === FILE_A_MIRROR) return ok(a, 200); // 忽略 Range，整文件重发
      return ok(b);
    });
    vi.stubGlobal('fetch', fetchMock);

    const partials = createDownloadPartials();
    await ensureModelDownloaded(SPEC, { partials });

    expect(headers[1]).toEqual({ Range: 'bytes=3-' });
    expect(await isModelCached(SPEC)).toBe(true);
    expect(partials.size).toBe(0);
  });

  it('字节数不符：报错并丢弃续传缓冲（避免错位续传）', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('a.bin') ? ok(bytesOf(5, 1)) : ok(bytesOf(4, 2)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const partials = createDownloadPartials();
    await expect(ensureModelDownloaded(SPEC, { partials })).rejects.toThrow(
      'asrErr.modelFileDownloadFailed',
    );
    expect(partials.get('a.bin')?.received).toBe(0);
    expect(await isModelCached(SPEC)).toBe(false);
  });

  it('取消：抛 DownloadCancelledError 且不落库', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return ok(bytesOf(6, 1));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ensureModelDownloaded(SPEC, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(await isModelCached(SPEC)).toBe(false);
  });
});
