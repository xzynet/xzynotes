import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from '~/core/i18n';
import { localizeError } from '~/core/i18n';
import type { ImagePayload } from '~/core/messages';
import { useT } from '~/components/i18n';
import { send } from '~/entrypoints/sidepanel/rpc';

type Tool = 'rect' | 'arrow' | 'pen' | 'text' | 'mosaic';

type Op =
  | { kind: 'rect'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'pen'; points: Array<{ x: number; y: number }>; color: string }
  | { kind: 'text'; x: number; y: number; text: string; color: string }
  | { kind: 'mosaic'; x1: number; y1: number; x2: number; y2: number };

const TOOLS: Array<{ key: Tool; labelKey: MessageKey }> = [
  { key: 'rect', labelKey: 'annotator.toolRect' },
  { key: 'arrow', labelKey: 'annotator.toolArrow' },
  { key: 'pen', labelKey: 'annotator.toolPen' },
  { key: 'text', labelKey: 'annotator.toolText' },
  { key: 'mosaic', labelKey: 'annotator.toolMosaic' },
];

const COLORS = ['#ef4444', '#f59e0b', '#2563eb', '#10b981', '#ffffff'];

/** 箭头头部 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(10, ctx.canvas.width / 60);
  for (const delta of [Math.PI / 7, -Math.PI / 7]) {
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - len * Math.cos(angle + delta), y2 - len * Math.sin(angle + delta));
    ctx.stroke();
  }
}

function drawOp(ctx: CanvasRenderingContext2D, base: HTMLCanvasElement, op: Op): void {
  const lineWidth = Math.max(2, Math.round(ctx.canvas.width / 400));
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (op.kind) {
    case 'rect': {
      ctx.strokeStyle = op.color;
      ctx.strokeRect(op.x1, op.y1, op.x2 - op.x1, op.y2 - op.y1);
      break;
    }
    case 'arrow': {
      ctx.strokeStyle = op.color;
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      drawArrowHead(ctx, op.x1, op.y1, op.x2, op.y2);
      break;
    }
    case 'pen': {
      if (op.points.length < 2) break;
      ctx.strokeStyle = op.color;
      ctx.beginPath();
      const first = op.points[0];
      if (!first) break;
      ctx.moveTo(first.x, first.y);
      for (const p of op.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      break;
    }
    case 'text': {
      const fontSize = Math.max(14, Math.round(ctx.canvas.width / 40));
      ctx.font = `bold ${fontSize}px sans-serif`;
      // 黑边白字式可读性处理：先描边再填充
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = Math.max(2, fontSize / 8);
      ctx.strokeText(op.text, op.x, op.y);
      ctx.fillStyle = op.color;
      ctx.fillText(op.text, op.x, op.y);
      break;
    }
    case 'mosaic': {
      const sx = Math.min(op.x1, op.x2);
      const sy = Math.min(op.y1, op.y2);
      const w = Math.abs(op.x2 - op.x1);
      const h = Math.abs(op.y2 - op.y1);
      if (w < 2 || h < 2) break;
      const factor = Math.max(2, Math.round(ctx.canvas.width / 100));
      const sw = Math.max(1, Math.floor(w / factor));
      const sh = Math.max(1, Math.floor(h / factor));
      const tmp = document.createElement('canvas');
      tmp.width = sw;
      tmp.height = sh;
      const tctx = tmp.getContext('2d');
      if (!tctx) break;
      tctx.drawImage(base, sx, sy, w, h, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, sw, sh, sx, sy, w, h);
      ctx.imageSmoothingEnabled = true;
      break;
    }
  }
}

/**
 * 圈画标注器：矩形/箭头/画笔/文字/马赛克 五种工具，canvas 实现。
 * 以原图分辨率绘制，CSS 缩放展示；保存时 toBlob 覆盖原图。
 */
