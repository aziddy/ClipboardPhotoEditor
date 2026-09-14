import {
  MAX_DIMENSION, createLayerId, invertTransform, multiplyTransforms, transformPoint,
} from './editorLayers';
import {
  RasterCache, TILE_SIZE, RASTER_MEMORY_LIMIT, RASTER_DIRTY_LIMIT,
  RASTER_SCRATCH_RESERVE, storageFull,
} from './rasterStorage';

const tileKey = (x, y) => `${x},${y}`;
const coordinates = (key) => key.split(',').map(Number);
const PREVIEW_MEMORY_LIMIT = 16 * 1024 * 1024;
const PREVIEW_DIMENSION_LIMIT = 4096;
const releaseCanvas = (canvas) => { canvas.width = 1; canvas.height = 1; };
const surface = (width, height) => {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  if (!canvas.getContext('2d')) throw new Error('Could not allocate image working memory.');
  return canvas;
};
const rectPoints = ({ x, y, width, height }) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
const pointBounds = (points) => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

export const alphaBounds = (data, width, height) => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3]) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

export class RasterEngine {
  constructor(storage, notify = () => {}, options = {}) {
    this.storage = storage;
    this.notify = notify;
    this.tileMemoryLimit = options.tileMemoryLimit ?? RASTER_MEMORY_LIMIT - RASTER_SCRATCH_RESERVE;
    this.dirtyLimit = Math.min(options.dirtyLimit ?? RASTER_DIRTY_LIMIT, this.tileMemoryLimit);
    this.cache = new RasterCache(this.tileMemoryLimit);
    this.previewMemoryLimit = Math.max(0, Math.min(options.previewMemoryLimit ?? PREVIEW_MEMORY_LIMIT, this.tileMemoryLimit));
    this.previewCache = new RasterCache(this.previewMemoryLimit, (entry) => {
      if (entry.canvas) releaseCanvas(entry.canvas);
    });
    this.previewCacheHits = 0;
    this.previewCacheMisses = 0;
    this.previewFrameKeys = null;
    this.peakResidentRasterBytes = 0;
    this.dirtyTiles = new Map();
    this.dirtyBytes = 0;
    this.peakDirtyBytes = 0;
    this.peakResidentBytes = 0;
    this.versions = new Map();
    this.pending = new Set();
    this.files = new Map();
    this.bytes = 0;
    this.history = [];
    this.current = [];
    this.currentKey = null;
    this.droppedHistory = new Set();
    this.stroke = null;
    this.inUse = new Set();
    this.canceled = false;
  }

  stats() {
    return {
      backend: this.storage.kind, storageBytes: this.bytes, storageLimit: this.storage.limit,
      cacheBytes: this.cache.bytes, peakCacheBytes: this.cache.peakBytes,
      dirtyBytes: this.dirtyBytes, peakDirtyBytes: this.peakDirtyBytes,
      residentTileBytes: this.cache.bytes + this.dirtyBytes,
      peakResidentTileBytes: this.peakResidentBytes, tileMemoryLimit: this.tileMemoryLimit,
      previewCacheBytes: this.previewCache.bytes, peakPreviewCacheBytes: this.previewCache.peakBytes,
      previewMemoryLimit: this.previewMemoryLimit,
      previewCacheHits: this.previewCacheHits, previewCacheMisses: this.previewCacheMisses,
      residentRasterBytes: this.cache.bytes + this.dirtyBytes + this.previewCache.bytes,
      peakResidentRasterBytes: this.peakResidentRasterBytes,
      dirtyLimit: this.dirtyLimit,
      scratchReserve: RASTER_SCRATCH_RESERVE, rasterVersions: this.versions.size,
      tileFiles: this.files.size,
    };
  }

  checkCanceled() {
    if (this.canceled) throw Object.assign(new Error('Image operation canceled.'), { name: 'AbortError' });
  }

  version(id) {
    const version = this.versions.get(id);
    if (!version) throw new Error('Temporary image data is unavailable. Import the image again.');
    return version;
  }

