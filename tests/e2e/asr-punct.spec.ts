import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test as base, chromium, type BrowserContext } from '@playwright/test';

/** 扩展构建产物（pnpm build 产物目录） */
const EXT_PATH = path.resolve('.output/chrome-mv3');

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
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

declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

/** 找到 vite 打包出的标点 worker 文件名（带内容 hash） */
function punctWorkerAsset(): string {
  const name = readdirSync(path.join(EXT_PATH, 'assets')).find((f) =>
    f.startsWith('punct.worker'),
  );
  if (!name) throw new Error('构建产物中缺少 punct.worker（assets/punct.worker-*.js）');
  return `/assets/${name}`;
}

interface PunctEventView {
  type: string;
  fatal?: boolean;
  message?: string;
}

/**
 * 标点恢复 worker 链路冒烟（真实 Chromium + 真实 ort WASM 后端 + 占位模型字节）：
 * 守护的浏览器侧风险点——/ort/ 下 wasm 可达、CSP(wasm-unsafe-eval) 允许编译、
 * proxy=false 的 worker 内初始化路径、worker 打包产物可加载。
 * 模型用垃圾字节：预期在 ONNX 解析处报 fatal error（证明 ort wasm 运行时本身已初始化成功）。
 * 真模型的推理正确性由 tests/unit/asr-punct.test.ts 的集成用例覆盖。
 */
test('标点 worker 初始化链路（ort wasm 加载 → 模型解析报错）', async ({ context, extensionId }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const asset = punctWorkerAsset();
  const firstEvent = await page.evaluate(async (workerAsset) => {
    const worker = new Worker(chrome.runtime.getURL(workerAsset));
    return await new Promise<PunctEventView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待标点 worker 消息超时')), 60_000);
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`worker 加载失败：${e.message ?? 'unknown'}`));
      };
      worker.onmessage = (e: MessageEvent<PunctEventView>) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(e.data);
      };
      worker.postMessage({
        type: 'init',
        model: new Uint8Array(256).buffer,
        tokens: new TextEncoder().encode('["<blank>","<unk>","你"]').buffer,
      });
    });
  }, asset);

  expect(firstEvent.type).toBe('error');
  expect(firstEvent.fatal).toBe(true);
  expect(firstEvent.message ?? '').not.toBe('');
  // 关键断言：错误必须来自「模型字节非法」的解析阶段，而不是 wasm 后端没加载起来。
  // 曾踩过的坑：ort wasm 后端运行时需动态 import 胶水 mjs（ort-wasm-simd-threaded.mjs），
  // vite 未发出该文件时报 "Failed to fetch dynamically imported module"——
  // 若只断言"有 error"会把这类链路断裂误判为通过。
  expect(firstEvent.message ?? '').not.toMatch(
    /dynamically imported|no available backend|Failed to fetch|404/,
  );
});
