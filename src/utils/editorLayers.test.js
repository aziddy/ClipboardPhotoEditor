import {
  HISTORY_LIMIT,
  MAX_DIMENSION,
  applyLayerTransform,
  beginLayerStroke,
  cloneLayer,
  continueLayerStroke,
  createEmptyDocument,
  createImageLayer,
  createLayer,
  cropDocument,
  editorReducer,
  finishLayerStroke,
  getLayerBounds,
  getLayerDocumentBounds,
  getLayerGroupBounds,
  invertTransform,
  makeCompositeCanvas,
  renderDocument,
  resizeDocument,
  transformPoint,
  translateLayer,
} from './editorLayers';

// These tests exercise state/geometry with a canvas double. Actual resampling,
// clipping, and brush pixels also need verification in a browser's Canvas 2D.
let contexts;
let canvasCount;

beforeEach(() => {
  contexts = new WeakMap();
  canvasCount = 0;
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
    if (!contexts.has(this)) {
      canvasCount += 1;
      const ctx = {
        marks: [],
        save: jest.fn(),
        restore: jest.fn(),
        transform: jest.fn(),
        setTransform: jest.fn(),
        scale: jest.fn(),
        translate: jest.fn(),
        beginPath: jest.fn(),
        closePath: jest.fn(),
        moveTo: jest.fn(),
        lineTo: jest.fn(),
        rect: jest.fn(),
        clip: jest.fn(),
      };
      ctx.drawImage = jest.fn((source) => {
        ctx.marks.push(...(contexts.has(source) ? contexts.get(source).marks : ['image']));
      });
      ctx.fillRect = jest.fn(() => ctx.marks.push('fill'));
      ctx.clearRect = jest.fn(() => { ctx.marks = []; });
      ctx.stroke = jest.fn(() => ctx.marks.push(ctx.globalCompositeOperation));
      ctx.getImageData = jest.fn((x, y, width, height) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(ctx.marks.length ? 255 : 0),
      }));
      contexts.set(this, ctx);
    }
    return contexts.get(this);
  });
});

afterEach(() => jest.restoreAllMocks());

const image = (naturalWidth, naturalHeight) => ({ naturalWidth, naturalHeight });

const makeDocument = () => {
  const background = createImageLayer(image(600, 480), createEmptyDocument(), 1);
  return { width: 600, height: 480, layers: [background], activeLayerId: background.id };
};

const addLargeImage = (doc) => {
  const layer = createImageLayer(image(2400, 1920), doc, 2);
  return { ...doc, layers: [...doc.layers, layer], activeLayerId: layer.id };
};

const expectMatrixCloseTo = (actual, expected) => {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9));
};

test('fits a larger image using placement while retaining every native pixel', () => {
  const doc = makeDocument();
  const layer = createImageLayer(image(2400, 1920), doc, 2);

  expect([layer.canvas.width, layer.canvas.height]).toEqual([2400, 1920]);
  expect(layer.transform).toEqual([0.25, 0, 0, 0.25, 0, 0]);
  expect(getLayerDocumentBounds(layer)).toEqual({ x: 0, y: 0, width: 600, height: 480 });
  expect([doc.width, doc.height, doc.layers.length]).toEqual([600, 480, 1]);
});

test('centers smaller and differently shaped images without enlarging them', () => {
  const doc = makeDocument();
  expect(createImageLayer(image(300, 100), doc, 2).transform).toEqual([1, 0, 0, 1, 150, 190]);
  expect(createImageLayer(image(2400, 1200), doc, 2).transform).toEqual([0.25, 0, 0, 0.25, 0, 90]);
  const first = createImageLayer(image(1600, 900), createEmptyDocument(), 1);
  expect(first.transform).toEqual([1, 0, 0, 1, 0, 0]);
  expect(first.name).toBe('Background');
});

test.each([[0, 10], [10, 0], [NaN, 10], [MAX_DIMENSION + 1, 10], [10, MAX_DIMENSION + 1]])(
  'rejects unsupported %s × %s imports before allocating or clipping a bitmap',
  (width, height) => {
    expect(() => createImageLayer(image(width, height), createEmptyDocument(), 1)).toThrow();
    expect(canvasCount).toBe(0);
  }
);

test('repeated scaling and rotation retain the same source and recover the original placement', () => {
  const original = createImageLayer(image(2400, 1920), makeDocument(), 2);
  const allocated = canvasCount;
  let layer = original;
  for (let index = 0; index < 5; index += 1) {
    layer = applyLayerTransform(layer, { scaleX: 50, scaleY: 50 });
    layer = applyLayerTransform(layer, { scaleX: 200, scaleY: 200 });
    layer = applyLayerTransform(layer, { rotationDeg: 37 });
    layer = applyLayerTransform(layer, { rotationDeg: -37 });
  }
  expect(layer.canvas).toBe(original.canvas);
  expectMatrixCloseTo(layer.transform, original.transform);
  expect(canvasCount).toBe(allocated);
  // All five transform cycles reuse the one source bounds scan.
  expect(original.canvas.getContext('2d').getImageData).toHaveBeenCalledTimes(Math.ceil(1920 / 256));
});

