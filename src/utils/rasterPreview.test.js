import { RasterEngine } from './rasterEngine';
import { MemoryRasterStorage } from './rasterStorage';

// Native browser checks own pixel comparisons. These small fake surfaces isolate
// preview ownership, invalidation, fallback, and the shared memory budget.
const identity = [1, 0, 0, 1, 0, 0];
const pixels = (width, height = 1) => new Uint8ClampedArray(width * height * 4).fill(255);
const makeCanvas = (width, height = 1) => {
  const context = {
    save: jest.fn(), restore: jest.fn(), beginPath: jest.fn(), rect: jest.fn(),
    clip: jest.fn(), setTransform: jest.fn(), resetTransform: jest.fn(),
    drawImage: jest.fn(), getImageData: () => ({ data: pixels(width, height) }),
  };
  return { width, height, getContext: () => context, addEventListener: jest.fn() };
};
const makeEngine = (options = {}) => {
  const engine = new RasterEngine(new MemoryRasterStorage(), () => {}, options);
  engine.readRegion = jest.fn(async (version, level, x, y, width, height) => makeCanvas(width, height));
  return engine;
};
const makeLayer = (version) => ({
  id: version.id, rasterId: version.id, visible: true, opacity: 100,
  sourceBounds: { x: 0, y: 0, width: version.width, height: version.height },
  transform: identity,
});
const tilePixels = (width = 1) => ({
  data: pixels(width), width, height: 1,
  bounds: { x: 0, y: 0, width, height: 1 },
});
const expectReleased = (canvas) => expect([canvas.width, canvas.height]).toEqual([1, 1]);
let previousOffscreenCanvas;

beforeEach(() => {
  previousOffscreenCanvas = global.OffscreenCanvas;
  global.OffscreenCanvas = jest.fn((width, height) => makeCanvas(width, height));
});

afterEach(() => {
  if (previousOffscreenCanvas === undefined) delete global.OffscreenCanvas;
  else global.OffscreenCanvas = previousOffscreenCanvas;
});

test('unchanged previews reuse their source across transforms and opacity changes', async () => {
  const engine = makeEngine();
  const version = engine.createVersion(8, 4);
  const layer = makeLayer(version);
  const ctx = makeCanvas(30, 20).getContext('2d');
  await engine.renderLayer(ctx, layer, identity, 30, 20, false);
  await engine.renderLayer(ctx, { ...layer, opacity: 45, transform: [1, 0, 0, 1, 2.5, 3] }, identity, 30, 20, false);
  expect(engine.readRegion).toHaveBeenCalledTimes(1);
  const preview = await engine.readRegion.mock.results[0].value;
  expect([preview.width, preview.height]).toEqual([8, 4]);
  for (const [patch] of ctx.drawImage.mock.calls) {
    expect(patch.getContext('2d').drawImage.mock.calls[0][0]).toBe(preview);
    expectReleased(patch);
  }
  expect(ctx.globalAlpha).toBe(0.45);
  expect(engine.stats()).toMatchObject({ previewCacheHits: 1, previewCacheMisses: 1, previewCacheBytes: 128 });
});

test('different versions and source levels keep independent previews', async () => {
  const engine = makeEngine();
  const first = engine.createVersion(1025, 3);
  const second = engine.createVersion(1025, 3, first);
  const original = await engine.previewSource(first, 0);
  const reduced = await engine.previewSource(first, 1);
  const duplicate = await engine.previewSource(second, 0);
  expect([reduced.width, reduced.height]).toEqual([513, 2]);
  expect(duplicate).not.toBe(original);
  expect(await engine.previewSource(first, 1)).toBe(reduced);
  expect(engine.readRegion).toHaveBeenCalledTimes(3);
});

test('lost graphics contexts rebuild their preview from stored source pixels', async () => {
  const engine = makeEngine();
  const version = engine.createVersion(4, 2);
  const lost = await engine.previewSource(version, 0);
  lost.getContext('2d').isContextLost = () => true;
  const rebuilt = await engine.previewSource(version, 0);
  expect(rebuilt).not.toBe(lost);
  expectReleased(lost);
  expect(engine.readRegion).toHaveBeenCalledTimes(2);
  expect(engine.stats().previewCacheBytes).toBe(32);
});

test('a context restored between renders cannot reuse its cleared preview', async () => {
  const engine = makeEngine();
  const version = engine.createVersion(4, 2);
  const cleared = await engine.previewSource(version, 0);
  cleared.getContext('2d').isContextLost = () => false;
  const listeners = Object.fromEntries(cleared.addEventListener.mock.calls);
  listeners.contextlost();
  listeners.contextrestored();
  expect(await engine.previewSource(version, 0)).not.toBe(cleared);
  expectReleased(cleared);
});

