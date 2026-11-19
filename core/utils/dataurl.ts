/**
 * dataURL ↔ Blob/字节 互转。
 * 只用 atob/btoa/Uint8Array/TextEncoder 等 Web 标准 API，
 * 在 MV3 service worker（无 FileReader）和 Node（单测）中都可用。
 */

/** 解析 dataURL → { bytes, mime }；非法输入抛错 */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  if (!dataUrl.startsWith('data:')) throw new Error('非法 dataURL');
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) throw new Error('非法 dataURL');
  const header = dataUrl.slice(5, commaIdx);
  const data = dataUrl.slice(commaIdx + 1);
  const mime = header.split(';')[0] || 'application/octet-stream';
  const isBase64 = header.includes(';base64');
  const bytes = isBase64
    ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(data));
  return { bytes, mime };
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const { bytes, mime } = dataUrlToBytes(dataUrl);
  // TS5.9：Uint8Array<ArrayBufferLike> 不满足 BlobPart，slice() 得到独立 ArrayBuffer
  return new Blob([bytes.slice()], { type: mime });
}

/** 字节 → base64 dataURL */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return bytesToDataUrl(buf, blob.type || 'application/octet-stream');
}
