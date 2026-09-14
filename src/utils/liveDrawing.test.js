import {
  createLiveDrawing, DRAWING_COORDINATE_LIMIT, DRAWING_CHUNK_LIMIT, DRAWING_PLANE_PIXELS, DRAWING_STROKE_LIMIT,
} from './liveDrawing';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const microtasks = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

let contexts;
let frames;
let nextFrame;
let originalRequest;
let originalCancel;

beforeEach(() => {
  contexts = new Map(); frames = new Map(); nextFrame = 0;
  originalRequest = window.requestAnimationFrame; originalCancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = jest.fn((callback) => { frames.set(++nextFrame, callback); return nextFrame; });
  window.cancelAnimationFrame = jest.fn((id) => frames.delete(id));
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
    if (!contexts.has(this)) {
      const operations = [];
      const ctx = { operations, globalAlpha: 1, globalCompositeOperation: 'source-over' };
      ['save', 'restore', 'setTransform', 'beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'clearRect']
        .forEach((name) => { ctx[name] = jest.fn((...args) => operations.push([name, ...args])); });
      ctx.stroke = jest.fn(() => operations.push(['stroke', ctx.globalAlpha, ctx.globalCompositeOperation]));
      ctx.drawImage = jest.fn((...args) => operations.push(['drawImage', ctx.globalAlpha, ...args]));
      contexts.set(this, ctx);
    }
    return contexts.get(this);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  window.requestAnimationFrame = originalRequest; window.cancelAnimationFrame = originalCancel;
});

const paintFrame = () => {
  const callbacks = [...frames.values()]; frames.clear();
  callbacks.forEach((callback) => callback(performance.now()));
};
const drain = async (controller) => {
  for (let i = 0; i < 100 && controller.hasWork(); i += 1) {
    paintFrame(); await microtasks();
  }
};
const fixture = (overrides = {}) => {
  let doc = {
    width: 600, height: 480, activeLayerId: 'layer',
    layers: [{ id: 'layer', rasterId: 'original', sourceWidth: 1200, sourceHeight: 960,
      sourceBounds: null, transform: [0.5, 0, 0, 0.5, 0, 0], visible: true, opacity: 50 }],
  };
  let revision = 0;
  const bitmapSets = [];
  const calls = [];
  const client = { call: jest.fn(async (method, args, transfer) => {
    calls.push({ method, args, transfer });
    if (overrides[method]) return overrides[method](args, transfer);
    if (method === 'prepareDrawing') {
      const bitmaps = Array.from({ length: 3 }, (_, index) => ({ index, close: jest.fn() }));
      bitmapSets.push(bitmaps);
      return { bitmaps };
    }
    if (method === 'finishStroke') return {
      rasterId: `stroke-${++revision}`, sourceWidth: 1200, sourceHeight: 960,
      sourceBounds: { x: revision, y: revision, width: 50, height: 40 },
    };
    return { rasterId: 'intermediate', sourceBounds: null };
  }) };
  const onCommit = jest.fn((next) => { doc = next; });
  const onStateChange = jest.fn(); const onError = jest.fn(); const onInvalidate = jest.fn();
  const controller = createLiveDrawing({ getClient: () => client, getDocument: () => doc,
    onCommit, onStateChange, onError, onInvalidate });
  const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 480;
  const options = () => ({ doc, activeLayerId: 'layer', width: canvas.width, height: canvas.height,
    view: [1, 0, 0, 1, 0, 0], key: doc.layers[0].rasterId, canvas });
  const begin = (point = { x: 100, y: 100 }, erase = false) => controller.begin({
    layerId: 'layer', point, size: 12, color: '#ff0000', erase, pointerId: 1,
  });
  return { controller, client, calls, canvas, options, begin, bitmapSets,
    onCommit, onStateChange, onError, onInvalidate, getDoc: () => doc,
    setDoc: (nextDoc) => { doc = nextDoc; } };
};

test('drawing reaches the next animation frame while native writes are still blocked', async () => {
  const nativeBegin = deferred();
  const setup = fixture({ beginStroke: () => nativeBegin.promise });
  await setup.controller.prepare(setup.options());
  paintFrame();
  setup.begin();
  setup.controller.move([{ x: 120, y: 100 }, { x: 140, y: 100 }]);
  paintFrame();
  const editable = [...contexts.keys()].find((canvas) => canvas !== setup.canvas);
  expect(contexts.get(editable).stroke).toHaveBeenCalledTimes(3);
  expect(setup.onCommit).not.toHaveBeenCalled();
  expect(setup.controller.state()).toMatchObject({ pending: true, drawing: true });
  expect(setup.controller.state().journalBytes).toBe(48);
  nativeBegin.resolve({}); setup.controller.end();
  await drain(setup.controller);
  expect(setup.onCommit).toHaveBeenCalledTimes(1);
  expect(setup.controller.state().journalBytes).toBe(0);
  setup.controller.dispose();
});

test('rapid strokes persist in order against the last committed raster and final bounds', async () => {
  const finish = deferred(); let finished = 0;
  const setup = fixture({ finishStroke: () => {
    finished += 1;
    return finished === 1 ? finish.promise : {
      rasterId: 'second', sourceWidth: 1200, sourceHeight: 960,
      sourceBounds: { x: 20, y: 30, width: 80, height: 90 },
    };
  } });
  await setup.controller.prepare(setup.options());
  setup.begin(); setup.controller.end(); await microtasks();
  expect(setup.begin({ x: 200, y: 200 })).toBe(true);
  setup.controller.move([{ x: 230, y: 220 }]); setup.controller.end(); paintFrame();
  expect(setup.controller.state().queuedStrokes).toBe(2);
  finish.resolve({ rasterId: 'first', sourceWidth: 1200, sourceHeight: 960,
    sourceBounds: { x: 10, y: 10, width: 1, height: 1 } });
  await drain(setup.controller);
  expect(setup.calls.filter((call) => call.method === 'beginStroke').map((call) => call.args.layer.rasterId))
    .toEqual(['original', 'first']);
  expect(setup.getDoc().layers[0]).toMatchObject({ rasterId: 'second',
    sourceBounds: { x: 20, y: 30, width: 80, height: 90 } });
  expect(setup.onCommit).toHaveBeenCalledTimes(2);
  const chunk = setup.calls.find((call) => call.method === 'strokePoints');
  expect(chunk.args.points).toBeInstanceOf(Float64Array);
  expect([...chunk.args.points]).toEqual([230, 220]);
  expect(chunk.transfer).toEqual([chunk.args.points.buffer]);
  setup.controller.dispose();
});

test('eraser edits only the active preview with layer opacity applied once during compositing', async () => {
  const setup = fixture();
  await setup.controller.prepare(setup.options());
  setup.begin({ x: 100, y: 100 }, true); paintFrame();
  const editable = [...contexts.keys()].find((canvas) => canvas !== setup.canvas);
  expect(contexts.get(editable).operations).toContainEqual(['stroke', 1, 'destination-out']);
  expect(contexts.get(editable).operations).toContainEqual(['rect', 0, 0, 600, 480]);
  expect(contexts.get(editable).operations).toContainEqual(['rect', 0, 0, 1200, 960]);
  const draws = contexts.get(setup.canvas).operations.filter(([type]) => type === 'drawImage').slice(-3);
  expect(draws.map((entry) => entry[1])).toEqual([1, 0.5, 1]);
  expect(draws[0][2]).toBe(setup.bitmapSets[0][0]);
  expect(draws[2][2]).toBe(setup.bitmapSets[0][2]);
  setup.controller.end(); await drain(setup.controller); setup.controller.dispose();
});

test('a preparation requested during drawing waits until all optimistic pixels are acknowledged', async () => {
  const nativeBegin = deferred();
  const setup = fixture({ beginStroke: () => nativeBegin.promise });
  await setup.controller.prepare(setup.options());
  setup.begin(); paintFrame();
  await setup.controller.prepare({ ...setup.options(), key: 'new-view', view: [2, 0, 0, 2, 0, 0] });
  expect(setup.calls.filter((call) => call.method === 'prepareDrawing')).toHaveLength(1);
  expect(setup.bitmapSets[0][0].close).not.toHaveBeenCalled();
  setup.controller.end(); nativeBegin.resolve({}); await drain(setup.controller);
  const prepares = setup.calls.filter((call) => call.method === 'prepareDrawing');
  expect(prepares).toHaveLength(2);
  expect(prepares[1].args.doc.layers[0].rasterId).toBe('stroke-1');
  expect(setup.bitmapSets[0][0].close).toHaveBeenCalledTimes(1);
  setup.controller.dispose();
});

test('input can be buffered during initial preparation and reset closes obsolete bitmaps', async () => {
  const preparation = deferred();
  const setup = fixture({ prepareDrawing: () => preparation.promise });
  const ready = setup.controller.prepare(setup.options());
  expect(setup.begin()).toBe(true);
  setup.controller.move([{ x: 150, y: 120 }]); setup.controller.end();
  expect(setup.calls.some((call) => call.method === 'beginStroke')).toBe(false);
  setup.controller.reset();
  const bitmaps = Array.from({ length: 3 }, () => ({ close: jest.fn() }));
  preparation.resolve({ bitmaps }); await ready; await microtasks();
  bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  expect(setup.onCommit).not.toHaveBeenCalled();
  expect(setup.controller.state()).toMatchObject({ pending: false, preparing: false, journalBytes: 0, previewBytes: 0 });
});

test('a native failure reverts the dependent queue and rejects a waiting document operation', async () => {
  const finish = deferred();
  const setup = fixture({ finishStroke: () => finish.promise });
  await setup.controller.prepare(setup.options());
  setup.begin(); setup.controller.end();
  setup.begin({ x: 200, y: 200 }); setup.controller.end();
  const waiting = setup.controller.flush();
  const failure = waiting.catch((error) => error);
  finish.reject(new Error('Disk full'));
  await drain(setup.controller);
  expect(await failure).toMatchObject({ message: 'Disk full' });
  expect(setup.onCommit).not.toHaveBeenCalled();
  expect(setup.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk full' }), 2);
  expect(setup.onInvalidate).toHaveBeenCalledTimes(1);
  expect(setup.getDoc().layers[0].rasterId).toBe('original');
  expect(setup.controller.ownsDisplay()).toBe(false);
  setup.controller.dispose();
});

test('buffer exhaustion explicitly pauses input without exceeding the coordinate budget', async () => {
  const nativeBegin = deferred();
  const setup = fixture({ beginStroke: () => nativeBegin.promise });
  await setup.controller.prepare(setup.options());
  setup.begin();
  function* points() { for (let x = 0; x < DRAWING_COORDINATE_LIMIT / 16; x += 1) yield { x, y: 10 }; }
  expect(setup.controller.move(points())).toBe(false);
  expect(setup.controller.state()).toMatchObject({ paused: true, drawing: true });
  expect(setup.controller.state().journalBytes).toBe(DRAWING_COORDINATE_LIMIT - DRAWING_CHUNK_LIMIT);
  expect(setup.begin()).toBe(false);
  expect(setup.controller.move([{ x: 0, y: 0 }])).toBe(false);
  setup.controller.end();
  expect(setup.controller.state().paused).toBe(true);
  setup.controller.reset(); nativeBegin.resolve({}); await microtasks();
  expect(setup.controller.state().journalBytes).toBe(0);
});

test('the stroke-header limit requires actual pointer release even if a flush drains the queue', async () => {
  const nativeBegin = deferred();
  const setup = fixture({ beginStroke: () => nativeBegin.promise });
  await setup.controller.prepare(setup.options());
  for (let index = 0; index < DRAWING_STROKE_LIMIT; index += 1) {
    expect(setup.begin()).toBe(true); setup.controller.end();
  }
  expect(setup.begin()).toBe(false);
  const flushing = setup.controller.flush();
  nativeBegin.resolve({});
  for (let index = 0; index < 1000 && setup.controller.state().pending; index += 1) {
    paintFrame(); await microtasks();
  }
  await flushing;
  expect(setup.onCommit).toHaveBeenCalledTimes(DRAWING_STROKE_LIMIT);
  expect(setup.controller.state().paused).toBe(true);
  expect(setup.begin()).toBe(false);
  setup.controller.end();
  expect(setup.controller.state().paused).toBe(false);
  expect(setup.begin()).toBe(true);
  setup.controller.reset();
});

test('large viewports keep preview allocation bounded and release all owned surfaces', async () => {
  const setup = fixture();
  setup.canvas.width = 7680; setup.canvas.height = 4320;
  await setup.controller.prepare(setup.options());
  const args = setup.calls[0].args;
  expect(args.width * args.height).toBeLessThanOrEqual(DRAWING_PLANE_PIXELS);
  expect(setup.controller.state().previewBytes).toBeLessThanOrEqual(18 * 1024 * 1024);
  expect(args.view[0]).toBeCloseTo(args.width / 7680);
  const editable = [...contexts.keys()].find((canvas) => canvas !== setup.canvas);
  setup.controller.releasePreview();
  setup.bitmapSets[0].forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  expect(editable.width).toBe(1); expect(editable.height).toBe(1);
  expect(setup.controller.state().previewBytes).toBe(0);
});

test('preparation sizes the display canvas and coalesces obsolete view requests', async () => {
  const first = deferred(); let callCount = 0;
  const obsolete = Array.from({ length: 3 }, () => ({ close: jest.fn() }));
  const latest = Array.from({ length: 3 }, () => ({ close: jest.fn() }));
  const setup = fixture({ prepareDrawing: () => ++callCount === 1 ? first.promise : { bitmaps: latest } });
  setup.controller.prepare(setup.options());
  setup.controller.prepare({ ...setup.options(), key: 'middle', width: 700, height: 500 });
  setup.controller.prepare({ ...setup.options(), key: 'latest', width: 800, height: 600 });
  expect(callCount).toBe(1);
  first.resolve({ bitmaps: obsolete }); await microtasks();
  expect(callCount).toBe(2);
  expect(setup.canvas.width).toBe(800); expect(setup.canvas.height).toBe(600);
  obsolete.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  setup.controller.dispose();
});

test('rapid idle opacity changes prepare only the latest metadata and composite its alpha once', async () => {
  const first = deferred(); const second = deferred(); let callCount = 0;
  const obsolete = Array.from({ length: 3 }, () => ({ close: jest.fn() }));
  const latest = Array.from({ length: 3 }, () => ({ close: jest.fn() }));
  const setup = fixture({ prepareDrawing: () => ++callCount === 1 ? first.promise : second.promise });
  const opacityOptions = (opacity) => {
    setup.setDoc({ ...setup.getDoc(), layers: setup.getDoc().layers.map(layer => ({ ...layer, opacity })) });
    return { ...setup.options(), key: `opacity-${opacity}` };
  };
  setup.controller.prepare(opacityOptions(100));
  for (let opacity = 99; opacity >= 25; opacity -= 1) setup.controller.prepare(opacityOptions(opacity));
  expect(setup.controller.state()).toMatchObject({ pending: false, drawing: false, preparing: true });
  expect(callCount).toBe(1);

  first.resolve({ bitmaps: obsolete }); await microtasks();
  expect(callCount).toBe(2);
  expect(setup.calls[1].args.doc.layers[0].opacity).toBe(25);
  obsolete.forEach(bitmap => expect(bitmap.close).toHaveBeenCalledTimes(1));
  expect(contexts.has(setup.canvas)).toBe(false);

  second.resolve({ bitmaps: latest }); await microtasks(); paintFrame();
  const draws = contexts.get(setup.canvas).operations.filter(([type]) => type === 'drawImage').slice(-3);
  expect(draws.map(entry => entry[1])).toEqual([1, 0.25, 1]);
  expect(setup.controller.state()).toMatchObject({ pending: false, preparing: false });
  expect(setup.onCommit).not.toHaveBeenCalled();
  expect(setup.onError).not.toHaveBeenCalled();
  setup.controller.dispose();
});

test('cold input buffers against the latest coalesced view and waits for its preparation', async () => {
  const first = deferred(); const second = deferred(); let callCount = 0;
  const obsolete = Array.from({ length: 3 }, () => ({ close: jest.fn() }));
  const latest = Array.from({ length: 3 }, () => ({ close: jest.fn() }));
  const setup = fixture({ prepareDrawing: () => ++callCount === 1 ? first.promise : second.promise });
  setup.controller.prepare(setup.options());
  setup.controller.prepare({ ...setup.options(), key: 'latest-view', view: [2, 0, 0, 2, 30, 40] });
  expect(setup.begin({ x: 50, y: 60 })).toBe(true);
  setup.controller.move([{ x: 70, y: 80 }]); setup.controller.end();
  expect(callCount).toBe(2);
  first.resolve({ bitmaps: obsolete }); await microtasks(); paintFrame();
  obsolete.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  expect(setup.calls.some((call) => call.method === 'beginStroke')).toBe(false);
  expect(contexts.has(setup.canvas)).toBe(false);
  second.resolve({ bitmaps: latest }); await drain(setup.controller);
  const editable = [...contexts.keys()].find((canvas) => canvas !== setup.canvas);
  expect(contexts.get(editable).operations).toContainEqual(['setTransform', 2, 0, 0, 2, 30, 40]);
  expect(contexts.get(editable).stroke).toHaveBeenCalledTimes(2);
  expect(setup.onCommit).toHaveBeenCalledTimes(1);
  setup.controller.dispose();
});

test('failed preview preparation reports once until its key changes or it is explicitly invalidated', async () => {
  const setup = fixture({ prepareDrawing: () => Promise.reject(new Error('Preview allocation failed')) });
  await setup.controller.prepare(setup.options());
  await setup.controller.prepare(setup.options());
  await setup.controller.flush();
  expect(setup.onError).toHaveBeenCalledTimes(1);
  expect(setup.calls.filter((call) => call.method === 'prepareDrawing')).toHaveLength(1);
  await setup.controller.prepare({ ...setup.options(), key: 'new-source' });
  expect(setup.onError).toHaveBeenCalledTimes(2);
  setup.controller.invalidate();
  await setup.controller.prepare({ ...setup.options(), key: 'new-source' });
  expect(setup.onError).toHaveBeenCalledTimes(3);
  setup.controller.dispose();
});

test('a canvas failure during a frame rejects flush and releases the optimistic preview', async () => {
  const nativeBegin = deferred();
  const setup = fixture({ beginStroke: () => nativeBegin.promise });
  await setup.controller.prepare(setup.options());
  setup.begin(); setup.controller.move([{ x: 150, y: 120 }]);
  const editable = [...contexts.keys()].find((canvas) => canvas !== setup.canvas);
  contexts.get(editable).stroke.mockImplementation(() => { throw new Error('Canvas context lost'); });
  const failure = setup.controller.flush().catch((error) => error);
  expect(() => paintFrame()).not.toThrow();
  expect(await failure).toMatchObject({ message: 'Canvas context lost' });
  expect(setup.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Canvas context lost' }), 1);
  expect(setup.controller.state()).toMatchObject({ pending: false, journalBytes: 0, previewBytes: 0 });
  setup.bitmapSets[0].forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  nativeBegin.resolve({}); await microtasks();
  expect(setup.onCommit).not.toHaveBeenCalled();
  setup.controller.dispose();
});

test('a finish descriptor returned after a canvas failure releases its unacknowledged raster', async () => {
  const finished = deferred();
  const setup = fixture({ finishStroke: () => finished.promise });
  await setup.controller.prepare(setup.options());
  setup.begin(); setup.controller.end(); await microtasks();
  expect(setup.calls.some((call) => call.method === 'finishStroke')).toBe(true);
  const editable = [...contexts.keys()].find((canvas) => canvas !== setup.canvas);
  contexts.get(editable).stroke.mockImplementation(() => { throw new Error('Canvas context lost'); });
  const failure = setup.controller.flush().catch((error) => error);
  paintFrame();
  expect(await failure).toMatchObject({ message: 'Canvas context lost' });
  finished.resolve({ rasterId: 'unacknowledged-finish', sourceWidth: 1200, sourceHeight: 960 });
  await microtasks();
  expect(setup.onCommit).not.toHaveBeenCalled();
  expect(setup.calls.find((call) => call.method === 'releasePending')?.args)
    .toEqual({ rasterIds: ['unacknowledged-finish'] });
  expect(setup.getDoc().layers[0].rasterId).toBe('original');
  setup.controller.dispose();
});

test('a failed display composite releases newly installed bitmaps and gates preparation retries', async () => {
  const setup = fixture();
  setup.canvas.getContext('2d').drawImage.mockImplementation(() => { throw new Error('Display context lost'); });
  await expect(setup.controller.prepare(setup.options())).resolves.toBe(false);
  expect(setup.controller.ownsDisplay()).toBe(false);
  expect(setup.controller.state().previewBytes).toBe(0);
  setup.bitmapSets[0].forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  await setup.controller.prepare(setup.options());
  expect(setup.onError).toHaveBeenCalledTimes(1);
  setup.controller.dispose();
});

test('continuous pointer samples do not cause a React state notification per point or frame', async () => {
  const nativeBegin = deferred();
  const setup = fixture({ beginStroke: () => nativeBegin.promise });
  await setup.controller.prepare(setup.options());
  setup.begin();
  const count = setup.onStateChange.mock.calls.length;
  for (let x = 0; x < 20; x += 1) {
    setup.controller.move([{ x, y: 10 }]); paintFrame();
  }
  expect(setup.onStateChange).toHaveBeenCalledTimes(count);
  nativeBegin.resolve({}); setup.controller.end(); await drain(setup.controller);
  setup.controller.dispose();
});
