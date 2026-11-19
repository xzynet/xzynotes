export interface CapturedFrame {
  blob: Blob;
  width: number;
  height: number;
}

/** 抓帧统一规格：宽 ≤ 1280px，JPEG quality 0.85 */
export const CAPTURE_MAX_WIDTH = 1280;
export const CAPTURE_QUALITY = 0.85;

export function scaledSize(
  videoWidth: number,
  videoHeight: number,
  maxWidth = CAPTURE_MAX_WIDTH,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / videoWidth);
  return {
    width: Math.round(videoWidth * scale),
    height: Math.round(videoHeight * scale),
  };
}

/**
 * 从 <video> 抓当前帧。可能因 DRM/跨域污染抛错，
 * 调用方应降级到 BrowserAdapter.captureVisibleTab。
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  maxWidth = CAPTURE_MAX_WIDTH,
  quality = CAPTURE_QUALITY,
): Promise<CapturedFrame> {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (!vw || !vh) throw new Error('err.videoNotReady');
  const { width, height } = scaledSize(vw, vh, maxWidth);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('err.canvasContextFailed');
  ctx.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('err.captureFailed');
  return { blob, width, height };
}
