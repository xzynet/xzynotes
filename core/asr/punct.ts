/**
 * CT-Transformer 标点恢复：纯算法部分（core 纯净约束：无浏览器/Worker API）。
 *
 * 模型：csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12
 * 算法逐行移植自该仓库 test.py（FunASR ct-transformer 推理流程）：
 *  - 分词：中文按字、英文按空白切出的词；中英混排时按「ASCII 段 / 非 ASCII 段」分组
 *  - 推理：20 token 一个窗口，窗口间从上一个句末（。/？）处重叠续切
 *  - 重组：英文词之间补空格；标点跟在所属 token 之后
 *
 * 推理本身由调用方注入（infer），worker 里用 onnxruntime-web 跑 ONNX；
 * 单测用脚本化 infer 全程验证算法。
 */

/** 标点 id 表：config.yaml 的 punc_list 顺序（<unk>/_/,/./?/、） */
export const PUNCT_ID = {
  unk: 0,
  none: 1, // "_"
  comma: 2, // "，"
  dot: 3, // "。"
  quest: 4, // "？"
  pause: 5, // "、"
} as const;

export const PUNCT_ID_TO_CHAR: Readonly<Record<number, string>> = {
  [PUNCT_ID.comma]: '，',
  [PUNCT_ID.dot]: '。',
  [PUNCT_ID.quest]: '？',
  [PUNCT_ID.pause]: '、',
};

/** 推理回调：输入一个 token id 窗口，返回每个位置的标点 id（6 类 argmax 结果） */
export type PunctInfer = (ids: number[]) => Promise<number[]>;

const isAscii = (s: string): boolean => s.length > 0 && s.charCodeAt(0) < 128;

/**
 * test.py 的分组：按空白切词后，把每个词再按「连续 ASCII / 连续非 ASCII」切段。
 * 返回的每段要么全 ASCII（作为整词查表），要么全非 ASCII（逐字查表）。
 */
export function splitToSegments(text: string): string[] {
  const segments: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    let current = '';
    let currentAscii: boolean | null = null;
    for (const ch of word) {
      const chAscii = isAscii(ch);
      if (currentAscii === null || chAscii === currentAscii) {
        current += ch;
        currentAscii = chAscii;
      } else {
        segments.push(current);
        current = ch;
        currentAscii = chAscii;
      }
    }
    if (current) segments.push(current);
  }
  return segments;
}

/** 分段 → token id 序列 + 与 id 对齐的原文单元（中文逐字、英文整词；保留原文形态） */
export function tokenizeForPunct(
  text: string,
  token2id: ReadonlyMap<string, number>,
  unkId: number,
): { ids: number[]; units: string[] } {
  const ids: number[] = [];
  const units: string[] = [];
  for (const seg of splitToSegments(text)) {
    if (isAscii(seg)) {
      ids.push(token2id.get(seg) ?? unkId);
      units.push(seg);
    } else {
      for (const ch of seg) {
        ids.push(token2id.get(ch) ?? unkId);
        units.push(ch);
      }
    }
  }
  return { ids, units };
}

/**
 * 给无标点文本恢复标点。逐行移植 test.py 的分窗推理与重组逻辑，
 * 差异：重组时用原文单元而非 id2token 回查（未知词不会变成 <unk>）。
 */
export async function punctuateText(
  text: string,
  token2id: ReadonlyMap<string, number>,
  unkId: number,
  infer: PunctInfer,
): Promise<string> {
  const { ids, units } = tokenizeForPunct(text, token2id, unkId);
  if (ids.length === 0) return text;

  const SEGMENT = 20;
  const MAX_LEN = 200;
  const numSegments = Math.ceil(ids.length / SEGMENT);

  // 与 ids 前缀对齐的标点预测（test.py 的 punctuations 数组）
  const preds: number[] = [];
  let last = -1;
  for (let i = 0; i < numSegments; i++) {
    let thisStart = i * SEGMENT;
    const thisEnd = Math.min(thisStart + SEGMENT, ids.length);
    if (last !== -1) thisStart = last;
    const inputs = ids.slice(thisStart, thisEnd);

    const out = await infer(inputs);

    // 从窗口尾部向前找最近的句末（。/？），找不到记最近的逗号
    let dotIndex = -1;
    let commaIndex = -1;
    for (let k = out.length - 1; k > 1; k--) {
      const p = out[k]!;
      if (p === PUNCT_ID.dot || p === PUNCT_ID.quest) {
        dotIndex = k;
        break;
      }
      if (commaIndex === -1 && p === PUNCT_ID.comma) commaIndex = k;
    }
    // 超长无句末窗口：把最近逗号提升为句号强制收尾
    if (dotIndex === -1 && inputs.length >= MAX_LEN && commaIndex !== -1) {
      dotIndex = commaIndex;
      out[dotIndex] = PUNCT_ID.dot;
    }
    if (dotIndex === -1) {
      if (last === -1) last = thisStart;
      // 最后一个窗口仍无句末：收到窗口尾
      if (i === numSegments - 1) dotIndex = inputs.length - 1;
    } else {
      last = thisStart + dotIndex + 1;
    }
    if (dotIndex !== -1) preds.push(...out.slice(0, dotIndex + 1));
  }

  const ans: string[] = [];
  const pushUnit = (t: string) => {
    // 两个相邻 ASCII 单元之间补空格（中文与标点前后不加）
    if (ans.length > 0 && isAscii(ans[ans.length - 1]!) && isAscii(t)) ans.push(' ');
    ans.push(t);
  };
  for (let i = 0; i < preds.length; i++) {
    pushUnit(units[i]!);
    const punct = PUNCT_ID_TO_CHAR[preds[i]!];
    if (punct) ans.push(punct);
  }
  // 防御：预测序列理论上覆盖全部 token，不足时把尾巴原文补上
  for (let i = preds.length; i < units.length; i++) pushUnit(units[i]!);
  return ans.join('');
}
