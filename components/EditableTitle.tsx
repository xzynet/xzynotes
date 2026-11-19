import { useEffect, useRef, useState } from 'react';
import { useT } from './i18n';

export function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

/**
 * 行内编辑的课程标题：铅笔进入编辑，Enter/失焦提交，Esc 取消。
 * onSave 负责落库与结果提示；reject 时回退为原标题显示。
 */
export function EditableTitle({
  title,
  onSave,
}: {
  title: string;
  onSave: (next: string) => Promise<void>;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const cancel = () => {
    setDraft(title);
    setEditing(false);
  };

  const commit = () => {
    if (saving) return;
    const next = draft.trim();
    if (!next || next === title) {
      cancel();
      return;
    }
    setSaving(true);
    void onSave(next)
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
        aria-label={t('title.courseTitle')}
        className="w-full min-w-0 flex-1 rounded border border-blue-400 bg-white px-1 py-0.5 text-sm font-bold text-gray-800 outline-none"
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <h2 className="min-w-0 truncate text-sm font-bold" title={title}>
        {title}
      </h2>
      <button
        type="button"
        title={t('title.editTitle')}
        aria-label={t('title.editTitle')}
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        className="shrink-0 rounded p-0.5 text-gray-300 hover:bg-gray-100 hover:text-gray-600"
      >
        <PencilIcon />
      </button>
    </div>
  );
}
