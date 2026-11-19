import { readdirSync } from 'node:fs';
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

/** 扩展页内的 chrome.runtime.getURL（页面上下文无扩展类型定义） */
declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

/** 找到 vite 打包出的引擎 worker 文件名（带内容 hash） */
function engineWorkerAsset(): string {
  const name = readdirSync(path.join(EXT_PATH, 'assets')).find((f) => f.startsWith('engine.worker'));
  if (!name) throw new Error('构建产物中缺少 engine.worker（assets/engine.worker-*.js）');
  return `/assets/${name}`;
}

interface EngineEventView {
  type: string;
  message?: string;
}

/**
 * 转写引擎集成冒烟（真实 Chromium + 真实 wasm 运行时 + 占位模型字节）：
 * 验证 CSP(wasm-unsafe-eval)、worker 加载、importScripts 胶水、wasm 编译、
 * MEMFS 写入、识别器创建路径全链路可达。模型用垃圾字节——
 * 预期在"识别器创建"处报错（证明前面的环节都通了），拿到协议化 error 即为通过；
 * 若 CSP/worker/SAB 任一环节断裂，根本等不到任何协议消息。
 */
for (const runtime of ['online', 'offline'] as const) {
  test(`ASR 引擎 worker 初始化链路（${runtime} 运行时）`, async ({ context, extensionId }) => {
    test.setTimeout(120_000);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    // offline 运行时（SenseVoice）是 pthread 构建，需要 SharedArrayBuffer → 跨源隔离
    if (runtime === 'offline') {
      expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
    }

    const workerAsset = engineWorkerAsset();
    const firstEvent = await page.evaluate(
      async ({ asset, runtimeKind }) => {
        const base = chrome.runtime.getURL(`/wasm/sherpa/${runtimeKind}/`);
        const worker = new Worker(chrome.runtime.getURL(asset));
        return await new Promise<EngineEventView>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('等待引擎消息超时')), 90_000);
          worker.onerror = (e) => {
            clearTimeout(timer);
            reject(new Error(`worker 加载失败：${e.message ?? 'unknown'}`));
          };
          worker.onmessage = (e: MessageEvent<EngineEventView>) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(e.data);
          };
          worker.postMessage({
            type: 'init',
            modelId: runtimeKind === 'online' ? 'paraformer-streaming' : 'sensevoice',
            wasmUrls: {
              mainJs:
                base +
                (runtimeKind === 'online'
                  ? 'sherpa-onnx-wasm-main-asr.js'
                  : 'sherpa-onnx-wasm-main-vad-asr.js'),
              mainWasm:
                base +
                (runtimeKind === 'online'
                  ? 'sherpa-onnx-wasm-main-asr.wasm'
                  : 'sherpa-onnx-wasm-main-vad-asr.wasm'),
              glueJs: base + 'sherpa-onnx-asr.js',
            },
            // 占位模型：仅为打通"写 MEMFS → 建识别器"链路，预期模型解析失败
            files: {
              'encoder.int8.onnx': new Uint8Array(256).buffer,
              'decoder.int8.onnx': new Uint8Array(256).buffer,
              'model.int8.onnx': new Uint8Array(256).buffer,
              'tokens.txt': new TextEncoder().encode('0 \n').buffer,
            },
          });
        });
      },
      { asset: workerAsset, runtimeKind: runtime },
    );

    // ready（识别器宽容地建起来了）或 error（模型字节非法被解析层拒绝）都算链路打通；
    // 关键是引擎以协议消息回了话。
    expect(['ready', 'error']).toContain(firstEvent.type);
    if (firstEvent.type === 'error') {
      expect(firstEvent.message ?? '').not.toBe('');
    }
  });
}