test('retained graphics replace raw cache entries for their level while stored pixels remain readable', async () => {
  const engine = makeEngine();
  const version = engine.createVersion(1024, 1);
  await engine.writeTile(version, 0, 0, 0, tilePixels());
  await engine.writeTile(version, 0, 1, 0, tilePixels());
  await engine.writeTile(version, 1, 0, 0, tilePixels());
  const fullResolutionTiles = [...version.levels[0].values()];
  const reducedTile = version.levels[1].get('0,0');
  const reducedData = engine.cache.get(reducedTile.id);
  await engine.previewSource(version, 0);
  fullResolutionTiles.forEach((tile) => expect(engine.cache.get(tile.id)).toBeUndefined());
  expect(engine.cache.get(reducedTile.id)).toBe(reducedData);
  const read = jest.spyOn(engine.storage, 'read');
  expect(await engine.readTile(fullResolutionTiles[0])).toEqual(pixels(1));
  expect(read).toHaveBeenCalledWith(fullResolutionTiles[0].id);
  expect(engine.storage.files.size).toBe(3);
});

test('writing a level releases its stale preview while preserving another level', async () => {
  const engine = makeEngine();
  const version = engine.createVersion(1024, 2);
  const original = await engine.previewSource(version, 0);
  const reduced = await engine.previewSource(version, 1);
  await engine.writeTile(version, 0, 0, 0, tilePixels());
  expectReleased(original);
  expect(await engine.previewSource(version, 1)).toBe(reduced);
  expect(await engine.previewSource(version, 0)).not.toBe(original);
  expect(engine.readRegion).toHaveBeenCalledTimes(3);
});

test('deleting transparent tile content invalidates its cached preview', async () => {
  const engine = makeEngine();
  const version = engine.createVersion(4, 2);
  await engine.writeTile(version, 0, 0, 0, tilePixels());
  const preview = await engine.previewSource(version, 0);
  await engine.writeTile(version, 0, 0, 0, { ...tilePixels(), bounds: null });
  expect(version.levels[0].size).toBe(0);
  expectReleased(preview);
  expect(engine.stats().previewCacheBytes).toBe(0);
  expect(await engine.previewSource(version, 0)).not.toBe(preview);
});

test('active stroke versions bypass previews and staging releases stale surfaces', async () => {
  const engine = makeEngine();
  const version = engine.createVersion(4, 2);
  const preview = await engine.previewSource(version, 0);
  engine.stroke = { version, dirty: new Map(), changed: new Set() };
  expect(await engine.previewSource(version, 0)).toBeNull();
  await engine.stageTile(0, 0, makeCanvas(2));
  expectReleased(preview);
  expect(await engine.previewSource(version, 0)).toBeNull();
  expect(engine.readRegion).toHaveBeenCalledTimes(1);
  expect(engine.stats().previewCacheBytes).toBe(0);
});

test('failed source construction returns its memory reservation', async () => {
  const engine = makeEngine({ tileMemoryLimit: 32, previewMemoryLimit: 16 });
  const version = engine.createVersion(4, 1);
  engine.cache.set('raw', pixels(8));
  engine.readRegion.mockImplementationOnce(async () => {
    expect(engine.stats().previewCacheBytes).toBe(16);
    expect(engine.cache.limit).toBe(16);
    expect(engine.stats().residentRasterBytes).toBeLessThanOrEqual(32);
    throw new Error('Storage read failed');
  });
  await expect(engine.previewSource(version, 0)).rejects.toThrow('Storage read failed');
  expect(engine.stats().previewCacheBytes).toBe(0);
  expect(engine.cache.limit).toBe(32);
  expect(await engine.previewSource(version, 0)).toMatchObject({ width: 4, height: 1 });
});

test('LRU eviction releases the least recently used canvas backing', async () => {
  const engine = makeEngine({ tileMemoryLimit: 64, previewMemoryLimit: 32 });
  const versions = Array.from({ length: 3 }, () => engine.createVersion(4, 1));
  const first = await engine.previewSource(versions[0], 0);
  const second = await engine.previewSource(versions[1], 0);
  expect(await engine.previewSource(versions[0], 0)).toBe(first);
  await engine.previewSource(versions[2], 0);
  expectReleased(second);
  expect(first.width).toBe(4);
  expect(engine.stats().previewCacheBytes).toBe(32);
});

