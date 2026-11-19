import { describe, expect, it } from 'vitest';
import { ASR_MODELS, type AsrModelId } from '../../core/asr';
import {
  modelsForCapabilities,
  SUPPORTED_ASR_MODELS,
} from '../../entrypoints/sidepanel/asr/capabilities';

/**
 * Firefox 只放开了文件/流式转写 + Paraformer：入口层按能力裁剪模型列表。
 * 这里守住两条边界——跨源隔离缺失时剔除 pthread 运行时（SenseVoice），
 * 单线程的流式 Paraformer 任何浏览器都保留。
 */

describe('转写能力矩阵 · 模型裁剪', () => {
  it('跨源隔离可用（Chrome）：注册表里的模型全开放', () => {
    expect(modelsForCapabilities({ crossOriginIsolated: true })).toEqual(
      Object.keys(ASR_MODELS) as AsrModelId[],
    );
  });

  it('无跨源隔离（Firefox）：剔除依赖 SharedArrayBuffer 的模型', () => {
    const ids = modelsForCapabilities({ crossOriginIsolated: false });
    expect(ids).toEqual(['paraformer-streaming']);
  });

  it('能力标记与运行时一致：仅 offline（pthread）构建依赖 SharedArrayBuffer', () => {
    for (const id of Object.keys(ASR_MODELS) as AsrModelId[]) {
      const spec = ASR_MODELS[id];
      expect(spec.needsSharedArrayBuffer).toBe(spec.runtime === 'offline');
    }
  });

  it('构建期按目标浏览器固化：默认环境（Chrome 语义）即全量模型', () => {
    expect(SUPPORTED_ASR_MODELS).toEqual(Object.keys(ASR_MODELS) as AsrModelId[]);
  });
});
