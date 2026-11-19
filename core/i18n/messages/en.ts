import { en as common } from './common';
import { en as panel } from './panel';
import { en as views } from './views';
import { en as subtitles } from './subtitles';
import { en as asrCard } from './asrCard';
import { en as asrChain } from './asrChain';
import { en as options } from './options';
import { en as background } from './background';
import { en as content } from './content';
import { en as widgets } from './widgets';
import { en as exportDoc } from './exportDoc';
import { en as ai } from './ai';
import { en as infra } from './infra';
import { en as adapters } from './adapters';
import type { zhCN } from './zh-CN';

/** 英文字典：TS 编译期强制与 zhCN 的 key 完全对齐，漏译即编译失败 */
export const en: Record<keyof typeof zhCN, string> = {
  ...common,
  ...panel,
  ...views,
  ...subtitles,
  ...asrCard,
  ...asrChain,
  ...options,
  ...background,
  ...content,
  ...widgets,
  ...exportDoc,
  ...ai,
  ...infra,
  ...adapters,
};
