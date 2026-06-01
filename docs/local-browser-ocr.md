# Local Browser OCR

The OCR feature runs on the user's device in the browser. It uses
Tesseract.js to recognize English text and word bounding boxes from the
current editor canvas.

## What Stays Local

- The image is not uploaded to an app server.
- OCR runs against an in-memory canvas generated from the visible editor
  composition.
- Recognized text, word boxes, and image-text selections are stored only in
  React state until the user copies them, clears OCR, refreshes, or closes the
  page.

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
6. Tesseract returns recognized text plus word-level bounding boxes.
7. Word boxes are mapped back to editor canvas coordinates and drawn as an
   overlay above the image.
8. The recognized text and confidence score are shown in the OCR panel.

## Selecting Text Over The Image

After OCR completes, recognized word boxes appear over the image. The overlay
captures pointer events so users can click a word or drag across multiple words
to select text directly on the image, similar to a macOS screenshot.

Selected text is copied in OCR reading order. If the selection spans multiple
recognized lines, the copied text preserves line breaks between those lines.

Because the overlay is interactive, normal canvas editing is blocked while OCR
boxes are visible. Clear OCR to remove the overlay and return to normal editing.

## OCR Panel UI

- The info icon beside the OCR heading explains the local/browser privacy model
  on hover or keyboard focus.
- `Run OCR` starts recognition on the current visible image.
- `Copy Selection` copies only the words selected over the image.
- `Copy All Text` copies the full recognized text from the OCR panel.
- `Cmd+C` or `Ctrl+C` copies selected OCR text when focus is not inside an
  editable field.
- `Clear` removes recognized text, word boxes, and the current selection.

## Privacy Notes

The current implementation does not send image pixels to a backend OCR service.
However, because the OCR runtime and language data are loaded from CDNs, the
browser may make network requests to fetch those public assets. Users who need
strict offline operation would need a self-hosted or bundled asset setup.

## Limitations

- OCR is English-only.
- OCR quality depends on image resolution, contrast, font clarity, and rotation.
- It reads the visible composite image, not hidden layers.
- Word boxes are based on Tesseract's OCR layout detection and may not align
  perfectly on low-quality or heavily transformed images.
- Canceling OCR terminates the active worker and a later run creates a new one.
