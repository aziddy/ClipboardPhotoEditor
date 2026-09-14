import { multiplyTransforms } from '/src/utils/editorLayers.js';

const status = document.getElementById('status');
const preview = document.getElementById('preview');
const previewContext = preview.getContext('2d');
const results = [];
const expected = new Map();
const modes = [];
const frames = 30;
const timingState = {
  initialVisibility: document.visibilityState,
  initialFocus: document.hasFocus(),
  visibilityLost: document.visibilityState !== 'visible',
  focusChanges: 0,
  frameTimeouts: 0,
};
const recordVisibility = () => { if (document.visibilityState !== 'visible') timingState.visibilityLost = true; };
document.addEventListener('visibilitychange', recordVisibility);
window.addEventListener('focus', () => { timingState.focusChanges += 1; });
window.addEventListener('blur', () => { timingState.focusChanges += 1; });
const checks = [
  'Reduced source with rotated, transparent layers',
  'Small source at native resolution',
  'Native source across tile seams',
  'Zoomed large source fallback',
  'Tiny preview using a lower mip level',
  'First in-progress brush update',
  'Second in-progress brush update',
  'Completed brush and rebuilt mips',
  'Undo after rendering an edited version',
  'PNG export after cached previews',
];

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const publishStatus = (phase) => {
  status.textContent = JSON.stringify({ phase, userAgent: navigator.userAgent, modes, results }, null, 2);
};
const release = (canvas) => { canvas.width = 1; canvas.height = 1; };
const rasterIds = (doc) => [...new Set(doc.layers.map((layer) => layer.rasterId))];
const layer = (source, id, transform, opacity = 100) => ({
  ...source, id, name: id, transform, opacity, visible: true,
});
const documentWith = (width, height, layers) => ({ width, height, layers, activeLayerId: layers[0].id });
const rotation = (angle, x, y) => {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [cosine, sine, -sine, cosine, x, y];
};
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    frames: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};

// Both runs decode the same fixtures; fixture creation and import are untimed.
const fixture = async (width, height) => {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  for (let y = 0; y < height; y += 40) {
    for (let x = 0; x < width; x += 40) {
      const alpha = ((x / 40 + y / 40) % 7 === 0) ? 0.4 : 1;
      context.fillStyle = `rgba(${x % 251}, ${y % 241}, ${(x * 3 + y * 7) % 253}, ${alpha})`;
      context.fillRect(x, y, 40, 40);
    }
  }
  context.lineWidth = 3;
  context.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  for (let x = 512; x < width; x += 512) {
    context.beginPath(); context.moveTo(x - 3, 0); context.lineTo(x + 3, height); context.stroke();
  }
  context.clearRect(492, 492, 39, 39);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  release(canvas);
  return blob;
};

