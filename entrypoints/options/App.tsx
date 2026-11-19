import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { ASR_MODELS, PUNCT_MODEL, PUNCT_MODEL_LABEL } from '~/core/asr';
import {
  createTranslator,
  detectLocale,
  localizeError,
  resolveLocale,
  type AppLanguage,
  type Locale,
  type MessageKey,
} from '~/core/i18n';
import { bytesToDataUrl, dataUrlToBytes } from '~/core/utils/dataurl';
import type { Command, LlmConfig, Setting, Theme } from '~/core/models';
import type { BackupData, TableCounts } from '~/core/storage/backup';
import { applyTheme } from '~/components/theme';
import { requestAiConsent } from '~/components/dataConsent';
import { I18nProvider } from '~/components/i18n';
import { cachedModelSizes, deleteModelFiles } from '../sidepanel/asr/model-store';
import { SUPPORTED_ASR_MODELS } from '../sidepanel/asr/capabilities';
import { send } from '../sidepanel/rpc';

const COMMAND_LABELS: Record<Command, MessageKey> = {
  capture: 'options.cmdCapture',
  captureAnnotate: 'options.cmdCaptureAnnotate',
  newNote: 'options.cmdNewNote',
  togglePanel: 'options.cmdTogglePanel',
  bookmark: 'options.cmdBookmark',
};

const THEME_OPTIONS: Array<{ value: Theme; label: MessageKey }> = [
  { value: 'auto', label: 'options.themeAuto' },
  { value: 'light', label: 'options.themeLight' },
  { value: 'dark', label: 'options.themeDark' },
];

