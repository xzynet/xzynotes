import Dexie, { type Table } from 'dexie';
import { isModelFileComplete, type DownloadableModel } from '~/core/asr';

/**
 * ASR 模型文件缓存：独立于主库的 Dexie 库。
 * 主库（kedaibiao）由后台 SW 独占打开，面板侧以更高版本打开同一库会触发
 * 多上下文升级/阻塞；且 Chrome 扩展消息无法传 Blob，模型字节只能就近落库。
 * 模型可重新下载，不进备份。
 */
export interface AsrFileRecord {
  /** `${modelId}/${path}` */
  key: string;
  modelId: string;
  path: string;
  bytes: number;
  blob: Blob;
  updatedAt: number;
}

class AsrDatabase extends Dexie {
  files!: Table<AsrFileRecord, string>;

  constructor() {
    super('kedaibiao-asr');
    this.version(1).stores({ files: 'key, modelId' });
  }
}

let dbPromise: Promise<AsrDatabase> | null = null;

function getDb(): Promise<AsrDatabase> {
  dbPromise ??= Promise.resolve().then(() => new AsrDatabase());
  return dbPromise;
}

const keyOf = (modelId: string, path: string) => `${modelId}/${path}`;

/** 列出某模型已缓存的文件（不含 Blob 本体，只读元数据） */
export async function listCachedFiles(modelId: string): Promise<Array<{ path: string; bytes: number }>> {
  const db = await getDb();
  const rows = await db.files.where('modelId').equals(modelId).toArray();
  return rows.map((r) => ({ path: r.path, bytes: r.bytes }));
}

/** 对照注册表校验：文件齐全且字节数吻合才算缓存完成 */
export async function isModelCached(spec: DownloadableModel): Promise<boolean> {
  return isModelFileComplete(spec, await listCachedFiles(spec.id));
}

/** 写入一个模型文件（整文件原子写入；半成品不落库，重试以文件为粒度） */
export async function putModelFile(modelId: string, path: string, blob: Blob): Promise<void> {
  const db = await getDb();
  await db.files.put({
    key: keyOf(modelId, path),
    modelId,
    path,
    bytes: blob.size,
    blob,
    updatedAt: Date.now(),
  });
}

/** 读出某模型全部文件的 Blob（转 ArrayBuffer 后 transfer 给 worker） */
export async function readModelFiles(modelId: string): Promise<Record<string, Blob>> {
  const db = await getDb();
  const rows = await db.files.where('modelId').equals(modelId).toArray();
  return Object.fromEntries(rows.map((r) => [r.path, r.blob]));
}

export async function deleteModelFiles(modelId: string): Promise<void> {
  const db = await getDb();
  await db.files.where('modelId').equals(modelId).delete();
}

/** 设置页展示用：各模型已占用的字节数 */
export async function cachedModelSizes(): Promise<Array<{ modelId: string; bytes: number }>> {
  const db = await getDb();
  const rows = await db.files.toArray();
  const byModel = new Map<string, number>();
  for (const r of rows) byModel.set(r.modelId, (byModel.get(r.modelId) ?? 0) + r.bytes);
  return [...byModel.entries()].map(([modelId, bytes]) => ({ modelId, bytes }));
}
