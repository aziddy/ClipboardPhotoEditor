import { createRasterLayer, applyLayerTransform, createEmptyDocument, invertTransform, transformPoint } from '/src/utils/editorLayers.js';
import { importRasterBlob } from '/src/utils/rasterImport.js';
const results = [];
const assert = (v, m) => {
  if (!v) throw Error(m);
};
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({
      name,
      passed: true,
      detail
    });
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: `${error.message}\n${error.stack}`
    });
  }
  document.getElementById('status').textContent = JSON.stringify(results, null, 2);
};
const makeClient = async backend => {
  const bootstrap = backend ? URL.createObjectURL(new Blob([`import '${location.origin}/src/utils/raster.worker.js'; Object.defineProperty(navigator.storage, 'getDirectory', {value: async () => { throw new Error('Disabled for fallback check'); }}); ${backend === 'memory' ? `Object.defineProperty(self, 'indexedDB', {value: undefined});` : ''}`], {
    type: 'text/javascript'
  })) : null;
  const w = new Worker(bootstrap || '/src/utils/raster.worker.js', {
    type: 'module'
  });
  const pending = new Map();
  let n = 0;
  let stats;
  let disposed = false;
  w.onmessage = ({
    data
  }) => {
    if (data.event) return;
    stats = data.stats;
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p.reject(Object.assign(Error(data.error.message), {
      name: data.error.name
    }));else p.resolve(data.result);
  };
  w.onerror = e => {
    for (const p of pending.values()) p.reject(Error(e.message));
    pending.clear();
  };
  const call = (method, args = {}, transfer = []) => new Promise((resolve, reject) => {
    if (method === 'dispose') disposed = true;
    const id = ++n;
    pending.set(id, {
      resolve,
      reject
    });
    w.postMessage({
      id,
      method,
      args
    }, transfer);
  });
  const sessionId = crypto.randomUUID();
  await call('init', { sessionId });
  if (bootstrap) URL.revokeObjectURL(bootstrap);
  return {
    call,
    sessionId,
    terminate: () => w.terminate(),
    stats: () => stats,
    close: async () => {
      try {
        if (!disposed) await call('dispose');
      } finally {
        w.terminate();
      }
    }
  };
};
const makeCanvas = (width, height) => {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
};
const png = c => new Promise(r => c.toBlob(r));
const fromBlob = async b => {
  const image = await createImageBitmap(b);
  const c = makeCanvas(image.width, image.height);
  c.getContext('2d').drawImage(image, 0, 0);
  image.close();
  return c;
};
const compare = (a, b) => {
  assert(a.width === b.width && a.height === b.height, 'Size mismatch');
  const x = a.getContext('2d').getImageData(0, 0, a.width, a.height).data,
    y = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
  let max = 0,
    sum = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i] - y[i]);
    max = Math.max(max, d);
    sum += d;
  }
  return {
    max,
    mean: sum / x.length
  };
};
let client, original, layer, doc, changed, second;
try {
  await check('OPFS worker initializes', async () => {
    client = await makeClient();
    assert(client.stats().backend === 'opfs', 'Unexpected backend ' + client.stats().backend);
    return client.stats();
  });
  original = makeCanvas(1040, 768);
  const ctx = original.getContext('2d');
  const pixels = ctx.createImageData(1040, 768);
  for (let y = 0; y < 768; y++) for (let x = 0; x < 1040; x++) {
    const i = (y * 1040 + x) * 4;
    pixels.data[i] = x % 256;
    pixels.data[i + 1] = y % 256;
    pixels.data[i + 2] = (x + y) % 2 ? 255 : 0;
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  await check('Import and native-resolution output preserve every pixel', async () => {
    const source = await client.call('importBlob', {
      blob: await png(original)
    });
    layer = createRasterLayer(source, createEmptyDocument(), 1);
    doc = {
      width: 1040,
      height: 768,
      layers: [layer],
      activeLayerId: layer.id
    };
    await client.call('retain', {
      documents: [{
        key: 'original',
        rasters: [layer.rasterId]
      }],
      current: [layer.rasterId],
      currentKey: 'original'
    });
    const output = await fromBlob(await client.call('exportBlob', {
      doc,
      format: 'image/png',
      quality: 1
    }));
    const diff = compare(original, output);
    assert(diff.max === 0, 'Changed native pixels ' + JSON.stringify(diff));
    return {
      diff,
      stats: client.stats()
    };
  });
  await check('Repeated shrinking/enlarging retains source detail', async () => {
    let moved = {
      ...layer,
      transform: [.25, 0, 0, .25, 0, 0]
    };
    for (let i = 0; i < 2; i++) moved = applyLayerTransform(moved, {
      scaleX: 200,
      scaleY: 200
    });
    moved = {
      ...moved,
      transform: [moved.transform[0], 0, 0, moved.transform[3], 0, 0]
    };
    const output = await fromBlob(await client.call('exportBlob', {
      doc: {
        ...doc,
        layers: [moved]
      },
      format: 'image/png',
      quality: 1
    }));
    assert(compare(original, output).max === 0, 'Resizing discarded pixels');
  });
  await check('Brush crosses tile edges and previous version stays unchanged', async () => {
    const source = await client.call('beginStroke', {
      layer,
      point: {
        x: 480,
        y: 300
      },
      size: 22,
      color: '#ff00aa',
      erase: false
    });
    await client.call('strokePoints', {
      points: [{
        x: 550,
        y: 310
      }]
    });
    changed = {
      ...layer,
      ...(await client.call('finishStroke'))
    };
    const output = await fromBlob(await client.call('exportBlob', {
      doc: {
        ...doc,
        layers: [changed]
      },
      format: 'image/png',
      quality: 1
    }));
    const before = await fromBlob(await client.call('exportBlob', {
      doc,
      format: 'image/png',
      quality: 1
    }));
    assert(compare(before, original).max === 0, 'Original was mutated');
    const p = output.getContext('2d').getImageData(511, 304, 3, 1).data;
    assert(p[0] === 255 && p[4] === 255 && p[8] === 255, 'Stroke has a tile gap');
    return client.stats();
  });
  await check('Eraser, cancel, and crop retain independent pixels', async () => {
    await client.call('beginStroke', {
      layer: changed,
      point: {
        x: 512,
        y: 305
      },
      size: 14,
      color: '#000000',
      erase: true
    });
    const erased = {
      ...changed,
      ...(await client.call('finishStroke'))
    };
    const out = await fromBlob(await client.call('exportBlob', {
      doc: {
        ...doc,
        layers: [erased]
      },
      format: 'image/png',
      quality: 1
    }));
    assert(out.getContext('2d').getImageData(512, 305, 1, 1).data[3] === 0, 'Eraser did not clear alpha');
    await client.call('beginStroke', {
      layer,
      point: {
        x: 512,
        y: 512
      },
      size: 80,
      color: '#ffffff'
    });
    await client.call('abortStroke');
    const before = await fromBlob(await client.call('exportBlob', {
      doc,
      format: 'image/png',
      quality: 1
    }));
    assert(compare(before, original).max === 0, 'Canceled stroke changed original');
    const cropped = await client.call('crop', {
      doc,
      crop: {
        x: 490,
        y: 200,
        width: 100,
        height: 100
      }
    });
    const cut = await fromBlob(await client.call('exportBlob', {
      doc: cropped,
      format: 'image/png',
      quality: 1
    }));
    const reference = makeCanvas(100, 100);
    reference.getContext('2d').drawImage(original, -490, -200);
    assert(compare(cut, reference).max === 0, 'Crop changed retained pixels');
  });
  await check('Rotated transparent tile boundaries have no seams', async () => {
    const moved = {
      ...layer,
      opacity: 45,
      transform: [Math.cos(.13), Math.sin(.13), -Math.sin(.13), Math.cos(.13), 20, -30]
    };
    const output = await fromBlob(await client.call('exportBlob', {
      doc: {
        ...doc,
        layers: [moved]
      },
      format: 'image/png',
      quality: 1
    }));
    const reference = makeCanvas(1040, 768),
      r = reference.getContext('2d');
    r.globalAlpha = .45;
    r.imageSmoothingQuality = 'high';
    r.setTransform(...moved.transform);
    r.drawImage(original, 0, 0);
    const diff = compare(output, reference);
    assert(diff.mean < 1, 'Tile boundary rendering differs: ' + JSON.stringify(diff));
    const actual = output.getContext('2d').getImageData(0, 0, 1040, 768).data;
    const expected = reference.getContext('2d').getImageData(0, 0, 1040, 768).data;
    const alphaDifferences = [];
    const inverse = invertTransform(moved.transform);
    let outerEdgeDifferences = 0;
    for (let i = 3; i < expected.length; i += 4) {
      if (expected[i] >= 113 && Math.abs(actual[i] - expected[i]) > 1) {
        const x = ((i - 3) / 4) % 1040;
        const y = Math.floor((i - 3) / 4 / 1040);
        const source = transformPoint(inverse, { x: x + 0.5, y: y + 0.5 });
        // Outer image-edge antialiasing can differ between HTML/OffscreenCanvas.
        // Check interior tile joins independently from that sampling boundary.
        if (source.x > 2 && source.x < 1038 && source.y > 2 && source.y < 766) {
          alphaDifferences.push({ x, y, actual: actual[i], expected: expected[i] });
        } else outerEdgeDifferences += 1;
      }
    }
    assert(!alphaDifferences.length, 'Opacity differences: ' + JSON.stringify(alphaDifferences.slice(0, 20)) + ' (total ' + alphaDifferences.length + ')');
    return { ...diff, outerEdgeDifferences };
  });
  await check('SVG import keeps its native dimensions', async () => {
    const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="red"/></svg>'], {
      type: 'image/svg+xml'
    });
    const source = await importRasterBlob(client, blob);
    assert(source.sourceWidth === 64 && source.sourceHeight === 32, 'SVG dimensions changed');
  });
  await check('Another session cannot delete an active session', async () => {
    second = await makeClient();
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('clipboard-photo-rasters-v1');
    const active = await directory.getDirectoryHandle(client.sessionId);
    assert(!(await active.values().next()).done, 'The active session lost its stored files');
    const output = await fromBlob(await client.call('exportBlob', {
      doc,
      format: 'image/png',
      quality: 1
    }));
    assert(compare(output, original).max === 0, 'Live session was deleted');
    await second.close();
    second = null;
  });
  await check('A later session removes abandoned OPFS files', async () => {
    const abandoned = await makeClient();
    await abandoned.call('importBlob', { blob: await png(original) });
    abandoned.terminate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await makeClient();
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('clipboard-photo-rasters-v1');
      let missing = false;
      try { await directory.getDirectoryHandle(abandoned.sessionId); }
      catch (error) { missing = error.name === 'NotFoundError'; }
      assert(missing, 'Abandoned files survived startup cleanup');
    } finally { await next.close(); }
  });
  for (const backend of ['indexeddb', 'memory']) await check(backend + ' fallback preserves pixels and disposes its data', async () => {
    const fallback = await makeClient(backend);
    try {
      assert(fallback.stats().backend === backend, 'Wrong fallback ' + fallback.stats().backend);
      const source = await fallback.call('importBlob', {
        blob: await png(original)
      });
      const fallbackDoc = {
        ...doc,
        layers: [{
          ...layer,
          ...source
        }]
      };
      const out = await fromBlob(await fallback.call('exportBlob', {
        doc: fallbackDoc,
        format: 'image/png',
        quality: 1
      }));
      assert(compare(out, original).max === 0, 'Fallback lost pixels');
      await fallback.call('dispose');
      assert(fallback.stats().storageBytes === 0, 'Fallback did not clean up');
    } finally {
      await fallback.close().catch(() => {});
    }
  });
  await check('Reset removes owned image storage and cache references', async () => {
    await client.call('dispose');
    const stats = client.stats();
    assert(stats.storageBytes === 0 && stats.cacheBytes === 0 && stats.rasterVersions === 0, 'Resources retained after reset');
    return stats;
  });
} catch (error) {
  results.push({
    name: 'Harness',
    passed: false,
    error: error.stack
  });
} finally {
  await client?.close().catch(() => {});
  await second?.close().catch(() => {});
}
const result = {
  kind: 'engine',
  complete: true,
  passed: results.filter(r => r.passed).length,
  total: results.length,
  results,
  userAgent: navigator.userAgent
};
document.getElementById('status').textContent = JSON.stringify(result, null, 2);
document.title = result.passed + '/' + result.total + ' tile engine checks';
window.results = result;
await fetch('/results', {
  method: 'POST',
  body: JSON.stringify(result)
});
