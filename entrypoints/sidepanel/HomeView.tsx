import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { CourseSummary, PushMessage } from '~/core/messages';
import { localizeError, type MessageKey } from '~/core/i18n';
import type { Platform } from '~/core/models';
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

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function CourseCard({
  summary,
  coverUrl,
  onVisible,
  onOpen,
  onDelete,
}: {
  summary: CourseSummary;
  coverUrl?: string;
  onVisible: (imageId: string) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { course, noteCount, screenshotCount, chapterCount, transcript, coverImageId } = summary;
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  const metaParts = [
    chapterCount > 0 ? t('home.metaChapters', { count: chapterCount }) : '',
    transcript ? t('home.metaTranscript', { count: transcript.cueCount }) : '',
    noteCount > 0 ? t('home.metaNotes', { count: noteCount }) : '',
    screenshotCount > 0 ? t('home.metaScreenshots', { count: screenshotCount }) : '',
  ].filter(Boolean);

  // 封面进入视口才拉取 dataURL
  useEffect(() => {
    if (coverImageId && !coverUrl) onVisible(coverImageId);
  }, [coverImageId, coverUrl, onVisible]);

  // 删除是不可恢复的级联删除，需二次点击确认；超时自动复位
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm hover:border-blue-300 hover:bg-blue-50/40"
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={t('home.coverAlt')}
            className="h-16 w-24 shrink-0 rounded-md border border-gray-200 object-cover"
          />
        ) : (
          <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-md bg-gray-100 text-xs text-gray-400">
            {coverImageId ? t('common.loading') : t(PLATFORM_KEY[course.platform])}
          </div>
        )}
        <div className="min-w-0 flex-1 pr-6">
          <p className="truncate text-sm font-medium text-gray-800" title={course.title}>
            {course.title}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {course.summary ? (
              <span className="mr-1 rounded bg-blue-50 px-1 py-0.5 text-blue-600">
                {t('home.aiSummaryBadge')}
              </span>
            ) : null}
            {metaParts.join(' · ')}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {t('home.lastUpdated', { date: new Date(course.updatedAt).toLocaleDateString() })}
          </p>
        </div>
      </button>
      <button
        type="button"
        title={confirming ? t('home.deleteConfirmTitle') : t('home.deleteCourseTitle')}
        onClick={() => {
          if (confirming) {
            setConfirming(false);
            onDelete();
          } else {
            setConfirming(true);
          }
        }}
        className={
          confirming
            ? 'absolute right-2 top-2 rounded bg-rose-600 px-1.5 py-0.5 text-xs text-white shadow hover:bg-rose-700'
            : 'absolute right-2 top-2 rounded p-1 text-gray-300 hover:bg-rose-50 hover:text-rose-600'
        }
      >
        {confirming ? t('home.deleteConfirm') : <TrashIcon />}
      </button>
    </div>
  );
}

export function HomeView({
  pushToast,
  onOpenCourse,
}: {
  pushToast: (text: string, level?: ToastLevel, action?: ToastItem['action']) => void;
  onOpenCourse: (summary: CourseSummary) => void;
}) {
  const [summaries, setSummaries] = useState<CourseSummary[] | null>(null);
  const { images, ensureImage } = useImageCache();
  const { t } = useT();

  const load = useCallback(async () => {
    try {
      setSummaries(await send<CourseSummary[]>({ type: 'courses:list' }));
    } catch (e) {
      pushToast(e instanceof Error ? localizeError(t, e) : t('home.listLoadFailed'), 'error');
    }
  }, [pushToast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteCourse = useCallback(
    (s: CourseSummary) => {
      send({ type: 'course:delete', courseId: s.course.id })
        .then(() => {
          pushToast(t('home.courseDeleted', { title: s.course.title }), 'success');
          void load();
        })
        .catch((e: unknown) => {
          pushToast(e instanceof Error ? localizeError(t, e) : t('home.deleteFailed'), 'error');
        });
    },
    [pushToast, load, t],
  );

  // 任何课程的笔记变更都刷新计数与封面
  useEffect(() => {
    const listener = (raw: unknown) => {
      if ((raw as PushMessage).type === 'notes:changed') void load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [load]);

  if (summaries === null) {
    return <div className="p-4 text-sm text-gray-500">{t('common.loading')}</div>;
  }

  if (summaries.length === 0) {
    return <p className="mt-8 text-center text-xs text-gray-400">{t('home.empty')}</p>;
  }

  return (
    <div className="space-y-2">
      {summaries.map((s) => (
        <CourseCard
          key={s.course.id}
          summary={s}
          coverUrl={s.coverImageId ? images[s.coverImageId]?.dataUrl : undefined}
          onVisible={(imageId) => void ensureImage(imageId)}
          onOpen={() => onOpenCourse(s)}
          onDelete={() => deleteCourse(s)}
        />
      ))}
    </div>
  );
}
