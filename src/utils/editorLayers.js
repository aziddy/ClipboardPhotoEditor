export const HISTORY_LIMIT = 30;
export const MAX_DIMENSION = 12000;

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const clampDimension = (value) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? clamp(number, 1, MAX_DIMENSION) : 1;
};

export const createDefaultTransformDraft = () => ({
  dx: 0,
  dy: 0,
  scaleX: 100,
  scaleY: 100,
  rotationDeg: 0,
});

export const createEmptyDocument = () => ({
  width: 0,
  height: 0,
  layers: [],
  activeLayerId: null,
});

export const hasDocument = (doc) => doc.width > 0 && doc.height > 0 && doc.layers.length > 0;

export const getActiveLayer = (doc) => (
  doc.layers.find((layer) => layer.id === doc.activeLayerId) || null
);

export const createCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = clampDimension(width);
  canvas.height = clampDimension(height);
  if (!canvas.getContext('2d')) {
    throw new Error('Could not allocate an image canvas. Try a smaller image.');
  }
  return canvas;
};

const cloneCanvas = (source) => {
  const canvas = createCanvas(source.width, source.height);
  canvas.getContext('2d').drawImage(source, 0, 0);
  return canvas;
};

// Canvas pixels are immutable in committed documents. Only pixel edits copy them.
export const cloneLayer = (layer) => ({
  ...layer,
  transform: [...layer.transform],
});

export const cloneDocument = (doc) => ({
  ...doc,
  layers: doc.layers.map(cloneLayer),
});

export const createLayerId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const createLayer = ({ name, width, height, x = 0, y = 0, draw }) => {
  const canvas = createCanvas(width, height);
  if (draw) draw(canvas.getContext('2d'), canvas);
  return {
    id: createLayerId(),
    name,
    canvas,
    // Canvas 2D matrix: native bitmap coordinates -> document coordinates.
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 100,
  };
};

export const createImageLayer = (image, doc, layerNumber) => {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Image has invalid dimensions.');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`Images must be ${MAX_DIMENSION.toLocaleString('en-US')} pixels or smaller on each side.`);
  }

  const isNewDocument = !hasDocument(doc);
  const scale = isNewDocument ? 1 : Math.min(1, doc.width / width, doc.height / height);
  const fittedWidth = Math.max(1, Math.round(width * scale));
  const fittedHeight = Math.max(1, Math.round(height * scale));
  const layer = createLayer({
    name: isNewDocument ? 'Background' : `Image ${layerNumber}`,
    width,
    height,
    draw: (ctx) => ctx.drawImage(image, 0, 0),
  });

  return {
    ...layer,
    transform: [
      fittedWidth / width, 0, 0, fittedHeight / height,
      isNewDocument ? 0 : Math.round((doc.width - fittedWidth) / 2),
      isNewDocument ? 0 : Math.round((doc.height - fittedHeight) / 2),
    ],
  };
};

// The editor's raster sources live in the worker; documents contain metadata only.
export const createRasterLayer = (source, doc, layerNumber) => {
  const { sourceWidth: width, sourceHeight: height } = source;
  const isNewDocument = !hasDocument(doc);
  const scale = isNewDocument ? 1 : Math.min(1, doc.width / width, doc.height / height);
  const fittedWidth = Math.max(1, Math.round(width * scale));
  const fittedHeight = Math.max(1, Math.round(height * scale));
  return {
    ...source, id: createLayerId(), name: isNewDocument ? 'Background' : `Image ${layerNumber}`,
    visible: true, opacity: 100,
    transform: [fittedWidth / width, 0, 0, fittedHeight / height,
      isNewDocument ? 0 : Math.round((doc.width - fittedWidth) / 2),
      isNewDocument ? 0 : Math.round((doc.height - fittedHeight) / 2)],
  };
};

// left * right applies right first, then left, without decomposing rotations/scales.
export const multiplyTransforms = (left, right) => {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h, b * g + d * h,
    a * i + c * j, b * i + d * j,
    a * k + c * l + e, b * k + d * l + f,
  ];
};

export const invertTransform = ([a, b, c, d, e, f]) => {
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) {
    throw new Error('The layer transform cannot be inverted.');
  }
  return [
    d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant,
  ];
};

