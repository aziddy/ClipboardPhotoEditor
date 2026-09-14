# Repository Guidelines

## Project Structure & Module Organization

This React 18 application uses Create React App and Chakra UI to resize, crop, and draw on images in the browser.

- `src/index.js` mounts the app and Chakra provider; `src/App.js` defines the editor tabs.
- `src/components/` contains the three `ClipboardPhoto*.js` editors.
- `src/utils/` contains shared upload hooks, canvas/export helpers, export controls, and `QualitySlider.js`. Reuse these across editors.
- `public/index.html` is the HTML shell; place static assets in `public/`.
- `build/` is generated output. No dedicated test or asset directories currently exist.

## Build, Test, and Development Commands

Run commands from the repository root:

- `npm ci` — install dependencies using the committed `package-lock.json`.
- `npm start` — start the local development server.
- `npm run build` — compile the production site into `build/`.
- `npx serve -s build` — preview the production build locally.
- `npm test` — start the Jest watcher through `react-scripts`.
- `npm test -- --watchAll=false` — run Jest once; currently reports no tests.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes in JavaScript, double quotes for JSX attributes, and semicolons. Follow existing functional components and React hooks. Use PascalCase for components and their filenames, camelCase for utilities and handlers, and `use`-prefixed names for hooks. Prefer Chakra UI components and style props for interface changes.

ESLint extends `react-app` and `react-app/jest` in `package.json`; there is no standalone lint script or configured formatter.

## Testing Guidelines

No automated tests or coverage thresholds are committed. Add behavior-focused Jest tests alongside relevant source files as `*.test.js`, such as `src/utils/imageExport.test.js`; mock browser canvas and clipboard APIs where needed.

For editor changes, build and manually check paste/upload, resizing, cropping, drawing, quality adjustments, PNG clipboard copying, PNG/JPEG downloads, and reset behavior. Check mobile upload behavior when changing input handling. JPEG clipboard copying is currently disabled in the UI.

## Commit & Pull Request Guidelines

History uses short descriptive subjects, such as `display size in KB`, without a consistent prefix convention. Keep commits focused. PRs should explain the behavior change, link related issues, list validation performed and browsers checked, and include screenshots for visible UI changes.

[IMPORTANT] DO NOT VIOLATE THIS GUIDELINE.
Do not credit AI agents as commit authors or co-authors, including `Co-authored-by` trailers.

## Local Configuration

Follow `README.md` for local HTTPS certificate setup with `mkcert`. Keep certificates in ignored `.cert/` and local settings in ignored `.env` files; do not commit these or generated `build/` output.
