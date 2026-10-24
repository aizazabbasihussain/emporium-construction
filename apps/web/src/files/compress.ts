/** Spec P1-04 section 5: photos are shrunk in the browser before upload. */
export const MAX_LONG_EDGE = 1600;
export const JPEG_QUALITY = 0.7;

export interface Size {
  width: number;
  height: number;
}

/** Scales down so the long edge is at most `maxEdge`; smaller images keep their size. */
export function targetSize(size: Size, maxEdge: number = MAX_LONG_EDGE): Size {
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= maxEdge) return size;
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** The browser operations compression needs; tests replace them, the browser versions are below. */
export interface CompressDeps {
  /** The pixel size of the image file. */
  measure(file: File): Promise<Size>;
  /** Draws the image at `size` and encodes it as JPEG with the given quality (0 to 1). */
  encodeJpeg(file: File, size: Size, quality: number): Promise<Blob>;
}

const isCompressible = (file: File) => file.type === 'image/jpeg' || file.type === 'image/png';

/**
 * Returns a JPEG no larger than 1600 px on its long edge at quality 0.7. Other files, and images
 * that would not get smaller, are returned unchanged.
 */
export async function compressImage(file: File, deps: CompressDeps): Promise<File> {
  if (!isCompressible(file)) return file;
  const size = targetSize(await deps.measure(file));
  const blob = await deps.encodeJpeg(file, size, JPEG_QUALITY);
  if (blob.size >= file.size) return file;
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
}

/** The real browser implementation: decode with createImageBitmap, draw on a canvas, export JPEG. */
export const browserDeps: CompressDeps = {
  async measure(file) {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  },
  async encodeJpeg(file, size, quality) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image'))),
        'image/jpeg',
        quality,
      ),
    );
  },
};