const makeClient = async (mode) => {
  const source = `
    import { RasterEngine } from '${location.origin}/src/utils/rasterEngine.js';
    import { MemoryRasterStorage } from '${location.origin}/src/utils/rasterStorage.js';
    let engine;
    let queue = Promise.resolve();
    self.onmessage = ({ data: { id, method, args } }) => {
      queue = queue.then(async () => {
        try {
          if (method === 'init') engine = new RasterEngine(new MemoryRasterStorage(), () => {}, args);
          const result = method === 'init' ? engine.stats() : await engine[method](args);
          const transfer = [result?.bitmap, ...(result?.bitmaps || [])].filter(Boolean);
          self.postMessage({ id, result, stats: engine.stats() }, transfer);
        } catch (error) {
          self.postMessage({ id, error: { name: error.name, message: error.message, stack: error.stack }, stats: engine?.stats() });
        }
      });
    };
  `;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url, { type: 'module' });
  const pending = new Map();
  let nextId = 0;
  let stats;
  let disposed = false;
  worker.onmessage = ({ data }) => {
    stats = data.stats;
    const request = pending.get(data.id);
    if (!request) { data.result?.bitmap?.close(); return; }
    clearTimeout(request.timeout);
    pending.delete(data.id);
    if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
    else request.resolve(data.result);
  };
  worker.onerror = (event) => {
    pending.forEach((request) => { clearTimeout(request.timeout); request.reject(new Error(event.message)); });
    pending.clear();
  };
  const call = (method, args = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${mode}: ${method} timed out after 90 seconds.`));
    }, 90000);
    pending.set(id, { resolve, reject, timeout });
    try { worker.postMessage({ id, method, args }); }
    catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
  });
  try { await call('init', mode === 'baseline' ? { previewMemoryLimit: 0 } : {}); }
  catch (error) { worker.terminate(); throw error; }
  finally { URL.revokeObjectURL(url); }
  return {
    call,
    stats: () => stats,
    async dispose() { if (!disposed) { await call('dispose'); disposed = true; } },
    async close() {
      try { if (!disposed) await call('dispose'); }
      finally {
        worker.terminate();
        pending.forEach((request) => { clearTimeout(request.timeout); request.reject(new Error('Worker closed.')); });
        pending.clear();
      }
    },
  };
};

const pixels = (bitmap) => {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  try {
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally { bitmap.close(); release(canvas); }
};
const compare = (reference, actual) => {
  assert(reference.width === actual.width && reference.height === actual.height, 'Output dimensions changed.');
  let maxChannelDifference = 0;
  let changedChannels = 0;
  let totalChannelDifference = 0;
  for (let i = 0; i < reference.data.length; i += 1) {
    const difference = Math.abs(reference.data[i] - actual.data[i]);
    if (difference) changedChannels += 1;
    totalChannelDifference += difference;
    maxChannelDifference = Math.max(maxChannelDifference, difference);
  }
  return { maxChannelDifference, meanChannelDifference: totalChannelDifference / reference.data.length, changedChannels, channels: reference.data.length };
};
const checkPixels = async (mode, name, getBitmap, limits = { maxChannelDifference: 0, meanChannelDifference: 0 }) => {
  publishStatus(`${mode}: ${name}`);
  const actual = pixels(await getBitmap());
  if (mode === 'baseline') {
    expected.set(name, actual);
    return;
  }
  const difference = compare(expected.get(name), actual);
  expected.delete(name);
  results.push({
    name,
    passed: difference.maxChannelDifference <= limits.maxChannelDifference && difference.meanChannelDifference <= limits.meanChannelDifference,
    limits,
    detail: difference,
  });
};

const renderTiming = async (client, options) => {
  recordVisibility();
  // Pace submissions like the editor. The animation wait is outside the clock;
  // a hidden tab cannot silently stall the entire accuracy/resource check.
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cancelAnimationFrame(frame);
      timingState.frameTimeouts += 1;
      resolve();
    }, 1000);
    const frame = requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
  });
  recordVisibility();
  const start = performance.now();
  const { bitmap } = await client.call('render', options);
  try {
    previewContext.clearRect(0, 0, preview.width, preview.height);
    previewContext.drawImage(bitmap, 0, 0);
  } finally { bitmap.close(); }
  recordVisibility();
  return performance.now() - start;
};

const benchmark = async (client, mode, name, options) => {
  preview.width = options.width;
  preview.height = options.height;
  const coldMs = await renderTiming(client, options);
  for (let i = 0; i < 3; i += 1) await renderTiming(client, options);
  const warmedStats = client.stats();
  const times = [];
  publishStatus(`${mode}: ${name}, measuring ${frames} pan, rotation, and opacity frames`);
  for (let i = 0; i < frames; i += 1) {
    const angle = Math.sin(i * 0.24) * 0.09;
    const animated = {
      ...options.doc,
      layers: options.doc.layers.map((item, index) => index ? {
        ...item,
        opacity: 45 + ((i * 7 + index * 13) % 50),
        transform: multiplyTransforms(rotation(angle, i % 9 - 4, i % 7 - 3), item.transform),
      } : item),
    };
    times.push(await renderTiming(client, {
      ...options, doc: animated,
      view: [...options.view.slice(0, 4), Math.sin(i * 0.3) * 12, Math.cos(i * 0.2) * 8],
    }));
  }
  const stats = client.stats();
  return {
    name, width: options.width, height: options.height, coldMs, ...summary(times), frameTimesMs: times,
    cacheHitsDuringFrames: stats.previewCacheHits - warmedStats.previewCacheHits,
    cacheMissesDuringFrames: stats.previewCacheMisses - warmedStats.previewCacheMisses,
    warmedStats, stats,
  };
};

const runMode = async (mode, fixtures) => {
  publishStatus(`${mode}: importing deterministic fixtures`);
  const client = await makeClient(mode);
  try {
    const large = await client.call('importBlob', { blob: fixtures.large });
    const small = await client.call('importBlob', { blob: fixtures.small });
    const original = documentWith(1600, 1200, [
      layer(large, 'background', [0.4, 0, 0, 0.4, 0, 0]),
      layer(large, 'rotated', multiplyTransforms(rotation(0.08, 160, 100), [0.27, 0, 0, 0.27, 0, 0]), 64),
      layer(large, 'foreground', multiplyTransforms(rotation(-0.06, 530, 380), [0.2, 0, 0, 0.2, 0, 0]), 78),
    ]);
    const nativeSmall = documentWith(768, 640, [layer(small, 'small', [1, 0, 0, 1, 0, 0])]);
    const nativeLarge = documentWith(4000, 3000, [layer(large, 'large', [1, 0, 0, 1, 0, 0])]);
    const retained = [{ key: 'original', rasters: rasterIds(original) }, { key: 'small', rasters: rasterIds(nativeSmall) }];
    await client.call('retain', { documents: retained, current: rasterIds(original), currentKey: 'original' });
    const options = { doc: original, width: 1000, height: 750, view: [0.625, 0, 0, 0.625, 0, 0] };
    const primary = await benchmark(client, mode, 'Shared source', options);
    const measuredStats = primary.stats;
    const modeResult = { mode, ...primary, workloads: [] };
    modes.push(modeResult);
    if (mode === 'baseline') {
      results.push({
        name: 'Baseline runs with the preview cache disabled',
        passed: measuredStats.previewMemoryLimit === 0 && measuredStats.previewCacheBytes === 0,
        detail: measuredStats,
      });
    }
    const renderBitmap = (settings) => async () => (await client.call('render', settings)).bitmap;
    // Browser resampling can round isolated preview channels by one; original
    // pixels, native previews, stroke versions, and exports remain byte-exact.
    const previewLimits = { maxChannelDifference: 1, meanChannelDifference: 0.001 };
    await checkPixels(mode, checks[0], renderBitmap(options), previewLimits);
    await checkPixels(mode, checks[1], renderBitmap({ doc: nativeSmall, width: 768, height: 640 }));
    await checkPixels(mode, checks[2], renderBitmap({ doc: nativeLarge, width: 960, height: 720, view: [1, 0, 0, 1, -301, -277] }));
    await checkPixels(mode, checks[3], renderBitmap({ doc: nativeLarge, width: 960, height: 720, view: [2.15, 0, 0, 2.15, -850.5, -770.25] }));
    await checkPixels(mode, checks[4], renderBitmap({ ...options, width: 120, height: 90, view: [0.075, 0, 0, 0.075, 0, 0] }), previewLimits);

    // Warm an editable native source, then render two updates to the same dirty
    // tile. This catches stale caches keyed only by version or dirty-tile ID.
    const strokeId = 'preview-stroke';
    const started = await client.call('beginStroke', {
      layer: nativeSmall.layers[0], point: { x: 490, y: 508 }, size: 22,
      color: '#ff00aa', erase: false, strokeId,
    });
    let edited = { ...nativeSmall, layers: [{ ...nativeSmall.layers[0], ...started }] };
    await checkPixels(mode, checks[5], renderBitmap({ doc: edited, width: 768, height: 640 }));
    const updated = await client.call('strokePoints', {
      points: [{ x: 530, y: 512 }, { x: 558, y: 530 }], strokeId, sequence: 1,
    });
    edited = { ...edited, layers: [{ ...edited.layers[0], ...updated }] };
    await checkPixels(mode, checks[6], renderBitmap({ doc: edited, width: 768, height: 640 }));
    const finished = await client.call('finishStroke', { strokeId });
    edited = { ...edited, layers: [{ ...edited.layers[0], ...finished }] };
    await client.call('retain', {
      documents: [...retained, { key: 'edited', rasters: rasterIds(edited) }],
      current: rasterIds(edited), currentKey: 'edited',
    });
    await checkPixels(mode, checks[7], renderBitmap({ doc: edited, width: 384, height: 320, view: [0.5, 0, 0, 0.5, 0, 0] }));
    await client.call('retain', { documents: retained, current: rasterIds(nativeSmall), currentKey: 'small' });
    await checkPixels(mode, checks[8], renderBitmap({ doc: nativeSmall, width: 768, height: 640 }));
    await checkPixels(mode, checks[9], async () => createImageBitmap(await client.call('exportBlob', {
      doc: original, format: 'image/png', quality: 1,
    })));
    publishStatus(`${mode}: importing two independent large rasters for cache pressure`);
    const independentSources = [large];
    for (let i = 0; i < 2; i += 1) independentSources.push(await client.call('importBlob', { blob: fixtures.large }));
    const pressureDoc = documentWith(1600, 1200, independentSources.map((source, index) => layer(
      source, `independent-${index}`,
      multiplyTransforms(rotation(index * 0.035, index * 25, index * 15), [0.4, 0, 0, 0.4, 0, 0]),
      index ? 62 : 100
    )));
    await client.call('retain', {
      documents: [...retained, { key: 'pressure', rasters: rasterIds(pressureDoc) }],
      current: rasterIds(pressureDoc), currentKey: 'pressure',
    });
    for (const width of [800, 1600]) {
      const height = width * 0.75;
      const scale = width / pressureDoc.width;
      const workload = await benchmark(client, mode, `Three independent sources at ${width}×${height}`, {
        doc: pressureDoc, width, height, view: [scale, 0, 0, scale, 0, 0],
      });
      modeResult.workloads.push(workload);
      if (mode === 'optimized') results.push({
        name: `${workload.name}: steady frames reuse the cache without repeated eviction`,
        passed: workload.cacheMissesDuringFrames <= 1 && workload.cacheHitsDuringFrames >= frames,
        detail: {
          hits: workload.cacheHitsDuringFrames, misses: workload.cacheMissesDuringFrames,
          frames, maximumMisses: 1, minimumHits: frames, stats: workload.stats,
        },
      });
    }
    const beforeReset = client.stats();
    await client.dispose();
    const afterReset = client.stats();
    modes[modes.length - 1].beforeReset = beforeReset;
    modes[modes.length - 1].afterReset = afterReset;
    if (mode === 'optimized') {
      results.push({
        name: 'Reset releases raster and preview caches',
        passed: afterReset.cacheBytes === 0 && afterReset.storageBytes === 0 && afterReset.previewCacheBytes === 0,
        detail: afterReset,
      });
      const limit = measuredStats.previewMemoryLimit;
      const bytes = measuredStats.previewCacheBytes;
      results.push({
        name: 'Preview cache is used within its memory limit',
        passed: Number.isFinite(limit) && limit > 0 && Number.isFinite(bytes) && bytes > 0 &&
          bytes <= limit && beforeReset.peakPreviewCacheBytes <= limit && measuredStats.previewCacheHits > 0,
        detail: { bytes, limit, peakBytes: beforeReset.peakPreviewCacheBytes, hits: measuredStats.previewCacheHits },
      });
      results.push({
        name: 'Raster and preview surfaces respect the shared resident limit',
        passed: beforeReset.residentRasterBytes <= beforeReset.tileMemoryLimit &&
          beforeReset.peakResidentRasterBytes <= beforeReset.tileMemoryLimit,
        detail: {
          residentRasterBytes: beforeReset.residentRasterBytes,
          peakResidentRasterBytes: beforeReset.peakResidentRasterBytes,
          tileMemoryLimit: beforeReset.tileMemoryLimit,
        },
      });
    }
  } finally { await client.close(); }
};

try {
  const fixtures = { large: await fixture(4000, 3000), small: await fixture(768, 640) };
  await runMode('baseline', fixtures);
  await runMode('optimized', fixtures);
} catch (error) {
  results.push({ name: 'Harness completed', passed: false, error: `${error.message}\n${error.stack}` });
}
const baseline = modes.find((entry) => entry.mode === 'baseline');
const optimized = modes.find((entry) => entry.mode === 'optimized');
const output = {
  kind: 'preview-check',
  userAgent: navigator.userAgent,
  devicePixelRatio,
  hardwareConcurrency: navigator.hardwareConcurrency,
  timing: 'One submission per animation frame; timed worker render roundtrip plus canvas presentation calls. Excludes animation-frame wait, pixel readback, import, and PNG encoding. Does not measure GPU completion or energy consumption.',
  timingsValid: !timingState.visibilityLost && timingState.frameTimeouts === 0,
  visibility: { ...timingState, finalVisibility: document.visibilityState, finalFocus: document.hasFocus() },
  passed: results.filter((result) => result.passed).length,
  total: results.length,
  speedup: baseline && optimized ? {
    total: baseline.totalMs / optimized.totalMs,
    p50: baseline.p50Ms / optimized.p50Ms,
    p95: baseline.p95Ms / optimized.p95Ms,
  } : null,
  modes,
  results,
};
window.previewCheckResults = output;
status.textContent = JSON.stringify(output, null, 2);
try {
  const response = await fetch('/results', { method: 'POST', body: JSON.stringify(output) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  status.textContent += `\nCould not save results: ${error.message}`;
}
