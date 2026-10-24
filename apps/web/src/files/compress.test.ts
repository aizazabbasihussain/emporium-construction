import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JPEG_QUALITY,
  MAX_LONG_EDGE,
  browserDeps,
  compressImage,
  targetSize,
  type CompressDeps,
} from './compress';

describe('targetSize', () => {
  it('keeps images whose long edge fits', () => {
    expect(targetSize({ width: 1600, height: 900 })).toEqual({ width: 1600, height: 900 });
    expect(targetSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it('scales the long edge down to 1600 and keeps the aspect ratio', () => {
    expect(targetSize({ width: 4000, height: 3000 })).toEqual({ width: 1600, height: 1200 });
    expect(targetSize({ width: 3000, height: 4000 })).toEqual({ width: 1200, height: 1600 });
  });

  it('never produces a zero side', () => {
    expect(targetSize({ width: 100000, height: 10 })).toEqual({ width: 1600, height: 1 });
  });
});

const photo = (name = 'wall.jpg', type = 'image/jpeg', bytes = 5000) =>
  new File([new Uint8Array(bytes)], name, { type, lastModified: 1_700_000_000_000 });

const deps = (blobBytes: number, size = { width: 4032, height: 3024 }) => {
  const encodeJpeg = vi.fn((_file: File, _size: unknown, _quality: number) =>
    Promise.resolve(new Blob([new Uint8Array(blobBytes)])),
  );
  const compress: CompressDeps = { measure: () => Promise.resolve(size), encodeJpeg };
  return { compress, encodeJpeg };
};

describe('compressImage (T-8)', () => {
  it('encodes at most 1600 px on the long edge with JPEG quality 0.7', async () => {
    const { compress, encodeJpeg } = deps(1000);
    const result = await compressImage(photo(), compress);
    expect(MAX_LONG_EDGE).toBe(1600);
    expect(JPEG_QUALITY).toBe(0.7);
    expect(encodeJpeg).toHaveBeenCalledTimes(1);
    const [, size, quality] = encodeJpeg.mock.calls[0] as [
      File,
      { width: number; height: number },
      number,
    ];
    expect(size).toEqual({ width: 1600, height: 1200 });
    expect(quality).toBe(0.7);
    expect(result.type).toBe('image/jpeg');
    expect(result.size).toBe(1000);
    expect(result.lastModified).toBe(1_700_000_000_000);
  });

  it('turns a PNG into a .jpg', async () => {
    const result = await compressImage(photo('scan.final.png', 'image/png'), deps(1000).compress);
    expect(result.name).toBe('scan.final.jpg');
    expect(result.type).toBe('image/jpeg');
  });

  it('leaves PDFs and spreadsheets untouched', async () => {
    const { compress, encodeJpeg } = deps(1);
    const pdf = photo('plan.pdf', 'application/pdf');
    expect(await compressImage(pdf, compress)).toBe(pdf);
    expect(encodeJpeg).not.toHaveBeenCalled();
  });

  it('keeps the original when the result would not be smaller', async () => {
    const original = photo('small.jpg', 'image/jpeg', 5000);
    expect(await compressImage(original, deps(5000, { width: 800, height: 600 }).compress)).toBe(
      original,
    );
  });
});

describe('browserDeps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stubCanvas = (blob: Blob | null) => {
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: (b: Blob | null) => void) => callback(blob));
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement);
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 4000, height: 3000, close }));
    return { drawImage, toBlob, canvas, close };
  };

  it('measures an image through createImageBitmap', async () => {
    const { close } = stubCanvas(null);
    expect(await browserDeps.measure(photo())).toEqual({ width: 4000, height: 3000 });
    expect(close).toHaveBeenCalled();
  });

  it('draws on a canvas of the target size and exports JPEG at the given quality', async () => {
    const blob = new Blob(['x']);
    const { drawImage, toBlob, canvas } = stubCanvas(blob);
    const result = await browserDeps.encodeJpeg(photo(), { width: 1600, height: 1200 }, 0.7);
    expect(result).toBe(blob);
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 1200);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.7);
  });

  it('fails when the canvas cannot encode', async () => {
    stubCanvas(null);
    await expect(browserDeps.encodeJpeg(photo(), { width: 10, height: 10 }, 0.7)).rejects.toThrow(
      'Could not encode',
    );
  });
});