  describe(version) {
    const points = [];
    version.levels[0].forEach((tile, key) => {
      if (!tile.bounds) return;
      const [x, y] = coordinates(key);
      points.push(...rectPoints({ ...tile.bounds, x: x * TILE_SIZE + tile.bounds.x, y: y * TILE_SIZE + tile.bounds.y }));
    });
    return {
      rasterId: version.id, sourceWidth: version.width, sourceHeight: version.height,
      sourceBounds: points.length ? pointBounds(points) : null,
    };
  }

  createVersion(width, height, original = null) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(`Images must be between 1 and ${MAX_DIMENSION.toLocaleString('en-US')} pixels on each side.`);
    }
    const count = Math.max(1, Math.ceil(Math.log2(Math.max(width, height) / TILE_SIZE)) + 1);
    const version = {
      id: createLayerId(), width, height,
      mipsReady: original?.mipsReady || false,
      levels: original ? original.levels.map((level) => new Map(level)) : Array.from({ length: count }, () => new Map()),
    };
    this.versions.set(version.id, version);
    this.pending.add(version.id);
    return version;
  }

  async blank({ width, height }) { return this.describe(this.createVersion(width, height)); }

  async readTile(tile) {
    const dirty = this.dirtyTiles.get(tile.id);
    if (dirty) return dirty.data;
    let data = this.cache.get(tile.id);
    if (!data) {
      data = await this.storage.read(tile.id);
      if (data.byteLength !== tile.width * tile.height * 4) throw new Error('Temporary image data is incomplete.');
      this.cache.set(tile.id, data);
      this.recordResidentBytes();
    }
    return data;
  }

  async pruneHistory() {
    const index = this.history.findIndex((entry) => entry.key !== this.currentKey);
    if (index < 0) return false;
    const [removed] = this.history.splice(index, 1);
    this.droppedHistory.add(removed.key);
    this.notify({ type: 'historyTrimmed', keys: [removed.key] });
    await this.collect();
    return true;
  }

  async freeInactivePreviews() {
    const protectedIds = new Set([...this.current, ...this.pending, ...this.inUse]);
    if (this.stroke) protectedIds.add(this.stroke.version.id);
    const before = this.bytes;
    for (const version of this.versions.values()) {
      if (protectedIds.has(version.id)) continue;
      this.invalidatePreview(version.id);
      version.levels.slice(1).forEach((level) => level.clear());
      version.mipsReady = false;
    }
    await this.collect();
    return this.bytes < before;
  }

  async saveTile(version, level, tx, ty, canvas) {
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const bounds = alphaBounds(data, width, height);
    await this.writeTile(version, level, tx, ty, { data, width, height, bounds });
  }

  recordResidentBytes() {
    this.peakDirtyBytes = Math.max(this.peakDirtyBytes, this.dirtyBytes);
    this.peakResidentBytes = Math.max(this.peakResidentBytes, this.cache.bytes + this.dirtyBytes);
    this.peakResidentRasterBytes = Math.max(this.peakResidentRasterBytes, this.cache.bytes + this.dirtyBytes + this.previewCache.bytes);
  }

  updateCacheLimits() {
    this.previewCache.setLimit(Math.min(this.previewMemoryLimit, this.tileMemoryLimit - this.dirtyBytes));
    this.cache.setLimit(this.tileMemoryLimit - this.dirtyBytes - this.previewCache.bytes);
  }

  invalidatePreview(versionId, level) {
    for (const [key, entry] of this.previewCache.entries) {
      if (entry.versionId === versionId && (level === undefined || entry.level === level)) this.previewCache.delete(key);
    }
    this.updateCacheLimits();
  }

  async previewSource(version, level) {
    // Committed source levels are immutable between writes. Cache their canvases
    // so transforms reuse browser graphics resources instead of uploading and
    // reconstructing overlapping patches every frame. Export keeps its exact path.
    if (this.stroke?.version === version) return null;
    const width = Math.ceil(version.width / (2 ** level));
    const height = Math.ceil(version.height / (2 ** level));
    const byteLength = width * height * 4;
    if (width > PREVIEW_DIMENSION_LIMIT || height > PREVIEW_DIMENSION_LIMIT || byteLength > this.previewCache.limit) return null;
    const key = `${version.id}:${level}`;
    const cached = this.previewCache.get(key);
    if (cached && !cached.invalid && !cached.canvas.getContext('2d').isContextLost?.()) {
      this.previewFrameKeys?.add(key);
      this.previewCacheHits += 1;
      return cached.canvas;
    }
    if (cached) { this.previewCache.delete(key); this.updateCacheLimits(); }
    // A document may have more layers than fit in the cache. Protect surfaces
    // already drawn this frame so large layers cannot evict each other forever.
    const evictable = [...this.previewCache.entries].filter(([id]) => !this.previewFrameKeys?.has(id));
    const available = this.previewCache.limit - this.previewCache.bytes + evictable.reduce((sum, [, entry]) => sum + entry.byteLength, 0);
    if (byteLength > available) return null;
    for (const [id] of evictable) {
      if (this.previewCache.bytes + byteLength <= this.previewCache.limit) break;
      this.previewCache.delete(id);
    }
    this.previewCacheMisses += 1;
    // Reserve before allocation/reads, shrinking the raw tile cache to keep both
    // representations inside the same resident working-memory budget.
    const entry = { versionId: version.id, level, byteLength, canvas: null };
    this.previewCache.set(key, entry);
    this.previewFrameKeys?.add(key);
    this.updateCacheLimits();
    this.recordResidentBytes();
    try {
      entry.canvas = await this.readRegion(version, level, 0, 0, width, height);
      // Restoration clears the backing pixels even if it completes before the
      // next render can observe isContextLost(). Rebuild either way.
      const invalidate = () => { entry.invalid = true; };
      entry.canvas.addEventListener('contextlost', invalidate);
      entry.canvas.addEventListener('contextrestored', invalidate);
      // The graphics surface replaces these clean cached pixels; keep originals
      // in storage without retaining two working-cache copies of the same level.
      version.levels[level].forEach((tile) => this.cache.delete(tile.id));
      return entry.canvas;
    } catch (error) {
      this.previewCache.delete(key);
      this.updateCacheLimits();
      throw error;
    }
  }

  async writeTile(version, level, tx, ty, { data, width, height, bounds, id = createLayerId() }, cache = true) {
    this.checkCanceled();
    const key = tileKey(tx, ty);
    this.invalidatePreview(version.id, level);
    if (!bounds) { version.levels[level].delete(key); return; }
    while (true) {
      try {
        if (this.bytes + data.byteLength > this.storage.limit) throw storageFull();
        await this.storage.write(id, data);
        break;
      } catch (error) {
        if (error.name !== 'QuotaExceededError') throw error;
        if (!(await this.freeInactivePreviews()) && !(await this.pruneHistory())) throw error;
      }
    }
    this.files.set(id, data.byteLength);
    this.bytes += data.byteLength;
    version.levels[level].set(key, { id, width, height, bounds });
    if (cache) this.cache.set(id, data);
    this.recordResidentBytes();
  }

  removeDirtyTile(key) {
    const tile = this.stroke?.dirty.get(key);
    if (!tile) return;
    this.stroke.dirty.delete(key);
    this.dirtyTiles.delete(tile.id);
    this.dirtyBytes -= tile.data.byteLength;
    this.updateCacheLimits();
  }

  async flushDirtyTile(key) {
    const stroke = this.stroke;
    const tile = stroke.dirty.get(key);
    if (!tile) return;
    const [x, y] = coordinates(key);
    await this.writeTile(stroke.version, 0, x, y, tile, false);
    this.removeDirtyTile(key);
    this.cache.set(tile.id, tile.data);
    this.recordResidentBytes();
  }

  async stageTile(tx, ty, canvas) {
    this.checkCanceled();
    const stroke = this.stroke;
    const key = tileKey(tx, ty);
    this.invalidatePreview(stroke.version.id, 0);
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const bounds = alphaBounds(data, width, height);
    if (!bounds) {
      this.removeDirtyTile(key);
      stroke.version.levels[0].delete(key);
      return;
    }
    let tile = stroke.dirty.get(key);
    if (tile) {
      tile.data.set(data);
      tile.bounds = bounds;
      // Insertion order tracks dirty-tile use for pressure spills.
      stroke.dirty.delete(key);
    } else {
      if (data.byteLength > this.dirtyLimit) {
        await this.writeTile(stroke.version, 0, tx, ty, { data, width, height, bounds });
        return;
      }
      while (this.dirtyBytes + data.byteLength > this.dirtyLimit) {
        await this.flushDirtyTile(stroke.dirty.keys().next().value);
      }
      tile = { id: createLayerId(), data, width, height, bounds };
      this.dirtyBytes += data.byteLength;
      this.updateCacheLimits();
      this.dirtyTiles.set(tile.id, tile);
    }
    stroke.dirty.set(key, tile);
    stroke.version.levels[0].set(key, { id: tile.id, width, height, bounds });
    this.recordResidentBytes();
  }

  async readRegion(version, level, x, y, width, height) {
    this.checkCanceled();
    const canvas = surface(width, height);
    const ctx = canvas.getContext('2d');
    try {
      for (let ty = Math.max(0, Math.floor(y / TILE_SIZE)); ty <= Math.floor((y + height - 1) / TILE_SIZE); ty += 1) {
        for (let tx = Math.max(0, Math.floor(x / TILE_SIZE)); tx <= Math.floor((x + width - 1) / TILE_SIZE); tx += 1) {
          const tile = version.levels[level].get(tileKey(tx, ty));
          if (!tile) continue;
          const data = await this.readTile(tile);
          ctx.putImageData(new ImageData(data, tile.width, tile.height), tx * TILE_SIZE - x, ty * TILE_SIZE - y);
        }
      }
      return canvas;
    } catch (error) { releaseCanvas(canvas); throw error; }
  }

  async buildMips(version, changed, regions = null) {
    if (!version.mipsReady) { changed = new Set(version.levels[0].keys()); regions = null; }
    let affected = changed;
    let affectedRegions = regions;
    for (let level = 1; level < version.levels.length; level += 1) {
      const width = Math.ceil(version.width / (2 ** level));
      const height = Math.ceil(version.height / (2 ** level));
      const parents = new Set();
      const dirty = affectedRegions || [...affected].map((key) => {
        const [x, y] = coordinates(key);
        return { x: x * TILE_SIZE, y: y * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE };
      });
      dirty.forEach((rect) => {
        // The sampling gutter means an edit can also affect an adjacent parent.
        for (let py = Math.max(0, Math.floor((rect.y - 2) / (2 * TILE_SIZE))); py <= Math.floor((rect.y + rect.height + 2) / (2 * TILE_SIZE)); py += 1) {
          for (let px = Math.max(0, Math.floor((rect.x - 2) / (2 * TILE_SIZE))); px <= Math.floor((rect.x + rect.width + 2) / (2 * TILE_SIZE)); px += 1) {
            if (px * TILE_SIZE < width && py * TILE_SIZE < height) parents.add(tileKey(px, py));
          }
        }
      });
      for (const key of parents) {
        const [x, y] = coordinates(key);
        const w = Math.min(TILE_SIZE, width - x * TILE_SIZE);
        const h = Math.min(TILE_SIZE, height - y * TILE_SIZE);
        const input = await this.readRegion(version, level - 1, x * TILE_SIZE * 2 - 2, y * TILE_SIZE * 2 - 2, w * 2 + 4, h * 2 + 4);
        const output = surface(w, h);
        try {
          const ctx = output.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.setTransform(0.5, 0, 0, 0.5, -1, -1);
          ctx.drawImage(input, 0, 0);
          await this.saveTile(version, level, x, y, output);
        } finally { releaseCanvas(input); releaseCanvas(output); }
      }
      affected = parents;
      if (affectedRegions) affectedRegions = dirty.map((rect) => ({ x: (rect.x - 2) / 2, y: (rect.y - 2) / 2, width: (rect.width + 4) / 2, height: (rect.height + 4) / 2 }));
    }
    version.mipsReady = true;
  }

  async importBlob({ blob }) {
    let bitmap;
    try { bitmap = await createImageBitmap(blob); }
    catch (error) {
      throw Object.assign(new Error('This image needs the browser image decoder.'), { name: 'ImageDecodeError' });
    }
    return this.importBitmap({ bitmap });
  }

  async importBitmap({ bitmap: image }) {
    let version;
    try {
      version = this.createVersion(image.width, image.height);
      const changed = new Set();
      for (let y = 0; y < image.height; y += TILE_SIZE) {
        for (let x = 0; x < image.width; x += TILE_SIZE) {
          const canvas = surface(Math.min(TILE_SIZE, image.width - x), Math.min(TILE_SIZE, image.height - y));
          try {
            canvas.getContext('2d').drawImage(image, -x, -y);
            await this.saveTile(version, 0, x / TILE_SIZE, y / TILE_SIZE, canvas);
            changed.add(tileKey(x / TILE_SIZE, y / TILE_SIZE));
          } finally { releaseCanvas(canvas); }
        }
      }
      image.close(); image = null;
      await this.buildMips(version, changed);
      return this.describe(version);
    } catch (error) {
      if (version) { this.pending.delete(version.id); this.versions.delete(version.id); }
      await this.collect();
      throw error;
    } finally { image?.close(); }
  }

  async retain({ documents, current, currentKey }) {
    this.history = documents.filter((entry) => !this.droppedHistory.has(entry.key));
    this.current = current;
    this.currentKey = currentKey;
    const acknowledged = new Set([...current, ...this.history.flatMap((entry) => entry.rasters)]);
    acknowledged.forEach((id) => this.pending.delete(id));
    await this.collect();
  }

  async releasePending({ rasterIds }) {
    rasterIds.forEach((id) => this.pending.delete(id));
    await this.collect();
  }

  async collect() {
    const retained = new Set([...this.current, ...this.pending, ...this.inUse, ...this.history.flatMap((entry) => entry.rasters)]);
    if (this.stroke) {
      retained.add(this.stroke.version.id);
      retained.add(this.stroke.originalId);
    }
    const files = new Set();
    for (const [id, version] of this.versions) {
      if (!retained.has(id)) { this.invalidatePreview(id); this.versions.delete(id); continue; }
      version.levels.forEach((level) => level.forEach((tile) => files.add(tile.id)));
    }
    for (const [id, bytes] of this.files) {
      if (files.has(id)) continue;
      await this.storage.remove(id);
      this.files.delete(id);
      this.cache.delete(id);
      this.bytes -= bytes;
    }
  }

  checkStroke({ strokeId, sequence } = {}) {
    const stroke = this.stroke;
    if (!stroke || (strokeId !== undefined && strokeId !== stroke.id)) {
      throw Object.assign(new Error('The stroke was canceled.'), { name: 'AbortError' });
    }
    if (sequence !== undefined) {
      if (!Number.isSafeInteger(sequence) || sequence <= stroke.sequence) {
        throw Object.assign(new Error('The stroke update is out of order.'), { name: 'AbortError' });
      }
      stroke.sequence = sequence;
    }
    return stroke;
  }

  async beginStroke({ layer, point, size, color, erase, strokeId, sequence = 0 }) {
    if (this.stroke) throw new Error('Finish the current stroke first.');
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('The stroke sequence is invalid.');
    const original = this.version(layer.rasterId);
    const version = this.createVersion(original.width, original.height, original);
    this.stroke = {
      id: strokeId ?? createLayerId(), sequence, originalId: original.id,
      version, transform: layer.transform, size, color, erase, lastPoint: point,
      dirty: new Map(), changed: new Set(), regions: new Map(),
    };
    try {
      await this.applyStrokePointBatch([{ x: point.x + 0.01, y: point.y + 0.01 }]);
      return this.describe(version);
    }
    catch (error) { await this.abortStroke(); throw error; }
  }

  async strokePoints({ points, strokeId, sequence }) {
    const stroke = this.checkStroke({ strokeId, sequence });
    const packed = ArrayBuffer.isView(points);
    const count = packed ? points.length / 2 : points.length;
    if (!Number.isInteger(count)) throw new Error('Stroke coordinates are incomplete.');
    try {
      // Keep scratch geometry bounded even when a delayed frame sends a large batch.
      for (let start = 0; start < count; start += 128) {
        const batch = [];
        for (let i = start; i < Math.min(count, start + 128); i += 1) {
          batch.push(packed ? { x: points[i * 2], y: points[i * 2 + 1] } : points[i]);
        }
        await this.applyStrokePointBatch(batch);
      }
      return this.describe(stroke.version);
    } catch (error) { await this.abortStroke(); throw error; }
  }

  async applyStrokePointBatch(points) {
    const stroke = this.stroke;
    const { version, size, transform } = stroke;
    const inverse = invertTransform(transform);
    const tiles = new Map();
    let previous = stroke.lastPoint;
    for (const point of points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Stroke coordinates are invalid.');
      const padding = size / 2 + 2;
      const bounds = pointBounds(rectPoints({
        x: Math.min(previous.x, point.x) - padding, y: Math.min(previous.y, point.y) - padding,
        width: Math.abs(previous.x - point.x) + padding * 2, height: Math.abs(previous.y - point.y) + padding * 2,
      }).map((p) => transformPoint(inverse, p)));
      for (let y = Math.max(0, Math.floor(bounds.y / TILE_SIZE)); y <= Math.min(Math.ceil(version.height / TILE_SIZE) - 1, Math.floor((bounds.y + bounds.height) / TILE_SIZE)); y += 1) {
        for (let x = Math.max(0, Math.floor(bounds.x / TILE_SIZE)); x <= Math.min(Math.ceil(version.width / TILE_SIZE) - 1, Math.floor((bounds.x + bounds.width) / TILE_SIZE)); x += 1) {
          const key = tileKey(x, y);
          if (!tiles.has(key)) tiles.set(key, []);
          tiles.get(key).push([previous, point]);
          stroke.changed.add(key);
          const left = Math.max(x * TILE_SIZE, bounds.x);
          const top = Math.max(y * TILE_SIZE, bounds.y);
          const right = Math.min((x + 1) * TILE_SIZE, bounds.x + bounds.width);
          const bottom = Math.min((y + 1) * TILE_SIZE, bounds.y + bounds.height);
          const region = { x: left, y: top, width: right - left, height: bottom - top };
          const earlier = stroke.regions.get(key);
          stroke.regions.set(key, earlier ? pointBounds([...rectPoints(earlier), ...rectPoints(region)]) : region);
        }
      }
      previous = point;
    }
    for (const [key, segments] of tiles) {
      const [x, y] = coordinates(key);
      const left = x * TILE_SIZE; const top = y * TILE_SIZE;
      const canvas = await this.readRegion(version, 0, left, top, Math.min(TILE_SIZE, version.width - left), Math.min(TILE_SIZE, version.height - top));
      try {
        const ctx = canvas.getContext('2d');
        ctx.setTransform(...multiplyTransforms([1, 0, 0, 1, -left, -top], inverse));
        ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke.color;
        ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
        segments.forEach(([from, to]) => {
          ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        });
        await this.stageTile(x, y, canvas);
      } finally { releaseCanvas(canvas); }
    }
    stroke.lastPoint = previous;
  }

  async finishStroke(args = {}) {
    if (!this.stroke && args.strokeId === undefined) return null;
    const stroke = this.checkStroke(args);
    try {
      for (const key of [...stroke.dirty.keys()]) await this.flushDirtyTile(key);
      await this.buildMips(stroke.version, stroke.changed, [...stroke.regions.values()]);
      await this.collect();
      const result = this.describe(stroke.version);
      this.stroke = null;
      return result;
    } catch (error) { await this.abortStroke(); throw error; }
  }

  async abortStroke({ strokeId } = {}) {
    if (strokeId !== undefined && this.stroke && strokeId !== this.stroke.id) return;
    if (this.stroke) {
      this.pending.delete(this.stroke.version.id);
      for (const key of [...this.stroke.dirty.keys()]) this.removeDirtyTile(key);
    }
    this.stroke = null;
    await this.collect();
  }

  async crop({ doc, crop }) {
    const layers = [];
    const created = [];
    try {
      for (const layer of doc.layers) {
        const original = this.version(layer.rasterId);
        const version = this.createVersion(original.width, original.height, original);
        created.push(version.id);
        const changed = new Set();
        for (const [key, tile] of original.levels[0]) {
          const [x, y] = coordinates(key);
          const left = x * TILE_SIZE; const top = y * TILE_SIZE;
          const corners = rectPoints({ x: left, y: top, width: tile.width, height: tile.height }).map((p) => transformPoint(layer.transform, p));
          const inside = (p) => p.x >= crop.x && p.y >= crop.y && p.x <= crop.x + crop.width && p.y <= crop.y + crop.height;
          if (corners.every(inside)) continue;
          const bounds = pointBounds(corners);
          if (bounds.x + bounds.width <= crop.x || bounds.y + bounds.height <= crop.y || bounds.x >= crop.x + crop.width || bounds.y >= crop.y + crop.height) {
            version.levels[0].delete(key);
          } else {
            const input = await this.readRegion(original, 0, left, top, tile.width, tile.height);
            const output = surface(tile.width, tile.height);
            try {
              const ctx = output.getContext('2d');
              ctx.setTransform(...multiplyTransforms([1, 0, 0, 1, -left, -top], invertTransform(layer.transform)));
              ctx.beginPath(); ctx.rect(crop.x, crop.y, crop.width, crop.height); ctx.clip();
              ctx.resetTransform(); ctx.drawImage(input, 0, 0);
              await this.saveTile(version, 0, x, y, output);
            } finally { releaseCanvas(input); releaseCanvas(output); }
          }
          changed.add(key);
        }
        await this.buildMips(version, changed);
        layers.push({ ...layer, ...this.describe(version), transform: multiplyTransforms([1, 0, 0, 1, -crop.x, -crop.y], layer.transform) });
      }
      return { ...doc, width: crop.width, height: crop.height, layers };
    } catch (error) {
      created.forEach((id) => this.pending.delete(id));
      await this.collect();
      throw error;
    }
  }

  async renderLayer(ctx, layer, view, width, height, fullResolution) {
    if (!layer.visible || layer.opacity <= 0 || !layer.sourceBounds) return;
    const version = this.version(layer.rasterId);
    let matrix = multiplyTransforms(view, layer.transform);
    const scale = Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3]));
    // Editing/exports use original pixels. Extremely small output still needs a
    // reduced source level to keep a single sampling footprint bounded.
    const reduction = fullResolution ? Math.max(1, 1 / (scale * 32)) : Math.max(1, 1 / scale);
    const level = this.stroke?.version === version && this.stroke.changed.size
      ? 0 : Math.min(version.levels.length - 1, Math.max(0, Math.floor(Math.log2(reduction))));
    if (level > 0 && !version.mipsReady) await this.buildMips(version, new Set(version.levels[0].keys()));
    matrix = multiplyTransforms(matrix, [2 ** level, 0, 0, 2 ** level, 0, 0]);
    const inverse = invertTransform(matrix);
    const imageBounds = pointBounds(rectPoints(layer.sourceBounds).map((p) => transformPoint(multiplyTransforms(view, layer.transform), p)));
    const left = Math.max(0, Math.floor(imageBounds.x) - 2);
    const top = Math.max(0, Math.floor(imageBounds.y) - 2);
    const right = Math.min(width, Math.ceil(imageBounds.x + imageBounds.width) + 2);
    const bottom = Math.min(height, Math.ceil(imageBounds.y + imageBounds.height) + 2);
    if (right <= left || bottom <= top) return;
    const preview = fullResolution ? null : await this.previewSource(version, level);
    const levelWidth = Math.ceil(version.width / (2 ** level));
    const levelHeight = Math.ceil(version.height / (2 ** level));
    const padding = Math.min(128, Math.ceil(4 * Math.max(1, Math.hypot(inverse[0], inverse[1]), Math.hypot(inverse[2], inverse[3]))));
    const drawBlock = async (x, y, w, h) => {
      this.checkCanceled();
      const region = pointBounds(rectPoints({ x, y, width: w, height: h }).map((p) => transformPoint(inverse, p)));
      const sx = Math.max(0, Math.floor(region.x) - padding);
      const sy = Math.max(0, Math.floor(region.y) - padding);
      const sw = Math.min(levelWidth, Math.ceil(region.x + region.width) + padding) - sx;
      const sh = Math.min(levelHeight, Math.ceil(region.y + region.height) + padding) - sy;
      if (sw <= 0 || sh <= 0) return;
      if ((sw > 1024 || sh > 1024) && (w > 1 || h > 1)) {
        if (w >= h && w > 1) {
          const half = Math.floor(w / 2);
          await drawBlock(x, y, half, h); await drawBlock(x + half, y, w - half, h);
        } else {
          const half = Math.floor(h / 2);
          await drawBlock(x, y, w, half); await drawBlock(x, y + half, w, h - half);
        }
        return;
      }
      if (sw * sh > 1024 * 1024) throw new Error('This transform needs too much working memory. Reduce its stretch.');
      const patch = preview ? surface(sw, sh) : await this.readRegion(version, level, sx, sy, sw, sh);
      try {
        // Preserve the original sampling footprint. Some browsers filter large
        // source canvases differently even when drawn through a smaller clip.
        if (preview) patch.getContext('2d').drawImage(preview, -sx, -sy);
        ctx.save();
        // Integer destination clips partition the output without overlapping alpha.
        // Each source patch includes neighboring samples, even across tile edges.
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        ctx.globalAlpha = Math.max(0, Math.min(1, (layer.opacity ?? 100) / 100));
        ctx.imageSmoothingQuality = 'high';
        ctx.setTransform(...matrix);
        ctx.drawImage(patch, sx, sy);
        ctx.restore();
      } finally { releaseCanvas(patch); }
    };
    for (let y = top; y < bottom; y += 256) {
      for (let x = left; x < right; x += 256) {
        await drawBlock(x, y, Math.min(256, right - x), Math.min(256, bottom - y));
      }
    }
  }

  async composite({ doc, width = doc.width, height = doc.height, view = [1, 0, 0, 1, 0, 0], fullResolution = false }) {
    this.inUse = new Set(doc.layers.map((layer) => layer.rasterId));
    this.previewFrameKeys = new Set();
    let canvas;
    try {
      canvas = surface(width, height);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(...view);
      ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
      ctx.resetTransform();
      for (const layer of doc.layers) await this.renderLayer(ctx, layer, view, width, height, fullResolution);
      return canvas;
    } catch (error) { if (canvas) releaseCanvas(canvas); throw error; }
    finally { this.inUse.clear(); this.previewFrameKeys = null; }
  }

  async render(options) {
    const canvas = await this.composite(options);
    try { return { bitmap: canvas.transferToImageBitmap() }; }
    finally { releaseCanvas(canvas); }
  }

  async prepareDrawing({ doc, activeLayerId, width, height, view }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 2 * 1024 * 1024) {
      throw new Error('The drawing preview exceeds its working memory budget.');
    }
    const index = doc.layers.findIndex((layer) => layer.id === activeLayerId);
    if (index < 0) throw new Error('The drawing layer is unavailable.');
    const groups = [
      doc.layers.slice(0, index),
      [{ ...doc.layers[index], opacity: 100 }],
      doc.layers.slice(index + 1),
    ];
    const bitmaps = [];
    try {
      for (const layers of groups) {
        const { bitmap } = await this.render({ doc: { ...doc, layers }, width, height, view });
        bitmaps.push(bitmap);
      }
      return { bitmaps };
    } catch (error) {
      bitmaps.forEach((bitmap) => bitmap.close());
      throw error;
    }
  }

  async exportBlob({ doc, format, quality }) {
    const canvas = await this.composite({ doc, fullResolution: true });
    try { return await canvas.convertToBlob({ type: format, quality }); }
    finally { releaseCanvas(canvas); }
  }

  async ocrInput({ doc }) {
    const edge = Math.max(doc.width, doc.height);
    const scale = edge > 4200 ? 4200 / edge : edge < 1600 ? Math.min(2, 1600 / edge) : 1;
    const width = Math.max(1, Math.round(doc.width * scale));
    const height = Math.max(1, Math.round(doc.height * scale));
    const canvas = await this.composite({ doc, width, height, view: [scale, 0, 0, scale, 0, 0], fullResolution: true });
    try {
      const ctx = canvas.getContext('2d');
      ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
      return { blob: await canvas.convertToBlob({ type: 'image/png' }), scale };
    } finally { releaseCanvas(canvas); }
  }

  async dispose() {
    this.canceled = true;
    this.stroke = null; this.current = []; this.history = [];
    this.pending.clear(); this.versions.clear(); this.files.clear(); this.cache.clear(); this.bytes = 0;
    this.previewCache.clear();
    this.dirtyTiles.clear(); this.dirtyBytes = 0;
    this.cache.setLimit(this.tileMemoryLimit);
    this.inUse.clear(); this.droppedHistory.clear();
    await this.storage.dispose();
  }
}
