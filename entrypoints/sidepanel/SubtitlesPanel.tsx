import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { groupCuesByChapter, segmentChapters, type DensityPoint } from '~/core/chapters';
import { formatTimestamp } from '~/core/export';
import type { AiGenerateResult, CourseContext, PushMessage } from '~/core/messages';
import { localizeError } from '~/core/i18n';
import type { Chapter, Setting, SubtitleCue, Transcript } from '~/core/models';
import { buildSubtitleIndex, type SearchHit, type SubtitleSearch } from '~/core/search';
import { newId } from '~/core/utils/id';
import { useT } from '~/components/i18n';
import { requestAiConsent } from '~/components/dataConsent';
import type { ToastItem, ToastLevel } from '~/components/Toaster';
import { AsrCard } from './AsrCard';
import { hostJobActive } from './asr/host-client';
import { send } from './rpc';

type PanelStatus = 'loading' | 'ready' | 'no-subtitles';

/**
 * 字幕页签：章节大纲为主视图——有章节（AI/规则）时直接逐章列出标题与摘要，
 * 每章字幕融合在标题与摘要之后、缺省收起，点「字幕」小按钮展开；
 * 播放进度落入某章时该章高亮；没有章节时回退为字幕全文平铺列表
 * （跟随播放高亮 + 定位当前）；另有字幕全文检索，点击结果回跳。
 */