test('raw pixels, dirty strokes, and preview surfaces share the existing memory cap', async () => {
  const engine = makeEngine({ tileMemoryLimit: 32, dirtyLimit: 24, previewMemoryLimit: 32 });
  const source = engine.createVersion(6, 1);
  const originalRaw = pixels(8);
  engine.cache.set('raw', originalRaw);
  const preview = await engine.previewSource(source, 0);
  expect(engine.cache.bytes).toBe(0);
  expect(engine.stats().residentRasterBytes).toBe(24);
  const draft = engine.createVersion(1024, 1);
  engine.stroke = { version: draft, dirty: new Map(), changed: new Set() };
  await engine.stageTile(0, 0, makeCanvas(2));
  expect(engine.stats().residentRasterBytes).toBe(32);
  await engine.stageTile(1, 0, makeCanvas(2));
  expectReleased(preview);
  engine.cache.set('small-raw', pixels(4));
  engine.recordResidentBytes();
  expect(engine.stats()).toMatchObject({ dirtyBytes: 16, cacheBytes: 16, previewCacheBytes: 0, residentRasterBytes: 32 });
  expect(engine.stats().peakResidentRasterBytes).toBeLessThanOrEqual(32);
});

test('a full frame retains reusable layers when all layer surfaces cannot fit', async () => {
  const engine = makeEngine({ tileMemoryLimit: 64, previewMemoryLimit: 32 });
  const versions = Array.from({ length: 3 }, () => engine.createVersion(4, 1));
  const doc = { width: 4, height: 1, layers: versions.map(makeLayer) };
  await engine.composite({ doc });
  await engine.composite({ doc });
  const readCounts = versions.map((version) => engine.readRegion.mock.calls.filter(([source]) => source === version).length);
  expect(readCounts).toEqual([1, 1, 2]);
  expect(engine.stats()).toMatchObject({ previewCacheMisses: 2, previewCacheHits: 2, previewCacheBytes: 32 });
  expect(engine.previewFrameKeys).toBeNull();
});

test.each([
  ['full-resolution output', {}, 32, 8, true],
  ['surface exceeds memory allowance', { previewMemoryLimit: 16 }, 32, 8, false],
  ['surface exceeds dimension allowance', {}, 4097, 1, false],
  ['preview caching is disabled', { previewMemoryLimit: 0 }, 32, 8, false],
])('%s uses bounded source patches without retaining them', async (name, options, width, height, fullResolution) => {
  const engine = makeEngine(options);
  const version = engine.createVersion(width, height);
  const ctx = makeCanvas(32, 8).getContext('2d');
  await engine.renderLayer(ctx, makeLayer(version), identity, 32, 8, fullResolution);
  expect(ctx.drawImage).toHaveBeenCalled();
  expect(engine.stats().previewCacheBytes).toBe(0);
  expect(engine.stats().previewCacheMisses).toBe(0);
  for (const [patch] of ctx.drawImage.mock.calls) expectReleased(patch);
  for (const [, , , , patchWidth, patchHeight] of engine.readRegion.mock.calls) {
    expect(patchWidth).toBeLessThanOrEqual(1024);
    expect(patchHeight).toBeLessThanOrEqual(1024);
  }
});

test('collecting an unreferenced version releases its preview only', async () => {
  const engine = makeEngine();
  const oldVersion = engine.createVersion(4, 2);
  const currentVersion = engine.createVersion(4, 2);
  const oldPreview = await engine.previewSource(oldVersion, 0);
  const currentPreview = await engine.previewSource(currentVersion, 0);
  await engine.releasePending({ rasterIds: [oldVersion.id] });
  expectReleased(oldPreview);
  expect(engine.versions.has(oldVersion.id)).toBe(false);
  expect(await engine.previewSource(currentVersion, 0)).toBe(currentPreview);
  expect(engine.stats().previewCacheBytes).toBe(32);
});

test('discarding inactive preview levels releases graphics for retained history', async () => {
  const engine = makeEngine();
  const oldVersion = engine.createVersion(1024, 2);
  const currentVersion = engine.createVersion(4, 2);
  const oldPreview = await engine.previewSource(oldVersion, 1);
  const currentPreview = await engine.previewSource(currentVersion, 0);
  await engine.retain({
    documents: [{ key: 'history', rasters: [oldVersion.id] }],
    current: [currentVersion.id], currentKey: 'current',
  });
  await engine.freeInactivePreviews();
  expectReleased(oldPreview);
  expect(engine.versions.has(oldVersion.id)).toBe(true);
  expect(await engine.previewSource(currentVersion, 0)).toBe(currentPreview);
});

test('disposing the editor releases every cached surface and raster allocation', async () => {
  const engine = makeEngine();
  const first = engine.createVersion(4, 2);
  const second = engine.createVersion(4, 2);
  await engine.writeTile(first, 0, 0, 0, tilePixels());
  const previews = [await engine.previewSource(first, 0), await engine.previewSource(second, 0)];
  await engine.dispose();
  previews.forEach(expectReleased);
  expect(engine.stats()).toMatchObject({
    previewCacheBytes: 0, cacheBytes: 0, dirtyBytes: 0,
    residentRasterBytes: 0, storageBytes: 0, rasterVersions: 0,
  });
});
