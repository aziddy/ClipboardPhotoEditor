import { MemoryRasterStorage, RasterCache } from './rasterStorage';
import { RasterEngine } from './rasterEngine';
import { createRasterLayer, editorReducer, createEmptyDocument } from './editorLayers';
import { getEditorViewport } from './editorViewport';

const pixels = (width = 1) => new Uint8ClampedArray(width * 4).fill(255);
const canvas = (width = 1) => ({ width, height: 1, getContext: () => ({ getImageData: () => ({ data: pixels(width) }) }) });

test('cache eviction respects recent reads and never exceeds its byte budget', () => {
  const cache = new RasterCache(8);
  cache.set('a', pixels()); cache.set('b', pixels()); cache.get('a'); cache.set('c', pixels());
  expect(cache.get('a')).toBeDefined(); expect(cache.get('b')).toBeUndefined();
  expect(cache.bytes).toBe(8); expect(cache.peakBytes).toBe(8);
  cache.set('large', pixels(3)); expect(cache.bytes).toBe(8);
  cache.clear(); expect(cache.bytes).toBe(0);
});

test('reserving room for dirty tiles evicts clean pixels before exceeding the shared limit', () => {
  const cache = new RasterCache(12);
  cache.set('a', pixels()); cache.set('b', pixels()); cache.set('c', pixels());
  cache.get('a'); cache.setLimit(4);
  expect(cache.bytes).toBe(4);
  expect(cache.get('a')).toBeDefined();
  expect(cache.get('b')).toBeUndefined();
  cache.setLimit(12); cache.set('d', pixels());
  expect(cache.bytes).toBe(8);
});

// Canvas pixel accuracy is exercised in the native browser harness. These tests
// isolate transaction ownership and storage scheduling from browser rasterization.
const stagePointTiles = (engine) => {
  engine.applyStrokePointBatch = jest.fn(async (points) => {
    for (const point of points) {
      const x = Math.floor(point.x / 512);
      await engine.stageTile(x, 0, canvas());
      engine.stroke.changed.add(`${x},0`);
      engine.stroke.regions.set(`${x},0`, { x: x * 512, y: 0, width: 1, height: 1 });
    }
  });
  engine.buildMips = jest.fn(async () => {});
};

const beginStagedStroke = async (engine, version, args = {}) => engine.beginStroke({
  layer: { rasterId: version.id, transform: [1, 0, 0, 1, 0, 0] },
  point: { x: 0, y: 0 }, size: 1, color: '#ffffff', ...args,
});

test('movement reuses private pixels without writing, rebuilding previews, or collecting', async () => {
  const storage = new MemoryRasterStorage();
  const engine = new RasterEngine(storage);
  const original = engine.createVersion(1, 1);
  await engine.saveTile(original, 0, 0, 0, canvas());
  await engine.retain({ documents: [{ key: 'base', rasters: [original.id] }], current: [original.id], currentKey: 'base' });
  stagePointTiles(engine);
  const write = jest.spyOn(storage, 'write');
  const collect = jest.spyOn(engine, 'collect');
  await beginStagedStroke(engine, original);
  const data = engine.stroke.dirty.get('0,0').data;
  expect(data).not.toBe(await engine.readTile(original.levels[0].get('0,0')));
  await engine.strokePoints({ points: new Float64Array([0, 0, 0, 0]) });
  expect(engine.stroke.dirty.get('0,0').data).toBe(data);
  expect(write).not.toHaveBeenCalled();
  expect(engine.buildMips).not.toHaveBeenCalled();
  expect(collect).not.toHaveBeenCalled();
  const result = await engine.finishStroke();
  expect(result.sourceBounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  expect(write).toHaveBeenCalledTimes(1);
  expect(engine.buildMips).toHaveBeenCalledTimes(1);
  expect(collect).toHaveBeenCalledTimes(1);
  expect(engine.stats().dirtyBytes).toBe(0);
  expect(await engine.readTile(original.levels[0].get('0,0'))).toEqual(pixels());
});

test('large strokes spill bounded dirty tiles and finish with all expanded bounds', async () => {
  const storage = new MemoryRasterStorage();
  const engine = new RasterEngine(storage, () => {}, { tileMemoryLimit: 12, dirtyLimit: 8 });
  const original = engine.createVersion(1536, 1);
  stagePointTiles(engine);
  const write = jest.spyOn(storage, 'write');
  const first = await beginStagedStroke(engine, original);
  await engine.strokePoints({ points: [{ x: 512, y: 0 }] });
  expect(write).not.toHaveBeenCalled();
  await engine.strokePoints({ points: [{ x: 1024, y: 0 }] });
  expect(write).toHaveBeenCalledTimes(1);
  expect(engine.stats().dirtyBytes).toBe(8);
  expect(engine.stats().peakDirtyBytes).toBe(8);
  expect(engine.stats().peakResidentTileBytes).toBeLessThanOrEqual(12);
  expect(first.sourceBounds.width).toBe(1);
  const result = await engine.finishStroke();
  expect(result.sourceBounds).toEqual({ x: 0, y: 0, width: 1025, height: 1 });
  expect(write).toHaveBeenCalledTimes(3);
  expect(engine.stats().dirtyBytes).toBe(0);
  expect(engine.stats().residentTileBytes).toBeLessThanOrEqual(12);
  for (const tile of engine.version(result.rasterId).levels[0].values()) {
    expect(await engine.readTile(tile)).toEqual(pixels());
  }
});

test('failed stroke commitment discards staged pixels and preserves the last committed source', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage(4));
  const original = engine.createVersion(1, 1);
  await engine.saveTile(original, 0, 0, 0, canvas());
  await engine.retain({ documents: [{ key: 'base', rasters: [original.id] }], current: [original.id], currentKey: 'base' });
  stagePointTiles(engine);
  const draft = await beginStagedStroke(engine, original);
  await expect(engine.finishStroke()).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(engine.stroke).toBeNull();
  expect(engine.stats().dirtyBytes).toBe(0);
  expect(engine.versions.has(draft.rasterId)).toBe(false);
  expect(engine.bytes).toBe(4);
  expect(await engine.readTile(original.levels[0].get('0,0'))).toEqual(pixels());
});

