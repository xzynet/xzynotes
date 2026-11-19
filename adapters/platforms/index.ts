import { BilibiliAdapter } from './bilibili';
import { Icourse163Adapter } from './icourse163';
import { XuetangxAdapter } from './xuetangx';
import { ZhihuishuAdapter } from './zhihuishu';
import { YoutubeAdapter } from './youtube';
import { GenericAdapter } from './generic';
import type { PlatformAdapter } from './base';

/** 已注册的平台 adapter（按优先级匹配） */
const ADAPTERS: PlatformAdapter[] = [
  new BilibiliAdapter(),
  new YoutubeAdapter(),
  new Icourse163Adapter(),
  new XuetangxAdapter(),
  new ZhihuishuAdapter(),
];

/** 兜底 adapter，始终最后 */
export const genericAdapter = new GenericAdapter();

/** 选择接管当前 URL 的 adapter；无匹配时返回 generic 兜底 */
export function resolvePlatformAdapter(url: string): PlatformAdapter {
  return ADAPTERS.find((a) => a.match(url)) ?? genericAdapter;
}

export {
  BilibiliAdapter,
  GenericAdapter,
  Icourse163Adapter,
  XuetangxAdapter,
  YoutubeAdapter,
  ZhihuishuAdapter,
};
export { NoSubtitlesError } from './base';
export type { PlatformAdapter, PlatformCourseInfo } from './base';
export { captureVideoFrame, scaledSize } from './capture';