test('selection bounds include placement, transparent margins, and group translation', () => {
  const layer = createImageLayer(image(80, 40), { ...makeDocument(), width: 40, height: 20 }, 2);
  layer.canvas.getContext('2d').getImageData.mockImplementation((x, y, width, height) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 10; row < 30; row += 1) {
      for (let column = 20; column < 40; column += 1) {
        data[(row * width + column) * 4 + 3] = 255;
      }
    }
    return { data };
  });
  expect(getLayerDocumentBounds(layer)).toEqual({ x: 10, y: 5, width: 10, height: 10 });
  const moved = translateLayer(layer, 30, -10);
  expect(getLayerGroupBounds([layer, moved])).toEqual({ x: 10, y: -5, width: 40, height: 20 });
  expect(moved.canvas).toBe(layer.canvas);
});

test.each([false, true])('maps a document-sized brush into a rotated, stretched bitmap (erase=%s)', (erase) => {
  const original = createImageLayer(image(2400, 1920), makeDocument(), 2);
  const transformed = applyLayerTransform(original, { scaleX: 200, scaleY: 50, rotationDeg: 90, dx: 40, dy: 20 });
  const point = { x: 340, y: 260 };
  const stroke = beginLayerStroke(transformed, point, { size: 8, color: '#ff0000', erase });
  const nativePoint = transformPoint(stroke.ctx.transform.mock.calls[0], point);

  expect(nativePoint.x).toBeCloseTo(1200);
  expect(nativePoint.y).toBeCloseTo(960);
  expect(stroke.ctx.lineWidth).toBe(8);
  expect(stroke.ctx.globalCompositeOperation).toBe(erase ? 'destination-out' : 'source-over');
  expect([stroke.layer.canvas.width, stroke.layer.canvas.height]).toEqual([2400, 1920]);
  expect(stroke.layer.canvas).not.toBe(original.canvas);
  expect(original.canvas.getContext('2d').marks).toEqual(['image']);

  continueLayerStroke(stroke, { x: 350, y: 260 });
  finishLayerStroke(stroke);
  const enlarged = applyLayerTransform(stroke.layer, { scaleX: 200, scaleY: 200 });
  expect(enlarged.canvas).toBe(stroke.layer.canvas);
  expect(enlarged.canvas.getContext('2d').marks).toEqual([
    'image', erase ? 'destination-out' : 'source-over', erase ? 'destination-out' : 'source-over',
  ]);
});

test('a blank layer can be painted and its cached empty bounds are refreshed', () => {
  const layer = createLayer({ name: 'Drawing', width: 40, height: 30 });
  expect(getLayerBounds(layer.canvas)).toBeNull();
  const stroke = beginLayerStroke(layer, { x: 10, y: 10 }, { size: 4, color: '#000000' });
  getLayerBounds(stroke.layer.canvas);
  const ctx = stroke.layer.canvas.getContext('2d');
  const scansBefore = ctx.getImageData.mock.calls.length;
  continueLayerStroke(stroke, { x: 15, y: 15 });
  finishLayerStroke(stroke);
  expect(getLayerBounds(stroke.layer.canvas)).not.toBeNull();
  expect(ctx.getImageData.mock.calls.length).toBe(scansBefore + 1);
  expect(getLayerBounds(layer.canvas)).toBeNull();
});

test('cropping masks native pixels and moves the retained content into the new document', () => {
  const doc = addLargeImage(makeDocument());
  const original = doc.layers[1];
  const cropped = cropDocument(doc, { x: 100, y: 80, width: 300, height: 240 });
  const layer = cropped.layers[1];
  const ctx = layer.canvas.getContext('2d');

  expect([cropped.width, cropped.height]).toEqual([300, 240]);
  expect([layer.canvas.width, layer.canvas.height]).toEqual([2400, 1920]);
  expect(layer.canvas).not.toBe(original.canvas);
  expect(layer.transform).toEqual([0.25, 0, 0, 0.25, -100, -80]);
  const sourceCropOrigin = transformPoint(ctx.transform.mock.calls[0], { x: 100, y: 80 });
  expect(sourceCropOrigin).toEqual({ x: 400, y: 320 });
  expect(ctx.rect).toHaveBeenCalledWith(100, 80, 300, 240);
  expect(ctx.clip).toHaveBeenCalledTimes(1);
  expect(original.canvas.getContext('2d').marks).toEqual(['image']);
});