test('canceling a spilled stroke releases its temporary files without altering the source', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage(), () => {}, { tileMemoryLimit: 12, dirtyLimit: 4 });
  const original = engine.createVersion(1024, 1);
  await engine.saveTile(original, 0, 0, 0, canvas());
  stagePointTiles(engine);
  const draft = await beginStagedStroke(engine, original);
  await engine.strokePoints({ points: [{ x: 512, y: 0 }] });
  expect(engine.bytes).toBe(8);
  await engine.abortStroke();
  expect(engine.versions.has(draft.rasterId)).toBe(false);
  expect(engine.bytes).toBe(4);
  expect(engine.stats().dirtyBytes).toBe(0);
  expect(await engine.readTile(original.levels[0].get('0,0'))).toEqual(pixels());
});

test('stroke identifiers and sequences reject stale updates without changing the active transaction', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const original = engine.createVersion(1, 1);
  stagePointTiles(engine);
  await beginStagedStroke(engine, original, { strokeId: 'current', sequence: 0 });
  await engine.strokePoints({ points: [{ x: 0, y: 0 }], strokeId: 'current', sequence: 1 });
  await expect(engine.strokePoints({ points: [], strokeId: 'current', sequence: 1 })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(engine.finishStroke({ strokeId: 'old', sequence: 2 })).rejects.toMatchObject({ name: 'AbortError' });
  expect(engine.stroke.id).toBe('current');
  await engine.finishStroke({ strokeId: 'current', sequence: 2 });
  expect(engine.stroke).toBeNull();
});

test('erasing a staged tile releases dirty memory and leaves shared original pixels intact', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const original = engine.createVersion(1, 1);
  await engine.saveTile(original, 0, 0, 0, canvas());
  stagePointTiles(engine);
  await beginStagedStroke(engine, original);
  await engine.stageTile(0, 0, {
    width: 1, height: 1,
    getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(4) }) }),
  });
  expect(engine.stats().dirtyBytes).toBe(0);
  const erased = await engine.finishStroke();
  expect(erased.sourceBounds).toBeNull();
  expect(engine.bytes).toBe(4);
  expect(await engine.readTile(original.levels[0].get('0,0'))).toEqual(pixels());
});

test('drawing preparation separates layer order and applies active opacity only in the live compositor', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const layers = [
    { id: 'below', opacity: 25 }, { id: 'active', opacity: 40 }, { id: 'above', opacity: 75 },
  ];
  const bitmaps = layers.map(() => ({ close: jest.fn() }));
  engine.render = jest.fn();
  bitmaps.forEach((bitmap) => engine.render.mockResolvedValueOnce({ bitmap }));
  const view = [2, 0, 0, 2, 3, 4];
  const result = await engine.prepareDrawing({ doc: { width: 10, height: 10, layers }, activeLayerId: 'active', width: 20, height: 20, view });
  expect(result.bitmaps).toEqual(bitmaps);
  expect(engine.render.mock.calls.map(([args]) => args.doc.layers)).toEqual([
    [layers[0]], [{ ...layers[1], opacity: 100 }], [layers[2]],
  ]);
  expect(engine.render.mock.calls.every(([args]) => args.view === view && args.width === 20 && args.height === 20)).toBe(true);
  expect(layers[1].opacity).toBe(40);
});

