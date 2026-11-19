export type ToastLevel = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  text: string;
  level: ToastLevel;
  /** 例如「撤销」按钮 */
  action?: { label: string; onClick: () => void };
}

const LEVEL_CLASS: Record<ToastLevel, string> = {
  info: 'bg-gray-800 text-gray-100',
  success: 'bg-emerald-600 text-white',
  error: 'bg-rose-600 text-white',
};

export function Toaster({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-3 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-3">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-lg px-3 py-2 text-sm shadow-lg ${LEVEL_CLASS[t.level]}`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 break-words">{t.text}</span>
            {t.action ? (
              <button
                type="button"
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={t.action.onClick}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
