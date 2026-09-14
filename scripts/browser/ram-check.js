import * as old from '/baselineLayers.js';
import { createRasterLayer } from '/src/utils/editorLayers.js';
const mode = new URLSearchParams(location.search).get('mode') || 'tiled';
const status = document.getElementById('status');
const preview = document.getElementById('preview');
const delay = ms => new Promise(r => setTimeout(r, ms));
const phases = [];
const times = [];
let client, state, doc;
const phase = async (name, extra = {}) => {
  phases.push({
    name,
    time: Date.now(),
    ...extra
  });
  status.textContent = JSON.stringify({
    mode,
    phases,
    times
  }, null, 2);
  await fetch('/results', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'ram-' + mode,
      phase: name,
      mode,
      phases,
      times,
      userAgent: navigator.userAgent
    })
  });
};
const makeImage = async () => {
  const c = document.createElement('canvas');
  c.width = 4000;
  c.height = 3000;
  const ctx = c.getContext('2d');
  for (let y = 0; y < 3000; y += 40) for (let x = 0; x < 4000; x += 40) {
    ctx.fillStyle = `rgb(${x % 255},${y % 255},${(x + y) % 255})`;
    ctx.fillRect(x, y, 40, 40);
  }
  const blob = await new Promise(r => c.toBlob(r));
  c.width = 1;
  c.height = 1;
  return blob;
};
const makeClient = async () => {
  const worker = new Worker('/src/utils/raster.worker.js', {
    type: 'module'
  });
  const requests = new Map();
  let id = 0,
    stats;
  worker.onmessage = ({
    data
  }) => {
    if (data.event) return;
    stats = data.stats;
    const request = requests.get(data.id);
    requests.delete(data.id);
    data.error ? request.reject(Error(data.error.message)) : request.resolve(data.result);
  };
  const call = (method, args = {}) => new Promise((resolve, reject) => {
    requests.set(++id, {
      resolve,
      reject
    });
    worker.postMessage({
      id,
      method,
      args
    });
  });
  await call('init', {
    sessionId: crypto.randomUUID()
  });
  return {
    call,
    stats: () => stats,
    close: () => worker.terminate()
  };
};
const retain = async () => client.call('retain', {
  documents: state.history.map((d, i) => ({
    key: d.key,
    rasters: d.layers.map(l => l.rasterId)
  })),
  current: doc.layers.map(l => l.rasterId),
  currentKey: doc.key
});
const draw = async () => {
  if (mode === 'baseline') {
    old.renderDocument(preview.getContext('2d'), doc);
  } else {
    const {
      bitmap
    } = await client.call('render', {
      doc,
      width: 600,
      height: 480
    });
    preview.getContext('2d').clearRect(0, 0, 600, 480);
    preview.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  preview.getContext('2d').getImageData(0, 0, 1, 1);
};
try {
  document.getElementById('heading').textContent = mode + ' — 4000×3000 image, 30 strokes';
  await phase('empty');
  await delay(3000);
  let blob = await makeImage();
  if (mode === 'baseline') {
    const url = URL.createObjectURL(blob),
      image = new Image();
    image.src = url;
    await image.decode();
    const layer = old.createImageLayer(image, {
      width: 600,
      height: 480,
      layers: [{}]
    }, 1);
    doc = {
      width: 600,
      height: 480,
      layers: [layer],
      activeLayerId: layer.id
    };
    state = old.editorReducer({
      doc: old.createEmptyDocument(),
      history: [],
      historyIndex: -1
    }, {
      type: 'commit',
      doc
    });
    doc = state.doc;
    image.src = '';
    URL.revokeObjectURL(url);
  } else {
    client = await makeClient();
    const source = await client.call('importBlob', {
      blob
    });
    const layer = createRasterLayer(source, {
      width: 600,
      height: 480,
      layers: [{}]
    }, 1);
    doc = {
      key: '0',
      width: 600,
      height: 480,
      layers: [layer],
      activeLayerId: layer.id
    };
    state = {
      history: [doc]
    };
    await retain();
  }
  blob = null;
  await draw();
  await phase('imported', {
    stats: client?.stats()
  });
  await delay(3000);
  for (let i = 0; i < 30; i++) {
    const start = performance.now(),
      point = {
        x: 120 + i % 10 * 30,
        y: 150 + Math.floor(i / 10) * 40
      },
      to = {
        x: point.x + 12,
        y: point.y + 8
      };
    if (mode === 'baseline') {
      const stroke = old.beginLayerStroke(doc.layers[0], point, {
        size: 4,
        color: '#ff2266'
      });
      old.continueLayerStroke(stroke, to);
      old.finishLayerStroke(stroke);
      old.getLayerDocumentBounds(stroke.layer);
      doc = {
        ...doc,
        layers: [stroke.layer]
      };
      state = old.editorReducer(state, {
        type: 'commit',
        doc
      });
      doc = state.doc;
    } else {
      const source = await client.call('beginStroke', {
        layer: doc.layers[0],
        point,
        size: 4,
        color: '#ff2266'
      });
      await client.call('strokePoints', {
        points: [to]
      });
      const completed = await client.call('finishStroke');
      doc = {
        ...doc,
        key: String(i + 1),
        layers: [{
          ...doc.layers[0],
          ...completed
        }]
      };
      state.history = [...state.history, doc].slice(-30);
      await retain();
    }
    await draw();
    times.push(performance.now() - start);
    if (i === 9 || i === 19 || i === 29) await phase('stroke-' + (i + 1), {
      stats: client?.stats()
    });
    await delay(30);
  }
  await phase('settling', {
    stats: client?.stats()
  });
  await delay(6000);
  await phase('steady', {
    stats: client?.stats()
  });
  await delay(3000);
  await phase('export-start');
  const exportStart = performance.now();
  const exportDoc = old.resizeDocument(doc, 4000, 3000);
  let exported;
  if (mode === 'baseline') {
    const canvas = old.makeCompositeCanvas(exportDoc);
    exported = await new Promise(r => canvas.toBlob(r));
    canvas.width = 1;
    canvas.height = 1;
  } else exported = await client.call('exportBlob', {
    doc: exportDoc,
    format: 'image/png',
    quality: 1
  });
  await phase('export-end', {
    milliseconds: performance.now() - exportStart,
    bytes: exported.size
  });
  exported = null;
  await delay(3000);
  if (mode === 'baseline') {
    const canvases = new Set([...state.history.flatMap(d => d.layers.map(l => l.canvas)), ...doc.layers.map(l => l.canvas)]);
    for (const c of canvases) {
      c.width = 1;
      c.height = 1;
    }
  } else {
    await client.call('dispose');
    client.close();
  }
  state = null;
  doc = null;
  preview.width = 1;
  preview.height = 1;
  await phase('reset');
  await delay(6000);
  await phase('complete', {
    stats: client?.stats()
  });
  document.title = mode + ' RAM benchmark complete';
} catch (error) {
  await phase('failed', {
    error: error.stack
  });
  document.title = mode + ' RAM benchmark FAILED';
}