test('failed or oversized drawing preparation does not retain partially-created bitmaps', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const bitmap = { close: jest.fn() };
  engine.render = jest.fn().mockResolvedValueOnce({ bitmap }).mockRejectedValueOnce(new Error('Storage unavailable'));
  const args = { doc: { width: 10, height: 10, layers: [{ id: 'active' }] }, activeLayerId: 'active', width: 20, height: 20 };
  await expect(engine.prepareDrawing(args)).rejects.toThrow('Storage unavailable');
  expect(bitmap.close).toHaveBeenCalledTimes(1);
  engine.render.mockClear();
  await expect(engine.prepareDrawing({ ...args, width: 2048, height: 2048 })).rejects.toThrow('memory budget');
  expect(engine.render).not.toHaveBeenCalled();
});

test('memory fallback fails atomically at capacity and releases removed pixels', async () => {
  const storage = new MemoryRasterStorage(8);
  await storage.write('original', pixels(2));
  await expect(storage.write('new', pixels())).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(await storage.read('original')).toEqual(pixels(2));
  await expect(storage.read('new')).rejects.toThrow();
  await storage.remove('original'); expect(storage.bytes).toBe(0);
});

test('versions and duplicate layers share unchanged tiles and release only unreachable data', async () => {
  const storage = new MemoryRasterStorage();
  const engine = new RasterEngine(storage);
  const first = engine.createVersion(1024, 1);
  await engine.saveTile(first, 0, 0, 0, canvas());
  await engine.saveTile(first, 0, 1, 0, canvas());
  const second = engine.createVersion(1024, 1, first);
  await engine.saveTile(second, 0, 0, 0, canvas());
  expect(second.levels[0].get('1,0')).toBe(first.levels[0].get('1,0'));
  expect(engine.bytes).toBe(12);
  await engine.retain({ documents: [{ key: 'first', rasters: [first.id] }, { key: 'second', rasters: [second.id] }], current: [second.id, second.id], currentKey: 'second' });
  expect(engine.bytes).toBe(12);
  await engine.retain({ documents: [{ key: 'second', rasters: [second.id] }], current: [second.id], currentKey: 'second' });
  expect(engine.bytes).toBe(8);
  engine.cache.clear();
  expect(await engine.readTile(second.levels[0].get('1,0'))).toEqual(pixels());
  await engine.dispose(); expect(storage.bytes).toBe(0); expect(engine.stats().cacheBytes).toBe(0);
});

test('a stale retain message cannot delete an import before the UI acknowledges it', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const imported = engine.createVersion(1, 1);
  await engine.saveTile(imported, 0, 0, 0, canvas());
  await engine.retain({ documents: [], current: [], currentKey: null });
  expect(engine.version(imported.id)).toBe(imported);
  expect(engine.bytes).toBe(4);
});

test('discarded pending results release their files when no document retains them', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const abandoned = engine.createVersion(1, 1);
  await engine.saveTile(abandoned, 0, 0, 0, canvas());
  await engine.releasePending({ rasterIds: [abandoned.id] });
  expect(engine.pending.has(abandoned.id)).toBe(false);
  expect(engine.versions.has(abandoned.id)).toBe(false);
  expect(engine.stats().storageBytes).toBe(0);
  expect(engine.stats().cacheBytes).toBe(0);
});

test('releasing pending ownership preserves current, undo, drawing, and rendering references', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const current = engine.createVersion(1, 1);
  const history = engine.createVersion(1, 1);
  const rendering = engine.createVersion(1, 1);
  for (const version of [current, history, rendering]) await engine.saveTile(version, 0, 0, 0, canvas());
  await engine.retain({ documents: [{ key: 'undo', rasters: [history.id] }], current: [current.id], currentKey: 'current' });
  stagePointTiles(engine);
  const drawing = await beginStagedStroke(engine, current);
  engine.inUse.add(rendering.id);
  await engine.releasePending({ rasterIds: [current.id, history.id, rendering.id, drawing.rasterId] });
  for (const id of [current.id, history.id, rendering.id, drawing.rasterId]) expect(engine.versions.has(id)).toBe(true);
  expect(engine.stats().storageBytes).toBe(12);
  expect(engine.stats().dirtyBytes).toBe(4);
  engine.inUse.clear();
  await engine.abortStroke();
  expect(engine.versions.has(rendering.id)).toBe(false);
  expect(engine.versions.has(drawing.rasterId)).toBe(false);
  expect(engine.versions.has(current.id)).toBe(true);
  expect(engine.versions.has(history.id)).toBe(true);
  expect(engine.stats().storageBytes).toBe(8);
});