export function SubtitlesPanel({
  ctx,
  pushToast,
  onSeek,
  onAsrBusy,
}: {
  ctx: CourseContext;
  pushToast: (text: string, level?: ToastLevel, action?: ToastItem['action']) => void;
  onSeek: (sec: number) => void;
  /** 转写任务起停（local=面板内任务需冻结跟随，host=宿主任务；见 App.tsx） */
  onAsrBusy?: (state: { local: boolean; host: boolean }) => void;
}) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<PanelStatus>('loading');
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  /** true = 当前展示的 cue 来自本地语音转写（而非平台字幕） */
  const [fromTranscript, setFromTranscript] = useState(false);
  const [query, setQuery] = useState('');
  const [now, setNow] = useState<number | null>(null);
  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  /** 章节字幕展开状态：内容惰性挂载（长字幕避免 DOM 翻倍），缺省收起 */
  const [openChapters, setOpenChapters] = useState<Record<string, boolean>>({});
  /** 整课概述：初始取课程记录里的存值，AI 生成成功后用响应更新 */
  const [overview, setOverview] = useState(ctx.course.summary);
  /** 行内编辑（仅本地转写来源）：正在编辑的 cue 全局下标与草稿 */
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const indexRef = useRef<SubtitleSearch | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 切换课程时重置概述与章节缓存
  useEffect(() => {
    setOverview(ctx.course.summary);
    setChapters(null);
    setOpenChapters({});
  }, [ctx.course.id, ctx.course.summary]);

  // 读取已存章节：有章节时直接展示
  useEffect(() => {
    send<Chapter[]>({ type: 'chapters:list', courseId: ctx.course.id })
      .then(setChapters)
      .catch(() => setChapters([]));
  }, [ctx.course.id]);

  // 拉字幕 + 建检索索引；平台无字幕时回退本地语音转写缓存
  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const data = await send<SubtitleCue[]>({ type: 'subtitles:get', tabId: ctx.tabId });
      setCues(data);
      indexRef.current = buildSubtitleIndex(data);
      setFromTranscript(false);
      setStatus('ready');
      return;
    } catch {
      // 平台无字幕，继续尝试本地转写缓存（Chrome/Firefox 的转写结果都存在这里）
    }
    try {
      const t = await send<Transcript | null>({ type: 'transcript:get', courseId: ctx.course.id });
      if (t && t.cues.length > 0) {
        // 有缓存也要先看后台任务：任务在宿主里跑着（结果尚未落盘）时，
        // 展示的应是转写卡片（重新接回进度），而不是上一轮已完成的字幕
        if (await hostJobActive(ctx.course.id)) {
          setStatus('no-subtitles');
          return;
        }
        setCues(t.cues);
        indexRef.current = buildSubtitleIndex(t.cues);
        setFromTranscript(true);
        setStatus('ready');
        return;
      }
    } catch {
      // 缓存读取失败按无转写处理
    }
    setStatus('no-subtitles');
  }, [ctx.tabId, ctx.course.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 静默刷新：不闪 loading，成功自愈无字幕状态（字幕分段陆续到达时用） */
  const softReload = useCallback(async () => {
    try {
      const data = await send<SubtitleCue[]>({ type: 'subtitles:get', tabId: ctx.tabId });
      setCues(data);
      indexRef.current = buildSubtitleIndex(data);
      // 真字幕到达后优先展示真字幕（替代本地转写）
      setFromTranscript(false);
      setStatus('ready');
    } catch {
      // 保持现状
    }
  }, [ctx.tabId]);

  /** 转写完成：cue 回填主视图，检索/章节/回跳立即可用 */
  const handleAsrFinished = useCallback((newCues: SubtitleCue[]) => {
    setCues(newCues);
    indexRef.current = buildSubtitleIndex(newCues);
    setFromTranscript(true);
    setStatus('ready');
  }, []);

  /** 提交行内编辑（仅本地转写）：更新视图与检索索引，并写回转写缓存 */
  const commitEdit = useCallback(async () => {
    if (editIdx === null) return;
    const text = editDraft.trim();
    const idx = editIdx;
    setEditIdx(null);
    if (!text || cues[idx]?.text === text) return;
    const next = cues.map((c, i) => (i === idx ? { ...c, text } : c));
    setCues(next);
    indexRef.current = buildSubtitleIndex(next);
    try {
      const t = await send<Transcript | null>({ type: 'transcript:get', courseId: ctx.course.id });
      if (t) {
        await send({
          type: 'transcript:save',
          transcript: { ...t, cues: next, updatedAt: Date.now() },
        });
      }
    } catch (e) {
      pushToast(t('subtitles.editSaveFailed', { message: localizeError(t, e) }), 'error');
    }
  }, [editIdx, editDraft, cues, ctx.course.id, pushToast, t]);

  /** 单条字幕行：点击查看/回跳；本地转写来源时悬停出编辑按钮，点击进入行内编辑 */
  const renderCueRow = (cue: SubtitleCue, gi: number, active: boolean) => {
    if (editIdx === gi) {
      return (
        <div key={`${cue.start}-${gi}`} className="flex items-start gap-2 rounded-md px-2 py-1.5">
          <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs font-medium text-gray-500">
            {formatTimestamp(cue.start)}
          </span>
          <textarea
            autoFocus
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onBlur={() => void commitEdit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void commitEdit();
              } else if (e.key === 'Escape') {
                setEditIdx(null);
              }
            }}
            rows={Math.max(2, Math.ceil(editDraft.length / 28))}
            className="min-w-0 flex-1 rounded border border-blue-300 px-1 py-0.5 text-xs outline-none focus:border-blue-500"
          />
        </div>
      );
    }
    return (
      <div
        key={`${cue.start}-${gi}`}
        data-active={active || undefined}
        className={`group flex w-full items-start gap-2 rounded-md px-2 py-1.5 ${
          active ? 'bg-blue-100' : 'hover:bg-blue-50'
        }`}
      >
        <button
          type="button"
          onClick={() => onSeek(cue.start)}
          className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs font-medium ${
            active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {formatTimestamp(cue.start)}
        </button>
        <button
          type="button"
          onClick={() => onSeek(cue.start)}
          className={`min-w-0 flex-1 break-words text-left text-xs ${
            active ? 'text-blue-900' : 'text-gray-700'
          }`}
        >
          {cue.text}
        </button>
        {fromTranscript ? (
          <button
            type="button"
            title={t('subtitles.editText')}
            onClick={() => {
              setEditIdx(gi);
              setEditDraft(cue.text);
            }}
            className="shrink-0 rounded px-1 text-gray-300 transition-colors hover:bg-blue-50 hover:text-blue-600"
          >
            ✎
          </button>
        ) : null}
      </div>
    );
  };

  // 拦截器捕获到新字幕分段 → 实时刷新
  useEffect(() => {
    const listener = (raw: unknown) => {
      const msg = raw as PushMessage;
      if (msg.type === 'subtitles:changed') void softReload();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [softReload]);

  // 检索：空查询不显示结果区
  const hits = useMemo<SearchHit[] | null>(() => {
    const q = query.trim();
    if (!q) return null;
    return indexRef.current?.search(q, 100) ?? [];
  }, [query]);

  // 字幕按章节归组：展开章节条目时取用（首个章节之前的字幕不归属任何章）
  const chapterCues = useMemo(
    () => (chapters && chapters.length > 0 ? groupCuesByChapter(chapters, cues) : null),
    [chapters, cues],
  );

  // 没有章节（AI/规则）时，字幕全文平铺展示
  const showFlatList = !chapters || chapters.length === 0;

  // 每秒同步播放进度：平铺列表高亮当前句、章节大纲高亮当前章
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = window.setInterval(() => {
      send<number>({ type: 'video:getTime', tabId: ctx.tabId })
        .then(setNow)
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status, ctx.tabId]);

  // 当前播放句：最后一个 start <= now 的分句下标（字幕按时间有序）
  const activeCueIdx = useMemo(() => {
    if (now === null) return -1;
    let idx = -1;
    for (let i = 0; i < cues.length; i++) {
      if ((cues[i]?.start ?? Number.POSITIVE_INFINITY) <= now) idx = i;
      else break;
    }
    return idx;
  }, [now, cues]);

  // 当前播放章：最后一个 startSec <= now 的章节
  const activeChapterId = useMemo(() => {
    if (now === null || !chapters || chapters.length === 0) return null;
    let id: string | null = null;
    for (const ch of [...chapters].sort((a, b) => a.startSec - b.startSec)) {
      if (ch.startSec <= now) id = ch.id;
      else break;
    }
    return id;
  }, [now, chapters]);

  const locateCurrent = useCallback(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  /** 手动生成规则章节（实验性，供导出 TOC） */
  const generateChapters = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    try {
      let danmaku: DensityPoint[] = [];
      try {
        danmaku = await send<DensityPoint[]>({ type: 'danmaku:get', tabId: ctx.tabId });
      } catch {
        // 弹幕是增强数据，失败按无弹幕切分
      }
      const drafts = segmentChapters(cues, { danmaku }, locale);
      const next: Chapter[] = drafts.map((d) => ({
        id: newId(),
        courseId: ctx.course.id,
        title: d.title,
        startSec: d.startSec,
        summary: '',
        source: 'rule' as const,
      }));
      await send({ type: 'chapters:replace', courseId: ctx.course.id, chapters: next });
      setChapters(next);
      pushToast(t('subtitles.chaptersGenerated', { count: next.length }), 'success');
    } catch (e) {
      pushToast(e instanceof Error ? localizeError(t, e) : t('subtitles.generateFailed'), 'error');
    } finally {
      setGenerating(false);
    }
  }, [ctx.course.id, ctx.tabId, cues, generating, pushToast, t]);

  /** AI 生成章节 + 内容总结（后台调用 LLM，结果落库并返回） */
  const generateAiChapters = useCallback(async () => {
    if (aiGenerating) return;
    // Firefox 要求 permissions.request 处在用户输入处理栈内，故必须在任何 await 之前发起
    const consented = await requestAiConsent();
    setAiGenerating(true);
    try {
      const setting = await send<Setting>({ type: 'setting:get' });
      if (!setting.llm.model.trim() || !setting.llm.apiToken.trim()) {
        pushToast(t('subtitles.configLlmFirst'), 'error', {
          label: t('subtitles.openSettings'),
          onClick: () => void browser.runtime.openOptionsPage(),
        });
        return;
      }
      if (!consented) {
        pushToast(t('bg.err.aiConsentRequired'), 'error');
        return;
      }
      const result = await send<AiGenerateResult>({
        type: 'ai:generateChapters',
        courseId: ctx.course.id,
        cues,
      });
      setChapters(result.chapters);
      if (result.overview) setOverview(result.overview);
      pushToast(t('subtitles.aiChaptersGenerated', { count: result.chapters.length }), 'success');
    } catch (e) {
      pushToast(e instanceof Error ? localizeError(t, e) : t('subtitles.aiGenerateFailed'), 'error');
    } finally {
      setAiGenerating(false);
    }
  }, [aiGenerating, ctx.course.id, cues, pushToast, t]);

  if (status === 'loading') {
    return <p className="mt-8 text-center text-xs text-gray-400">{t('subtitles.loading')}</p>;
  }

  if (status === 'no-subtitles') {
    return (
      <div className="mt-8 flex flex-col items-center gap-2 p-6 text-center">
        <p className="text-sm text-gray-500">{t('subtitles.noSubtitles')}</p>
        <p className="text-xs text-gray-400">{t('subtitles.noSubtitlesHint')}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-1 rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
        >
          {t('common.retry')}
        </button>
        <AsrCard
          key={ctx.course.id}
          ctx={ctx}
          pushToast={pushToast}
          onFinished={handleAsrFinished}
          onBusyChange={onAsrBusy}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('subtitles.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
        />
        {showFlatList && hits === null ? (
          <button
            type="button"
            onClick={locateCurrent}
            disabled={activeCueIdx < 0}
            className="shrink-0 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40"
          >
            {t('subtitles.locateCurrent')}
          </button>
        ) : null}
      </div>

      {/* 字幕来自本地转写时的来源提示 + 重新转写入口 */}
      {fromTranscript ? (
        <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
          <span>{t('subtitles.fromTranscriptHint')}</span>
          <button
            type="button"
            onClick={() => setStatus('no-subtitles')}
            className="rounded px-1.5 py-0.5 hover:bg-emerald-100"
          >
            {t('subtitles.retranscribe')}
          </button>
        </div>
      ) : null}

      {/* 章节大纲：有章节（AI/规则）直接展示 */}
      <div className="rounded-md border border-gray-200 bg-white p-2">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
          <span>
            {chapters?.length
              ? t('subtitles.chapterCount', { count: chapters.length })
              : t('subtitles.chapterOutline')}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={generating || aiGenerating || cues.length === 0}
              onClick={() => void generateChapters()}
              className="rounded px-1.5 py-0.5 hover:bg-gray-100 disabled:opacity-40"
            >
              {generating ? t('subtitles.generating') : t('subtitles.ruleGenerate')}
            </button>
            <button
              type="button"
              disabled={generating || aiGenerating || cues.length === 0}
              onClick={() => void generateAiChapters()}
              className="rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50 disabled:opacity-40"
            >
              {aiGenerating
                ? t('subtitles.aiGenerating')
                : chapters && chapters.length > 0
                  ? t('subtitles.regenerate')
                  : t('subtitles.aiGenerate')}
            </button>
          </span>
        </div>
        {overview ? (
          <details className="mb-1 rounded-md bg-gray-50 px-2 py-1.5">
            <summary className="cursor-pointer text-xs font-medium text-gray-500">
              {t('subtitles.courseOverview')}
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-gray-600">
              {overview}
            </p>
          </details>
        ) : null}
        {chapters === null ? (
          <p className="py-2 text-center text-xs text-gray-400">{t('subtitles.chaptersLoading')}</p>
        ) : chapters.length === 0 ? (
          <p className="py-2 text-center text-xs text-gray-400">{t('subtitles.noChaptersHint')}</p>
        ) : (
          <div className="space-y-1">
            {chapters.map((ch, i) => {
              const active = ch.id === activeChapterId;
              return (
              <div key={ch.id} className={`rounded-md ${active ? 'bg-blue-100' : 'hover:bg-blue-50'}`}>
                <div className="flex items-start gap-2 px-2 py-1">
                  <span className="shrink-0 pt-0.5 font-mono text-xs text-gray-400">{i + 1}.</span>
                  <button
                    type="button"
                    onClick={() => onSeek(ch.startSec)}
                    title={t('subtitles.jumpToChapterStart')}
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs font-medium ${
                      active ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-600'
                    }`}
                  >
                    {formatTimestamp(ch.startSec)}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSeek(ch.startSec)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span
                      className={`block truncate text-xs ${active ? 'font-medium text-blue-900' : 'text-gray-800'}`}
                      title={ch.title}
                    >
                      {ch.title}
                    </span>
                    {ch.summary ? (
                      <span
                        className="mt-0.5 line-clamp-2 block text-xs text-gray-400"
                        title={ch.summary}
                      >
                        {ch.summary}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpenChapters((s) => ({ ...s, [ch.id]: !s[ch.id] }))}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100"
                  >
                    {openChapters[ch.id] ? t('subtitles.collapse') : t('subtitles.expandCues')}
                  </button>
                </div>
                {openChapters[ch.id] ? (
                  <div className="space-y-0.5 px-2 pb-1">
                    {(chapterCues?.get(ch.id) ?? []).length === 0 ? (
                      <p className="py-1 text-xs text-gray-400">{t('subtitles.noCuesInChapter')}</p>
                    ) : (
                      (chapterCues?.get(ch.id) ?? []).map((cue) =>
                        renderCueRow(cue, cues.indexOf(cue), false),
                      )
                    )}
                  </div>
                ) : null}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 字幕检索结果 */}
      {hits !== null ? (
        hits.length === 0 ? (
          <p className="mt-4 text-center text-xs text-gray-400">{t('subtitles.noMatch')}</p>
        ) : (
          <div className="space-y-0.5">
            {hits.map((hit, i) => (
              <button
                key={`hit-${hit.sec}-${i}`}
                type="button"
                onClick={() => onSeek(hit.sec)}
                className="flex w-full items-start gap-2 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-left hover:bg-blue-50"
              >
                <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs font-medium text-blue-600">
                  {formatTimestamp(hit.sec)}
                </span>
                <span className="min-w-0 break-words text-xs text-gray-700">{hit.text}</span>
              </button>
            ))}
          </div>
        )
      ) : showFlatList ? (
        /* 无章节时的字幕全文（跟随播放高亮）；本地转写来源可行内编辑 */
        <div ref={listRef} className="space-y-0.5">
          {cues.map((cue, i) => renderCueRow(cue, i, i === activeCueIdx))}
        </div>
      ) : null}
    </div>
  );
}
