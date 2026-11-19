import { describe, expect, it } from 'vitest';
import { noopOcrEngine, OcrNotAvailableError } from '../../core/ocr';

describe('core/ocr · V1.0 留空实现', () => {
  it('recognize 直接抛 OcrNotAvailableError', async () => {
    await expect(noopOcrEngine.recognize(new Blob(['x']))).rejects.toBeInstanceOf(
      OcrNotAvailableError,
    );
  });

  it('错误消息为已注册的文案 key（展示端 localizeError 翻译）', async () => {
    const err = await noopOcrEngine.recognize(new Blob(['x'])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OcrNotAvailableError);
    expect((err as Error).name).toBe('OcrNotAvailableError');
    expect((err as Error).message).toBe('err.ocrUnavailable');
  });
});
