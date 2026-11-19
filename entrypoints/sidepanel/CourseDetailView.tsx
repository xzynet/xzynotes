import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { ASR_MODELS, type AsrModelId } from '~/core/asr';
import { formatTimestamp } from '~/core/export';
import type { CourseContext, CourseSummary, PushMessage } from '~/core/messages';
import { localizeError, type MessageKey } from '~/core/i18n';
import type { Chapter, Note, Platform, Transcript } from '~/core/models';
import { tabMatchesCourse } from '~/core/utils/url';
import { NoteCard } from '~/components/NoteCard';
import { EditableTitle } from '~/components/EditableTitle';
import { useT } from '~/components/i18n';
import type { ToastItem, ToastLevel } from '~/components/Toaster';
import { send } from './rpc';
import { useImageCache } from './useImageCache';

const PLATFORM_KEY: Record<Platform, MessageKey> = {
  bilibili: 'platform.bilibili',
  icourse163: 'platform.icourse163',
  xuetangx: 'platform.xuetangx',
  zhihuishu: 'platform.zhihuishu',
  youtube: 'platform.youtube',
  generic: 'platform.generic',
};

export function CourseDetailView({
  summary,
  ctx,
  pushToast,
  onBack,
}: {
  summary: CourseSummary;
  /** 当前窗口正在播放的课程上下文；同课时点击章节/笔记直接页内跳转 */
  ctx: CourseContext | null;
  pushToast: (text: string, level?: ToastLevel, action?: ToastItem['action']) => void;
  onBack: () => void;
}) {
  const { course } = summary;
  const { t } = useT();
  const [title, setTitle] = useState(course.title);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const { images, ensureImage } = useImageCache();

  const rename = useCallback(
    async (next: string) => {
      try {
        await send({ type: 'course:rename', courseId: course.id, title: next });
        setTitle(next);
        pushToast(t('course.titleRenamed'), 'success');
      } catch (e) {
        pushToast(e instanceof Error ? localizeError(t, e) : t('course.renameFailed'), 'error');
        throw e;
      }
    },
    [course.id, pushToast, t],
  );

  const load = useCallback(async () => {
    try {
      const [noteList, tr] = await Promise.all([
        send<Note[]>({ type: 'notes:list', courseId: course.id }),
        send<Transcript | null>({ type: 'transcript:get', courseId: course.id }),
      ]);
      setNotes(noteList);
      setTranscript(tr && tr.cues.length > 0 ? tr : null);
    } catch (e) {
      pushToast(e instanceof Error ? localizeError(t, e) : t('course.notesLoadFailed'), 'error');
    }
  }, [course.id, pushToast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    send<Chapter[]>({ type: 'chapters:list', courseId: course.id })
      .then(setChapters)
      .catch(() => setChapters([]));
  }, [course.id]);

  useEffect(() => {
    const listener = (raw: unknown) => {
      const msg = raw as PushMessage;
      if (msg.type === 'notes:changed' && msg.courseId === course.id) void load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [course.id, load]);

  // 当前窗口正播放本课程时直接页内 seek（id 相等或 URL 兜底匹配）；否则让后台在
  // 已打开的标签页里找这门课跳转，都找不到（课程未打开）才退化为新标签页打开课程页。
  // 页内 seek 失败（播放器未就绪/页面无视频元素）也回退到这条路径，而不是只弹错误
  const seekOrOpen = useCallback(
    (sec: number) => {
      const openElsewhere = async (excludeTabId?: number) => {
        const win = await browser.windows.getCurrent().catch(() => undefined);
        const r = await send<{ handled: boolean }>({
          type: 'video:seekCourse',
          courseId: course.id,
          sec,
          windowId: win?.id,
          excludeTabId,
        });
        if (!r.handled) await browser.tabs.create({ url: course.url }).catch(() => {});
      };
      if (ctx && (ctx.course.id === course.id || tabMatchesCourse(ctx.course.url, course))) {
        send({ type: 'video:seek', tabId: ctx.tabId, sec }).catch((e: unknown) => {
          // 排除刚才失败的 tab，避免 seekCourse 又选中它
          void openElsewhere(ctx.tabId).catch(() =>
            pushToast(e instanceof Error ? localizeError(t, e) : t('course.seekFailed'), 'error'),
          );
        });
        return;
      }
      void (async () => {
        try {
          await openElsewhere();
        } catch (e) {
          pushToast(e instanceof Error ? localizeError(t, e) : t('course.seekFailed'), 'error');
        }
      })();
    },
    [ctx, course.id, course.url, pushToast, t],
  );

  const deleteNote = useCallback(
    (note: Note) => {
      const image = note.imageId ? images[note.imageId] : undefined;
      send({ type: 'note:delete', id: note.id })
        .then(() => {
          pushToast(t('course.noteDeleted'), 'info', {
            label: t('course.undo'),
            onClick: () => {
              send({ type: 'note:restore', note, image })
                .then(() => pushToast(t('course.deleteUndone'), 'success'))
                .catch((e) =>
                  pushToast(e instanceof Error ? localizeError(t, e) : t('course.undoFailed'), 'error'),
                );
            },
          });
        })
        .catch((e) =>
          pushToast(e instanceof Error ? localizeError(t, e) : t('course.deleteFailed'), 'error'),
        );
    },
    [images, pushToast, t],
  );

  /** 截图标题保存；reject 交给 NoteCard 回退编辑态 */
  const updateNoteContent = useCallback(
    async (note: Note, content: string) => {
      try {
        await send({ type: 'note:update', id: note.id, content });
        pushToast(content ? t('course.captionSaved') : t('course.captionCleared'), 'success');
      } catch (e) {
        pushToast(e instanceof Error ? localizeError(t, e) : t('course.captionSaveFailed'), 'error');
        throw e;
      }
    },
    [pushToast, t],
  );

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
        >
          {t('course.back')}
        </button>
        <EditableTitle title={title} onSave={rename} />
        <span className="shrink-0 text-xs text-gray-400">{t(PLATFORM_KEY[course.platform])}</span>
      </div>

      {notes === null || chapters === null ? (
        <div className="p-4 text-sm text-gray-500">{t('common.loading')}</div>
      ) : (
        <>
          {course.summary ? (
            <details className="mb-3 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm">
              <summary className="cursor-pointer text-xs font-medium text-gray-500">
                {t('course.overviewAi')}
              </summary>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-gray-600">
                {course.summary}
              </p>
            </details>
          ) : null}

          {chapters.length > 0 ? (
            <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
              <p className="mb-2 text-xs font-medium text-gray-500">
                {t('course.chaptersTitle', { count: chapters.length })}
              </p>
              <div className="space-y-1">
                {chapters.map((ch, i) => (
                  <button
                    key={ch.id}
                    type="button"
                    title={t('course.seekChapter')}
                    onClick={() => seekOrOpen(ch.startSec)}
                    className="flex w-full items-start gap-2 rounded-md px-1 py-0.5 text-left hover:bg-blue-50"
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-xs text-gray-400">{i + 1}.</span>
                    <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs font-medium text-blue-600">
                      {formatTimestamp(ch.startSec)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-gray-800" title={ch.title}>
                        {ch.title}
                      </p>
                      {ch.summary ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-gray-400" title={ch.summary}>
                          {ch.summary}
                        </p>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {transcript ? (
            <details className="mb-3 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm">
              <summary className="cursor-pointer text-xs font-medium text-gray-500">
                {t('course.transcriptTitle', {
                  count: transcript.cues.length,
                  duration: formatTimestamp(transcript.durationSec),
                })}
              </summary>
              <p className="mt-1 text-xs text-gray-400">
                {t('course.transcriptMeta', {
                  model: ASR_MODELS[transcript.modelId as AsrModelId]?.label ?? transcript.modelId,
                  time: new Date(transcript.updatedAt).toLocaleString(),
                })}
              </p>
              <div className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
                {transcript.cues.map((cue, i) => (
                  <button
                    key={`${cue.start}-${i}`}
                    type="button"
                    onClick={() => seekOrOpen(cue.start)}
                    className="flex w-full items-start gap-2 rounded-md px-1 py-0.5 text-left hover:bg-blue-50"
                  >
                    <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs font-medium text-blue-600">
                      {formatTimestamp(cue.start)}
                    </span>
                    <span className="min-w-0 break-words text-xs text-gray-700">{cue.text}</span>
                  </button>
                ))}
              </div>
            </details>
          ) : null}

          {notes.length > 0 ? (
            <div className="space-y-2">
              {notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  imageUrl={note.imageId ? images[note.imageId]?.dataUrl : undefined}
                  highlight={false}
                  loopPhase="idle"
                  inLoopRange={false}
                  onSeek={seekOrOpen}
                  onDelete={deleteNote}
                  onUpdateContent={updateNoteContent}
                  onImageVisible={(imageId) => void ensureImage(imageId)}
                />
              ))}
            </div>
          ) : chapters.length === 0 && !course.summary && !transcript ? (
            <p className="mt-8 text-center text-xs text-gray-400">{t('course.empty')}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
