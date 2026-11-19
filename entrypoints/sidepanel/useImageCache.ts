import { useCallback, useState } from 'react';
import type { ImagePayload } from '~/core/messages';
import { send } from './rpc';

/** 截图 dataURL 缓存：配合 NoteCard 的懒加载回调按需拉取 */
export function useImageCache() {
  const [images, setImages] = useState<Record<string, ImagePayload>>({});

  const ensureImage = useCallback(async (imageId: string) => {
    setImages((prev) => {
      if (prev[imageId]) return prev;
      void send<ImagePayload>({ type: 'image:get', id: imageId })
        .then((payload) => setImages((cur) => ({ ...cur, [imageId]: payload })))
        .catch(() => {});
      return prev;
    });
  }, []);

  return { images, ensureImage };
}
