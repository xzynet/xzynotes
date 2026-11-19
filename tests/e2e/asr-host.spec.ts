import path from 'node:path';
import { expect, test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { ASR_MODELS } from '../../core/asr';

/** 扩展构建产物（pnpm build 产物目录） */
const EXT_PATH = path.resolve('.output/chrome-mv3');

/** 扩展页内的 chrome.*（页面上下文无扩展类型定义） */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    getContexts(filter: { contextTypes: string[] }): Promise<Array<{ contextType: string }>>;
  };
  action: { getBadgeText(details: object): Promise<string> };
  windows: { getCurrent(): Promise<{ id?: number }> };
};

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      // channel: 'chromium' 用完整版浏览器（headless shell 不支持扩展）
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

/** 宿主快照的测试侧视图（只取断言用到的字段） */
interface Snapshot {
  state: {
    courseId: string | null;
    phase: string;
    running: boolean;
    error: string | null;
    mode: string;
  };
  cues: unknown[];
  updates: Record<string, string>;
}

/** 经后台中继下发一条宿主命令（面板侧与真实链路一致） */
async function hostCmd(page: Page, command: unknown): Promise<Snapshot> {
  return (await page.evaluate(async (cmd) => {
    const resp = (await chrome.runtime.sendMessage({ type: 'asr:hostCommand', command: cmd })) as
      | { ok: boolean; data?: unknown; error?: string }
      | undefined;
    if (!resp?.ok) throw new Error(resp?.error ?? 'asr:hostCommand 无响应');
    return resp.data;
  }, command)) as Snapshot;
}

const openPanel = async (context: BrowserContext, extensionId: string): Promise<Page> => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('button', { name: '全部课程' })).toBeVisible();
  return panel;
};

/**
 * 文件/流式转写由 offscreen 宿主承载：任务状态存活在面板文档之外。
 *
 * 这里不下载模型、不联网——「模型缓存缺失」本身就能让宿主里的引擎启动失败，
 * 借此验证全链路：按需创建 offscreen 文档 → 后台中继命令 → 宿主执行任务 →
 * 面板轮询到终态；关键是第 5 步——把面板文档整个关掉再开，
 * 任务状态仍在宿主里（真实运行时就是「关侧栏继续转写」）。
 */
test('转写任务跑在 offscreen 宿主：关掉面板后台任务状态仍在', async ({
  context,
  extensionId,
}) => {
  const panel = await openPanel(context, extensionId);

  // 1) status 会按需创建宿主文档，并回空闲快照
  const idle = await hostCmd(panel, { type: 'asrHost:status', sinceCue: 0 });
  expect(idle.state.courseId).toBe(null);
  expect(idle.state.running).toBe(false);

  // 2) 扩展里确实多了一个 offscreen 文档
  const contexts = await panel.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }),
  );
  expect(contexts.some((c) => c.contextType === 'OFFSCREEN_DOCUMENT')).toBe(true);

  // 3) 下发任务（模型未缓存 → 宿主内引擎启动失败，落到 error 终态）
  const started = await hostCmd(panel, {
    type: 'asrHost:start',
    courseId: 'e2e-host-course',
    modelId: 'paraformer-streaming',
    mode: 'stream',
    urls: ['https://example.invalid/video.mp4'],
    punct: false,
  });
  expect(started.state.courseId).toBe('e2e-host-course');

  // 4) 轮询到终态：任务确实在宿主里跑过（error 里是模型缓存缺失的文案 key）
  let terminal: Snapshot | undefined;
  await expect
    .poll(
      async () => {
        const snap = await hostCmd(panel, { type: 'asrHost:status', sinceCue: 0 });
        terminal = snap;
        return snap.state.phase;
      },
      { timeout: 30_000 },
    )
    .toBe('error');
  expect(terminal?.state.running).toBe(false);
  expect(terminal?.state.error).toBeTruthy();

  // 5) 关掉面板文档（等价于收起侧栏）后重开：任务状态仍在宿主里
  await panel.close();
  const reopened = await openPanel(context, extensionId);
  const after = await hostCmd(reopened, { type: 'asrHost:status', sinceCue: 0 });
  expect(after.state.courseId).toBe('e2e-host-course');
  expect(after.state.phase).toBe('error');

  // 6) 收起终态后回到空闲
  const cleared = await hostCmd(reopened, { type: 'asrHost:clear' });
  expect(cleared.state.courseId).toBe(null);
});

/**
 * 完成标记：宿主跑完转写时面板多半没开着，后台在图标上打个勾；
 * 用户打开面板（panel:init）即清除。
 */
test('后台转写完成：图标打完成标记，面板打开后清除', async ({ context, extensionId }) => {
  const panel = await openPanel(context, extensionId);
  expect(await panel.evaluate(() => chrome.action.getBadgeText({}))).toBe('');

  await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'asr:jobDone', cueCount: 42 }),
  );
  await expect
    .poll(async () => panel.evaluate(() => chrome.action.getBadgeText({})), { timeout: 10_000 })
    .toBe('✓');

  // 面板打开（panel:init）即清掉标记
  await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'panel:init' }).catch(() => undefined),
  );
  await expect
    .poll(async () => panel.evaluate(() => chrome.action.getBadgeText({})), { timeout: 10_000 })
    .toBe('');
});

/** 面板课程视图只在收到后台 course:context 广播后才渲染 */
const FAKE_CONTEXT = {
  course: {
    id: 'e2e-prepare-course',
    platform: 'generic',
    title: '下载测试课程',
    url: 'https://example.invalid/video',
    summary: '',
  },
  tabId: 999_999,
  windowId: -1,
  degraded: false,
};

