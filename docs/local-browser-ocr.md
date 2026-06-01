# Local Browser OCR

The OCR feature runs on the user's device in the browser. It uses
Tesseract.js to recognize English text from the current editor canvas.

## What Stays Local

- The image is not uploaded to an app server.
- OCR runs against an in-memory canvas generated from the visible editor
  composition.
- Recognized text is stored only in React state until the user copies it,
  clears it, refreshes, or closes the page.

## What May Download

The first OCR run lazy-loads the OCR runtime into the browser:

- `tesseract.js` worker code
- `tesseract.js-core` WebAssembly runtime
- English trained language data from `https://tessdata.projectnaptha.com/4.0.0`

These assets are code/model files, not the user's image. Browser caching and
Tesseract's IndexedDB language-data cache may make later OCR runs faster.

## Processing Flow

1. The editor renders visible layers into the same composite canvas used for
   export.
2. A temporary OCR canvas is created in memory.
3. Transparency is flattened onto a white background.
4. Small images are upscaled and very large images are downscaled before OCR.
5. Tesseract runs in a web worker so the UI can show progress and remain
   responsive.
6. The recognized text and confidence score are shown in the OCR panel.

## Privacy Notes

The current implementation does not send image pixels to a backend OCR service.
However, because the OCR runtime and language data are loaded from CDNs, the
browser may make network requests to fetch those public assets. Users who need
strict offline operation would need a self-hosted or bundled asset setup.

## Limitations

- OCR is English-only.
- OCR quality depends on image resolution, contrast, font clarity, and rotation.
- It reads the visible composite image, not hidden layers.
- Canceling OCR terminates the active worker and a later run creates a new one.
