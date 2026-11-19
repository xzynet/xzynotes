import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PUNCT_ID,
  punctuateText,
  splitToSegments,
  tokenizeForPunct,
} from '~/core/asr/punct';

/** CT-Transformer 标点恢复：算法单测（脚本化 infer）+ 真模型集成测试（无模型文件自动跳过） */

describe('splitToSegments（中英混排分组）', () => {
  it('按空白切词后再按 ASCII/非 ASCII 分段', () => {
    expect(splitToSegments('你好吗how are you我很好谢谢')).toEqual([
      '你好吗',
      'how',
      'are',
      'you',
      '我很好谢谢',
    ]);
  });
  it('连续英文/数字保持整段', () => {
    expect(splitToSegments('今天我们学习 abc123 中文')).toEqual(['今天我们学习', 'abc123', '中文']);
  });
  it('空输入与全空白', () => {
    expect(splitToSegments('')).toEqual([]);
    expect(splitToSegments('   ')).toEqual([]);
  });
});

describe('tokenizeForPunct', () => {
  const token2id = new Map([
    ['你', 10],
    ['好', 11],
    ['how', 100],
  ]);
  it('中文逐字、英文整词，未知走 unk', () => {
    const { ids, units } = tokenizeForPunct('你好how呀', token2id, 0);
    expect(ids).toEqual([10, 11, 100, 0]);
    expect(units).toEqual(['你', '好', 'how', '呀']);
  });
});

describe('punctuateText（脚本化 infer）', () => {
  const token2id = new Map([
    ['你', 10],
    ['好', 11],
    ['吗', 12],
    ['谢', 13],
    ['how', 100],
    ['are', 101],
    ['you', 102],
  ]);

  it('按预测插标点：中文逐字、英文词间补空格、未知词保留原文', async () => {
    // 你 好 吗 how are you 谢 谢 → 吗后问号、you 后逗号、末尾句号
    const text = '你好吗how are you谢谢xyz';
    const result = await punctuateText(text, token2id, 0, async (ids) => {
      expect(ids).toEqual([10, 11, 12, 100, 101, 102, 13, 13, 0]);
      return [
        PUNCT_ID.none,
        PUNCT_ID.none,
        PUNCT_ID.quest,
        PUNCT_ID.none,
        PUNCT_ID.none,
        PUNCT_ID.comma,
        PUNCT_ID.none,
        PUNCT_ID.none,
        PUNCT_ID.dot,
      ];
    });
    expect(result).toBe('你好吗？how are you，谢谢xyz。');
  });

  it('多窗口：第一个窗口无句末时从 last 重叠续切，最终强制收尾', async () => {
    const ids = Array.from({ length: 45 }, (_, i) => i + 1); // 45 个 token → 3 窗口
    const token2idBig = new Map(ids.map((id) => [`w${id}`, id]));
    const text = ids.map((id) => `w${id}`).join(' ');
    const calls: number[][] = [];
    const result = await punctuateText(text, token2idBig, 0, async (window) => {
      calls.push([...window]);
      // 窗口 1（token 1-20）：无句末无逗号 → 不产出；窗口 2（last=0 起 1-40）在 token 5 处给句号
      const out = new Array<number>(window.length).fill(PUNCT_ID.none);
      if (calls.length === 2) out[4] = PUNCT_ID.dot;
      if (calls.length === 3) out[out.length - 1] = PUNCT_ID.dot;
      return out;
    });
    // 窗口 2 产出 token1-5（含句号），last=5；窗口 3 从 token 6 开始到 45，末尾句号
    expect(calls[0]).toEqual(ids.slice(0, 20));
    expect(calls[1]).toEqual(ids.slice(0, 40));
    expect(calls[2]).toEqual(ids.slice(5, 45));
    expect(result).toBe('w1 w2 w3 w4 w5。' + ids.slice(5).map((id) => `w${id}`).join(' ') + '。');
  });
});

// ---- 真模型集成测试：模型大，未缓存时跳过（CI 无模型） ----
const MODEL_PATH = '.cache/sherpa-wasm/models/punct/model.onnx';
const TOKENS_PATH = '.cache/sherpa-wasm/models/punct/tokens.json';
const hasModel = existsSync(MODEL_PATH) && existsSync(TOKENS_PATH);

describe.skipIf(!hasModel)('CT-Transformer 真模型集成（onnxruntime）', () => {
  it(
    '真实推理：中英混排恢复标点',
    { timeout: 120_000 },
    async () => {
      const ort = await import('onnxruntime-web');
      ort.env.wasm.numThreads = 1;

      const tokens: string[] = JSON.parse(await readFile(TOKENS_PATH, 'utf8'));
      const token2id = new Map(tokens.map((t, i) => [t, i]));
      const unkId = token2id.get('<unk>');
      expect(unkId).toBeDefined();

      const session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['wasm'],
      });
      const [inputName, lengthName] = session.inputNames;
      const outputName = session.outputNames[0]!;

      const infer = async (ids: number[]): Promise<number[]> => {
        const feeds = {
          [inputName!]: new ort.Tensor('int32', Int32Array.from(ids), [1, ids.length]),
          [lengthName!]: new ort.Tensor('int32', new Int32Array([ids.length]), [1]),
        };
        const out = await session.run(feeds);
        const logits = out[outputName]!; // [1, seq, 6]
        const data = logits.data as Float32Array;
        const seq = logits.dims[1]!;
        const numPunct = logits.dims[2]!;
        const preds: number[] = [];
        for (let s = 0; s < seq; s++) {
          let best = 0;
          let bestVal = -Infinity;
          for (let p = 0; p < numPunct; p++) {
            const v = data[s * numPunct + p]!;
            if (v > bestVal) {
              bestVal = v;
              best = p;
            }
          }
          preds.push(best);
        }
        return preds;
      };

      const zh = await punctuateText('今天我们来讲中医食疗学的基本内容', token2id, unkId!, infer);
      console.log('[punct-zh]', zh);
      expect(zh).toContain('，');
      expect(zh.endsWith('。')).toBe(true);
      expect(zh).not.toContain('<unk>');

      const mixed = await punctuateText('你好吗how are you我很好谢谢', token2id, unkId!, infer);
      console.log('[punct-mixed]', mixed);
      expect(mixed).toContain('how are you'); // 英文词间空格保留
      expect(mixed).not.toContain('<unk>');
      expect(/[，。？、]/.test(mixed)).toBe(true);
    },
  );
});