test('document resize preserves pixels and exactly reverses placement, including off-canvas content', () => {
  let doc = addLargeImage(makeDocument());
  doc.layers[1] = applyLayerTransform(doc.layers[1], { scaleX: 200, scaleY: 150, rotationDeg: 27, dx: -80 });
  const smaller = resizeDocument(doc, 150, 160);
  const restored = resizeDocument(smaller, 600, 480);
  restored.layers.forEach((layer, index) => {
    expect(layer.canvas).toBe(doc.layers[index].canvas);
    expectMatrixCloseTo(layer.transform, doc.layers[index].transform);
  });
});

test('composites and resize previews draw the native bitmap at document dimensions', () => {
  const doc = addLargeImage(makeDocument());
  doc.layers[0] = { ...doc.layers[0], visible: false };
  const composite = makeCompositeCanvas(doc);
  const ctx = composite.getContext('2d');
  expect([composite.width, composite.height]).toEqual([600, 480]);
  expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  expect(ctx.drawImage).toHaveBeenLastCalledWith(doc.layers[1].canvas, 0, 0);
  expect(ctx.transform).toHaveBeenLastCalledWith(0.25, 0, 0, 0.25, 0, 0);

  renderDocument(ctx, doc, { resizeDimensions: { width: 300, height: 240 } });
  expect(ctx.scale).toHaveBeenLastCalledWith(0.5, 0.5);
  expect(ctx.drawImage).toHaveBeenLastCalledWith(doc.layers[1].canvas, 0, 0);
});

test('undo, redo, and duplicate layers retain independent pixel edits and transform snapshots', () => {
  const doc = addLargeImage(makeDocument());
  const original = doc.layers[1];
  const duplicate = { ...cloneLayer(original), id: 'duplicate' };
  let state = editorReducer({ history: [], historyIndex: -1 }, { type: 'commit', doc });
  const stroke = beginLayerStroke(duplicate, { x: 50, y: 50 }, { size: 8, color: '#ff0000', erase: true });
  finishLayerStroke(stroke);
  const edited = applyLayerTransform(stroke.layer, { scaleX: 200, scaleY: 200 });
  state = editorReducer(state, { type: 'commit', doc: { ...doc, layers: [...doc.layers, edited] } });
  expect(state.doc.layers[0].canvas).toBe(doc.layers[0].canvas);
  expect(state.history[0].layers[1].canvas).toBe(original.canvas);
  expect(original.canvas.getContext('2d').marks).toEqual(['image']);

  state = editorReducer(state, { type: 'undo' });
  expect(state.doc.layers).toHaveLength(2);
  expect(state.doc.layers[1].canvas).toBe(original.canvas);
  state = editorReducer(state, { type: 'redo' });
  expect(state.doc.layers[2].canvas).toBe(edited.canvas);
  expect(state.doc.layers[2].canvas.getContext('2d').marks).toContain('destination-out');
  expect(state.doc.layers[2].transform).toEqual(edited.transform);
  state.doc.layers[2].transform[4] = 999;
  expect(state.history[1].layers[2].transform[4]).not.toBe(999);
});

test('history shares unchanged bitmaps, drops redo branches, caps entries, and resets', () => {
  let doc = makeDocument();
  const source = doc.layers[0].canvas;
  let state = { doc: createEmptyDocument(), history: [], historyIndex: -1 };
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
    doc = { ...doc, layers: [translateLayer(doc.layers[0], 1, 0)] };
    state = editorReducer(state, { type: 'commit', doc });
  }
  expect(state.history).toHaveLength(HISTORY_LIMIT);
  expect(state.history.every((entry) => entry.layers[0].canvas === source)).toBe(true);
  expect(canvasCount).toBe(1);
  state = editorReducer(state, { type: 'undo' });
  state = editorReducer(state, { type: 'commit', doc: state.doc });
  expect(editorReducer(state, { type: 'redo' })).toBe(state);
  expect(editorReducer(state, { type: 'reset' })).toEqual({
    doc: createEmptyDocument(), history: [], historyIndex: -1,
  });
});

test('inverse coordinates remain accurate after rotation combined with nonuniform document resizing', () => {
  let doc = addLargeImage(makeDocument());
  doc.layers[1] = applyLayerTransform(doc.layers[1], { scaleX: 175, scaleY: 80, rotationDeg: 42, dx: 100, dy: -70 });
  doc = resizeDocument(doc, 900, 320);
  const matrix = doc.layers[1].transform;
  const sourcePoint = { x: 1000, y: 500 };
  const roundTrip = transformPoint(invertTransform(matrix), transformPoint(matrix, sourcePoint));
  expect(roundTrip.x).toBeCloseTo(sourcePoint.x, 9);
  expect(roundTrip.y).toBeCloseTo(sourcePoint.y, 9);
});
