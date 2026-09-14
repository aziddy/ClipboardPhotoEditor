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