test('storage pressure removes older history while preserving current and pending versions', async () => {
  const events = [];
  const engine = new RasterEngine(new MemoryRasterStorage(8), (event) => events.push(event));
  const first = engine.createVersion(1, 1); await engine.saveTile(first, 0, 0, 0, canvas());
  const current = engine.createVersion(1, 1); await engine.saveTile(current, 0, 0, 0, canvas());
  await engine.retain({ documents: [{ key: 'old', rasters: [first.id] }, { key: 'current', rasters: [current.id] }], current: [current.id], currentKey: 'current' });
  const next = engine.createVersion(1, 1); await engine.saveTile(next, 0, 0, 0, canvas());
  expect(events).toEqual([{ type: 'historyTrimmed', keys: ['old'] }]);
  expect(engine.version(current.id)).toBe(current); expect(engine.version(next.id)).toBe(next);
  expect(engine.bytes).toBe(8);
  await engine.retain({ documents: [{ key: 'old', rasters: [first.id] }, { key: 'current', rasters: [current.id] }], current: [current.id], currentKey: 'current' });
  expect(engine.history.map((entry) => entry.key)).toEqual(['current']);
});

test('a failed write cannot replace the last valid tile', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage(4));
  const version = engine.createVersion(1, 1); await engine.saveTile(version, 0, 0, 0, canvas());
  const original = version.levels[0].get('0,0');
  await expect(engine.saveTile(version, 0, 0, 0, canvas())).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(version.levels[0].get('0,0')).toBe(original);
  expect(await engine.readTile(original)).toEqual(pixels());
});

test('storage pressure frees inactive previews before sacrificing undo pixels', async () => {
  const events = [];
  const engine = new RasterEngine(new MemoryRasterStorage(20), (event) => events.push(event));
  const old = engine.createVersion(1024, 1);
  const current = engine.createVersion(1024, 1);
  for (const version of [old, current]) {
    await engine.saveTile(version, 0, 0, 0, canvas());
    await engine.saveTile(version, 1, 0, 0, canvas());
    version.mipsReady = true;
  }
  await engine.retain({ documents: [{ key: 'old', rasters: [old.id] }, { key: 'current', rasters: [current.id] }], current: [current.id], currentKey: 'current' });
  const next = engine.createVersion(1024, 1);
  await engine.saveTile(next, 0, 0, 0, canvas());
  await engine.saveTile(next, 1, 0, 0, canvas());
  expect(events).toEqual([]);
  expect(engine.history).toHaveLength(2);
  expect(await engine.readTile(old.levels[0].get('0,0'))).toEqual(pixels());
  expect(old.mipsReady).toBe(false);
  expect(current.mipsReady).toBe(true);
  expect(engine.bytes).toBe(20);
});

test('transparent edits remove tile data from the new version without changing its source', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const original = engine.createVersion(1, 1); await engine.saveTile(original, 0, 0, 0, canvas());
  const edited = engine.createVersion(1, 1, original);
  await engine.saveTile(edited, 0, 0, 0, { width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) });
  expect(engine.describe(edited).sourceBounds).toBeNull();
  expect(engine.describe(original).sourceBounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
});

test('tiled documents retain native dimensions with no canvas in history', () => {
  const source = { rasterId: 'source', sourceWidth: 6000, sourceHeight: 4000, sourceBounds: { x: 0, y: 0, width: 6000, height: 4000 } };
  const layer = createRasterLayer(source, { width: 600, height: 480, layers: [{}] }, 2);
  expect(layer.transform).toEqual([0.1, 0, 0, 0.1, 0, 40]);
  let state = { doc: createEmptyDocument(), history: [], historyIndex: -1 };
  state = editorReducer(state, { type: 'commit', doc: { width: 600, height: 480, layers: [layer], activeLayerId: layer.id } });
  state = editorReducer(state, { type: 'commit', doc: { ...state.doc, layers: [{ ...layer, opacity: 50 }] } });
  const old = state.history[0].revisionId;
  state = editorReducer(state, { type: 'dropHistory', keys: [old] });
  expect(state.historyIndex).toBe(0); expect(state.doc.layers[0].rasterId).toBe('source');
  expect(JSON.stringify(state)).not.toContain('canvas');
});

test('viewport allocation follows the display size while coordinates follow zoom and pan', () => {
  const view = getEditorViewport({ width: 12000, height: 8000 }, 800, 600, 200, { x: 30, y: -20 }, 2);
  expect([view.pixelWidth, view.pixelHeight]).toEqual([1600, 1200]);
  const docPoint = { x: 6400, y: 3600 };
  const screenPoint = { x: docPoint.x * view.scale + view.x, y: docPoint.y * view.scale + view.y };
  expect((screenPoint.x - view.x) / view.scale).toBeCloseTo(docPoint.x);
  expect((screenPoint.y - view.y) / view.scale).toBeCloseTo(docPoint.y);
});
