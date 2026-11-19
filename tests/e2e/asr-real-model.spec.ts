import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { ASR_MODELS } from '../../core/asr';

/**
 * 真实模型端到端：把真 Paraformer 模型 + 真语音喂给宿主，验证整条链路真的能出文本。
 *
 * 其它宿主用例都用「模型缺失」走通传输与状态机，跑不到引擎；这一条补上引擎与落盘：
 *   本地 HTTP 提供模型文件与语音 → 面板页把模型写进扩展缓存 → 宿主下载/解码媒体、
 *   在 offscreen 文档里装真实引擎、跑推理 → 断言跑完、进度对齐、文本已落盘、面板切到字幕视图。
 *
 * 依赖本地缓存（不进仓库，缺失即跳过，CI 不受影响）：
 *   .cache/sherpa-wasm/models/  真实模型（见 scripts/verify-sherpa-runtime.mjs 的下载说明）
 *   .cache/asr-test/0.wav       真实语音（模型仓库的 test_wavs/0.wav）
 */

const EXT_PATH = path.resolve('.output/chrome-mv3');
const MODEL_DIR = path.resolve('.cache/sherpa-wasm/models');
const CLIP_PATH = path.resolve('.cache/asr-test/0.wav');

/** 注册表里的模型文件 → 本地缓存文件名（与 verify-sherpa-runtime.mjs 一致） */
const MODEL_DISK_NAMES: Record<string, string> = {
  'encoder.int8.onnx': 'paraformer-encoder.int8.onnx',
  'decoder.int8.onnx': 'paraformer-decoder.int8.onnx',
  'tokens.txt': 'paraformer-tokens.txt',
};

const HAS_FIXTURES =
  existsSync(CLIP_PATH) &&
  Object.values(MODEL_DISK_NAMES).every((f) => existsSync(path.join(MODEL_DIR, f)));

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    getContexts(filter: { contextTypes: string[] }): Promise<Array<{ contextType: string }>>;
  };
  windows: { getCurrent(): Promise<{ id?: number }> };
};

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      locale: 'zh-CN',
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

/** 本地 HTTP（CORS 全放行）：扩展页与宿主文档都从真实网络栈取，避免大文件走 CDP */
async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cors = { 'access-control-allow-origin': '*' };
    let filePath: string | null = null;
    let type = 'application/octet-stream';
    if (url.pathname === '/clip.wav') {
      filePath = CLIP_PATH;
      type = 'audio/wav';
    } else if (url.pathname.startsWith('/model/')) {
      const disk = MODEL_DISK_NAMES[decodeURIComponent(url.pathname.slice('/model/'.length))];
      if (disk) filePath = path.join(MODEL_DIR, disk);
    }
    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404, cors).end();
      return;
    }
    res.writeHead(200, { ...cors, 'content-type': type, 'content-length': String(statSync(filePath).size) });
    createReadStream(filePath).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Snapshot {
  state: {
    courseId: string | null;
    mode: string;
    phase: string;
    running: boolean;
    processedSec: number;
    mediaStage: string | null;
    mediaLoaded: number;
    mediaTotal: number;
    modelLoaded: number;
    error: string | null;
  };
  cues: Array<{ start: number; end: number; text: string }>;
}

async function hostCmd(page: Page, command: unknown): Promise<Snapshot> {
  return (await page.evaluate(async (cmd) => {
    const resp = (await chrome.runtime.sendMessage({ type: 'asr:hostCommand', command: cmd })) as
      | { ok: boolean; data?: unknown; error?: string }
      | undefined;
    if (!resp?.ok) throw new Error(resp?.error ?? 'asr:hostCommand 无响应');
    return resp.data;
  }, command)) as Snapshot;
}

const FAKE_CONTEXT = {
  course: {
    id: 'e2e-real-model-course',
    platform: 'generic',
    title: '真实模型测试课程',
    url: 'https://example.invalid/video',
    summary: '',
  },
  tabId: 999_999,
  windowId: -1,
  degraded: false,
};

