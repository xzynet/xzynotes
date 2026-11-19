import { browser } from 'wxt/browser';

/**
 * Firefox 内置数据收集同意（Firefox 140+）。
 *
 * AI 章节切分会把课程字幕正文发往用户配置的 LLM 端点，对应 Mozilla 分类里的
 * `websiteContent`，故 manifest 中声明为 optional（见 wxt.config.ts）。声明只是前提：
 * Mozilla 要求扩展在用户手势链路里调 `permissions.request` 拿到授权后才能传输，
 * 否则属于无同意外传。Chrome 没有这套机制，无需也无法申请。
 *
 * 面板/选项页（可弹窗）用 requestAiConsent，后台（传输发生地，弹窗 API 在手势之外
 * 不可用）用 hasAiConsent 兜底 —— 与 asr/permission.ts 的 panel/host 分工一致。
 */

/** webext 类型尚未收录 data_collection 键，按官方文档补型 */
interface DataCollectionPermissions {
  request(details: { data_collection: string[] }): Promise<boolean>;
  contains(details: { data_collection: string[] }): Promise<boolean>;
}

const AI_DATA = ['websiteContent'];
const permissions = browser.permissions as unknown as DataCollectionPermissions;

/**
 * 申请 AI 数据外传授权。
 * Firefox 要求 permissions.request 处在用户输入处理栈内，故调用方必须在点击处理器里
 * **同步**调用本函数（前面不能有 await），否则请求会被拒。
 */
export function requestAiConsent(): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return Promise.resolve(true);
  return permissions.request({ data_collection: AI_DATA }).catch(() => false);
}

/** 查询 AI 数据外传授权是否已生效（后台侧调用，不能弹窗） */
export function hasAiConsent(): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return Promise.resolve(true);
  return permissions.contains({ data_collection: AI_DATA }).catch(() => false);
}
