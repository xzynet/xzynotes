/**
 * OCR 接口定义。V1.0 仅留空实现（任何调用直接抛 OcrNotAvailableError），
 * V1.5 接入 tesseract.js 时提供同名接口的真实实现。
 */
export interface OcrEngine {
  readonly name: string;
  /** 识别图片中的文字，返回纯文本 */
  recognize(image: Blob): Promise<string>;
}

export class OcrNotAvailableError extends Error {
  constructor(message = 'err.ocrUnavailable') {
    super(message);
    this.name = 'OcrNotAvailableError';
  }
}

export const noopOcrEngine: OcrEngine = {
  name: 'noop',
  recognize: () => Promise.reject(new OcrNotAvailableError()),
};