export const transformPoint = ([a, b, c, d, e, f], { x, y }) => ({
  x: a * x + c * y + e,
  y: b * x + d * y + f,
});

export const translateLayer = (layer, dx, dy) => ({
  ...layer,
  transform: multiplyTransforms([1, 0, 0, 1, dx, dy], layer.transform),
});

const boundsCache = new WeakMap();

export const getLayerBounds = (canvas) => {
  if (boundsCache.has(canvas)) return boundsCache.get(canvas);
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let bounds;

  try {
    // Scan in strips to avoid another full-size RGBA allocation for large images.
    for (let top = 0; top < height; top += 256) {
      const rows = Math.min(256, height - top);
      const pixels = ctx.getImageData(0, top, width, rows).data;
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (pixels[(y * width + x) * 4 + 3] > 0) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, top + y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, top + y);
          }
        }
      }
    }
    bounds = maxX === -1 ? null : {
      x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1,
    };
  } catch (err) {
    bounds = { x: 0, y: 0, width, height };
  }
  boundsCache.set(canvas, bounds);
  return bounds;
};

const getBoundsFromPoints = (points) => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

export const getLayerDocumentBounds = (layer) => {
  const bounds = layer.rasterId ? layer.sourceBounds : getLayerBounds(layer.canvas);
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  return getBoundsFromPoints([
    { x, y }, { x: x + width, y },
    { x: x + width, y: y + height }, { x, y: y + height },
  ].map((point) => transformPoint(layer.transform, point)));
};

export const getLayerGroupBounds = (layers) => {
  const bounds = layers.map(getLayerDocumentBounds).filter(Boolean);
  if (bounds.length === 0) return null;
  return getBoundsFromPoints(bounds.flatMap(({ x, y, width, height }) => [
    { x, y }, { x: x + width, y: y + height },
  ]));
};

export const toRadians = (degrees) => degrees * Math.PI / 180;
export const toDegrees = (radians) => radians * 180 / Math.PI;

export const normalizeRotation = (degrees) => {
  let normalized = degrees % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
};

export const getDraftScaleX = (draft) => draft.scaleX ?? draft.scale ?? 100;
export const getDraftScaleY = (draft) => draft.scaleY ?? draft.scale ?? 100;
export const getDraftRotation = (draft) => draft.rotationDeg ?? 0;

export const hasTransform = (draft) => (
  Math.round(draft.dx ?? 0) !== 0 ||
  Math.round(draft.dy ?? 0) !== 0 ||
  Math.round(getDraftScaleX(draft)) !== 100 ||
  Math.round(getDraftScaleY(draft)) !== 100 ||
  Math.round(getDraftRotation(draft)) !== 0
);

export const rotateLocalPoint = (center, localPoint, rotationDeg) => {
  const angle = toRadians(rotationDeg);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: center.x + localPoint.x * cos - localPoint.y * sin,
    y: center.y + localPoint.x * sin + localPoint.y * cos,
  };
};

export const getLocalPoint = (point, center, rotationDeg) => {
  const angle = toRadians(rotationDeg);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
};

export const getTransformedGeometry = (layer, draft = createDefaultTransformDraft()) => {
  const bounds = getLayerDocumentBounds(layer);
  if (!bounds) return null;
  const width = Math.max(1, bounds.width * clamp(getDraftScaleX(draft), 1, 300) / 100);
  const height = Math.max(1, bounds.height * clamp(getDraftScaleY(draft), 1, 300) / 100);
  const center = {
    x: bounds.x + bounds.width / 2 + (draft.dx ?? 0),
    y: bounds.y + bounds.height / 2 + (draft.dy ?? 0),
  };
  const rotationDeg = getDraftRotation(draft);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const corners = {
    nw: rotateLocalPoint(center, { x: -halfWidth, y: -halfHeight }, rotationDeg),
    ne: rotateLocalPoint(center, { x: halfWidth, y: -halfHeight }, rotationDeg),
    se: rotateLocalPoint(center, { x: halfWidth, y: halfHeight }, rotationDeg),
    sw: rotateLocalPoint(center, { x: -halfWidth, y: halfHeight }, rotationDeg),
  };
  const handles = {
    ...corners,
    n: rotateLocalPoint(center, { x: 0, y: -halfHeight }, rotationDeg),
    e: rotateLocalPoint(center, { x: halfWidth, y: 0 }, rotationDeg),
    s: rotateLocalPoint(center, { x: 0, y: halfHeight }, rotationDeg),
    w: rotateLocalPoint(center, { x: -halfWidth, y: 0 }, rotationDeg),
  };
  return { bounds, center, width, height, rotationDeg, corners, handles };
};

