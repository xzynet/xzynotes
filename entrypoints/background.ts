import { browser } from 'wxt/browser';
import type { AsrHostCommand } from '../core/asr/host';
import {
  buildChapterMessages,
  chunkCues,
  formatTranscript,
  mergeAiChunks,
  parseAiChapters,
} from '../core/ai/prompt';
import { chatCompletions } from '../core/ai/client';
import { formatTimestamp } from '../core/export';
import {
  createTranslator,
  localizeError,
  resolveLocale,
  type Locale,
  type Translator,
} from '../core/i18n';
import {
  err,
  ok,
  readableError,
  type AiGenerateResult,
  type ApiResponse,
  type CaptureResult,
  type ContentRequest,
  type CourseContext,
  type CourseSummary,
  type ExportBundle,
  type ImagePayload,
  type PushMessage,
  type RequestMessage,
} from '../core/messages';
import { type Chapter, type Course, type Note, type Setting, type SubtitleCue } from '../core/models';
import { DexieStorage } from '../core/storage';
import { dataUrlToBlob, blobToDataUrl } from '../core/utils/dataurl';
import { decodeSubtitleBuffer } from '../core/utils/srt';
import { newId } from '../core/utils/id';
import { tabMatchesCourse } from '../core/utils/url';
import { createBrowserAdapter } from '../adapters/browsers';
import { hasAiConsent } from '../components/dataConsent';

/**
 * MV3 service worker：无状态、消息驱动。
 * 监听器在顶层同步注册；Dexie 连接句柄可随 SW 休眠重建，不算状态。
 */
