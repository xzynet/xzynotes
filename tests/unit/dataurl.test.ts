import { describe, expect, it } from 'vitest';
import { blobToDataUrl, bytesToDataUrl, dataUrlToBlob, dataUrlToBytes } from '../../core/utils/dataurl';

describe('core/utils/dataurl', () => {
  it('Blob → dataURL → Blob 往返一致（含中文）', async () => {
    const original = new Blob(['hello 你好，学知云课记'], { type: 'text/plain' });
    const dataUrl = await blobToDataUrl(original);
    expect(dataUrl.startsWith('data:text/plain;base64,')).toBe(true);
    const restored = dataUrlToBlob(dataUrl);
    expect(restored.type).toBe('text/plain');
    expect(await restored.text()).toBe('hello 你好，学知云课记');
  });

  it('dataUrlToBlob 保留 MIME 类型', () => {
    const blob = dataUrlToBlob('data:image/jpeg;base64,/9j/4AAQ');
    expect(blob.type).toBe('image/jpeg');
  });

  it('支持非 base64 的 URI 编码 dataURL', () => {
    const blob = dataUrlToBlob('data:text/plain,hello%20world');
    expect(blob.type).toBe('text/plain');
  });

  it('dataURL ↔ 字节 互转（zip 备份用）', () => {
    const original = new TextEncoder().encode('截图二进制 0011');
    const dataUrl = bytesToDataUrl(original, 'image/jpeg');
    const { bytes, mime } = dataUrlToBytes(dataUrl);
    expect(mime).toBe('image/jpeg');
    expect(bytes).toEqual(original);
  });

  it('非法 dataURL 抛错', () => {
    expect(() => dataUrlToBlob('https://example.com/x.png')).toThrow('非法 dataURL');
    expect(() => dataUrlToBlob('data:no-comma')).toThrow('非法 dataURL');
  });
});
