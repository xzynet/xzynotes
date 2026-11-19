import { zh as common } from './common';
import { zh as panel } from './panel';
import { zh as views } from './views';
import { zh as subtitles } from './subtitles';
import { zh as asrCard } from './asrCard';
import { zh as asrChain } from './asrChain';
import { zh as options } from './options';
import { zh as background } from './background';
import { zh as content } from './content';
import { zh as widgets } from './widgets';
import { zh as exportDoc } from './exportDoc';
import { zh as ai } from './ai';
import { zh as infra } from './infra';
import { zh as adapters } from './adapters';

/** 中文字典（key 的源头：类型、补全、对齐检查都由它派生） */
export const zhCN = {
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
} as const;
