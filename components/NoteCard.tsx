import { useEffect, useRef, useState } from 'react';
import { formatTimestamp } from '~/core/export';
import type { MessageKey } from '~/core/i18n';
import type { Note } from '~/core/models';
import { PencilIcon } from './EditableTitle';
import { useT } from './i18n';

export type LoopPhase = 'idle' | 'pickingB' | 'active';

interface NoteCardProps {
  note: Note;
  /** 截图 dataURL；未加载时显示占位并触发懒加载 */
  imageUrl?: string;
  highlight: boolean;
  loopPhase: LoopPhase;
  /** 该笔记是否处于当前循环区间内 */
  inLoopRange: boolean;
  onSeek: (sec: number) => void;
  onDelete: (note: Note) => void;
  /** 截图标题保存（不提供时截图标题不可编辑） */
  onUpdateContent?: (note: Note, content: string) => Promise<void>;
  /** 不提供时隐藏 A-B 循环按钮（如历史课程浏览视图） */
  onLoopClick?: (note: Note) => void;
  onCancelLoop?: () => void;
  onImageVisible: (imageId: string) => void;
}

const TYPE_LABEL: Record<Note['type'], MessageKey> = {
  screenshot: 'note.typeScreenshot',
  text: 'note.typeText',
  bookmark: 'note.typeBookmark',
};

function ImageThumb({
  imageId,
  url,
  onVisible,
  onSeek,
}: {
  imageId: string;
  url?: string;
  onVisible: (imageId: string) => void;
  /** 点击截图跳转到对应时间点 */
  onSeek: () => void;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (url || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisible(imageId);
          io.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [imageId, url, onVisible]);

  if (url) {
    return (
      <button
        type="button"
        title={t('note.seekTo')}
        onClick={onSeek}
        className="mt-2 block w-full cursor-pointer overflow-hidden rounded-md border border-gray-200 hover:border-blue-300"
      >
        <img src={url} alt={t('note.screenshotAlt')} className="w-full" />
      </button>
    );
  }
  return (
    <div
      ref={ref}
      className="mt-2 flex h-20 items-center justify-center rounded-md bg-gray-100 text-xs text-gray-400"
    >
      {t('note.loadingImage')}
    </div>
  );
}

/**
 * 截图标题的行内编辑：有标题时铅笔进入编辑，无标题时显示「添加标题」入口；
 * Enter/失焦提交（空串 = 清除标题），Esc 取消；onSave reject 时回退原标题。
 */
function ScreenshotTitle({
  note,
  onSave,
}: {
  note: Note;
  onSave: (note: Note, content: string) => Promise<void>;
}) {
  const { t } = useT();
  const content = note.content.trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const cancel = () => {
    setDraft(note.content);
    setEditing(false);
  };

  const commit = () => {
    if (saving) return;
    const next = draft.trim();
    if (next === content) {
      cancel();
      return;
    }
    setSaving(true);
    void onSave(note, next)
      .then(() => setEditing(false))
      .catch(cancel)
      .finally(() => setSaving(false));
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // 中文输入法组词中的 Enter/Esc 是选词键，不触发提交/取消
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cancel();
        }}
        onBlur={commit}
        placeholder={t('note.screenshotTitle')}
        aria-label={t('note.screenshotTitle')}
        className="mt-2 w-full rounded border border-blue-400 px-1.5 py-1 text-sm outline-none"
      />
    );
  }

  if (!content) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(note.content);
          setEditing(true);
        }}
        className="mt-2 text-xs text-gray-400 hover:text-blue-600"
      >
        {t('note.addTitle')}
      </button>
    );
  }

  return (
    <div className="mt-2 flex items-start gap-1">
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-gray-800">
        {note.content}
      </p>
      <button
        type="button"
        title={t('note.editTitle')}
        aria-label={t('note.editTitle')}
        onClick={() => {
          setDraft(note.content);
          setEditing(true);
        }}
        className="shrink-0 rounded p-0.5 text-gray-300 hover:bg-gray-100 hover:text-gray-600"
      >
        <PencilIcon />
      </button>
    </div>
  );
}

export function NoteCard(props: NoteCardProps) {
  const { t } = useT();
  const { note } = props;

  const loopLabel = (() => {
    if (props.loopPhase === 'idle') return 'A-B';
    if (props.loopPhase === 'pickingB') return t('note.loopSetB');
    return props.inLoopRange ? t('note.loopCancel') : t('note.loopActive');
  })();

  return (
    <div
      id={`note-${note.id}`}
      className={`rounded-lg border bg-white p-3 shadow-sm transition-colors ${
        props.highlight ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          title={t('note.seekTo')}
          className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs font-medium text-blue-600 hover:bg-blue-100"
          onClick={() => props.onSeek(note.timestampSec)}
        >
          {formatTimestamp(note.timestampSec)}
        </button>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
          {t(TYPE_LABEL[note.type])}
        </span>
        <div className="flex-1" />
        {props.onLoopClick && props.onCancelLoop ? (
          <button
            type="button"
            title={t('note.loopTitle')}
            className={`rounded px-1.5 py-0.5 text-xs ${
              props.inLoopRange && props.loopPhase === 'active'
                ? 'bg-amber-100 text-amber-700'
                : 'text-gray-500 hover:bg-gray-100'
            }`}
            onClick={() => {
              if (props.loopPhase === 'active') props.onCancelLoop?.();
              else props.onLoopClick?.(note);
            }}
          >
            {loopLabel}
          </button>
        ) : null}
        <button
          type="button"
          title={t('note.deleteTitle')}
          className="rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-rose-50 hover:text-rose-600"
          onClick={() => props.onDelete(note)}
        >
          {t('common.delete')}
        </button>
      </div>

      {note.type === 'screenshot' && props.onUpdateContent ? (
        <ScreenshotTitle note={note} onSave={props.onUpdateContent} />
      ) : note.content.trim() ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-800">{note.content}</p>
      ) : null}

      {note.type === 'screenshot' && note.imageId ? (
        <ImageThumb
          imageId={note.imageId}
          url={props.imageUrl}
          onVisible={props.onImageVisible}
          onSeek={() => props.onSeek(note.timestampSec)}
        />
      ) : null}
    </div>
  );
}