export function Annotator({
  imageId,
  onSave,
  onCancel,
}: {
  imageId: string;
  onSave: (dataUrl: string, width: number, height: number) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ops, setOps] = useState<Op[]>([]);
  const [draft, setDraft] = useState<Op | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState(COLORS[0] ?? '#ef4444');
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // 加载截图
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await send<ImagePayload>({ type: 'image:get', id: imageId });
        const img = new Image();
        img.onload = () => {
          if (!cancelled) setImage(img);
        };
        img.onerror = () => {
          if (!cancelled) setLoadError('annotator.loadFailed');
        };
        img.src = payload.dataUrl;
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'annotator.loadFailed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  // 重绘：原图 → 逐个回放标注操作
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let base = baseCanvasRef.current;
    if (!base) {
      base = document.createElement('canvas');
      baseCanvasRef.current = base;
    }
    base.width = image.naturalWidth;
    base.height = image.naturalHeight;
    const bctx = base.getContext('2d');
    if (!bctx) return;
    bctx.drawImage(image, 0, 0);
    ctx.drawImage(image, 0, 0);
    for (const op of ops) drawOp(ctx, base, op);
    if (draft) drawOp(ctx, base, draft);
  }, [image, ops, draft]);

  const canvasPos = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * scale,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const pos = canvasPos(e);
      if (!pos) return;
      if (tool === 'text') {
        setTextInput({ x: pos.x, y: pos.y, value: '' });
        return;
      }
      if (tool === 'pen') {
        setDraft({ kind: 'pen', points: [pos], color });
      } else {
        setDraft({ kind: tool, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y, ...(tool === 'mosaic' ? {} : { color }) } as Op);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [canvasPos, tool, color],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const pos = canvasPos(e);
      if (!pos) return;
      setDraft((prev) => {
        if (!prev) return prev;
        if (prev.kind === 'pen') return { ...prev, points: [...prev.points, pos] };
        return { ...prev, x2: pos.x, y2: pos.y };
      });
    },
    [canvasPos],
  );

  const onPointerUp = useCallback(() => {
    setDraft((prev) => {
      if (!prev) return prev;
      // 过滤退化操作（点了一下没拖）；text 由输入框提交，不会成为 draft
      let degenerate = false;
      if (prev.kind === 'pen') {
        degenerate = prev.points.length < 2;
      } else if (prev.kind !== 'text') {
        degenerate = Math.abs(prev.x2 - prev.x1) < 3 && Math.abs(prev.y2 - prev.y1) < 3;
      }
      if (!degenerate) setOps((ops) => [...ops, prev]);
      return null;
    });
  }, []);

  const commitText = useCallback(() => {
    setTextInput((prev) => {
      if (prev && prev.value.trim()) {
        setOps((ops) => [...ops, { kind: 'text', x: prev.x, y: prev.y, text: prev.value.trim(), color }]);
      }
      return null;
    });
  }, [color]);

  const doSave = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => onSave(reader.result as string, canvas.width, canvas.height);
        reader.readAsDataURL(blob);
      },
      'image/jpeg',
      0.9,
    );
  }, [onSave]);

  // Esc 取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const textInputPos = (() => {
    if (!textInput || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.width;
    return { left: textInput.x * scale, top: textInput.y * scale };
  })();

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 p-2 dark:border-neutral-700">
        {TOOLS.map((toolOption) => (
          <button
            key={toolOption.key}
            type="button"
            onClick={() => setTool(toolOption.key)}
            className={`rounded px-2 py-1 text-xs ${
              tool === toolOption.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-neutral-700 dark:text-gray-300'
            }`}
          >
            {t(toolOption.labelKey)}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-neutral-600" />
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={t('annotator.color', { color: c })}
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border ${color === c ? 'ring-2 ring-blue-500' : 'border-gray-300'}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-neutral-600" />
        <button
          type="button"
          disabled={ops.length === 0}
          onClick={() => setOps((ops) => ops.slice(0, -1))}
          className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:bg-neutral-700 dark:text-gray-300"
        >
          {t('annotator.undo')}
        </button>
        <button
          type="button"
          disabled={ops.length === 0}
          onClick={() => setOps([])}
          className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:bg-neutral-700 dark:text-gray-300"
        >
          {t('annotator.clear')}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={doSave}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
        >
          {t('common.save')}
        </button>
      </div>

      <div className="relative flex-1 overflow-auto bg-gray-100 p-2 dark:bg-neutral-950">
        {loadError ? (
          <p className="mt-8 text-center text-sm text-rose-600">{localizeError(t, loadError)}</p>
        ) : !image ? (
          <p className="mt-8 text-center text-sm text-gray-400">{t('annotator.loading')}</p>
        ) : (
          <div className="relative inline-block">
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="block max-w-full cursor-crosshair touch-none"
            />
            {textInput && textInputPos ? (
              <input
                autoFocus
                value={textInput.value}
                onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitText();
                  if (e.key === 'Escape') setTextInput(null);
                }}
                onBlur={commitText}
                placeholder={t('annotator.textPlaceholder')}
                className="absolute z-10 rounded border border-blue-400 bg-white px-1 text-sm text-gray-900"
                style={{ left: textInputPos.left, top: textInputPos.top }}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
