import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test as base, chromium, type BrowserContext } from '@playwright/test';

/** 扩展构建产物（pnpm build 产物目录） */
const EXT_PATH = path.resolve('.output/chrome-mv3');

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      // channel: 'chromium' 用完整版浏览器（headless shell 不支持扩展）
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await use(new URL(sw.url()).host);
  },
});

/** 生成 3 秒 16kHz 单声道正弦波 WAV（440Hz，覆盖"有声"断言） */
function makeToneWav(): Buffer {
  const rate = 16_000;
  const seconds = 3;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.6 * 32767);
    data.writeInt16LE(s, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); // PCM 块大小
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // 字节率
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // 位深
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 扩展页内的 chrome.*（页面上下文无扩展类型定义） */
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  tabs: {
    query(query: { active?: boolean; lastFocusedWindow?: boolean }): Promise<Array<{ id?: number }>>;
  };
};

/**
 * 真实链路：真实 B 站视频页 → content script 解析媒体源（playurl）→ 面板上下文 Range 拉取 CDN。
 * 依赖外网，拉不通时跳过（与 extension.spec.ts 的在线测试同策略）。
 */
test('B站真实页面：解析媒体源 + 面板上下文直连 CDN', async ({ context, extensionId }) => {
  test.setTimeout(120_000);
  const bvid: string | null = await fetch(
    'https://api.bilibili.com/x/web-interface/popular?ps=1',
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com' } },
  )
    .then(async (r) => {
      const json = (await r.json()) as { data?: { list?: Array<{ bvid?: string }> } };
      return json.data?.list?.[0]?.bvid ?? null;
    })
    .catch(() => null);
  if (!bvid) {
    test.skip(true, '无法访问 B站 API（离线环境跳过）');
    return;
  }

  // 先开面板页、再开视频页：让视频页保持 lastFocusedWindow 的活动标签，
  // 面板侧 chrome.tabs.query({active}) 才能取到它（面板页本身是普通标签页会抢 active）
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const videoPage = await context.newPage();
  await videoPage.goto(`https://www.bilibili.com/video/${bvid}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  // 内容脚本就绪标志
  await videoPage.locator('#kedaibiao-launcher').waitFor({ timeout: 20_000 });

  // 面板上下文：经 background 转发 content script 解析媒体源，再直连 CDN 拉 1KB
  const result = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) return { error: '未找到活动标签页' } as const;
    const resp = (await chrome.runtime.sendMessage({
      type: 'media:resolveAudio',
      tabId,
    })) as { ok: boolean; data?: string[] | null; error?: string };
    if (!resp.ok) return { error: resp.error ?? '消息失败' } as const;
    const urls = resp.data;
    if (!urls || urls.length === 0) return { error: '未解析到媒体源' } as const;
    const url = urls[0]!;
    const probe = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
    });
    const buf = await probe.arrayBuffer();
    return {
      error: null,
      url,
      status: probe.status,
      bytes: buf.byteLength,
    } as const;
  });

  if (result.error) {
    test.skip(true, `在线解析跳过：${result.error}`);
    return;
  }
  expect(result.url).toMatch(/^https:\/\/[^/]*bilivideo\.com\//);
  expect([200, 206]).toContain(result.status);
  expect(result.bytes).toBeGreaterThan(0);
});

/** 面板内下载 + OfflineAudioContext 解码重采样（本地 WAV 经路由提供，不依赖外网） */
test('文件转写管线：面板内下载 + decodeAudioData 解码为 16kHz 单声道', async ({
  context,
  extensionId,
}) => {
  const wav = makeToneWav();
  await context.route('https://media.kedaibiao.test/clip.wav', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: {
        'content-length': String(wav.length),
        'access-control-allow-origin': '*',
      },
      body: wav,
    }),
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const result = await page.evaluate(async () => {
    // 与 entrypoints/sidepanel/asr/file-pipeline.ts 同构的最小流程
    const resp = await fetch('https://media.kedaibiao.test/clip.wav');
    const total = Number(resp.headers.get('content-length') ?? 0);
    const reader = resp.body!.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let progressEvents = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      progressEvents++;
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const buf = await ctx.decodeAudioData(merged.buffer);
    const pcm = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    return {
      total,
      loaded,
      progressEvents,
      decodedLength: pcm.length,
      sampleRate: buf.sampleRate,
      rms: Math.sqrt(sum / pcm.length),
    };
  });

  expect(result.loaded).toBe(wav.length);
  expect(result.total).toBe(wav.length);
  expect(result.progressEvents).toBeGreaterThan(0);
  expect(result.sampleRate).toBe(16000);
  // 3 秒 @16kHz（解码长度允许微小端点差异）
  expect(Math.abs(result.decodedLength - 48_000)).toBeLessThan(2000);
  // 正弦波 RMS ≈ 0.6/√2 ≈ 0.42，显著大于 0 即证明有声
  expect(result.rms).toBeGreaterThan(0.1);
});

/** mediabunny 模块构建（带扩展名的相对导入，浏览器可直接加载），经路由挂到测试源 */
const MB_MODULES_ROOT = path.resolve('node_modules/mediabunny/dist/modules');

/** evaluate 里动态导入 mediabunny 的最小类型（只列本测试用到的面） */
interface MediabunnyModule {
  Input: new (opts: { source: unknown; formats: unknown }) => {
    getPrimaryAudioTrack(): Promise<{ canDecode(): Promise<boolean> } | null>;
    computeDuration(): Promise<number>;
    dispose(): void;
  };
  StreamSource: new (opts: {
    getSize: () => number;
    read: (start: number, end: number) => Promise<Uint8Array>;
    prefetchProfile?: string;
  }) => unknown;
  AudioSampleSink: new (track: unknown) => {
    samples(): AsyncGenerator<
      {
        sampleRate: number;
        numberOfChannels: number;
        numberOfFrames: number;
        copyTo(dest: Float32Array, opts: { planeIndex: number; format: string }): void;
        close(): void;
      },
      void,
      unknown
    >;
  };
  ALL_FORMATS: unknown;
}

/**
 * 流式转写管线（stream-pipeline.ts 同构流程）的真实浏览器验证：
 * Range 分段读取 + mediabunny 流式解封装/解码 → 16kHz PCM。
 * 用普通页面上下文（非扩展页）：扩展页 CSP script-src 'self' 禁止远程模块 import，
 * 而该链路本身不依赖扩展 API（CORS 由路由放行，不触发权限申请分支）。
 */
test('流式转写管线：Range 分段读取 + mediabunny 流式解码为 PCM', async ({ context }) => {
  const wav = makeToneWav();
  let rangeRequests = 0;

  await context.route('https://stream.test/mb/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/mb\//, '');
    const file = path.join(MB_MODULES_ROOT, rel);
    if (!file.startsWith(MB_MODULES_ROOT)) {
      await route.fulfill({ status: 403 });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: readFileSync(file),
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });

  // mediabunny 模块构建会静态 import 'node:fs/promises'（node 专用 FileSource 用，
  // 浏览器路径运行时不会触达），用 import map  shim 成空模块让裸 ESM 可加载
  await context.route('https://stream.test/mb-shim.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {};' }),
  );

  await context.route('https://stream.test/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<html><head><script type="importmap">
        {"imports":{"node:fs/promises":"https://stream.test/mb-shim.js"}}
      </script></head></html>`,
    }),
  );

  await context.route('https://stream.test/clip.wav', async (route) => {
    const range = (await route.request().headers())['range'];
    const headers = {
      'access-control-allow-origin': '*',
      'content-type': 'audio/wav',
    };
    // 无 Range 的请求回 200：流式管线依赖分段读取，借此验证请求都带 Range
    if (!range) {
      await route.fulfill({
        status: 200,
        headers: { ...headers, 'content-length': String(wav.length) },
        body: wav,
      });
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m?.[1] ?? 0);
    const end = m?.[2] ? Math.min(Number(m[2]), wav.length - 1) : wav.length - 1;
    rangeRequests++;
    await route.fulfill({
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${wav.length}`,
        'content-length': String(end - start + 1),
      },
      body: wav.subarray(start, end + 1),
    });
  });

  const page = await context.newPage();
  await page.goto('https://stream.test/');

  const result = await page.evaluate(async () => {
    // 变量形式的 specifier：tsc 不做静态解析（该模块由测试路由在浏览器侧提供）
    const mbUrl = 'https://stream.test/mb/src/index.js';
    const mb = (await import(mbUrl)) as unknown as MediabunnyModule;
    const url = 'https://stream.test/clip.wav';
    // 与 entrypoints/sidepanel/asr/stream-pipeline.ts 同构的最小流程
    const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const total = Number(probe.headers.get('content-range')?.split('/')[1] ?? 0);
    const input = new mb.Input({
      source: new mb.StreamSource({
        getSize: () => total,
        read: async (start, end) => {
          const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
          return new Uint8Array(await resp.arrayBuffer());
        },
        prefetchProfile: 'network',
      }),
      formats: mb.ALL_FORMATS,
    });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { error: '无音轨' } as const;
    const canDecode = await track.canDecode();
    const durationSec = await input.computeDuration();
    const sink = new mb.AudioSampleSink(track);
    let frames = 0;
    let sum = 0;
    let sampleRate = 0;
    for await (const sample of sink.samples()) {
      sampleRate = sample.sampleRate;
      const buf = new Float32Array(sample.numberOfFrames);
      sample.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      frames += sample.numberOfFrames;
      sample.close();
    }
    input.dispose();
    return {
      error: null,
      total,
      canDecode,
      durationSec,
      frames,
      sampleRate,
      rms: Math.sqrt(sum / Math.max(1, frames)),
    } as const;
  });

  expect(result.error ?? null).toBeNull();
  if (result.error) return;
  expect(result.total).toBe(wav.length);
  expect(result.canDecode).toBe(true);
  expect(result.sampleRate).toBe(16000);
  // 时长 ≈ 3 秒，帧数 ≈ 48000（允许端点差异）
  expect(Math.abs(result.durationSec - 3)).toBeLessThan(0.2);
  expect(Math.abs(result.frames - 48_000)).toBeLessThan(2000);
  expect(result.rms).toBeGreaterThan(0.1);
  // 探测 + 至少一次数据读取：确实走了 Range 分段
  expect(rangeRequests).toBeGreaterThanOrEqual(2);
});
