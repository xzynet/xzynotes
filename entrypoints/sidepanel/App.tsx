import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { formatTimestamp, generateMarkdown } from '~/core/export';
import {
  createTranslator,
  isMessageKey,
  localizeError,
  resolveLocale,
  type Locale,
} from '~/core/i18n';
import { I18nProvider } from '~/components/i18n';
import {
  type CourseContext,
  type CourseSummary,
  type ExportBundle,
  type PushMessage,
} from '~/core/messages';
import type { Note, Setting } from '~/core/models';
import { NoteCard } from '~/components/NoteCard';
import { EditableTitle } from '~/components/EditableTitle';
import { Annotator } from '~/components/Annotator';
import { Toaster, type ToastItem, type ToastLevel } from '~/components/Toaster';
import { send } from './rpc';
import { useImageCache } from './useImageCache';
import { HomeView } from './HomeView';
import { CourseDetailView } from './CourseDetailView';
import { SubtitlesPanel } from './SubtitlesPanel';
import { applyTheme } from '~/components/theme';

type View =
  | { name: 'home' }
  | { name: 'course'; summary: CourseSummary }
  | { name: 'current' };

let toastSeq = 0;

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  /** 生效语言：init 内解析 setting 前为 null（解析前不渲染，避免语言闪屏） */
  const [locale, setLocale] = useState<Locale | null>(null);
  const [view, setView] = useState<View>({ name: 'home' });
  const [ctx, setCtx] = useState<CourseContext | null>(null);
  /** 当前课程视图内的子页签 */
  const [currentTab, setCurrentTab] = useState<'notes' | 'chapters'>('chapters');
  /** 「当前课程」不可用的原因（页面不支持 / 脚本未注入等） */
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const { images, ensureImage } = useImageCache();
  const [draft, setDraft] = useState('');
  const [pendingA, setPendingA] = useState<number | null>(null);
  const [loop, setLoop] = useState<{ a: number; b: number } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [exporting, setExporting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** Alt+A 标注流程：待标注的截图 */
  const [annotate, setAnnotate] = useState<{
    imageId: string;
    courseId: string;
    time: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightNoteIdRef = useRef<string | null>(null);
  /** 面板所在窗口：多窗口时只跟随本窗口的活动标签页 */
  const myWindowIdRef = useRef<number | null>(null);
  /** 上下文比对用的最新值（消息监听器闭包里的 ctx 可能滞后） */
  const ctxRef = useRef<CourseContext | null>(null);
  ctxRef.current = ctx;
  /** 转写任务是否在跑：跑在面板文档里，跟随切页会重挂转写卡片把任务终止 */
  const asrBusyRef = useRef(false);
  /** 上一轮上报过「任务进行中」：过滤卡片挂载/卸载时的无意义 false 上报 */
  const asrWasBusyRef = useRef(false);
  /** 因转写任务而冻结了「跟随标签页」（仅用于展示提示条） */
  const [frozenByAsr, setFrozenByAsr] = useState(false);
  /** 转写任务进行中（用于离开课程页时的状态条） */
  const [asrBusy, setAsrBusy] = useState(false);

  const pushToast = useCallback(
    (text: string, level: ToastLevel = 'info', action?: ToastItem['action']) => {
      const id = ++toastSeq;
      setToasts((ts) => [...ts, { id, text, level, action }]);
      // 有操作按钮的 toast 停留 10s（撤销窗口），其余 4s
      window.setTimeout(
        () => setToasts((ts) => ts.filter((t) => t.id !== id)),
        action ? 10000 : 4000,
      );
    },
    [],
  );

  const t = useMemo(() => createTranslator(locale ?? 'zh-CN'), [locale]);
  /** 回调内取最新 t：避免语言切换改变回调身份、导致 init 等 effect 重跑 */
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // 文档标题跟随当前语言
  useEffect(() => {
    if (locale) document.title = t('brand.name');
  }, [locale, t]);

  const loadNotes = useCallback(
    async (courseId: string) => {
      try {
        setNotes(await send<Note[]>({ type: 'notes:list', courseId }));
      } catch (e) {
        pushToast(
          e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.loadNotesFailed'),
          'error',
        );
      }
    },
    [pushToast],
  );

  // 切到「当前课程」并聚焦输入框（Alt+N 体验）；输入框渲染后再聚焦
  const focusNewNoteInput = useCallback(() => {
    setView({ name: 'current' });
    setCurrentTab('notes');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const init = useCallback(async () => {
    try {
      const win = await browser.windows.getCurrent().catch(() => undefined);
      myWindowIdRef.current = win?.id ?? null;
      // 主题设置（面板打开即生效）
      const setting = await send<Setting>({ type: 'setting:get' }).catch(() => null);
      if (setting) applyTheme(setting.theme);
      // 语言：设置项优先，'auto' 跟随浏览器 UI 语言
      setLocale(resolveLocale(setting?.language ?? 'auto', browser.i18n.getUILanguage()));
      const context = await send<CourseContext>({
        type: 'panel:init',
        windowId: myWindowIdRef.current ?? undefined,
      });
      setCtx(context);
      setCtxError(null);
      if (context.degraded) {
        pushToast(tRef.current('panel.degradedToast'), 'error');
      }
      await loadNotes(context.course.id);
      // Alt+N 打开面板后自动聚焦输入框
      const pending = (await browser.storage.session.get('pendingFocusNote')) as Record<
        string,
        unknown
      >;
      if (pending['pendingFocusNote']) {
        await browser.storage.session.remove('pendingFocusNote');
        focusNewNoteInput();
      }
      // Alt+A 冷启动：面板晚于广播打开时补开标注器
      const pendingAnno = (await browser.storage.session.get('pendingAnnotate')) as Record<
        string,
        { imageId: string; courseId: string; time: number } | undefined
      >;
      const anno = pendingAnno['pendingAnnotate'];
      if (anno) {
        await browser.storage.session.remove('pendingAnnotate');
        setAnnotate(anno);
      }
    } catch (e) {
      // 非视频页/脚本未注入/未激活：仅「当前课程」不可用，全部课程首页照常显示
      setCtx(null);
      setCtxError(
        e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.notVideoPage'),
      );
    }
  }, [loadNotes, pushToast, focusNewNoteInput]);

  useEffect(() => {
    void init();
  }, [init]);

  /**
   * 应用活动标签页的课程上下文（null = 当前页不是视频页/未激活）。
   * 上下文与现状相同时不动，避免同一课程重复刷新。
   */
  const applyContext = useCallback(
    (next: CourseContext | null) => {
      if (!next) {
        if (ctxRef.current) {
          setCtx(null);
          setCtxError(tRef.current('panel.tabNotVideoPage'));
          setLoop(null);
          setPendingA(null);
        }
        return;
      }
      const prev = ctxRef.current;
      if (prev && prev.course.id === next.course.id && prev.tabId === next.tabId) return;
      setCtx(next);
      setCtxError(null);
      setLoop(null);
      setPendingA(null);
      if (next.degraded) {
        pushToast(tRef.current('panel.degradedToast'), 'error');
      }
      void loadNotes(next.course.id);
    },
    [loadNotes, pushToast],
  );

  /**
   * 转写任务起停。local = 任务跑在面板文档里的转写卡片上（引擎 worker + 媒体流），
   * 面板跟随切页会重挂卡片把它 dispose 掉——故 local 期间冻结上下文，结束后重新跟随；
   * host = offscreen 宿主任务，与面板同生共死无关，只用于顶部状态条。
   */
  const handleAsrBusy = useCallback(
    (busy: { local: boolean; host: boolean }) => {
      asrBusyRef.current = busy.local;
      setAsrBusy(busy.local || busy.host);
      if (busy.local) {
        asrWasBusyRef.current = true;
        return;
      }
      // 卡片挂载时就上报 false：没有真正跑过任务则无需重新跟随
      if (!asrWasBusyRef.current) return;
      asrWasBusyRef.current = false;
      setFrozenByAsr(false);
      void send<CourseContext>({
        type: 'panel:init',
        windowId: myWindowIdRef.current ?? undefined,
      })
        .then(applyContext)
        .catch(() => applyContext(null));
    },
    [applyContext],
  );

  // 后台广播：toast / 笔记变更 / 设置变更 / 聚焦输入框
  useEffect(() => {
    const listener = (raw: unknown) => {
      const msg = raw as PushMessage;
      if (msg.type === 'toast') {
        // 后台广播的可能是已注册的文案 key：key 翻译、非 key 原文透传
        pushToast(isMessageKey(msg.text) ? tRef.current(msg.text) : msg.text, msg.level);
      } else if (msg.type === 'notes:changed') {
        if (ctx && msg.courseId === ctx.course.id) {
          highlightNoteIdRef.current = msg.highlightNoteId ?? null;
          void loadNotes(msg.courseId);
        }
      } else if (msg.type === 'setting:changed') {
        // 设置页改语言后面板即时切换
        setLocale(resolveLocale(msg.setting.language, browser.i18n.getUILanguage()));
      } else if (msg.type === 'panel:focusNewNote') {
        if (ctx) focusNewNoteInput();
      } else if (msg.type === 'panel:annotate') {
        setAnnotate({ imageId: msg.imageId, courseId: msg.courseId, time: msg.time });
      } else if (msg.type === 'course:context') {
        // 切标签页/页面内跳转后跟随：只处理本窗口的广播
        if (myWindowIdRef.current !== null && msg.windowId !== myWindowIdRef.current) return;
        // 转写任务进行中：跟随切页会把任务一并终止（卡片卸载 → dispose），
        // 改为冻结在当前课程，任务结束后由 handleAsrBusy 重新跟随
        if (asrBusyRef.current) {
          setFrozenByAsr(!ctxRef.current || msg.context?.course.id !== ctxRef.current.course.id);
          return;
        }
        applyContext(msg.context);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [ctx, loadNotes, pushToast, focusNewNoteInput, applyContext]);

  // 新增笔记后滚动定位 + 高亮闪现
  useEffect(() => {
    const id = highlightNoteIdRef.current;
    if (!id || !notes.some((n) => n.id === id)) return;
    highlightNoteIdRef.current = null;
    setHighlightId(id);
    document.getElementById(`note-${id}`)?.scrollIntoView({ block: 'center' });
    const timer = window.setTimeout(() => setHighlightId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [notes]);

  // ---- 动作（当前课程视图） ----

  const renameCourse = useCallback(
    async (next: string) => {
      if (!ctx) return;
      try {
        await send({ type: 'course:rename', courseId: ctx.course.id, title: next });
        setCtx({ ...ctx, course: { ...ctx.course, title: next, titleLocked: true } });
        pushToast(tRef.current('panel.renameSuccess'), 'success');
      } catch (e) {
        pushToast(
          e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.renameFailed'),
          'error',
        );
        throw e;
      }
    },
    [ctx, pushToast],
  );

  const openCurrentView = useCallback(() => {
    setView({ name: 'current' });
    if (ctx) void loadNotes(ctx.course.id);
  }, [ctx, loadNotes]);

  const seek = useCallback(
    async (sec: number) => {
      if (!ctx) return;
      try {
        await send({ type: 'video:seek', tabId: ctx.tabId, sec });
      } catch (e) {
        pushToast(
          e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.seekFailed'),
          'error',
        );
      }
    },
    [ctx, pushToast],
  );

  const submitNote = useCallback(async () => {
    const content = draft.trim();
    if (!content || !ctx) return;
    try {
      await send({ type: 'note:createText', courseId: ctx.course.id, tabId: ctx.tabId, content });
      setDraft('');
      pushToast(tRef.current('panel.noteSaved'), 'success');
    } catch (e) {
      pushToast(
        e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.noteSaveFailed'),
        'error',
      );
    }
  }, [ctx, draft, pushToast]);

  /** 「截图编辑」按钮：与 Alt+A 同一流程，后台抓帧后广播 panel:annotate 打开标注器 */
  const captureAnnotate = useCallback(async () => {
    if (!ctx || capturing) return;
    setCapturing(true);
    try {
      await send({ type: 'capture:annotate', windowId: myWindowIdRef.current ?? undefined });
    } catch (e) {
      pushToast(
        e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.captureFailed'),
        'error',
      );
    } finally {
      setCapturing(false);
    }
  }, [ctx, capturing, pushToast]);

  const deleteNote = useCallback(
    (note: Note) => {
      const image = note.imageId ? images[note.imageId] : undefined;
      send({ type: 'note:delete', id: note.id })
        .then(() => {
          pushToast(tRef.current('panel.noteDeleted'), 'info', {
            label: tRef.current('panel.undo'),
            onClick: () => {
              send({ type: 'note:restore', note, image })
                .then(() => pushToast(tRef.current('panel.undoSuccess'), 'success'))
                .catch((e) =>
                  pushToast(
                    e instanceof Error
                      ? localizeError(tRef.current, e)
                      : tRef.current('panel.undoFailed'),
                    'error',
                  ),
                );
            },
          });
        })
        .catch((e) =>
          pushToast(
            e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.noteDeleteFailed'),
            'error',
          ),
        );
    },
    [images, pushToast],
  );

  /** 截图标题保存；reject 交给 NoteCard 回退编辑态 */
  const updateNoteContent = useCallback(
    async (note: Note, content: string) => {
      try {
        await send({ type: 'note:update', id: note.id, content });
        pushToast(tRef.current(content ? 'panel.captionSaved' : 'panel.captionCleared'), 'success');
      } catch (e) {
        pushToast(
          e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.captionSaveFailed'),
          'error',
        );
        throw e;
      }
    },
    [pushToast],
  );

  const clickLoop = useCallback(
    async (note: Note) => {
      if (!ctx) return;
      if (pendingA === null) {
        setPendingA(note.timestampSec);
        pushToast(tRef.current('panel.loopPointA', { time: formatTimestamp(note.timestampSec) }));
        return;
      }
      const [a, b] = [Math.min(pendingA, note.timestampSec), Math.max(pendingA, note.timestampSec)];
      if (b - a < 1) {
        pushToast(tRef.current('panel.loopTooClose'), 'error');
        setPendingA(null);
        return;
      }
      try {
        await send({ type: 'video:setLoop', tabId: ctx.tabId, a, b });
        setLoop({ a, b });
        setPendingA(null);
        pushToast(
          tRef.current('panel.loopStarted', { a: formatTimestamp(a), b: formatTimestamp(b) }),
          'success',
        );
      } catch (e) {
        pushToast(
          e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.loopSetFailed'),
          'error',
        );
        setPendingA(null);
      }
    },
    [ctx, pendingA, pushToast],
  );

  const cancelLoop = useCallback(async () => {
    if (!ctx) return;
    try {
      await send({ type: 'video:clearLoop', tabId: ctx.tabId });
    } catch {
      // 页面不可达时本地状态也复位
    }
    setLoop(null);
    setPendingA(null);
  }, [ctx]);

  /** 标注器保存：覆盖原图 → 创建截图笔记 */
  const saveAnnotate = useCallback(
    async (dataUrl: string, width: number, height: number) => {
      if (!annotate) return;
      try {
        await send({ type: 'image:replace', id: annotate.imageId, dataUrl, width, height });
        await send({
          type: 'note:createImage',
          courseId: annotate.courseId,
          imageId: annotate.imageId,
          timestampSec: annotate.time,
        });
        pushToast(tRef.current('panel.annotateSaved'), 'success');
      } catch (e) {
        pushToast(
          e instanceof Error
            ? localizeError(tRef.current, e)
            : tRef.current('panel.annotateSaveFailed'),
          'error',
        );
      }
      setAnnotate(null);
    },
    [annotate, pushToast],
  );

  /** 标注器取消：清理孤儿截图 */
  const cancelAnnotate = useCallback(() => {
    if (annotate) {
      void send({ type: 'image:delete', id: annotate.imageId }).catch(() => {});
    }
    setAnnotate(null);
  }, [annotate]);

  const doExport = useCallback(
    async (mode: 'download' | 'copy') => {
      if (!ctx || exporting) return;
      setExporting(true);
      try {
        const bundle = await send<ExportBundle>({ type: 'export:course', courseId: ctx.course.id });
        // 逐时间点取平台回跳链接（B站 ?t=秒）：笔记 + 章节起点
        const secs = [
          ...new Set([
            ...bundle.notes.map((n) => n.timestampSec),
            ...bundle.chapters.map((c) => c.startSec),
          ]),
        ];
        const jumpEntries = await Promise.all(
          secs.map(async (sec) => {
            try {
              const url = await send<string>({ type: 'video:jumpUrl', tabId: ctx.tabId, sec });
              return [sec, url] as const;
            } catch {
              return [sec, bundle.course.url] as const;
            }
          }),
        );
        const jumpMap = new Map(jumpEntries);
        const imagesForExport = Object.fromEntries(
          Object.entries(bundle.images).map(([id, img]) => [id, { dataUrl: img.dataUrl }]),
        );
        const md = generateMarkdown(bundle.course, bundle.notes, bundle.chapters, {
          embedImage: bundle.setting.exportPrefs.embedImage,
          footerCredit: bundle.setting.exportPrefs.footerCredit,
          makeJumpUrl: (sec) => jumpMap.get(sec) ?? bundle.course.url,
          images: imagesForExport,
          locale: locale ?? undefined,
        });
        if (mode === 'copy') {
          await navigator.clipboard.writeText(md);
          pushToast(tRef.current('panel.exportCopied'), 'success');
        } else {
          downloadText(`${bundle.course.title}.md`, md);
          pushToast(tRef.current('panel.exportDownloaded'), 'success');
        }
      } catch (e) {
        pushToast(
          e instanceof Error ? localizeError(tRef.current, e) : tRef.current('panel.exportFailed'),
          'error',
        );
      } finally {
        setExporting(false);
      }
    },
    [ctx, exporting, pushToast, locale],
  );

  // ---- 渲染 ----

  const onHomeSection = view.name !== 'current';

  // 语言解析完成前不渲染，避免先显示兜底语言再切换
  if (!locale) return null;

  return (
    <I18nProvider locale={locale}>
      <div className="flex min-h-screen flex-col bg-gray-50">
        <nav className="flex border-b border-gray-200 bg-white text-sm">
          <button
            type="button"
            onClick={() => setView({ name: 'home' })}
            className={`flex-1 px-3 py-2 font-medium ${
              onHomeSection
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {t('panel.navAllCourses')}
          </button>
          <button
            type="button"
            onClick={openCurrentView}
            title={ctx ? ctx.course.title : (ctxError ?? t('panel.navUnsupportedTitle'))}
            className={`flex-1 px-3 py-2 font-medium ${
              !onHomeSection
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {t('panel.navCurrentCourse')}
          </button>
        </nav>

        {/* 转写任务进行中且已离开课程页：转写卡片在被隐藏的课程视图里，
            这里补一条始终可见的状态，说明任务还在跑 */}
        {asrBusy && view.name !== 'current' ? (
          <div className="border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-xs leading-relaxed text-sky-700">
            {t('panel.asrBusyHint')}
          </div>
        ) : null}

        {view.name === 'home' ? (
          <main className="flex-1 overflow-y-auto p-3">
            <HomeView
              pushToast={pushToast}
              onOpenCourse={(summary) => setView({ name: 'course', summary })}
            />
          </main>
        ) : view.name === 'course' ? (
          <main className="flex-1 overflow-y-auto p-3">
            <CourseDetailView
              summary={view.summary}
              ctx={ctx}
              pushToast={pushToast}
              onBack={() => setView({ name: 'home' })}
            />
          </main>
        ) : null}

        {/* 当前课程无上下文：引导去支持的平台页 */}
        {view.name === 'current' && !ctx ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <h1 className="text-lg font-bold">{t('brand.name')}</h1>
            <p className="text-sm text-gray-500">{ctxError ?? t('panel.emptyHint')}</p>
            <p className="text-xs text-gray-400">
              {t('panel.supportedPlatforms', {
                platforms: [
                  t('platform.bilibili'),
                  t('platform.icourse163'),
                  t('platform.xuetangx'),
                  t('platform.zhihuishu'),
                ].join(' / '),
              })}
            </p>
            <button
              type="button"
              onClick={() => void init()}
              className="mt-1 rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
            >
              {t('panel.retryConnect')}
            </button>
          </div>
        ) : null}

        {/* 当前课程视图常驻挂载：离开本页只做 CSS 隐藏、不卸载——转写任务跑在 AsrCard 里
            （引擎 worker + 媒体流），卸载即 dispose 引擎、终止正在进行的转写。
            contents 不生成盒子，可见时布局与直接列在下面完全一致 */}
        {ctx ? (
          <div className={view.name === 'current' ? 'contents' : 'hidden'}>
            <header className="border-b border-gray-200 bg-white px-3 py-2">
              <EditableTitle title={ctx.course.title} onSave={renameCourse} />
              <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                <span>
                  {ctx.course.platform === 'bilibili'
                    ? t('platform.bilibili')
                    : ctx.course.platform === 'youtube'
                      ? t('platform.youtube')
                      : ctx.course.platform}
                </span>
                {ctx.degraded ? (
                  <span className="text-amber-500">{t('panel.genericMode')}</span>
                ) : null}
              </div>
            </header>

            <div className="flex border-b border-gray-200 bg-white text-xs">
              {(
                [
                  ['chapters', t('panel.tabChapters')],
                  ['notes', t('panel.tabNotes')],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCurrentTab(key)}
                  className={`flex-1 px-3 py-1.5 font-medium ${
                    currentTab === key
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {frozenByAsr ? (
              <div className="border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-xs leading-relaxed text-sky-700">
                {t('panel.asrFrozenHint')}
              </div>
            ) : null}

            {/* 字幕页签常驻挂载、切到「笔记」时仅 CSS 隐藏：转写任务跑在 AsrCard 里
                （引擎 worker + 媒体流），卸载它会 dispose 引擎、终止正在进行的转写 */}
            <main className={currentTab === 'chapters' ? 'flex-1 overflow-y-auto' : 'hidden'}>
              <SubtitlesPanel
                key={ctx.course.id}
                ctx={ctx}
                pushToast={pushToast}
                onSeek={(sec) => void seek(sec)}
                onAsrBusy={handleAsrBusy}
              />
            </main>
            {currentTab === 'chapters' ? null : (
              <>
                <div className="border-b border-gray-200 bg-white p-3">
                  <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submitNote();
                    }}
                    placeholder={t('panel.notePlaceholder')}
                    rows={2}
                    className="w-full resize-none rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void submitNote()}
                      disabled={!draft.trim()}
                      className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                    >
                      {t('panel.saveNote')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void captureAnnotate()}
                      disabled={capturing}
                      title={t('panel.captureAnnotateTitle')}
                      className="rounded-md border border-blue-300 px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-40"
                    >
                      {capturing ? t('panel.capturing') : t('panel.captureAnnotate')}
                    </button>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => void doExport('download')}
                      disabled={exporting || notes.length === 0}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      {t('panel.exportMd')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void doExport('copy')}
                      disabled={exporting || notes.length === 0}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      {t('panel.copy')}
                    </button>
                  </div>
                </div>

                {loop ? (
                  <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                    <span>
                      {t('panel.looping', {
                        a: formatTimestamp(loop.a),
                        b: formatTimestamp(loop.b),
                      })}
                    </span>
                    <button type="button" className="underline" onClick={() => void cancelLoop()}>
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : null}

                <main className="flex-1 space-y-2 overflow-y-auto p-3">
                  {notes.length === 0 ? (
                    <p className="mt-8 text-center text-xs text-gray-400">
                      {t('panel.emptyNotes')}
                    </p>
                  ) : (
                    notes.map((note) => (
                      <NoteCard
                        key={note.id}
                        note={note}
                        imageUrl={note.imageId ? images[note.imageId]?.dataUrl : undefined}
                        highlight={note.id === highlightId}
                        loopPhase={loop ? 'active' : pendingA !== null ? 'pickingB' : 'idle'}
                        inLoopRange={
                          loop !== null && note.timestampSec >= loop.a && note.timestampSec <= loop.b
                        }
                        onSeek={(sec) => void seek(sec)}
                        onDelete={deleteNote}
                        onUpdateContent={updateNoteContent}
                        onLoopClick={(n) => void clickLoop(n)}
                        onCancelLoop={() => void cancelLoop()}
                        onImageVisible={(imageId) => void ensureImage(imageId)}
                      />
                    ))
                  )}
                </main>
              </>
            )}
          </div>
        ) : null}

        <Toaster items={toasts} />

        <button
          type="button"
          onClick={() => void browser.runtime.openOptionsPage()}
          title={t('panel.settings')}
          aria-label={t('panel.settings')}
          className="fixed bottom-3 right-3 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white text-base text-gray-500 shadow-md hover:bg-gray-50 hover:text-gray-700"
        >
          ⚙
        </button>

        {annotate ? (
          <Annotator
            imageId={annotate.imageId}
            onSave={(dataUrl, width, height) => void saveAnnotate(dataUrl, width, height)}
            onCancel={cancelAnnotate}
          />
        ) : null}
      </div>
    </I18nProvider>
  );
}
