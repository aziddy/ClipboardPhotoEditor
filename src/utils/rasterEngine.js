import {
  MAX_DIMENSION, createLayerId, invertTransform, multiplyTransforms, transformPoint,
} from './editorLayers';
import { RasterCache, TILE_SIZE, RASTER_SCRATCH_RESERVE, storageFull } from './rasterStorage';

const tileKey = (x, y) => `${x},${y}`;
const coordinates = (key) => key.split(',').map(Number);
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
  constructor(storage, notify = () => {}) {
    this.storage = storage;
    this.notify = notify;
    this.cache = new RasterCache();
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
    let data = this.cache.get(tile.id);
    if (!data) {
      data = await this.storage.read(tile.id);
      if (data.byteLength !== tile.width * tile.height * 4) throw new Error('Temporary image data is incomplete.');
      this.cache.set(tile.id, data);
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
      version.levels.slice(1).forEach((level) => level.clear());
      version.mipsReady = false;
    }
    await this.collect();
    return this.bytes < before;
  }

  async saveTile(version, level, tx, ty, canvas) {
    this.checkCanceled();
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const bounds = alphaBounds(data, width, height);
    const key = tileKey(tx, ty);
    if (!bounds) { version.levels[level].delete(key); return; }
    const id = createLayerId();
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
    this.cache.set(id, data);
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

  async collect() {
    const retained = new Set([...this.current, ...this.pending, ...this.inUse, ...this.history.flatMap((entry) => entry.rasters)]);
    if (this.stroke) retained.add(this.stroke.version.id);
    const files = new Set();
    for (const [id, version] of this.versions) {
      if (!retained.has(id)) { this.versions.delete(id); continue; }
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

  async beginStroke({ layer, point, size, color, erase }) {
    if (this.stroke) throw new Error('Finish the current stroke first.');
    const original = this.version(layer.rasterId);
    const version = this.createVersion(original.width, original.height, original);
    this.stroke = { version, transform: layer.transform, size, color, erase, lastPoint: point };
    try { return await this.strokePoints({ points: [{ x: point.x + 0.01, y: point.y + 0.01 }] }); }
    catch (error) { await this.abortStroke(); throw error; }
  }

  async strokePoints({ points }) {
    const stroke = this.stroke;
    if (!stroke) throw Object.assign(new Error('The stroke was canceled.'), { name: 'AbortError' });
    const { version, size, transform } = stroke;
    const inverse = invertTransform(transform);
    const tiles = new Map();
    const dirtyRegions = [];
    let previous = stroke.lastPoint;
    for (const point of points) {
      const padding = size / 2 + 2;
      const bounds = pointBounds(rectPoints({
        x: Math.min(previous.x, point.x) - padding, y: Math.min(previous.y, point.y) - padding,
        width: Math.abs(previous.x - point.x) + padding * 2, height: Math.abs(previous.y - point.y) + padding * 2,
      }).map((p) => transformPoint(inverse, p)));
      dirtyRegions.push(bounds);
      for (let y = Math.max(0, Math.floor(bounds.y / TILE_SIZE)); y <= Math.min(Math.ceil(version.height / TILE_SIZE) - 1, Math.floor((bounds.y + bounds.height) / TILE_SIZE)); y += 1) {
        for (let x = Math.max(0, Math.floor(bounds.x / TILE_SIZE)); x <= Math.min(Math.ceil(version.width / TILE_SIZE) - 1, Math.floor((bounds.x + bounds.width) / TILE_SIZE)); x += 1) {
          const key = tileKey(x, y);
          if (!tiles.has(key)) tiles.set(key, []);
          tiles.get(key).push([previous, point]);
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
        await this.saveTile(version, 0, x, y, canvas);
      } finally { releaseCanvas(canvas); }
    }
    stroke.lastPoint = previous;
    await this.buildMips(version, new Set(tiles.keys()), dirtyRegions);
    await this.collect();
    return this.describe(version);
  }

  async finishStroke() {
    if (!this.stroke) return null;
    const result = this.describe(this.stroke.version);
    this.stroke = null;
    return result;
  }

  async abortStroke() {
    if (this.stroke) this.pending.delete(this.stroke.version.id);
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
    const level = Math.min(version.levels.length - 1, Math.max(0, Math.floor(Math.log2(reduction))));
    if (level > 0 && !version.mipsReady) await this.buildMips(version, new Set(version.levels[0].keys()));
    matrix = multiplyTransforms(matrix, [2 ** level, 0, 0, 2 ** level, 0, 0]);
    const inverse = invertTransform(matrix);
    const imageBounds = pointBounds(rectPoints(layer.sourceBounds).map((p) => transformPoint(multiplyTransforms(view, layer.transform), p)));
    const left = Math.max(0, Math.floor(imageBounds.x) - 2);
    const top = Math.max(0, Math.floor(imageBounds.y) - 2);
    const right = Math.min(width, Math.ceil(imageBounds.x + imageBounds.width) + 2);
    const bottom = Math.min(height, Math.ceil(imageBounds.y + imageBounds.height) + 2);
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
      const patch = await this.readRegion(version, level, sx, sy, sw, sh);
      try {
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
    finally { this.inUse.clear(); }
  }

  async render(options) {
    const canvas = await this.composite(options);
    try { return { bitmap: canvas.transferToImageBitmap() }; }
    finally { releaseCanvas(canvas); }
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
    this.inUse.clear(); this.droppedHistory.clear();
    await this.storage.dispose();
  }
}