export default defineBackground(() => {
  const storage = new DexieStorage();
  const browserAdapter = createBrowserAdapter();

  // ---- 工具 ----

  function push(msg: PushMessage): void {
    // 面板未打开时消息无人接收，静默丢弃
    void browser.runtime.sendMessage(msg).catch(() => {});
  }

  function toast(text: string, level: 'info' | 'success' | 'error' = 'info'): void {
    push({ type: 'toast', level, text });
  }

  /** 后台文案翻译器：设置解析前先兜底中文，refreshI18n 解析后替换 */
  let locale: Locale = 'zh-CN';
  let t: Translator = createTranslator(locale);

  /**
   * 重新解析语言并替换翻译器（启动时与 setting:save 后调用）；
   * 右键菜单标题随语言刷新（update 依赖菜单已创建，故调用点排在创建之后，
   * 引用的 contextMenuReady / ASR_ACTIVATE_MENU_ID 为后文 const，运行时已初始化）
   */
  async function refreshI18n(setting?: Setting): Promise<void> {
    const s = setting ?? (await storage.getSetting());
    locale = resolveLocale(s.language, browser.i18n.getUILanguage());
    t = createTranslator(locale);
    await contextMenuReady;
    await browser.contextMenus
      .update(ASR_ACTIVATE_MENU_ID, { title: t('bg.contextMenuActivate') })
      .catch(() => {});
  }

  async function getActiveTab(windowId?: number): Promise<Browser.tabs.Tab | undefined> {
    const tabs = await browser.tabs.query(
      windowId === undefined
        ? { active: true, lastFocusedWindow: true }
        : { active: true, windowId },
    );
    return tabs[0];
  }

  async function sendToTab<T>(tabId: number, msg: ContentRequest): Promise<ApiResponse<T>> {
    try {
      return (await browser.tabs.sendMessage(tabId, msg)) as ApiResponse<T>;
    } catch {
      return err('bg.err.connectPage');
    }
  }

  /** 与 content script 的 matches 保持一致：用于区分「页面不支持」和「脚本未注入/已失效」 */
  const SUPPORTED_PAGE_RE =
    /:\/\/[^/]*(?:bilibili\.com\/video\/|icourse163\.org\/|xuetangx\.com\/|zhihuishu\.com\/|youtube\.com\/watch)/;

  /** 可注入脚本的页面协议（chrome://、about:、商店页、未授权的 file:// 等不可注入） */
  function isInjectableUrl(url: string | undefined): boolean {
    return !!url && /^https?:\/\//.test(url);
  }

  /**
   * 按需向标签页注入内容脚本（支撑任意 HTML5 视频页的通用模式）。
   * 需要该 tab 已获 activeTab 授权（点工具栏图标/右键菜单/快捷键）——与 tabCapture
   * 激活是同一批手势，所以走到转写时必然已可注入；未授权/不可注入页静默失败，
   * 由调用方回退为「页面不可用」提示。in-flight 去重防并发双注入。
   */
  const injectingTabs = new Map<number, Promise<boolean>>();
  function ensureContentScript(tabId: number): Promise<boolean> {
    let p = injectingTabs.get(tabId);
    if (!p) {
      p = browser.scripting
        .executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] })
        .then(() => true)
        .catch(() => false)
        .finally(() => {
          injectingTabs.delete(tabId);
        });
      injectingTabs.set(tabId, p);
    }
    return p;
  }

  /** 指定窗口活动标签页的课程上下文（实时查询，不依赖 SW 内存） */
  async function activeCourseContext(windowId?: number): Promise<ApiResponse<CourseContext>> {
    const tab = await getActiveTab(windowId);
    if (!tab?.id) return err('bg.err.noActiveTab');
    let resp = await sendToTab<Omit<CourseContext, 'tabId' | 'windowId'>>(tab.id, {
      type: 'course:getContext',
    });
    if (!resp.ok && isInjectableUrl(tab.url)) {
      // 通用页（或内置平台脚本失效）：已激活则注入内容脚本后重试一次
      if (await ensureContentScript(tab.id)) {
        resp = await sendToTab<Omit<CourseContext, 'tabId' | 'windowId'>>(tab.id, {
          type: 'course:getContext',
        });
      }
    }
    if (!resp.ok) {
      // 受支持的站点但连不上：多为扩展更新/重载后旧页面的脚本已失效，刷新即可恢复
      if (SUPPORTED_PAGE_RE.test(tab.url ?? '')) {
        return err('bg.err.connectPageScript');
      }
      if (isInjectableUrl(tab.url)) {
        return err('bg.err.pageNotActivated');
      }
      return err('bg.err.pageUnsupported');
    }
    const course = await mergeStoredCourse(resp.data.course);
    return ok({ ...resp.data, course, tabId: tab.id, windowId: tab.windowId });
  }

  /** 窗口活动 tab 变化时向面板推送最新课程上下文（null = 当前页不支持） */
  async function pushCourseContext(windowId: number): Promise<void> {
    const tab = await getActiveTab(windowId);
    if (!tab?.id) return;
    let resp = await sendToTab<Omit<CourseContext, 'tabId' | 'windowId'>>(tab.id, {
      type: 'course:getContext',
    });
    if (!resp.ok && SUPPORTED_PAGE_RE.test(tab.url ?? '')) {
      // 页面加载中脚本可能尚未就绪（含 SPA 换 P），等一拍重试一次
      await new Promise((r) => setTimeout(r, 800));
      resp = await sendToTab<Omit<CourseContext, 'tabId' | 'windowId'>>(tab.id, {
        type: 'course:getContext',
      });
    }
    if (!resp.ok && isInjectableUrl(tab.url)) {
      // 通用页：该 tab 此前被激活过（activeTab 仍有效）时注入脚本即亮；
      // 未激活则注入失败、广播 null，面板显示不可用提示，不打扰
      if (await ensureContentScript(tab.id)) {
        resp = await sendToTab<Omit<CourseContext, 'tabId' | 'windowId'>>(tab.id, {
          type: 'course:getContext',
        });
      }
    }
    const context = resp.ok
      ? {
          ...resp.data,
          course: await mergeStoredCourse(resp.data.course),
          tabId: tab.id,
          windowId,
        }
      : null;
    push({ type: 'course:context', windowId, context });
  }

  /**
   * 页面侧重建的 course 不含已存数据：补回库里已有的 AI 概述与用户改过的标题，
   * 保证产物长期可见、自定义标题不被页面标题覆盖
   */
  async function mergeStoredCourse(course: Course): Promise<Course> {
    const existing =
      (await storage.getCourse(course.id)) ?? (await migrateLegacyGenericCourse(course));
    if (!existing) return course;
    return {
      ...course,
      summary: course.summary || existing.summary,
      title: existing.titleLocked ? existing.title : course.title,
      // 旧记录可能无此字段（读取不过 schema），显式归一
      titleLocked: existing.titleLocked === true,
    };
  }

  /**
   * 旧版通用课程 id 只有 origin+pathname（无 search/hash），SPA 哈希路由站的全部
   * 页面会折叠成同一门课、笔记互相串台。id 细分后首次打开对应视频页时，把旧课程
   * 数据整体改挂到新 id（旧数据可能混有多个视频，无法自动拆分；新 id 已有数据
   * 或旧课不存在时不动）。
   */
  async function migrateLegacyGenericCourse(course: Course): Promise<Course | undefined> {
    if (!course.id.startsWith('generic:')) return undefined;
    let u: URL;
    try {
      u = new URL(course.url);
    } catch {
      return undefined;
    }
    const legacyId = `generic:${u.origin}${u.pathname}`;
    if (legacyId === course.id) return undefined;
    return (await storage.rekeyCourse(legacyId, course.id))
      ? storage.getCourse(course.id)
      : undefined;
  }

  async function activateTab(tab: Browser.tabs.Tab & { id: number }): Promise<void> {
    await browser.tabs.update(tab.id, { active: true }).catch(() => {});
    await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  /**
   * 历史课程详情页的跳转：在已打开的标签页里找这门课，找到则 seek 并激活。
   * 匹配 = 实时课程 id 相等，或 URL 身份兜底（课程 id 规则随平台/版本变化：
   * MOOC 课节 id 在 hash 里、入库时被 canonical 化去掉，页面降级时退为 generic，
   * 单靠 id 相等会漏配）。同课程页但脚本已失效（扩展重载）时先试补注恢复，
   * 授权已丢才激活并提示刷新/重新激活而不是再开重复标签页；都没有则 handled:false，
   * 由面板决定开新标签页。
   */
  async function seekCourse(
    courseId: string,
    sec: number,
    windowId?: number,
    excludeTabId?: number,
  ): Promise<ApiResponse<{ handled: boolean }>> {
    const course = await storage.getCourse(courseId);
    // 探测范围放宽到全部 http(s) 标签页（通用模式课程也可能已打开）；
    // url 不可见（权限范围外）的标签页同样保留，靠 getContext 探测识别。
    // 对未知标签页只探测、不注入（无激活手势，未注入页探测静默失败）；
    // 仅对已确认 URL 匹配的课程页补注脚本（授权来自之前的激活手势，与手势本身无关）
    const candidates = (await browser.tabs.query({})).filter(
      (t): t is Browser.tabs.Tab & { id: number } =>
        t.id !== undefined && t.id !== excludeTabId && (!t.url || isInjectableUrl(t.url)),
    );
    // 面板所在窗口的标签页优先
    candidates.sort((a, b) => Number(b.windowId === windowId) - Number(a.windowId === windowId));

    let deadTab: (Browser.tabs.Tab & { id: number }) | undefined;
    for (const tab of candidates) {
      const urlMatch =
        course !== undefined &&
        tab.url !== undefined &&
        tab.url !== '' &&
        tabMatchesCourse(tab.url, course);
      let resp = await sendToTab<Omit<CourseContext, 'tabId' | 'windowId'>>(tab.id, {
        type: 'course:getContext',
      });
      if (!resp.ok && urlMatch && tab.status === 'complete') {
        // 通用页脚本按需注入，扩展重载后失效但 activeTab 授权未随页面刷新丢失时，
        // 补注一次即可免手动刷新恢复；授权已丢（页面刷新过）则注入失败走 deadTab
        if (await ensureContentScript(tab.id)) {
          resp = await sendToTab<Omit<CourseContext, 'tabId' | 'windowId'>>(tab.id, {
            type: 'course:getContext',
          });
        }
      }
      if (resp.ok) {
        if (resp.data.course.id !== courseId && !urlMatch) continue;
        // seek 失败（如播放器未就绪且等待超时）：继续找其它标签页，而不是吞掉错误
        const seekResp = await sendToTab(tab.id, { type: 'video:seek', sec });
        if (!seekResp.ok) continue;
        await activateTab(tab);
        return ok({ handled: true });
      }
      if (!deadTab && urlMatch && tab.status === 'complete') deadTab = tab;
    }
    if (deadTab) {
      await activateTab(deadTab);
      // 通用页脚本不在 manifest 注入列表里，刷新页面不会恢复，需点图标重新激活授权
      return err(
        course?.platform === 'generic'
          ? 'bg.err.courseScriptInactive'
          : 'bg.err.courseScriptStale',
      );
    }
    return ok({ handled: false });
  }

  async function touchCourse(course: Course): Promise<void> {
    await storage.upsertCourse({ ...(await mergeStoredCourse(course)), updatedAt: Date.now() });
  }

  /** 导出/备份前脱敏：apiToken 不离开本机 */
  function sanitizeSetting(setting: Setting): Setting {
    return { ...setting, llm: { ...setting.llm, apiToken: '' } };
  }

  /** AI 章节切分：分块调用 LLM → 解析合并 → 章节与概述落库 */
  async function generateAiChapters(
    courseId: string,
    cues: SubtitleCue[],
  ): Promise<ApiResponse<AiGenerateResult>> {
    const setting = await storage.getSetting();
    const { llm } = setting;
    if (!llm.model.trim() || !llm.apiToken.trim()) {
      return err('bg.err.aiNotConfigured');
    }
    // 字幕正文属 Firefox 的 websiteContent 外传，未获用户授权不得发往端点
    if (!(await hasAiConsent())) return err('bg.err.aiConsentRequired');
    const course = await storage.getCourse(courseId);
    const chunks = chunkCues(cues);
    if (chunks.length === 0) return err('bg.err.noSubtitleContent');

    try {
      const results = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const messages = buildChapterMessages(
          {
            transcript: formatTranscript(chunk),
            courseTitle: course?.title ?? '',
            chunkIndex: i,
            chunkCount: chunks.length,
            withOverview: i === 0,
          },
          locale,
        );
        const content = await chatCompletions(llm, messages);
        results.push(parseAiChapters(content));
      }
      const { overview, chapters: drafts } = mergeAiChunks(results);
      if (drafts.length === 0) return err('bg.err.aiNoChapters');

      const chapters: Chapter[] = drafts.map((d) => ({
        id: newId(),
        courseId,
        title: d.title,
        startSec: Math.floor(d.startSec),
        summary: d.summary,
        source: 'ai' as const,
      }));
      await storage.replaceChapters(courseId, chapters);
      if (overview && course) {
        await storage.upsertCourse({ ...course, summary: overview });
      }
      return ok({ chapters, overview });
    } catch (e) {
      return err(readableError(e));
    }
  }

  async function testAiConnection(): Promise<ApiResponse<{ model: string }>> {
    const { llm } = await storage.getSetting();
    if (!llm.model.trim() || !llm.apiToken.trim()) {
      return err('bg.err.aiModelTokenRequired');
    }
    // 连端点本身就是 AI 外传链路的一环，与生成章节同样需要授权
    if (!(await hasAiConsent())) return err('bg.err.aiConsentRequired');
    try {
      await chatCompletions(llm, [{ role: 'user', content: 'ping' }], {
        jsonMode: false,
        maxTokens: 1,
      });
      return ok({ model: llm.model });
    } catch (e) {
      return err(readableError(e));
    }
  }

  function notifyChanged(courseId: string, highlightNoteId?: string): void {
    push({ type: 'notes:changed', courseId, highlightNoteId });
  }

  // ---- 快捷键命令 ----

  /** 抓当前视频帧（canvas 优先，失败降级整页截图）；失败已 toast，返回 null */
  async function captureFrameForContext(ctx: CourseContext): Promise<CaptureResult | null> {
    const captureResp = await sendToTab<CaptureResult>(ctx.tabId, { type: 'video:capture' });
    if (captureResp.ok) return captureResp.data;
    if (browserAdapter.captureVisibleTab) {
      // DRM / canvas 污染降级：整页截图
      try {
        const blob = await browserAdapter.captureVisibleTab(ctx.windowId);
        const dataUrl = await blobToDataUrl(blob);
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        bitmap.close();
        const timeResp = await sendToTab<number>(ctx.tabId, { type: 'video:getTime' });
        return { dataUrl, width, height, time: timeResp.ok ? timeResp.data : 0 };
      } catch (e) {
        toast(t('bg.toast.captureFailed', { error: localizeError(t, e) }), 'error');
        return null;
      }
    }
    toast(t('bg.toast.captureFailed', { error: localizeError(t, captureResp.error) }), 'error');
    return null;
  }

  async function handleCapture(): Promise<void> {
    const ctxResp = await activeCourseContext();
    if (!ctxResp.ok) {
      toast(localizeError(t, ctxResp.error), 'error');
      return;
    }
    const ctx = ctxResp.data;

    const frame = await captureFrameForContext(ctx);
    if (!frame) return;
    const { dataUrl, width, height, time } = frame;

    // 1 秒内同时间点重复截图：去重提示
    const existing = await storage.listNotesByCourse(ctx.course.id);
    const duplicate = existing.find(
      (n) => n.type === 'screenshot' && Math.abs(n.timestampSec - time) <= 1,
    );
    if (duplicate) {
      toast(t('bg.toast.duplicateCapture'), 'info');
      return;
    }

    const imageId = newId();
    const noteId = newId();
    const now = Date.now();
    await storage.putImage({ id: imageId, blob: dataUrlToBlob(dataUrl), width, height });
    const note: Note = {
      id: noteId,
      courseId: ctx.course.id,
      type: 'screenshot',
      timestampSec: time,
      content: '',
      imageId,
      createdAt: now,
      updatedAt: now,
    };
    await storage.addNote(note);
    await touchCourse(ctx.course);
    notifyChanged(ctx.course.id, noteId);
    toast(t('bg.toast.captureSaved', { time: formatTimestamp(time) }), 'success');
  }

  /** Alt+A / 面板按钮：抓帧入库 → 面板打开标注器；保存后覆盖原图并创建笔记 */
  async function handleCaptureAnnotate(windowId?: number): Promise<void> {
    const ctxResp = await activeCourseContext(windowId);
    if (!ctxResp.ok) {
      toast(localizeError(t, ctxResp.error), 'error');
      return;
    }
    const ctx = ctxResp.data;
    const frame = await captureFrameForContext(ctx);
    if (!frame) return;
    const imageId = newId();
    await storage.putImage({
      id: imageId,
      blob: dataUrlToBlob(frame.dataUrl),
      width: frame.width,
      height: frame.height,
    });
    await touchCourse(ctx.course);
    // 面板可能尚未加载：双保险 = storage.session 标志 + 广播
    await browser.storage.session
      .set({ pendingAnnotate: { imageId, courseId: ctx.course.id, time: frame.time } })
      .catch(() => {});
    push({ type: 'panel:annotate', imageId, courseId: ctx.course.id, time: frame.time });
  }

  async function handleBookmark(): Promise<void> {
    const ctxResp = await activeCourseContext();
    if (!ctxResp.ok) {
      toast(localizeError(t, ctxResp.error), 'error');
      return;
    }
    const ctx = ctxResp.data;
    const timeResp = await sendToTab<number>(ctx.tabId, { type: 'video:getTime' });
    if (!timeResp.ok) {
      toast(localizeError(t, timeResp.error), 'error');
      return;
    }
    const noteId = newId();
    const now = Date.now();
    await storage.addNote({
      id: noteId,
      courseId: ctx.course.id,
      type: 'bookmark',
      timestampSec: timeResp.data,
      content: '',
      createdAt: now,
      updatedAt: now,
    });
    await touchCourse(ctx.course);
    notifyChanged(ctx.course.id, noteId);
    toast(t('bg.toast.bookmarkSaved', { time: formatTimestamp(timeResp.data) }), 'success');
  }

  async function handleNewNote(): Promise<void> {
    // 面板可能尚未加载：双保险 = storage.session 标志 + 广播
    await browser.storage.session.set({ pendingFocusNote: true }).catch(() => {});
    push({ type: 'panel:focusNewNote' });
  }

  async function handleCommand(command: string): Promise<void> {
    try {
      // 关键：Chrome 只在命令事件回调的同步阶段保留用户手势，
      // sidePanel.open 必须在任何 await 之前调用，否则报 "user gesture" 错误。
      if (
        command === 'capture' ||
        command === 'captureAnnotate' ||
        command === 'bookmark' ||
        command === 'newNote' ||
        command === 'togglePanel' ||
        command === 'activateAsr'
      ) {
        browserAdapter.openSidebar();
      }
      switch (command) {
        case 'capture':
          await handleCapture();
          break;
        case 'captureAnnotate':
          await handleCaptureAnnotate();
          break;
        case 'bookmark':
          await handleBookmark();
          break;
        case 'newNote':
          await handleNewNote();
          break;
        case 'togglePanel':
          // Chrome 侧栏无编程关闭 API，等价于打开（已在上面完成）
          break;
        case 'activateAsr':
          // 命令执行本身即完成 tabCapture 激活（activeTab 语义）；
          // 打开面板后，等待中的每 2s 自动重试会立即续上
          break;
        default:
          break;
      }
    } catch (e) {
      toast(t('bg.toast.commandFailed', { error: localizeError(t, e) }), 'error');
    }
  }

  // ---- 消息路由 ----

  /**
   * 转写任务宿主（Chrome offscreen document）。
   *
   * 文件/流式转写跑在独立文档里，侧栏关掉也不中断；面板只下发命令 + 轮询快照。
   * 命令统一经后台中继：面板直发 offscreen 时 SW 与宿主会同时收到同一条消息、
   * 谁先回执谁赢（SW 的 default 分支会回 unknownMessage），中继可保证应答唯一。
   */
  const ASR_HOST_URL = '/offscreen.html';
  let asrHostReady: Promise<void> | null = null;

  /** chrome.offscreen（仅 Chrome 声明；Firefox 无此命名空间） */
  interface OffscreenApi {
    hasDocument(): Promise<boolean>;
    createDocument(options: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
  }

  /** 幂等创建宿主文档（offscreen 权限仅 Chrome 声明，Firefox 走面板内转写） */
  function ensureAsrHost(): Promise<void> {
    const offscreen = (globalThis as { chrome?: { offscreen?: OffscreenApi } }).chrome?.offscreen;
    if (!offscreen) return Promise.reject(new Error('bg.err.asrHostUnsupported'));
    asrHostReady ??= (async () => {
      if (await offscreen.hasDocument()) return;
      await offscreen.createDocument({
        url: browser.runtime.getURL(ASR_HOST_URL),
        reasons: ['WORKERS', 'BLOBS'],
        justification: '网课语音转写：在独立文档里跑 WASM 识别引擎与媒体解码，关闭侧栏不中断',
      });
    })().catch((e: unknown) => {
      asrHostReady = null; // 创建失败允许下次重试
      throw e;
    });
    return asrHostReady;
  }

  async function relayToAsrHost(command: AsrHostCommand): Promise<ApiResponse<unknown>> {
    try {
      await ensureAsrHost();
    } catch (e) {
      return err(readableError(e));
    }
    // 有新任务在动：清掉上一次的完成标记
    if (command.type === 'asrHost:prepare' || command.type === 'asrHost:start') clearJobBadge();
    const resp = (await browser.runtime.sendMessage(command).catch((e: unknown) => ({
      ok: false,
      error: readableError(e),
    }))) as ApiResponse<unknown> | undefined;
    return resp ?? err('bg.err.asrHostNoResponse');
  }

  /**
   * 宿主转写完成标记：任务跑在 offscreen 里，面板很可能没开着。
   * 面板开着时完成 toast 已经提示过，就不再打标；侧栏一打开（panel:init）即清除。
   */
  async function markJobDone(cueCount: number): Promise<void> {
    try {
      if (await isSidePanelOpen()) return;
      await browser.action.setBadgeBackgroundColor({ color: '#059669' });
      await browser.action.setBadgeText({ text: '✓' });
      await browser.action.setTitle({ title: t('asr.transcribeDone', { count: cueCount }) });
    } catch (e) {
      console.warn('[kedaibiao] 设置转写完成标记失败：', e);
    }
  }

  /** 清除图标上的完成标记（标题置空即恢复默认） */
  function clearJobBadge(): void {
    void browser.action.setBadgeText({ text: '' }).catch(() => {});
    void browser.action.setTitle({ title: '' }).catch(() => {});
  }

  /** 侧栏是否开着（runtime.getContexts 仅 Chrome 提供；拿不到就当没开） */
  async function isSidePanelOpen(): Promise<boolean> {
    const runtimeApi = (
      globalThis as {
        chrome?: {
          runtime?: { getContexts?: (f: { contextTypes: string[] }) => Promise<Array<{ contextType: string }>> };
        };
      }
    ).chrome?.runtime;
    if (typeof runtimeApi?.getContexts !== 'function') return false;
    try {
      const contexts = await runtimeApi.getContexts({ contextTypes: ['SIDE_PANEL'] });
      return contexts.length > 0;
    } catch {
      return false;
    }
  }

  async function routeMessage(
    msg: RequestMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<ApiResponse<unknown>> {
    switch (msg.type) {
      case 'panel:init': {
        // 面板打开了：清掉后台任务留下的完成标记
        clearJobBadge();
        const resp = await activeCourseContext(msg.windowId);
        if (resp.ok) await touchCourse(resp.data.course);
        return resp;
      }

      case 'panel:open': {
        browserAdapter.openSidebar(sender.tab?.windowId);
        return ok(null);
      }

      case 'capture:annotate': {
        // 面板「截图编辑」按钮：与 Alt+A 同一流程（抓帧入库 → 广播 panel:annotate 开标注器）
        await handleCaptureAnnotate(msg.windowId);
        return ok(null);
      }

      case 'courses:list': {
        // 全部课程：无任何内容（无笔记、无章节、无 AI 概述、无语音转写）的课程不列出
        const courses = await storage.listCourses();
        const summaries: CourseSummary[] = [];
        for (const course of courses) {
          const [notes, chapters, transcript] = await Promise.all([
            storage.listNotesByCourse(course.id),
            storage.listChaptersByCourse(course.id),
            storage.getTranscript(course.id),
          ]);
          const hasTranscript = (transcript?.cues.length ?? 0) > 0;
          if (notes.length === 0 && chapters.length === 0 && !course.summary && !hasTranscript)
            continue;
          summaries.push({
            course,
            noteCount: notes.length,
            screenshotCount: notes.filter((n) => n.type === 'screenshot').length,
            chapterCount: chapters.length,
            transcript: hasTranscript
              ? {
                  cueCount: transcript!.cues.length,
                  durationSec: transcript!.durationSec,
                  updatedAt: transcript!.updatedAt,
                }
              : undefined,
            coverImageId: [...notes].reverse().find((n) => n.imageId)?.imageId,
          });
        }
        return ok(summaries);
      }

      case 'course:delete': {
        await storage.deleteCourse(msg.courseId);
        notifyChanged(msg.courseId);
        return ok(null);
      }

      case 'course:rename': {
        const title = msg.title.trim();
        if (!title) return err('bg.err.titleEmpty');
        const course = await storage.getCourse(msg.courseId);
        if (!course) return err('bg.err.courseNotFound');
        await storage.upsertCourse({
          ...course,
          title,
          titleLocked: true,
          updatedAt: Date.now(),
        });
        notifyChanged(msg.courseId);
        return ok(null);
      }

      case 'notes:list':
        return ok(await storage.listNotesByCourse(msg.courseId));

      case 'chapters:list':
        return ok(await storage.listChaptersByCourse(msg.courseId));

      case 'chapters:replace':
        await storage.replaceChapters(msg.courseId, msg.chapters);
        return ok(null);

      case 'transcript:get':
        // 无缓存时返回 null（面板据此决定展示转写入口还是转写结果）
        return ok((await storage.getTranscript(msg.courseId)) ?? null);

      case 'transcript:save':
        await storage.saveTranscript(msg.transcript);
        notifyChanged(msg.transcript.courseId);
        return ok(null);

      /**
       * 激活弹窗切换 / 图标状态查询。
       * chrome.action 依赖 manifest 的 action 声明（wxt.config.ts 已补空声明，
       * 此前未声明时该 API 在所有上下文都是 undefined，侧栏直调同步抛错打白面板）；
       * 图标行为切换集中在后台处理：弹窗自清除时后台可自行定位活动 tab。
       */
      case 'asr:setActivationPopup': {
        if (!import.meta.env.FIREFOX) {
          await browser.action
            .setPopup({ tabId: msg.tabId, popup: msg.enable ? 'activate-popup.html' : '' })
            .catch((e: unknown) => console.warn('[kedaibiao] 切换激活弹窗失败：', e));
        }
        return ok(null);
      }

      case 'asr:clearActivationPopup': {
        // 弹窗只会开在当前活动 tab 上，由后台解析目标 tab（弹窗上下文无需 tabs/action API）
        if (!import.meta.env.FIREFOX) {
          const tab = await getActiveTab();
          if (tab?.id !== undefined) {
            await browser.action.setPopup({ tabId: tab.id, popup: '' }).catch(() => {});
          }
        }
        return ok(null);
      }

      case 'asr:actionIconOnToolbar': {
        if (import.meta.env.FIREFOX) return ok(null);
        try {
          const settings = await browser.action.getUserSettings();
          return ok(settings.isOnToolbar);
        } catch {
          return ok(null);
        }
      }

      // 转写任务宿主（offscreen）：命令与状态查询统一中继给宿主文档
      case 'asr:hostCommand':
        return relayToAsrHost(msg.command);

      // 宿主转写完成（面板多半没开着）：在图标上打完成标记
      case 'asr:jobDone':
        await markJobDone(msg.cueCount);
        return ok(null);

      case 'setting:get':
        return ok(await storage.getSetting());

      case 'setting:save':
        await storage.saveSetting(msg.setting);
        // 语言可能已变：先刷新后台翻译器，再广播给面板即时刷新
        await refreshI18n(msg.setting);
        push({ type: 'setting:changed', setting: msg.setting });
        return ok(null);

      case 'stats:counts':
        return ok(await storage.countRecords());

      case 'backup:export': {
        const data = await storage.exportAll();
        return ok({ ...data, settings: sanitizeSetting(data.settings) });
      }

      case 'backup:import':
        return ok(await storage.importAll(msg.data));

      case 'note:createText': {
        const timeResp = await sendToTab<number>(msg.tabId, { type: 'video:getTime' });
        if (!timeResp.ok) return err(timeResp.error);
        const noteId = newId();
        const now = Date.now();
        const note: Note = {
          id: noteId,
          courseId: msg.courseId,
          type: 'text',
          timestampSec: timeResp.data,
          content: msg.content,
          createdAt: now,
          updatedAt: now,
        };
        await storage.addNote(note);
        notifyChanged(msg.courseId, noteId);
        return ok(note);
      }

      case 'note:delete': {
        const note = await storage.getNote(msg.id);
        await storage.deleteNote(msg.id);
        if (note) notifyChanged(note.courseId);
        return ok(null);
      }

      case 'note:update': {
        const note = await storage.getNote(msg.id);
        if (!note) return err('bg.err.noteNotFound');
        await storage.updateNote(msg.id, { content: msg.content.trim(), updatedAt: Date.now() });
        notifyChanged(note.courseId);
        return ok(null);
      }

      case 'note:restore': {
        if (msg.image) {
          await storage.putImage({
            id: msg.image.id,
            blob: dataUrlToBlob(msg.image.dataUrl),
            width: msg.image.width,
            height: msg.image.height,
          });
        }
        await storage.addNote(msg.note);
        notifyChanged(msg.note.courseId, msg.note.id);
        return ok(null);
      }

      case 'image:get': {
        const image = await storage.getImage(msg.id);
        if (!image) return err('bg.err.imageNotFound');
        const payload: ImagePayload = {
          id: image.id,
          dataUrl: await blobToDataUrl(image.blob),
          width: image.width,
          height: image.height,
        };
        return ok(payload);
      }

      case 'image:replace':
        // 标注器保存：覆盖原图
        await storage.putImage({
          id: msg.id,
          blob: dataUrlToBlob(msg.dataUrl),
          width: msg.width,
          height: msg.height,
        });
        return ok(null);

      case 'image:delete':
        await storage.deleteImage(msg.id);
        return ok(null);

      case 'note:createImage': {
        const noteId = newId();
        const now = Date.now();
        const note: Note = {
          id: noteId,
          courseId: msg.courseId,
          type: 'screenshot',
          timestampSec: msg.timestampSec,
          content: '',
          imageId: msg.imageId,
          createdAt: now,
          updatedAt: now,
        };
        await storage.addNote(note);
        notifyChanged(msg.courseId, noteId);
        return ok(note);
      }

      case 'video:seek':
        return sendToTab(msg.tabId, { type: 'video:seek', sec: msg.sec });

      case 'video:seekCourse':
        return seekCourse(msg.courseId, msg.sec, msg.windowId, msg.excludeTabId);

      case 'video:getTime':
        return sendToTab(msg.tabId, { type: 'video:getTime' });

      case 'video:getPlaybackInfo':
        return sendToTab(msg.tabId, { type: 'video:getPlaybackInfo' });

      case 'media:resolveAudio':
        return sendToTab(msg.tabId, { type: 'media:resolveAudio' });

      case 'video:setLoop':
        return sendToTab(msg.tabId, { type: 'video:setLoop', a: msg.a, b: msg.b });

      case 'video:clearLoop':
        return sendToTab(msg.tabId, { type: 'video:clearLoop' });

      case 'video:jumpUrl':
        return sendToTab(msg.tabId, { type: 'video:jumpUrl', sec: msg.sec });

      case 'subtitles:get':
        return sendToTab(msg.tabId, { type: 'subtitles:get' });

      case 'danmaku:get':
        return sendToTab(msg.tabId, { type: 'danmaku:get' });

      case 'net:fetchText': {
        // 字幕等文本资源的中转抓取：content script 受页面 CORS 约束，
        // SW 持有 host 权限可跨域抓取（如智慧树 newbase 的 JSONP 字幕接口）
        let target: URL;
        try {
          target = new URL(msg.url);
        } catch {
          return err('bg.err.invalidUrl');
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          return err('bg.err.httpOnly');
        }
        try {
          const resp = await fetch(target.toString(), { credentials: 'include' });
          if (!resp.ok) return err(`HTTP ${resp.status}`);
          return ok(decodeSubtitleBuffer(await resp.arrayBuffer()));
        } catch (e) {
          return err(readableError(e));
        }
      }

      case 'export:course': {
        const [course, notes, chapters, setting] = await Promise.all([
          storage.getCourse(msg.courseId),
          storage.listNotesByCourse(msg.courseId),
          storage.listChaptersByCourse(msg.courseId),
          storage.getSetting(),
        ]);
        if (!course) return err('bg.err.courseNotFound');
        const images: Record<string, ImagePayload> = {};
        for (const note of notes) {
          if (!note.imageId || images[note.imageId]) continue;
          const image = await storage.getImage(note.imageId);
          if (image) {
            images[image.id] = {
              id: image.id,
              dataUrl: await blobToDataUrl(image.blob),
              width: image.width,
              height: image.height,
            };
          }
        }
        const bundle: ExportBundle = { course, notes, chapters, images, setting: sanitizeSetting(setting) };
        return ok(bundle);
      }

      case 'ai:generateChapters':
        return generateAiChapters(msg.courseId, msg.cues);

      case 'ai:testConnection':
        return testAiConnection();

      default:
        return err('bg.err.unknownMessage');
    }
  }

  // ---- 顶层同步注册监听器（MV3 铁律） ----

  /**
   * 右键菜单「激活本页语音转写」：
   * Chrome 规定 tabCapture 必须先经用户手势在目标页激活（activeTab 授权）。
   * 图标点击已改走 action.onClicked（见文件末尾注释），点图标本身即激活手势；
   * 等待激活期间该 tab 的图标还会切换为激活弹窗（entrypoints/activate-popup）。
   * 此处菜单作为图标未固定到工具栏时的兜底——contextMenus 菜单项执行是
   * activeTab 文档保证计入的手势（规范示例），菜单执行本身即完成授予；
   * 顺手打开面板方便继续操作。SW 每次启动幂等重建（removeAll 防重复 id）。
   */
  const ASR_ACTIVATE_MENU_ID = 'asr-activate-page';
  const contextMenuReady = browser.contextMenus
    .removeAll()
    .then(() =>
      browser.contextMenus.create({
        id: ASR_ACTIVATE_MENU_ID,
        title: t('bg.contextMenuActivate'),
        contexts: ['page', 'frame', 'video', 'audio'],
      }),
    )
    .catch((e: unknown) => console.warn('[kedaibiao] 右键菜单注册失败：', e));
  // 解析语言设置、替换兜底翻译器并刷新菜单标题（排在菜单创建之后）
  void refreshI18n();
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== ASR_ACTIVATE_MENU_ID) return;
    if (tab?.windowId !== undefined) browserAdapter.openSidebar(tab.windowId);
  });

  /**
   * 智慧树字幕/视频接口校验 Referer：SW 代抓时补上。
   * tabIds: [-1] 限定只作用于非标签页（本扩展 SW 与扩展页）发起的请求，页面自身请求
   * 不受影响；网络层头修改对页面 JS 不可见，不触碰反作弊检测面。
   * 9001：字幕接口（newbase）；9002：视频源（vsvideo，语音转写文件模式下载用）。
   */
  async function registerZhihuishuRefererRule(): Promise<void> {
    try {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [9001, 9002],
        addRules: [
          {
            id: 9001,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                {
                  header: 'referer',
                  operation: 'set',
                  value: 'https://studyvideoh5.zhihuishu.com/',
                },
              ],
            },
            condition: {
              requestDomains: ['newbase.zhihuishu.com'],
              tabIds: [-1],
            },
          },
          {
            id: 9002,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                {
                  header: 'referer',
                  operation: 'set',
                  value: 'https://studyvideoh5.zhihuishu.com/',
                },
              ],
            },
            condition: {
              // 智慧树视频源是一族 *video.zhihuishu.com 子域（vsvideo/wsvideo/…）
              regexFilter: '^https?://[a-z0-9-]*video\\.zhihuishu\\.com/',
              tabIds: [-1],
            },
          },
        ],
      });
    } catch (e) {
      console.warn('[kedaibiao] DNR 规则注册失败：', e);
    }
  }
  void registerZhihuishuRefererRule();

  browser.commands.onCommand.addListener((command) => {
    void handleCommand(command);
  });

  // 切 tab / 活动页 URL 变化（含 SPA 换视频）时，向该窗口的面板推送新课程上下文
  browser.tabs.onActivated.addListener((activeInfo) => {
    void pushCourseContext(activeInfo.windowId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url || !tab.active) return;
    void pushCourseContext(tab.windowId);
  });

  browser.runtime.onMessage.addListener((rawMsg: unknown, sender, sendResponse) => {
    routeMessage(rawMsg as RequestMessage, sender)
      .then(sendResponse)
      .catch((e: unknown) => sendResponse(err(readableError(e))));
    return true;
  });

  // 启动诊断：在 SW 控制台可见已注册的命令（排查快捷键未绑定时用）
  browser.commands
    .getAll()
    .then((list) => console.log('[kedaibiao] 已注册命令：', list))
    .catch(() => {});

  /**
   * 点击工具栏图标打开侧栏（Chrome 与 Firefox 同走 action.onClicked）。
   *
   * Firefox 不会仅因 manifest 声明了 sidebar_action 就响应图标点击——必须声明
   * action 键（wxt.config.ts；不声明则工具栏无按钮、扩展面板里点击不派发事件），
   * 点击后由适配器调 sidebarAction.open()（action 点击本身即用户手势，满足其要求）。
   *
   * Chrome 侧不用 sidePanel.setPanelBehavior({openPanelOnActionClick})：Chrome 源码里
   * 侧栏 toggle 优先于 action popup，且该路径明确不授予 tab 权限
   * （extension_action_runner.cc RunAction：侧栏可跨 tab 持久、可从面板 UI 打开，
   * 故 toggle 侧栏不算激活手势）——「点图标开侧栏」永远不计入 tabCapture 激活，
   * 还会吞掉等待激活时设置的激活弹窗。
   * 改走 action.onClicked：RunAction 先 GrantTabPermissions 再分发——
   * 点图标本身即激活手势；等待激活期间该 tab 设了 popup 时则直接弹激活弹窗，
   * 不触发本事件。代价：图标失去「再点一次关面板」的 toggle（侧栏可用自带 X 关闭）。
   */
  browser.action.onClicked.addListener((tab) => {
    // sidePanel.open / sidebarAction.open 需要用户手势，须在事件回调同步阶段调用（同 commands 约束）
    browserAdapter.openSidebar(tab.windowId);
  });
  if (!import.meta.env.FIREFOX) {
    // 迁移：旧版本曾把 openPanelOnIconClick 偏好置为 true（持久化于 ExtensionPrefs），
    // 显式关闭一次，否则点图标仍走 toggle 侧栏、吞掉激活弹窗
    browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: false })
      .catch(() => {});
  }
});
