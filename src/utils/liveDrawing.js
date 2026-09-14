import { multiplyTransforms } from './editorLayers';

export const DRAWING_COORDINATE_LIMIT = 4 * 1024 * 1024;
export const DRAWING_CHUNK_LIMIT = 64 * 1024;
export const DRAWING_STROKE_LIMIT = 2048;
// Three retained planes plus the temporary bitmap used to initialize the editable
// plane stay within 24 MiB. The display canvas is owned by the editor.
export const DRAWING_PLANE_PIXELS = 1.5 * 1024 * 1024;

const POINT_CAPACITY = (DRAWING_COORDINATE_LIMIT - DRAWING_CHUNK_LIMIT) / 16;
const CHUNK_POINTS = DRAWING_CHUNK_LIMIT / 16;
const closeBitmaps = (result) => result?.bitmaps?.forEach((bitmap) => bitmap.close());
const canceled = () => Object.assign(new Error('Drawing was canceled.'), { name: 'AbortError' });
const samePreparation = (left, right) => left && right && left.key === right.key
  && left.canvas === right.canvas && left.width === right.width && left.height === right.height;

/**
 * The editable preview owns visual feedback; the ordered worker queue owns pixels
 * and history. Only completed worker descriptors enter the document model.
 */
export const createLiveDrawing = ({
  getClient, getDocument, onCommit, onStateChange = () => {},
  onError = () => {}, onInvalidate = () => {},
}) => {
  const journal = new Float64Array(POINT_CAPACITY * 2);
  let head = 0;
  let tail = 0;
  let epoch = 0;
  let nextStrokeId = 0;
  let preparationId = 0;
  let preparing = null;
  let preparingOptions = null;
  let failedPreparationKey = null;
  let desired = null;
  let planes = null;
  let active = null;
  let queue = [];
  let processing = false;
  let frame = null;
  let paused = false;
  let awaitingRelease = false;
  let disposed = false;
  let inFlightBytes = 0;
  let lastState = '';
  const waiters = [];

  const state = () => ({
    pending: queue.length > 0,
    drawing: active !== null,
    preparing: preparing !== null,
    paused,
    journalBytes: (tail - head) * 16 + inFlightBytes,
    previewBytes: planes ? planes.width * planes.height * 12 : 0,
    queuedStrokes: queue.length,
  });
  const notify = () => {
    const next = state();
    const signature = JSON.stringify(next);
    if (signature !== lastState) { lastState = signature; onStateChange(next); }
  };
  const pointAt = (index) => {
    const offset = (index % POINT_CAPACITY) * 2;
    return { x: journal[offset], y: journal[offset + 1] };
  };
  const append = (point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return true;
    if (tail - head >= POINT_CAPACITY) return false;
    const offset = (tail % POINT_CAPACITY) * 2;
    journal[offset] = point.x;
    journal[offset + 1] = point.y;
    tail += 1;
    return true;
  };
  const releasePlanes = () => {
    if (!planes) return;
    planes.below.close();
    planes.above.close();
    planes.active.width = 1;
    planes.active.height = 1;
    planes = null;
  };
  const reclaim = () => {
    while (queue[0]?.nativeDone && queue[0].painted === queue[0].end) queue.shift();
    head = queue.length ? Math.min(queue[0].painted, queue[0].acknowledged) : tail;
    if (paused && !awaitingRelease && !active
      && tail - head < POINT_CAPACITY / 2 && queue.length < DRAWING_STROKE_LIMIT / 2) {
      paused = false;
      notify();
    }
  };
  const compose = () => {
    if (!planes) return;
    const { canvas, width, height, below, active: editable, above, opacity } = planes;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(below, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = opacity;
    ctx.drawImage(editable, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.drawImage(above, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  };
  const paintStroke = (stroke, deadline) => {
    const ctx = planes.active.getContext('2d');
    const { doc, view } = planes;
    ctx.save();
    ctx.setTransform(...view);
    ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
    ctx.setTransform(...multiplyTransforms(view, stroke.layer.transform));
    ctx.beginPath();
    ctx.rect(0, 0, stroke.layer.sourceWidth, stroke.layer.sourceHeight);
    ctx.clip();
    ctx.setTransform(...view);
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.globalAlpha = 1;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let count = 0;
    while (stroke.painted < stroke.end) {
      const point = pointAt(stroke.painted);
      const from = stroke.lastPainted || point;
      const to = stroke.lastPainted ? point : { x: point.x + 0.01, y: point.y + 0.01 };
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      stroke.lastPainted = to;
      stroke.painted += 1;
      count += 1;
      if (count % 128 === 0 && performance.now() >= deadline) break;
    }
    ctx.restore();
  };
  const resolveWaiters = (error) => {
    waiters.splice(0).forEach(({ resolve, reject }) => error ? reject(error) : resolve());
  };
  let startPreparation;
  const settle = () => {
    reclaim();
    if (queue.length || processing) return;
    resolveWaiters();
    notify();
    // Render from committed source tiles only after every accepted local segment
    // has been painted and persisted. A late frame cannot erase newer strokes.
    if (!active && desired && (!planes || planes.key !== desired.key)) startPreparation();
  };
  const schedulePaint = () => {
    if (frame !== null || !planes || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!planes || disposed) return;
      try {
        const deadline = performance.now() + 8;
        for (const stroke of queue) {
          paintStroke(stroke, deadline);
          if (performance.now() >= deadline) break;
        }
        compose();
        reclaim();
        if (queue.some((stroke) => stroke.painted < stroke.end)) schedulePaint();
        settle();
      } catch (error) {
        fail(error, getClient(), epoch);
      }
    });
  };
  const invalidate = () => {
    if (queue.length || active) return false;
    preparationId += 1;
    preparing = null;
    preparingOptions = null;
    failedPreparationKey = null;
    desired = null;
    releasePlanes();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    notify();
    return true;
  };
  const fail = (error, client, operationEpoch) => {
    if (operationEpoch !== epoch || disposed) return;
    epoch += 1;
    const reverted = queue.filter((stroke) => !stroke.nativeDone).length;
    const pointerWasDown = active !== null;
    queue = [];
    active = null;
    head = tail;
    processing = false;
    inFlightBytes = 0;
    invalidate();
    paused = pointerWasDown;
    awaitingRelease = pointerWasDown;
    resolveWaiters(error);
    notify();
    client.call('abortStroke').catch(() => {});
    onInvalidate();
    onError(error, reverted);
  };
  const pump = async () => {
    if (processing || disposed || !queue.length) return;
    processing = true;
    const operationEpoch = epoch;
    const client = getClient();
    try {
      // Initial preview preparation must precede native mutation of its source.
      if (preparing) await preparing;
      if (operationEpoch !== epoch || disposed) return;
      while (operationEpoch === epoch && !disposed) {
        const stroke = queue.find((entry) => !entry.nativeDone);
        if (!stroke) break;
        if (!stroke.started) {
          const doc = getDocument();
          const layer = doc.layers.find((entry) => entry.id === stroke.layer.id);
          if (!layer) throw new Error('The drawing layer is no longer available.');
          stroke.started = true;
          stroke.sequence = 0;
          await client.call('beginStroke', {
            layer, point: pointAt(stroke.start), size: stroke.size, color: stroke.color,
            erase: stroke.erase, strokeId: stroke.id, sequence: stroke.sequence,
          });
          if (operationEpoch !== epoch || disposed) return;
          stroke.acknowledged = stroke.start + 1;
          reclaim();
        }
        while (stroke.acknowledged < stroke.end) {
          const count = Math.min(CHUNK_POINTS, stroke.end - stroke.acknowledged);
          const points = new Float64Array(count * 2);
          for (let index = 0; index < count; index += 1) {
            const point = pointAt(stroke.acknowledged + index);
            points[index * 2] = point.x;
            points[index * 2 + 1] = point.y;
          }
          inFlightBytes = points.byteLength;
          await client.call('strokePoints', {
            points, strokeId: stroke.id, sequence: ++stroke.sequence,
          }, [points.buffer]);
          if (operationEpoch !== epoch || disposed) return;
          inFlightBytes = 0;
          stroke.acknowledged += count;
          reclaim();
        }
        if (!stroke.ended) break;
        const descriptor = await client.call('finishStroke', {
          strokeId: stroke.id, sequence: ++stroke.sequence,
        });
        if (operationEpoch !== epoch || disposed) {
          // A canvas failure can cancel the local queue while finishStroke is
          // already persisting. Its returned version never reaches retain().
          if (descriptor?.rasterId) {
            client.call('releasePending', { rasterIds: [descriptor.rasterId] }).catch(() => {});
          }
          return;
        }
        if (!descriptor) throw new Error('The completed stroke has no image pixels.');
        const doc = getDocument();
        onCommit({
          ...doc,
          layers: doc.layers.map((layer) => layer.id === stroke.layer.id ? { ...layer, ...descriptor } : layer),
        });
        stroke.nativeDone = true;
        reclaim();
        notify();
      }
    } catch (error) {
      await fail(error, client, operationEpoch);
    } finally {
      if (operationEpoch === epoch) { processing = false; settle(); }
    }
  };
  startPreparation = () => {
    if (!desired || disposed || queue.length || active || preparing) return preparing || Promise.resolve(false);
    const options = { ...desired, doc: getDocument() };
    preparingOptions = options;
    const id = ++preparationId;
    const operationEpoch = epoch;
    releasePlanes();
    const scale = Math.min(1, Math.sqrt(DRAWING_PLANE_PIXELS / (options.width * options.height)));
    const width = Math.max(1, Math.floor(options.width * scale));
    const height = Math.max(1, Math.floor(options.height * scale));
    const view = multiplyTransforms([width / options.width, 0, 0, height / options.height, 0, 0], options.view);
    const promise = getClient().call('prepareDrawing', {
      doc: options.doc, activeLayerId: options.activeLayerId, width, height, view,
    }).then((result) => {
      if (id !== preparationId || operationEpoch !== epoch || disposed) { closeBitmaps(result); return false; }
      if (!queue.length && !samePreparation(options, desired)) { closeBitmaps(result); return false; }
      const editable = document.createElement('canvas');
      editable.width = width; editable.height = height;
      try { editable.getContext('2d').drawImage(result.bitmaps[1], 0, 0); }
      catch (error) { closeBitmaps(result); editable.width = 1; editable.height = 1; throw error; }
      result.bitmaps[1].close();
      const layer = options.doc.layers.find((entry) => entry.id === options.activeLayerId);
      planes = {
        ...options, width, height, view, below: result.bitmaps[0], active: editable,
        above: result.bitmaps[2], opacity: layer?.visible ? layer.opacity / 100 : 0,
        requestedWidth: options.width, requestedHeight: options.height,
      };
      if (options.canvas.width !== options.width) options.canvas.width = options.width;
      if (options.canvas.height !== options.height) options.canvas.height = options.height;
      compose();
      schedulePaint();
      return true;
    }).catch((error) => {
      if (id === preparationId && operationEpoch === epoch && !disposed) {
        releasePlanes();
        if (!queue.length && !samePreparation(options, desired)) return false;
        if (!queue.length) {
          desired = null; failedPreparationKey = options.key;
          onInvalidate(); onError(error, 0);
        }
        else throw error;
      }
      return false;
    }).finally(() => {
      if (id === preparationId && operationEpoch === epoch) {
        preparing = null; preparingOptions = null; notify();
        if (!queue.length && desired && !samePreparation(options, desired)) startPreparation();
      }
    });
    preparing = promise;
    // begin() can arrive while the request is pending; pump awaits this promise.
    promise.catch(() => {});
    notify();
    return promise;
  };
  const pause = () => {
    paused = true;
    awaitingRelease = true;
    if (active) active.ended = true;
    notify();
    pump();
  };
  const end = (released = true) => {
    if (active) active.ended = true;
    active = null;
    if (released || !paused) awaitingRelease = false;
    reclaim();
    notify();
    pump();
    settle();
  };
  const reset = () => {
    epoch += 1;
    const hadNativeWork = processing || queue.some((stroke) => stroke.started && !stroke.nativeDone);
    const client = hadNativeWork ? getClient() : null;
    queue = [];
    active = null;
    head = 0; tail = 0;
    processing = false;
    inFlightBytes = 0;
    paused = false;
    awaitingRelease = false;
    invalidate();
    resolveWaiters(canceled());
    if (client) client.call('abortStroke').catch(() => {});
    notify();
  };

  return {
    prepare(options) {
      if (disposed) return Promise.resolve(false);
      if (failedPreparationKey === options.key) return Promise.resolve(false);
      failedPreparationKey = null;
      desired = options;
      if (queue.length || active) return preparing || Promise.resolve(false);
      if (planes?.key === options.key && planes.canvas === options.canvas
        && planes.requestedWidth === options.width && planes.requestedHeight === options.height) return Promise.resolve(true);
      if (preparing) return preparing;
      return startPreparation();
    },
    begin({ layerId, point, size, color, erase, pointerId }) {
      if (disposed || paused || active || (!planes && !preparing)) return false;
      if (!queue.length && preparing && !samePreparation(preparingOptions, desired)) {
        // Idle view changes are coalesced. Once input arrives, pin that input to
        // the latest requested view rather than installing the older response.
        preparationId += 1;
        preparing = null;
        preparingOptions = null;
        startPreparation();
      }
      const source = planes || preparingOptions || desired;
      const layer = source?.doc.layers.find((entry) => entry.id === layerId);
      if (!layer || source.activeLayerId !== layerId || !Number.isFinite(point?.x)
        || !Number.isFinite(point?.y)) return false;
      if (queue.length >= DRAWING_STROKE_LIMIT || !append(point)) { pause(); return false; }
      const start = tail - 1;
      active = {
        id: ++nextStrokeId, layer: { ...layer, transform: [...layer.transform] },
        size, color, erase, pointerId, start, end: tail, painted: start,
        acknowledged: start, ended: false, started: false, nativeDone: false,
      };
      queue.push(active);
      notify();
      schedulePaint();
      pump();
      return true;
    },
    move(points) {
      if (!active || active.ended || paused || disposed) return false;
      for (const point of points) {
        if (!append(point)) { pause(); schedulePaint(); return false; }
        active.end = tail;
      }
      schedulePaint();
      pump();
      return true;
    },
    end,
    flush() {
      end(false);
      if (!queue.length && !processing) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    invalidate,
    releasePreview: invalidate,
    reset,
    dispose() { reset(); disposed = true; },
    state,
    hasWork: () => queue.length > 0 || active !== null || preparing !== null,
    ownsDisplay: () => planes !== null || queue.length > 0 || preparing !== null,
  };
};