/** 反复广播伪造的课程上下文，直到面板把该课程视图渲染出来 */
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
  const title = FAKE_CONTEXT.course.title;
  await expect
    .poll(
      async () => {
        await sender.evaluate(
          async (payload) => {
            await chrome.runtime.sendMessage({ type: 'course:context', ...payload }).catch(() => undefined);
          },
          { windowId: windowId ?? -1, context: FAKE_CONTEXT },
        );
        return panel.getByText(title).count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await sender.close();
}

/**
 * 模型下载也搬进宿主：缓存已就绪时 prepare 立即完成，面板据快照离开下载视图。
 * 这里用「占位字节 + 正确字节数」预置缓存（isModelCached 只比对字节数），
 * 从而不必真的下载 237MB，就能验证「面板下发 prepare → 宿主完成 → 面板继续」这条链路。
 */
test('模型下载交给宿主：prepare 完成后面板离开下载视图', async ({ context, extensionId }) => {
  const panel = await openPanel(context, extensionId);
  await expect(panel.getByRole('button', { name: '当前课程' })).toBeVisible();
  await pushCourseContext(context, extensionId, panel);

  await panel.getByRole('button', { name: '当前课程' }).click();
  const card = panel.getByText('本地语音转写（无字幕兜底）');
  await expect(card).toBeVisible({ timeout: 20_000 });

  // 缓存为空 → 点「开始转写」落到「首次使用需下载模型」
  await panel.getByRole('button', { name: '开始转写' }).first().click();
  await expect(panel.getByText('首次使用需下载模型')).toBeVisible({ timeout: 20_000 });

  // 预置缓存（占位字节 + 注册表字节数；Dexie 已建库，按当前版本打开即可）
  const spec = ASR_MODELS['paraformer-streaming'];
  await panel.evaluate(
    async (files) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('kedaibiao-asr');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!db.objectStoreNames.contains('files')) {
        db.close();
        throw new Error('test setup: kedaibiao-asr 缺少 files 存储（面板尚未初始化模型缓存？）');
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        for (const f of files) {
          tx.objectStore('files').put({
            key: `${f.modelId}/${f.path}`,
            modelId: f.modelId,
            path: f.path,
            bytes: f.bytes,
            blob: new Blob([]),
            updatedAt: Date.now(),
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    spec.files.map((f) => ({ modelId: spec.id, path: f.path, bytes: f.bytes })),
  );

  // 「下载并开始」→ 宿主 prepare（缓存已齐 → 立即完成）
  await panel.getByRole('button', { name: '下载并开始' }).click();
  await expect
    .poll(
      async () => {
        const snap = await hostCmd(panel, { type: 'asrHost:status', sinceCue: 0 });
        return `${snap.state.mode}:${snap.state.phase}`;
      },
      { timeout: 30_000 },
    )
    .toBe('prepare:done');

  // 面板据快照离开下载视图（继续走解析直链 → 用户选模式的后续流程）
  await expect(panel.getByText('正在下载模型…')).toHaveCount(0, { timeout: 20_000 });
});

/**
 * 回归：后台任务还在跑时重开面板，不能被「上一轮已完成的字幕」顶掉视图。
 *
 * load() 会先回退到本地转写缓存，而正在跑的任务结果尚未落盘——
 * 若不先问一声宿主，用户切页/收起侧栏再回来只会看到上一轮的字幕，
 * 正在转写的界面（含进度与已出句子）就再也接不回来了。
 */
test('后台任务未完成时重开面板：展示转写卡片而不是上一轮的字幕', async ({
  context,
  extensionId,
}) => {
  const STALE_TEXT = '上一轮转写好的字幕内容';
  const panel = await openPanel(context, extensionId);
  await expect(panel.getByRole('button', { name: '当前课程' })).toBeVisible();
  await pushCourseContext(context, extensionId, panel);

  // 造一份「上一轮已完成」的转写缓存
  await panel.evaluate(
    async ({ courseId, text }) => {
      await chrome.runtime.sendMessage({
        type: 'transcript:save',
        transcript: {
          id: courseId,
          courseId,
          modelId: 'paraformer-streaming',
          cues: [{ start: 0, end: 2, text }],
          durationSec: 2,
          updatedAt: Date.now(),
        },
      });
    },
    { courseId: FAKE_CONTEXT.course.id, text: STALE_TEXT },
  );

  // 无后台任务：展示缓存的字幕（旧行为，作为对照）
  await panel.reload();
  await pushCourseContext(context, extensionId, panel);
  await panel.getByRole('button', { name: '当前课程' }).click();
  await expect(panel.getByText(STALE_TEXT)).toBeVisible({ timeout: 20_000 });

  // 起一个后台任务（模型未缓存 → 很快落到 error 终态；任务已不在面板里跑）
  await hostCmd(panel, {
    type: 'asrHost:start',
    courseId: FAKE_CONTEXT.course.id,
    modelId: 'paraformer-streaming',
    mode: 'stream',
    urls: ['https://example.invalid/a.mp4'],
    punct: false,
  });
  await expect
    .poll(
      async () => (await hostCmd(panel, { type: 'asrHost:status', sinceCue: 0 })).state.phase,
      { timeout: 30_000 },
    )
    .toBe('error');

  // 重开面板：应当接回转写卡片，而不是展示上一轮的字幕
  await panel.reload();
  await pushCourseContext(context, extensionId, panel);
  await panel.getByRole('button', { name: '当前课程' }).click();
  await expect(panel.getByText('本地语音转写（无字幕兜底）')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText(STALE_TEXT)).toHaveCount(0);
});
