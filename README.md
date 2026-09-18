# ClipboardPhotoEditor
Paste or import an image, edit it in one unified canvas, and copy or download the final composition.

The editor supports raster layers, drawing, erasing, cropping, resizing, layer ordering, opacity, visibility, undo, redo, clipboard export, and PNG/JPEG downloads from a single workspace.

Added images initially fit inside the document while retaining their original pixels. Moving, scaling, rotating, and resizing the document preserve that detail. Brush and eraser edits use the layer's full resolution; cropping removes excluded pixels without downscaling the remaining image. Exports use the document's dimensions. Images can be up to 12,000 pixels on each side.

Original pixels and undo history use temporary browser storage on the user's device. The editor prefers OPFS, falls back to IndexedDB, and uses a bounded memory store if neither is available. Nothing is uploaded. These files are temporary working data, not saved projects: export your work before reloading or closing the tab.

Editing uses small image tiles, a bounded cache, and a preview sized to the visible viewport. Large imports and full-resolution exports still need temporary decoding/encoding memory. Choose **Calculate sizes** to encode PNG/JPEG and show their sizes; editing and quality changes no longer encode both formats automatically.

Moving, zooming, and changing layer opacity reuse cached source previews within the existing working-memory budget. Crop controls update independently of image rendering. These optimizations use Canvas 2D and require no WebGPU support.

Drawing appears through a bounded live preview while original-resolution strokes save in the background. Rapid strokes keep separate undo steps. Undo, export, and layer/view changes wait for accepted strokes; reset cancels immediately.

New documents start with a brush size of 0.5% of the image's longest edge, rounded to whole pixels with an 8px minimum (for example, 20px for a 4000px image). Adjust the size with the slider; your choice stays in place while editing and adding layers.

See [image storage and browser validation](docs/image-storage.md) for budgets, cleanup behavior, memory measurements, and tradeoffs.

## SSL Certificates Setup

Copying images to the clipboard requires a secure page, and SSL certificates enable HTTPS locally. Browsers also trust `http://localhost`, so certificates are optional if you set `HTTPS=false` in `.env`.

Follow these steps to set up SSL certificates for local HTTPS:

1. Install mkcert:
- On macOS with Homebrew:
    ```
    brew install mkcert
    ```

2. Install local CA:
   ```
   mkcert -install
   ```

3. Generate certificates:
   ```
   mkdir .cert
   cd .cert
   mkcert localhost
   ```

This will create the necessary certificate files (`localhost.pem` and `localhost-key.pem`) in the `.cert` directory, which are already configured in the project's environment settings.

## Run Project
```
npm start
```


## Static Hosting
### Build Static Files
```
npm run build
```
Now you can host the files in any static file hosting service like Vercel, Netlify, etc.

### Serve Static Files Locally

```npm install -g serve``` - Install **Serve** if you haven't already *(**-g** installs package globally on your machine)*

```npx serve -s build``` - Serve the files locally

## Run Tests

```sh
npm test -- --watchAll=false
```

The layer regression tests cover retained resolution, transforms, brush coordinates, cropping, resizing, and undo/redo. Verify pixel rendering and clipboard behavior in a browser as well; Jest mocks Canvas 2D.

For actual Canvas, worker, OPFS, and fallback checks in Chrome/Safari:

```sh
npm run build
npm run test:browser
```

Open the printed browser-check URLs. The editor check page generates its own fixtures and intercepts downloads. Use the ordinary editor to manually verify clipboard copying; Safari requires a real user click. These harnesses run only when explicitly opened and are excluded from the production build.

## How to use

1. Paste, drop, or import an image to create the document.
2. Import more images to add them as layers.
3. Use the toolbar for move, brush, eraser, crop, and resize tools.
4. Use the Layers panel to select, reorder, duplicate, hide, delete, rename, or fade layers.
5. Copy the composed image to your clipboard or download it as PNG/JPEG.