const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; label: MessageKey }> = [
  { value: 'auto', label: 'options.langAuto' },
  { value: 'zh-CN', label: 'options.langZhCN' },
  { value: 'en', label: 'options.langEn' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <h2 className="mb-3 text-sm font-bold text-gray-800 dark:text-gray-100">{title}</h2>
      {children}
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function App() {
  const [setting, setSetting] = useState<Setting | null>(null);
  const [locale, setLocale] = useState<Locale | null>(null);
  const [commands, setCommands] = useState<Browser.commands.Command[]>([]);
  const [counts, setCounts] = useState<TableCounts | null>(null);
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [llmDraft, setLlmDraft] = useState<LlmConfig | null>(null);
  const [llmStatus, setLlmStatus] = useState<string | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  /** ASR 模型缓存占用（modelId → 字节） */
  const [asrCache, setAsrCache] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 设置载入前按系统语言兜底，载入后由 setting.language 决定 */
  const effectiveLocale = locale ?? detectLocale(browser.i18n.getUILanguage());
  const t = useMemo(() => createTranslator(effectiveLocale), [effectiveLocale]);

  const refreshAsrCache = useCallback(async () => {
    const rows = await cachedModelSizes().catch(() => []);
    setAsrCache(Object.fromEntries(rows.map((r) => [r.modelId, r.bytes])));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const s = await send<Setting>({ type: 'setting:get' });
        setSetting(s);
        setLocale(resolveLocale(s.language, browser.i18n.getUILanguage()));
        setLlmDraft(s.llm);
        applyTheme(s.theme);
        setCounts(await send<TableCounts>({ type: 'stats:counts' }));
        setCommands(await browser.commands.getAll());
        const est = await navigator.storage.estimate();
        setEstimate({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
        void refreshAsrCache();
      } catch (e) {
        setStatus(e instanceof Error ? localizeError(t, e) : t('options.loadFailed'));
      }
    })();
    // 仅初始化一次；t 的兜底语言与此时 locale 一致
  }, []);

  /** 文档标题跟随语言切换 */
  useEffect(() => {
    document.title = `${t('brand.name')} · ${t('options.pageTitle')}`;
  }, [t]);

  /** 局部修改并立即保存 */
  const update = useCallback(
    (patch: Partial<Setting>) => {
      setSetting((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        applyTheme(next.theme);
        send({ type: 'setting:save', setting: next })
          .then(() => setStatus(t('options.saved')))
          .catch((e) =>
            setStatus(e instanceof Error ? localizeError(t, e) : t('options.saveFailed')),
          );
        return next;
      });
    },
    [t],
  );

  /** 保存 LLM 配置：顺带按 baseUrl 申请域名访问授权（需在点击手势内调用） */
  const saveLlm = useCallback(async () => {
    if (!llmDraft || llmBusy) return;
    setLlmBusy(true);
    try {
      const cfg: LlmConfig = {
        baseUrl: llmDraft.baseUrl.trim().replace(/\/+$/, ''),
        model: llmDraft.model.trim(),
        apiToken: llmDraft.apiToken.trim(),
      };
      if (!cfg.baseUrl || !/^https?:\/\//.test(cfg.baseUrl)) {
        setLlmStatus(t('options.llmInvalidBaseUrl'));
        return;
      }
      if (cfg.model && cfg.apiToken) {
        const origin = new URL(cfg.baseUrl).origin;
        const granted = await browser.permissions
          .request({ origins: [`${origin}/*`] })
          .catch(() => false);
        if (!granted) {
          setLlmStatus(t('options.llmPermissionDenied'));
          return;
        }
      }
      setLlmDraft(cfg);
      update({ llm: cfg });
      setLlmStatus(t('options.saved'));
    } catch (e) {
      setLlmStatus(e instanceof Error ? localizeError(t, e) : t('options.saveFailed'));
    } finally {
      setLlmBusy(false);
    }
  }, [llmDraft, llmBusy, update, t]);

  /** 用已保存的配置发一次最小调用验证连通性 */
  const testLlm = useCallback(async () => {
    if (llmBusy) return;
    // Firefox 要求 permissions.request 处在用户输入处理栈内，故必须在任何 await 之前发起
    const consented = await requestAiConsent();
    setLlmBusy(true);
    setLlmStatus(t('options.llmTesting'));
    try {
      if (!consented) {
        setLlmStatus(t('bg.err.aiConsentRequired'));
        return;
      }
      const r = await send<{ model: string }>({ type: 'ai:testConnection' });
      setLlmStatus(t('options.llmTestSuccess', { model: r.model }));
    } catch (e) {
      setLlmStatus(e instanceof Error ? localizeError(t, e) : t('options.llmTestFailed'));
    } finally {
      setLlmBusy(false);
    }
  }, [llmBusy, t]);

  const doBackupExport = useCallback(async () => {
    setStatus(t('options.backupExporting'));
    try {
      const data = await send<BackupData>({ type: 'backup:export' });
      const files: Record<string, Uint8Array> = {};
      const manifest = {
        ...data,
        images: Object.fromEntries(
          Object.entries(data.images).map(([id, img]) => [
            id,
            { path: `images/${id}.jpg`, width: img.width, height: img.height },
          ]),
        ),
      };
      files['backup.json'] = strToU8(JSON.stringify(manifest, null, 2));
      for (const [id, img] of Object.entries(data.images)) {
        files[`images/${id}.jpg`] = dataUrlToBytes(img.dataUrl).bytes;
      }
      const zipped = zipSync(files, { level: 6 });
      const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      a.href = url;
      a.download = `kedaibiao-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(t('options.backupExported'));
    } catch (e) {
      setStatus(e instanceof Error ? localizeError(t, e) : t('options.backupExportFailed'));
    }
  }, [t]);

  const doBackupImport = useCallback(
    async (file: File) => {
      setStatus(t('options.backupImporting'));
      try {
        const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
        const manifestBytes = unzipped['backup.json'];
        if (!manifestBytes) throw new Error('options.backupMissingManifest');
        const manifest = JSON.parse(strFromU8(manifestBytes)) as BackupData & {
          images: Record<string, { path: string; width: number; height: number }>;
        };
        const images: BackupData['images'] = {};
        for (const [id, meta] of Object.entries(manifest.images ?? {})) {
          const bin = unzipped[meta.path];
          if (!bin) continue;
          images[id] = {
            dataUrl: bytesToDataUrl(bin, 'image/jpeg'),
            width: meta.width,
            height: meta.height,
          };
        }
        const data: BackupData = { ...manifest, images };
        const imported = await send<TableCounts>({ type: 'backup:import', data });
        setCounts(await send<TableCounts>({ type: 'stats:counts' }));
        setStatus(
          t('options.backupImportDone', {
            courses: imported.courses,
            notes: imported.notes,
            chapters: imported.chapters,
            images: imported.images,
          }),
        );
      } catch (e) {
        setStatus(e instanceof Error ? localizeError(t, e) : t('options.backupImportFailed'));
      }
    },
    [t],
  );

  if (!setting) {
    return <div className="p-8 text-sm text-gray-500">{t('common.loading')}</div>;
  }

  const usagePct =
    estimate && estimate.quota > 0 ? Math.min(100, (estimate.usage / estimate.quota) * 100) : 0;

  return (
    <I18nProvider locale={effectiveLocale}>
      <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-neutral-900 dark:text-gray-100">
        <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
          <h1 className="text-xl font-bold">
            {t('brand.name')} · {t('options.pageTitle')}
          </h1>

          {/* 快捷键 */}
          <Section title={t('options.shortcuts')}>
            <ul className="space-y-2 text-sm">
              {(Object.keys(COMMAND_LABELS) as Command[]).map((name) => {
                const cmd = commands.find((c) => c.name === name);
                const current = cmd?.shortcut ?? '';
                const expected = setting.shortcuts[name];
                return (
                  <li key={name} className="flex items-center justify-between gap-3">
                    <span className="text-gray-700 dark:text-gray-300">
                      {t(COMMAND_LABELS[name])}
                    </span>
                    <span className="flex items-center gap-2">
                      <kbd className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-700">
                        {current || t('options.shortcutUnbound')}
                      </kbd>
                      {!current ? (
                        <span className="text-xs text-gray-400">
                          {t('options.shortcutUnboundHint')}
                        </span>
                      ) : current !== expected ? (
                        <span className="text-xs text-gray-400">
                          {t('options.shortcutCustomized')}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-gray-400">{t('options.shortcutsHint')}</p>
          </Section>

          {/* 主题 */}
          <Section title={t('options.theme')}>
            <div className="flex gap-2">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => update({ theme: opt.value })}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    setting.theme === opt.value
                      ? 'border-blue-500 bg-blue-50 text-blue-600 dark:bg-blue-950'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700'
                  }`}
                >
                  {t(opt.label)}
                </button>
              ))}
            </div>
          </Section>

          {/* 语言 */}
          <Section title={t('options.language')}>
            <div className="flex gap-2">
              {LANGUAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    update({ language: opt.value });
                    setLocale(resolveLocale(opt.value, browser.i18n.getUILanguage()));
                  }}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    setting.language === opt.value
                      ? 'border-blue-500 bg-blue-50 text-blue-600 dark:bg-blue-950'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700'
                  }`}
                >
                  {t(opt.label)}
                </button>
              ))}
            </div>
          </Section>

          {/* 截图质量 */}
          <Section title={t('options.captureQuality')}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.5}
                max={1}
                step={0.05}
                value={setting.capturePrefs.quality}
                onChange={(e) =>
                  update({ capturePrefs: { quality: Number(e.target.value) } })
                }
                className="flex-1"
              />
              <span className="w-12 text-right font-mono text-sm">
                {Math.round(setting.capturePrefs.quality * 100)}%
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-400">{t('options.captureQualityHint')}</p>
          </Section>

          {/* AI 大模型 */}
          <Section title={t('options.llmSection')}>
            {llmDraft ? (
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-gray-700 dark:text-gray-300">Base URL</span>
                  <input
                    type="text"
                    value={llmDraft.baseUrl}
                    onChange={(e) => setLlmDraft({ ...llmDraft, baseUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                    className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-700"
                  />
                </label>
                <label className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-gray-700 dark:text-gray-300">
                    {t('options.llmModelName')}
                  </span>
                  <input
                    type="text"
                    value={llmDraft.model}
                    onChange={(e) => setLlmDraft({ ...llmDraft, model: e.target.value })}
                    placeholder={t('options.llmModelPlaceholder')}
                    className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-700"
                  />
                </label>
                <label className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-gray-700 dark:text-gray-300">API Token</span>
                  <input
                    type="password"
                    value={llmDraft.apiToken}
                    onChange={(e) => setLlmDraft({ ...llmDraft, apiToken: e.target.value })}
                    placeholder="sk-..."
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-700"
                  />
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={llmBusy}
                    onClick={() => void saveLlm()}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {t('options.llmSave')}
                  </button>
                  <button
                    type="button"
                    disabled={llmBusy}
                    onClick={() => void testLlm()}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                  >
                    {t('options.llmTest')}
                  </button>
                  {llmStatus ? (
                    <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
                      {llmStatus}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-gray-400">{t('options.llmHint')}</p>
              </div>
            ) : null}
          </Section>

          {/* 导出偏好 */}
          <Section title={t('options.exportSection')}>
            <label className="mb-2 flex items-center justify-between text-sm">
              <span className="text-gray-700 dark:text-gray-300">{t('options.embedImage')}</span>
              <select
                value={setting.exportPrefs.embedImage}
                onChange={(e) =>
                  update({
                    exportPrefs: {
                      ...setting.exportPrefs,
                      embedImage: e.target.value as Setting['exportPrefs']['embedImage'],
                    },
                  })
                }
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700"
              >
                <option value="base64">{t('options.embedBase64')}</option>
                <option value="file">{t('options.embedFile')}</option>
              </select>
            </label>
            <label className="flex items-center justify-between text-sm">
              <span className="text-gray-700 dark:text-gray-300">
                {t('options.footerCredit')}
              </span>
              <input
                type="checkbox"
                checked={setting.exportPrefs.footerCredit}
                onChange={(e) =>
                  update({
                    exportPrefs: { ...setting.exportPrefs, footerCredit: e.target.checked },
                  })
                }
              />
            </label>
          </Section>

          {/* 存储占用 */}
          <Section title={t('options.storage')}>
            <div className="mb-2 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-700">
              <div className="h-full bg-blue-500" style={{ width: `${usagePct}%` }} />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {estimate
                ? t('options.storageUsed', {
                    used: formatBytes(estimate.usage),
                    quota: formatBytes(estimate.quota),
                  })
                : t('options.storageReading')}
            </p>
            {counts ? (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('options.storageCounts', {
                  courses: counts.courses,
                  notes: counts.notes,
                  chapters: counts.chapters,
                  images: counts.images,
                  transcripts: counts.transcripts,
                })}
              </p>
            ) : null}
          </Section>

          {/* 语音转写模型（当前浏览器可用的模型） */}
          <Section title={t('options.asrSection')}>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t('options.asrHint')}</p>
            {SUPPORTED_ASR_MODELS.map((id) => {
              const spec = ASR_MODELS[id];
              const cachedBytes = asrCache[id] ?? 0;
              return (
                <div key={id} className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-gray-700 dark:text-gray-300">
                    {t(spec.label)}
                    <span className="ml-2 text-xs text-gray-400">
                      {cachedBytes > 0
                        ? t('options.asrCached', { size: formatBytes(cachedBytes) })
                        : t('options.asrNotDownloaded', {
                            size: formatBytes(spec.totalBytes),
                          })}
                    </span>
                  </span>
                  {cachedBytes > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        void deleteModelFiles(id)
                          .then(refreshAsrCache)
                          .then(() =>
                            setStatus(t('options.asrCacheDeleted', { label: t(spec.label) })),
                          )
                          .catch((e) =>
                            setStatus(
                              e instanceof Error
                                ? localizeError(t, e)
                                : t('options.deleteFailed'),
                            ),
                          );
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                    >
                      {t('options.asrDeleteCache')}
                    </button>
                  ) : null}
                </div>
              );
            })}
            {/* 标点恢复模型（Paraformer 流式结果的可选增强，同样缓存于 ASR 库） */}
            {(() => {
              const cachedBytes = asrCache[PUNCT_MODEL.id] ?? 0;
              return (
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-gray-700 dark:text-gray-300">
                    {t(PUNCT_MODEL_LABEL)}
                    {t('options.asrPunctNote')}
                    <span className="ml-2 text-xs text-gray-400">
                      {cachedBytes > 0
                        ? t('options.asrCached', { size: formatBytes(cachedBytes) })
                        : t('options.asrNotDownloaded', {
                            size: formatBytes(PUNCT_MODEL.totalBytes),
                          })}
                    </span>
                  </span>
                  {cachedBytes > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        void deleteModelFiles(PUNCT_MODEL.id)
                          .then(refreshAsrCache)
                          .then(() =>
                            setStatus(
                              t('options.asrCacheDeleted', { label: t(PUNCT_MODEL_LABEL) }),
                            ),
                          )
                          .catch((e) =>
                            setStatus(
                              e instanceof Error
                                ? localizeError(t, e)
                                : t('options.deleteFailed'),
                            ),
                          );
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                    >
                      {t('options.asrDeleteCache')}
                    </button>
                  ) : null}
                </div>
              );
            })()}
          </Section>

          {/* 备份 */}
          <Section title={t('options.backupSection')}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void doBackupExport()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
              >
                {t('options.backupExport')}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
              >
                {t('options.backupImport')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void doBackupImport(file);
                  e.target.value = '';
                }}
              />
            </div>
            <p className="mt-2 text-xs text-gray-400">{t('options.backupHint')}</p>
          </Section>

          {status ? (
            <p className="text-center text-xs text-gray-500 dark:text-gray-400">{status}</p>
          ) : null}
        </div>
      </div>
    </I18nProvider>
  );
}
