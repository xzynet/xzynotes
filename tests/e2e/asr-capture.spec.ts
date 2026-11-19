import path from 'node:path';
import { expect, test as base, chromium, type BrowserContext } from '@playwright/test';

const EXT_PATH = path.resolve('.output/chrome-mv3');
const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
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

declare const chrome: { runtime: { getURL(path: string): string } };

/**
 * 捕获 PCM 管线回归：MediaStream（振荡器音源）→ AudioWorklet（public/asr/pcm-worklet.js）
 * 必须持续产出非零音频块。守护的是「numberOfOutputs:0 死端节点不被音频图驱动」这类回归。
 */
test('PCM 捕获管线：音源 → worklet 产出非零音频块', async ({ extensionId, context }) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const result = await page.evaluate(async () => {
    const tone = new AudioContext();
    await tone.resume();
    const osc = tone.createOscillator();
    osc.frequency.value = 440;
    const dest = tone.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();

    const ctx = new AudioContext();
    await ctx.resume();
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('/asr/pcm-worklet.js'));
    const source = ctx.createMediaStreamSource(dest.stream);
    // 与 capture.ts 完全相同的接法：numberOfOutputs:0，不接 destination
    const node = new AudioWorkletNode(ctx, 'kedaibiao-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    let chunks = 0;
    let maxAbs = 0;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      chunks++;
      const s = e.data;
      for (let i = 0; i < s.length; i++) maxAbs = Math.max(maxAbs, Math.abs(s[i]!));
    };
    source.connect(node);
    await new Promise((r) => setTimeout(r, 2000));
    await tone.close();
    await ctx.close();
    return { chunks, maxAbs, ctxState: 'closed' };
  });
  // 2 秒 48kHz 应产出 20+ 个 4096 帧块
  expect(result.chunks).toBeGreaterThan(10);
  expect(result.maxAbs).toBeGreaterThan(0.2);
});