/** 反复广播课程上下文，直到面板把该课程视图渲染出来 */
async function pushCourseContext(
  context: BrowserContext,
  extensionId: string,
  panel: Page,
): Promise<void> {
  const windowId = (await panel.evaluate(() => chrome.windows.getCurrent().then((w) => w.id))) as
    | number
    | undefined;
  const sender = await context.newPage();
  await sender.goto(`chrome-extension://${extensionId}/options.html`);
  await expect
    .poll(
      async () => {
        await sender.evaluate(
          async (payload) => {
            await chrome.runtime.sendMessage({ type: 'course:context', ...payload }).catch(() => undefined);
          },
          { windowId: windowId ?? -1, context: FAKE_CONTEXT },
        );
        return panel.getByText(FAKE_CONTEXT.course.title).count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await sender.close();
}

test.describe('真实模型端到端', () => {
  test.skip(!HAS_FIXTURES, '缺少本地真实模型/语音缓存（见文件头说明）');

  test('宿主内真 Paraformer 转写真实语音：出文本并落盘', async ({ context, extensionId }) => {
    // 装引擎 + 237MB 模型读取 + 推理，给足时间
    test.setTimeout(600_000);
    const fixture = await startFixtureServer();
    try {
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await expect(panel.getByRole('button', { name: '全部课程' })).toBeVisible();
      // 让转写卡片挂起来：既触发 Dexie 建库（后面直接写缓存），也顺带验证面板侧视图
      await pushCourseContext(context, extensionId, panel);
      await panel.getByRole('button', { name: '当前课程' }).click();
      await expect(panel.getByText('本地语音转写（无字幕兜底）')).toBeVisible({ timeout: 20_000 });

      // 1) 用面板页把真实模型写进扩展缓存（走本地 HTTP，字节数与注册表一致）
      const spec = ASR_MODELS['paraformer-streaming'];
      const seeded = await panel.evaluate(
        async ({ origin, modelId, files }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('kedaibiao-asr');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (!db.objectStoreNames.contains('files')) {
            db.close();
            throw new Error('test setup: kedaibiao-asr 缺少 files 存储（转写卡片尚未初始化？）');
          }
          const sizes: Record<string, number> = {};
          for (const f of files) {
            const resp = await fetch(`${origin}/model/${encodeURIComponent(f.path)}`);
            if (!resp.ok) throw new Error(`模型文件 ${f.path} HTTP ${resp.status}`);
            const blob = await resp.blob();
            sizes[f.path] = blob.size;
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction('files', 'readwrite');
              tx.objectStore('files').put({
                key: `${modelId}/${f.path}`,
                modelId,
                path: f.path,
                bytes: blob.size,
                blob,
                updatedAt: Date.now(),
              });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
          }
          db.close();
          return sizes;
        },
        {
          origin: fixture.origin,
          modelId: spec.id,
          files: spec.files.map((f) => ({ path: f.path, bytes: f.bytes })),
        },
      );
      // 落库字节数必须与注册表一致，否则 isModelCached 判定不完整
      for (const f of spec.files) expect(seeded[f.path]).toBe(f.bytes);

      // 2) 下发宿主文件转写（媒体 = 本地真实语音）
      await hostCmd(panel, {
        type: 'asrHost:start',
        courseId: FAKE_CONTEXT.course.id,
        modelId: spec.id,
        mode: 'file',
        urls: [`${fixture.origin}/clip.wav`],
        punct: false,
      });

      // 3) 等宿主跑完（真引擎推理，放长超时）；每步打印状态，卡住时能看出卡在哪一段
      const deadline = Date.now() + 300_000;
      let final = await hostCmd(panel, { type: 'asrHost:status', sinceCue: 0 });
      while (Date.now() < deadline && final.state.phase !== 'done' && final.state.phase !== 'error') {
        await panel.waitForTimeout(2000);
        final = await hostCmd(panel, { type: 'asrHost:status', sinceCue: 0 });
        const s = final.state;
        console.log(
          `[host] phase=${s.phase} mediaStage=${s.mediaStage} media=${s.mediaLoaded}/${s.mediaTotal} ` +
            `model=${s.modelLoaded} processed=${s.processedSec.toFixed(1)} cues=${final.cues.length}` +
            (s.error ? ` error=${s.error}` : ''),
        );
      }
      expect(final.state.phase).toBe('done');
      expect(final.state.running).toBe(false);
      // 进度对齐音频时长（10s 左右），说明媒体确实被完整解码并喂进引擎
      expect(final.state.processedSec).toBeGreaterThan(8);
      // 真实语音 → 真实文本
      expect(final.cues.length).toBeGreaterThan(0);
      const merged = final.cues.map((c) => c.text).join('');
      expect(merged.trim().length).toBeGreaterThan(4);

      // 4) 结果已落盘（宿主自己保存，不依赖面板在场）
      const saved = (await panel.evaluate(
        async (courseId) =>
          (await chrome.runtime.sendMessage({ type: 'transcript:get', courseId })) as {
            data?: { cues?: Array<{ text: string }> } | null;
          },
        FAKE_CONTEXT.course.id,
      )) as { data?: { cues?: Array<{ text: string }> } | null };
      const savedText = (saved.data?.cues ?? []).map((c) => c.text).join('');
      expect(savedText.trim().length).toBeGreaterThan(4);

      // 5) 面板据转写完成切到字幕视图（不再是无字幕兜底卡片）
      await expect(panel.getByText('该视频暂无字幕')).toHaveCount(0, { timeout: 60_000 });
    } finally {
      await fixture.close();
    }
  });
});