export const applyLayerTransform = (layer, draft) => {
  if (!hasTransform(draft)) return layer;
  // Translations also work on empty layers and don't need to scan their pixels.
  if (getDraftScaleX(draft) === 100 && getDraftScaleY(draft) === 100 && getDraftRotation(draft) === 0) {
    return translateLayer(layer, draft.dx ?? 0, draft.dy ?? 0);
  }
  const geometry = getTransformedGeometry(layer, draft);
  if (!geometry) return translateLayer(layer, draft.dx ?? 0, draft.dy ?? 0);

  const { bounds, center, width, height, rotationDeg } = geometry;
  const cos = Math.cos(toRadians(rotationDeg));
  const sin = Math.sin(toRadians(rotationDeg));
  const a = cos * width / bounds.width;
  const b = sin * width / bounds.width;
  const c = -sin * height / bounds.height;
  const d = cos * height / bounds.height;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const draftTransform = [a, b, c, d, center.x - a * cx - c * cy, center.y - b * cx - d * cy];
  return { ...layer, transform: multiplyTransforms(draftTransform, layer.transform) };
};

export const renderLayer = (ctx, layer, transformDraft = null, resizeScale = null) => {
  const opacity = clamp(layer.opacity ?? 100, 0, 100) / 100;
  if (!layer.visible || opacity <= 0) return;
  const transformedLayer = transformDraft ? applyLayerTransform(layer, transformDraft) : layer;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (resizeScale) ctx.scale(resizeScale.x, resizeScale.y);
  ctx.transform(...transformedLayer.transform);
  ctx.drawImage(layer.canvas, 0, 0);
  ctx.restore();
};

export const renderDocument = (ctx, doc, options = {}) => {
  const dimensions = options.resizeDimensions || doc;
  const resizeScale = options.resizeDimensions
    ? { x: dimensions.width / doc.width, y: dimensions.height / doc.height }
    : null;
  ctx.clearRect(0, 0, dimensions.width, dimensions.height);
  doc.layers.forEach((layer) => {
    const shouldTransform = options.transformLayerIds
      ? options.transformLayerIds.has(layer.id)
      : layer.id === options.transformLayerId;
    renderLayer(ctx, layer, shouldTransform ? options.transformDraft : null, resizeScale);
  });
};

export const makeCompositeCanvas = (doc) => {
  if (!hasDocument(doc)) return null;
  const canvas = createCanvas(doc.width, doc.height);
  renderDocument(canvas.getContext('2d'), doc);
  return canvas;
};

export const renderLayerThumbnail = (ctx, layer, width, height) => {
  ctx.clearRect(0, 0, width, height);
  const bounds = getLayerDocumentBounds(layer);
  if (!bounds) return;
  const scale = Math.min(width / bounds.width, height / bounds.height);
  ctx.save();
  ctx.translate((width - bounds.width * scale) / 2, (height - bounds.height * scale) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-bounds.x, -bounds.y);
  renderLayer(ctx, { ...layer, visible: true });
  ctx.restore();
};

export const cropFromEdges = (left, top, right, bottom, doc) => {
  const x = clamp(Math.round(Math.min(left, right)), 0, doc.width - 1);
  const y = clamp(Math.round(Math.min(top, bottom)), 0, doc.height - 1);
  const endX = clamp(Math.round(Math.max(left, right)), x + 1, doc.width);
  const endY = clamp(Math.round(Math.max(top, bottom)), y + 1, doc.height);
  return { x, y, width: endX - x, height: endY - y };
};

