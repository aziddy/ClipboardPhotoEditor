# ClipboardPhotoEditor
Paste (from your Clipboard) your Image into the Tab and then Edit (crop, resize, ....) and receive the newly edited Image in your Clipboard for use Elsewhere

## SSL Certificates Setup
This project uses HTTPS locally for secure development. Follow these steps to set up SSL certificates:

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

## How to use

1. Paste your image into the tab
2. Edit the image (crop, resize, etc.)
3. Receive the newly edited image in your clipboard for use elsewhere
