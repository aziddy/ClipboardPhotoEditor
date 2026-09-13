# ClipboardPhotoEditor
Paste or import an image, edit it in one unified canvas, and copy or download the final composition.

The editor supports raster layers, drawing, erasing, cropping, resizing, layer ordering, opacity, visibility, undo, redo, clipboard export, and PNG/JPEG downloads from a single workspace.

Added images initially fit inside the document while retaining their original pixels. Moving, scaling, rotating, and resizing the document preserve that detail. Brush and eraser edits use the layer's full resolution; cropping removes excluded pixels without downscaling the remaining image. Exports use the document's dimensions. Images can be up to 12,000 pixels on each side.

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

## How to use

1. Paste, drop, or import an image to create the document.
2. Import more images to add them as layers.
3. Use the toolbar for move, brush, eraser, crop, and resize tools.
4. Use the Layers panel to select, reorder, duplicate, hide, delete, rename, or fade layers.
5. Copy the composed image to your clipboard or download it as PNG/JPEG.