export const cropDocument = (doc, crop) => {
  const safeCrop = cropFromEdges(crop.x, crop.y, crop.x + crop.width, crop.y + crop.height, doc);
  const layers = doc.layers.map((layer) => {
    const canvas = createCanvas(layer.canvas.width, layer.canvas.height);
    const ctx = canvas.getContext('2d');
    ctx.save();
    // Project the crop into native pixels, then copy those pixels without scaling.
    ctx.transform(...invertTransform(layer.transform));
    ctx.beginPath();
    ctx.rect(safeCrop.x, safeCrop.y, safeCrop.width, safeCrop.height);
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
    return translateLayer({ ...layer, canvas }, -safeCrop.x, -safeCrop.y);
  });
  return { ...doc, width: safeCrop.width, height: safeCrop.height, layers };
};

export const resizeDocument = (doc, width, height) => {
  const nextWidth = clampDimension(width);
  const nextHeight = clampDimension(height);
  const resizeTransform = [nextWidth / doc.width, 0, 0, nextHeight / doc.height, 0, 0];
  return {
    ...doc,
    width: nextWidth,
    height: nextHeight,
    layers: doc.layers.map((layer) => ({
      ...layer,
      transform: multiplyTransforms(resizeTransform, layer.transform),
    })),
  };
};

export const updateLayer = (doc, layerId, updater) => ({
  ...doc,
  layers: doc.layers.map((layer) => (layer.id === layerId ? updater(layer) : layer)),
});

export const beginLayerStroke = (layer, point, { size, color, erase = false }) => {
  const editableLayer = { ...cloneLayer(layer), canvas: cloneCanvas(layer.canvas) };
  const ctx = editableLayer.canvas.getContext('2d');
  ctx.save();
  // Both the path and brush width use document pixels, even for stretched layers.
  ctx.transform(...invertTransform(editableLayer.transform));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size;
  ctx.strokeStyle = color;
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.beginPath();
  ctx.moveTo(point.x, point.y);
  ctx.lineTo(point.x + 0.01, point.y + 0.01);
  ctx.stroke();
  return { layer: editableLayer, ctx, lastPoint: point };
};

export const continueLayerStroke = (stroke, point) => {
  stroke.ctx.beginPath();
  stroke.ctx.moveTo(stroke.lastPoint.x, stroke.lastPoint.y);
  stroke.ctx.lineTo(point.x, point.y);
  stroke.ctx.stroke();
  stroke.lastPoint = point;
  boundsCache.delete(stroke.layer.canvas);
};

export const finishLayerStroke = (stroke) => {
  stroke.ctx.closePath();
  stroke.ctx.restore();
  boundsCache.delete(stroke.layer.canvas);
};

export const editorReducer = (state, action) => {
  switch (action.type) {
    case 'commit': {
      const historyDoc = { ...cloneDocument(action.doc), revisionId: createLayerId() };
      const history = [...state.history.slice(0, state.historyIndex + 1), historyDoc].slice(-HISTORY_LIMIT);
      return {
        doc: cloneDocument(historyDoc),
        history,
        historyIndex: history.length - 1,
      };
    }
    case 'setDoc':
      return { ...state, doc: action.doc };
    case 'dropHistory': {
      const keys = new Set(action.keys);
      const currentKey = state.history[state.historyIndex]?.revisionId;
      const history = state.history.filter((doc) => !keys.has(doc.revisionId) || doc.revisionId === currentKey);
      return { ...state, history, historyIndex: history.findIndex((doc) => doc.revisionId === currentKey) };
    }
    case 'selectLayer':
      return { ...state, doc: { ...state.doc, activeLayerId: action.layerId } };
    case 'undo': {
      if (state.historyIndex <= 0) return state;
      const historyIndex = state.historyIndex - 1;
      return { ...state, doc: cloneDocument(state.history[historyIndex]), historyIndex };
    }
    case 'redo': {
      if (state.historyIndex >= state.history.length - 1) return state;
      const historyIndex = state.historyIndex + 1;
      return { ...state, doc: cloneDocument(state.history[historyIndex]), historyIndex };
    }
    case 'reset':
      return { doc: createEmptyDocument(), history: [], historyIndex: -1 };
    default:
      return state;
  }
};
