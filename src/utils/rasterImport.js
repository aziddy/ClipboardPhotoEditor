import { MAX_DIMENSION } from './editorLayers';

export const importRasterBlob = async (client, blob) => {
  try { return await client.call('importBlob', { blob }); }
  catch (error) { if (error.name !== 'ImageDecodeError') throw error; }

  // Some formats (notably SVG) require the main-thread image decoder. Transfer
  // that temporary bitmap to the worker, then release every decoding surface.
  const url = URL.createObjectURL(blob);
  const image = new Image();
  let canvas;
  let bitmap;
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('This image could not be decoded.'));
      image.src = url;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(`Images must be between 1 and ${MAX_DIMENSION.toLocaleString('en-US')} pixels on each side.`);
    }
    canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not allocate image working memory.');
    ctx.drawImage(image, 0, 0);
    bitmap = canvas.transferToImageBitmap();
    return await client.call('importBitmap', { bitmap }, [bitmap]);
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
};
