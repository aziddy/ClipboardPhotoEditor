// Serves the production editor plus opt-in browser checks. Never ships in build/.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const resultsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-browser-results-'));
const baselineRevision = process.env.RASTER_BASELINE_REVISION || '194c6a4ea01af99e2ad3eacec5a4242c8ae68970';
const port = Number(process.env.BROWSER_TEST_PORT || 4176);
const assets = new Set(['engine-check.html', 'engine-check.js', 'ram-check.html', 'ram-check.js', 'ui-check.js']);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (request.method === 'POST' && ['/results', '/ui-results'].includes(url.pathname)) {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('Result too large.');
      }
      const result = JSON.parse(body);
      if (!/^[a-z-]+$/.test(result.kind)) throw new Error('Invalid result kind.');
      const browser = result.userAgent.includes('Chrome') ? 'chrome' : 'safari';
      fs.writeFileSync(path.join(resultsDirectory, `${browser}-${result.kind}.json`), JSON.stringify(result, null, 2));
      console.log(browser, result.kind, result.phase || `${result.passed}/${result.total}`);
      response.end('Saved');
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (url.pathname === '/baselineLayers.js') {
      const source = execFileSync('git', ['show', `${baselineRevision}:src/utils/editorLayers.js`], { cwd: root });
      response.setHeader('Content-Type', 'text/javascript');
      response.end(source);
      return;
    }
    let base;
    let relative;
    if (assets.has(url.pathname.slice(1))) {
      base = __dirname; relative = url.pathname.slice(1);
    } else if (url.pathname.startsWith('/src/')) {
      base = path.join(root, 'src'); relative = url.pathname.slice(5);
      if (!path.extname(relative)) relative += '.js';
    } else {
      base = path.join(root, 'build'); relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    }
    const filename = path.resolve(base, relative);
    if (!filename.startsWith(`${base}${path.sep}`)) throw new Error('Invalid path.');
    let data = fs.readFileSync(filename);
    if (url.pathname === '/' && url.searchParams.has('uicheck')) {
      data = data.toString().replace('</body>', '<script type="module" src="/ui-check.js"></script></body>');
    }
    response.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
    response.end(data);
  } catch (error) {
    response.writeHead(404); response.end(error.message);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Browser checks: http://localhost:${port}/engine-check.html`);
  console.log(`Editor checks: http://localhost:${port}/?uicheck=all`);
  console.log(`OCR fixture: http://localhost:${port}/?uicheck=ocr`);
  console.log(`RAM workload: http://localhost:${port}/ram-check.html?mode=tiled (or baseline)`);
  console.log(`Results: ${resultsDirectory}`);
});
