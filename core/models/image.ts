import { z } from 'zod';

export const ImageSchema = z.object({
  id: z.string().min(1),
  blob: z.custom<Blob>((v) => typeof Blob !== 'undefined' && v instanceof Blob, {
    message: 'expected Blob',
  }),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Image = z.infer<typeof ImageSchema>;
