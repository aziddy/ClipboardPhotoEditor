import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  Grid,
  HStack,
  IconButton,
  Input,
  Progress,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Switch,
  Text,
  Textarea,
  Tooltip,
  VStack,
  useToast,
} from '@chakra-ui/react';
import {
  ArrowDown,
  ArrowUp,
  Brush,
  Check,
  Copy,
  Crop,
  Eraser,
  Eye,
  EyeOff,
  GripVertical,
  Hand,
  ImagePlus,
  Info,
  Layers,
  Maximize2,
  MousePointer2,
  Plus,
  Redo2,
  RotateCcw,
  ScanText,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useImageExportControls } from '../utils/useImageExportControls';
import { useBrowserOcr } from '../utils/useBrowserOcr';

const HISTORY_LIMIT = 30;
const MAX_DIMENSION = 12000;
const MIN_DIMENSION = 1;
const DEFAULT_BRUSH_COLOR = '#ff2b2b';
const LAYER_DRAG_TYPE = 'application/x-clipboard-photo-layer';
const VIEW_ZOOM_MIN = 25;
const VIEW_ZOOM_MAX = 400;
const VIEW_ZOOM_STEP = 25;
const VIEW_ZOOM_DEFAULT = 100;

const TOOLS = {
  MOVE: 'move',
  BRUSH: 'brush',
  ERASER: 'eraser',
  CROP: 'crop',
  RESIZE: 'resize',
  PAN: 'pan',
};

const TOOL_SHORTCUTS = {
  1: TOOLS.MOVE,
  m: TOOLS.MOVE,
  2: TOOLS.BRUSH,
  b: TOOLS.BRUSH,
  3: TOOLS.CROP,
  c: TOOLS.CROP,
  4: TOOLS.RESIZE,
  r: TOOLS.RESIZE,
  5: TOOLS.PAN,
  h: TOOLS.PAN,
};

const TRANSFORM_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const createDefaultTransformDraft = () => ({
  dx: 0,
  dy: 0,
  scaleX: 100,
  scaleY: 100,
  rotationDeg: 0,
});

const createEmptyDocument = () => ({
  width: 0,
  height: 0,
  layers: [],
  activeLayerId: null,
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const clampDimension = (value) => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return MIN_DIMENSION;
  return clamp(number, MIN_DIMENSION, MAX_DIMENSION);
};

const createDefaultViewOffset = () => ({ x: 0, y: 0 });

const areViewOffsetsEqual = (first, second) => (
  first.x === second.x && first.y === second.y
);

const createCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = clampDimension(width);
  canvas.height = clampDimension(height);
  return canvas;
};

const cloneCanvas = (sourceCanvas) => {
  const canvas = createCanvas(sourceCanvas.width, sourceCanvas.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);
  return canvas;
};

const cloneLayer = (layer) => ({
  ...layer,
  canvas: cloneCanvas(layer.canvas),
});

const cloneDocument = (doc) => ({
  width: doc.width,
  height: doc.height,
  activeLayerId: doc.activeLayerId,
  layers: doc.layers.map(cloneLayer),
});

const hasDocument = (doc) => doc.width > 0 && doc.height > 0 && doc.layers.length > 0;

const getActiveLayer = (doc) => (
  doc.layers.find((layer) => layer.id === doc.activeLayerId) || null
);

const createLayerId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const getLayerX = (layer) => layer.x ?? 0;

const getLayerY = (layer) => layer.y ?? 0;

const createLayer = ({ name, width, height, x = 0, y = 0, draw }) => {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (draw) {
    draw(ctx, canvas);
  }

  return {
    id: createLayerId(),
    name,
    canvas,
    x,
    y,
    visible: true,
    opacity: 100,
  };
};

const getFittedImageRect = (image, width, height) => {
  const scale = Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const drawHeight = Math.max(1, Math.round(image.naturalHeight * scale));

  return {
    x: Math.round((width - drawWidth) / 2),
    y: Math.round((height - drawHeight) / 2),
    width: drawWidth,
    height: drawHeight,
  };
};

const createImageLayer = (image, doc, layerNumber) => {
  const isNewDocument = !hasDocument(doc);
  const rect = isNewDocument
    ? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }
    : getFittedImageRect(image, doc.width, doc.height);

  return createLayer({
    name: isNewDocument ? 'Background' : `Image ${layerNumber}`,
    width: rect.width,
    height: rect.height,
    x: rect.x,
    y: rect.y,
    draw: (ctx) => {
      ctx.drawImage(image, 0, 0, rect.width, rect.height);
    },
  });
};

const getResizedLayerRect = (layer, scaleX, scaleY) => ({
  width: clampDimension(layer.canvas.width * scaleX),
  height: clampDimension(layer.canvas.height * scaleY),
  x: Math.round(getLayerX(layer) * scaleX),
  y: Math.round(getLayerY(layer) * scaleY),
});

const renderLayer = (ctx, layer, transformDraft = null, resizeScale = null) => {
  const opacity = clamp(layer.opacity ?? 100, 0, 100) / 100;
  if (!layer.visible || opacity <= 0) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  if (transformDraft && hasTransform(transformDraft)) {
    drawTransformedLayer(ctx, layer, transformDraft);
  } else if (resizeScale) {
    const rect = getResizedLayerRect(layer, resizeScale.x, resizeScale.y);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.canvas, rect.x, rect.y, rect.width, rect.height);
  } else {
    ctx.drawImage(layer.canvas, getLayerX(layer), getLayerY(layer));
  }

  ctx.restore();
};

const renderDocument = (ctx, doc, options = {}) => {
  const dimensions = options.resizeDimensions || doc;
  const resizeScale = options.resizeDimensions
    ? { x: dimensions.width / doc.width, y: dimensions.height / doc.height }
    : null;
  ctx.clearRect(0, 0, dimensions.width, dimensions.height);

  doc.layers.forEach((layer) => {
    const shouldTransform = options.transformLayerIds
      ? options.transformLayerIds.has(layer.id)
      : layer.id === options.transformLayerId;
    const transformDraft = shouldTransform
      ? options.transformDraft
      : null;
    renderLayer(ctx, layer, transformDraft, resizeScale);
  });
};

const makeCompositeCanvas = (doc) => {
  if (!hasDocument(doc)) return null;

  const canvas = createCanvas(doc.width, doc.height);
  const ctx = canvas.getContext('2d');
  renderDocument(ctx, doc);
  return canvas;
};

const createDefaultCrop = (doc) => {
  const insetX = Math.max(1, Math.round(doc.width * 0.1));
  const insetY = Math.max(1, Math.round(doc.height * 0.1));
  const width = Math.max(1, doc.width - insetX * 2);
  const height = Math.max(1, doc.height - insetY * 2);

  return {
    x: insetX,
    y: insetY,
    width,
    height,
  };
};

const cropFromEdges = (left, top, right, bottom, doc) => {
  let nextLeft = clamp(Math.min(left, right), 0, Math.max(0, doc.width - 1));
  let nextRight = clamp(Math.max(left, right), 1, doc.width);
  let nextTop = clamp(Math.min(top, bottom), 0, Math.max(0, doc.height - 1));
  let nextBottom = clamp(Math.max(top, bottom), 1, doc.height);

  if (nextRight - nextLeft < 1) {
    if (nextRight >= doc.width) {
      nextLeft = Math.max(0, nextRight - 1);
    } else {
      nextRight = Math.min(doc.width, nextLeft + 1);
    }
  }

  if (nextBottom - nextTop < 1) {
    if (nextBottom >= doc.height) {
      nextTop = Math.max(0, nextBottom - 1);
    } else {
      nextBottom = Math.min(doc.height, nextTop + 1);
    }
  }

  return {
    x: Math.round(nextLeft),
    y: Math.round(nextTop),
    width: Math.round(nextRight - nextLeft),
    height: Math.round(nextBottom - nextTop),
  };
};

const getCropHitMode = (crop, point, tolerance) => {
  if (!crop) return 'create';

  const left = crop.x;
  const right = crop.x + crop.width;
  const top = crop.y;
  const bottom = crop.y + crop.height;
  const nearLeft = Math.abs(point.x - left) <= tolerance;
  const nearRight = Math.abs(point.x - right) <= tolerance;
  const nearTop = Math.abs(point.y - top) <= tolerance;
  const nearBottom = Math.abs(point.y - bottom) <= tolerance;
  const inside = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;

  if (nearLeft && nearTop) return 'nw';
  if (nearRight && nearTop) return 'ne';
  if (nearLeft && nearBottom) return 'sw';
  if (nearRight && nearBottom) return 'se';
  if (nearLeft && inside) return 'w';
  if (nearRight && inside) return 'e';
  if (nearTop && inside) return 'n';
  if (nearBottom && inside) return 's';
  if (inside) return 'move';
  return 'create';
};

const moveCrop = (originCrop, dx, dy, doc) => {
  const x = clamp(originCrop.x + dx, 0, Math.max(0, doc.width - originCrop.width));
  const y = clamp(originCrop.y + dy, 0, Math.max(0, doc.height - originCrop.height));
  return {
    ...originCrop,
    x: Math.round(x),
    y: Math.round(y),
  };
};

const resizeCrop = (originCrop, mode, dx, dy, doc) => {
  let left = originCrop.x;
  let right = originCrop.x + originCrop.width;
  let top = originCrop.y;
  let bottom = originCrop.y + originCrop.height;

  if (mode.includes('w')) left += dx;
  if (mode.includes('e')) right += dx;
  if (mode.includes('n')) top += dy;
  if (mode.includes('s')) bottom += dy;

  return cropFromEdges(left, top, right, bottom, doc);
};

const drawCropOverlay = (ctx, doc, crop) => {
  if (!crop) return;

  const lineWidth = Math.max(2, Math.round(Math.min(doc.width, doc.height) / 500));
  const handleSize = Math.max(8, Math.round(Math.min(doc.width, doc.height) / 70));
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;

  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.46)';
  ctx.fillRect(0, 0, doc.width, crop.y);
  ctx.fillRect(0, bottom, doc.width, doc.height - bottom);
  ctx.fillRect(0, crop.y, crop.x, crop.height);
  ctx.fillRect(right, crop.y, doc.width - right, crop.height);

  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = lineWidth * 2;
  ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
  ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
  ctx.setLineDash([]);

  const handles = [
    [crop.x, crop.y],
    [right, crop.y],
    [crop.x, bottom],
    [right, bottom],
    [crop.x + crop.width / 2, crop.y],
    [crop.x + crop.width / 2, bottom],
    [crop.x, crop.y + crop.height / 2],
    [right, crop.y + crop.height / 2],
  ];

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#0f172a';
  handles.forEach(([x, y]) => {
    ctx.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
    ctx.strokeRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  });

  ctx.restore();
};

const getLayerBounds = (canvas) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  let pixels;

  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch (err) {
    return {
      x: 0,
      y: 0,
      width,
      height,
    };
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX === -1) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

const toRadians = (degrees) => degrees * Math.PI / 180;

const toDegrees = (radians) => radians * 180 / Math.PI;

const normalizeRotation = (degrees) => {
  let normalized = degrees % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
};

const getDraftScaleX = (draft) => draft.scaleX ?? draft.scale ?? 100;

const getDraftScaleY = (draft) => draft.scaleY ?? draft.scale ?? 100;

const getDraftRotation = (draft) => draft.rotationDeg ?? 0;

const hasTransform = (draft) => (
  Math.round(draft.dx) !== 0 ||
  Math.round(draft.dy) !== 0 ||
  Math.round(getDraftScaleX(draft)) !== 100 ||
  Math.round(getDraftScaleY(draft)) !== 100 ||
  Math.round(getDraftRotation(draft)) !== 0
);

const getLayerDocumentBounds = (layer) => {
  const bounds = getLayerBounds(layer.canvas);
  if (!bounds) return null;

  return {
    x: getLayerX(layer) + bounds.x,
    y: getLayerY(layer) + bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
};

const getLayerGroupBounds = (layers) => {
  const bounds = layers.map(getLayerDocumentBounds).filter(Boolean);
  if (bounds.length === 0) return null;

  const left = Math.min(...bounds.map((rect) => rect.x));
  const top = Math.min(...bounds.map((rect) => rect.y));
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
};

const getTranslationDraft = (draft) => ({
  ...createDefaultTransformDraft(),
  dx: draft?.dx ?? 0,
  dy: draft?.dy ?? 0,
});

const rotateLocalPoint = (center, localPoint, rotationDeg) => {
  const angle = toRadians(rotationDeg);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: center.x + localPoint.x * cos - localPoint.y * sin,
    y: center.y + localPoint.x * sin + localPoint.y * cos,
  };
};

const getLocalPoint = (point, center, rotationDeg) => {
  const angle = toRadians(rotationDeg);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  return {
    x: dx * cos + dy * sin,
    y: -dx * sin + dy * cos,
  };
};

const getTransformedGeometry = (layer, draft = createDefaultTransformDraft()) => {
  const bounds = getLayerDocumentBounds(layer);
  if (!bounds) return null;

  const scaleX = clamp(getDraftScaleX(draft), 1, 300) / 100;
  const scaleY = clamp(getDraftScaleY(draft), 1, 300) / 100;
  const width = Math.max(1, bounds.width * scaleX);
  const height = Math.max(1, bounds.height * scaleY);
  const center = {
    x: bounds.x + bounds.width / 2 + draft.dx,
    y: bounds.y + bounds.height / 2 + draft.dy,
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

  return {
    bounds,
    center,
    width,
    height,
    rotationDeg,
    corners,
    handles,
  };
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

const drawTransformedLayer = (ctx, layer, draft) => {
  const geometry = getTransformedGeometry(layer, draft);
  if (!geometry) return;

  ctx.save();
  ctx.translate(geometry.center.x, geometry.center.y);
  ctx.rotate(toRadians(geometry.rotationDeg));
  ctx.drawImage(
    layer.canvas,
    geometry.bounds.x - getLayerX(layer),
    geometry.bounds.y - getLayerY(layer),
    geometry.bounds.width,
    geometry.bounds.height,
    -geometry.width / 2,
    -geometry.height / 2,
    geometry.width,
    geometry.height
  );
  ctx.restore();
};

const rasterizeTransform = (layer, draft) => {
  const bounds = getLayerBounds(layer.canvas);
  if (!bounds) {
    return {
      ...layer,
      x: getLayerX(layer) + draft.dx,
      y: getLayerY(layer) + draft.dy,
    };
  }

  const geometry = getTransformedGeometry(layer, draft);
  if (!geometry) return layer;

  const transformedBounds = getBoundsFromPoints(Object.values(geometry.corners));
  const rasterX = Math.floor(transformedBounds.x) - 1;
  const rasterY = Math.floor(transformedBounds.y) - 1;
  const rasterRight = Math.ceil(transformedBounds.x + transformedBounds.width) + 1;
  const rasterBottom = Math.ceil(transformedBounds.y + transformedBounds.height) + 1;
  const nextWidth = Math.max(1, rasterRight - rasterX);
  const nextHeight = Math.max(1, rasterBottom - rasterY);
  const nextCanvas = createCanvas(nextWidth, nextHeight);
  const ctx = nextCanvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(geometry.center.x - rasterX, geometry.center.y - rasterY);
  ctx.rotate(toRadians(geometry.rotationDeg));
  ctx.drawImage(
    layer.canvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    -geometry.width / 2,
    -geometry.height / 2,
    geometry.width,
    geometry.height
  );

  return {
    ...layer,
    canvas: nextCanvas,
    x: rasterX,
    y: rasterY,
  };
};

const drawLayerBounds = (ctx, layer, draft, doc) => {
  const geometry = getTransformedGeometry(layer, draft);
  if (!geometry) return;

  const lineWidth = Math.max(2, Math.round(Math.min(doc.width, doc.height) / 600));
  const handleSize = Math.max(9, Math.round(Math.min(doc.width, doc.height) / 70));
  const { nw, ne, se, sw } = geometry.corners;

  ctx.save();
  ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#2563eb';
  ctx.beginPath();
  ctx.moveTo(nw.x, nw.y);
  ctx.lineTo(ne.x, ne.y);
  ctx.lineTo(se.x, se.y);
  ctx.lineTo(sw.x, sw.y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#1d4ed8';
  TRANSFORM_HANDLES.forEach((handle) => {
    const point = geometry.handles[handle];
    ctx.fillRect(point.x - handleSize / 2, point.y - handleSize / 2, handleSize, handleSize);
    ctx.strokeRect(point.x - handleSize / 2, point.y - handleSize / 2, handleSize, handleSize);
  });

  ctx.restore();
};

const drawLayerGroupBounds = (ctx, layers, draft, doc) => {
  const bounds = getLayerGroupBounds(layers);
  if (!bounds) return;

  const lineWidth = Math.max(2, Math.round(Math.min(doc.width, doc.height) / 600));
  const dx = draft?.dx ?? 0;
  const dy = draft?.dy ?? 0;

  ctx.save();
  ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#2563eb';
  ctx.strokeRect(bounds.x + dx, bounds.y + dy, bounds.width, bounds.height);
  ctx.restore();
};

const getDistance = (pointA, pointB) => (
  Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y)
);

const isPointInRect = (point, rect, padding = 0) => (
  point.x >= rect.x - padding &&
  point.x <= rect.x + rect.width + padding &&
  point.y >= rect.y - padding &&
  point.y <= rect.y + rect.height + padding
);

const getSelectionRectFromPoints = (startPoint, currentPoint) => {
  const left = Math.min(startPoint.x, currentPoint.x);
  const top = Math.min(startPoint.y, currentPoint.y);
  const right = Math.max(startPoint.x, currentPoint.x);
  const bottom = Math.max(startPoint.y, currentPoint.y);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
};

const getWordRect = (word) => ({
  x: word.bbox.x0,
  y: word.bbox.y0,
  width: word.bbox.x1 - word.bbox.x0,
  height: word.bbox.y1 - word.bbox.y0,
});

const isPointInOcrWord = (point, word) => (
  point.x >= word.bbox.x0 &&
  point.x <= word.bbox.x1 &&
  point.y >= word.bbox.y0 &&
  point.y <= word.bbox.y1
);

const doesRectIntersectOcrWord = (rect, word) => (
  rect.x <= word.bbox.x1 &&
  rect.x + rect.width >= word.bbox.x0 &&
  rect.y <= word.bbox.y1 &&
  rect.y + rect.height >= word.bbox.y0
);

const isPointInTransformBox = (point, geometry, padding = 0) => {
  const local = getLocalPoint(point, geometry.center, geometry.rotationDeg);

  return (
    local.x >= -geometry.width / 2 - padding &&
    local.x <= geometry.width / 2 + padding &&
    local.y >= -geometry.height / 2 - padding &&
    local.y <= geometry.height / 2 + padding
  );
};

const getTransformHit = (point, geometry, tolerance) => {
  const handle = TRANSFORM_HANDLES.find((handleId) => (
    getDistance(point, geometry.handles[handleId]) <= tolerance
  ));

  if (handle) {
    return { action: 'resize', handle };
  }

  if (isPointInTransformBox(point, geometry)) {
    return { action: 'move' };
  }

  if (isPointInTransformBox(point, geometry, tolerance * 3)) {
    return { action: 'rotate' };
  }

  return null;
};

const getAngleFromCenter = (center, point) => (
  toDegrees(Math.atan2(point.y - center.y, point.x - center.x))
);

const getResizeTransformDraft = (interaction, point, shiftKey) => {
  const { baseBounds, handle, startDraft, startGeometry } = interaction;
  const localPoint = getLocalPoint(point, startGeometry.center, startGeometry.rotationDeg);
  const minSize = 4;
  const moveWest = handle.includes('w');
  const moveEast = handle.includes('e');
  const moveNorth = handle.includes('n');
  const moveSouth = handle.includes('s');
  const movesHorizontally = moveWest || moveEast;
  const movesVertically = moveNorth || moveSouth;

  let left = -startGeometry.width / 2;
  let right = startGeometry.width / 2;
  let top = -startGeometry.height / 2;
  let bottom = startGeometry.height / 2;

  if (moveWest) left = Math.min(localPoint.x, right - minSize);
  if (moveEast) right = Math.max(localPoint.x, left + minSize);
  if (moveNorth) top = Math.min(localPoint.y, bottom - minSize);
  if (moveSouth) bottom = Math.max(localPoint.y, top + minSize);

  if (shiftKey) {
    const aspectRatio = startGeometry.width / startGeometry.height || 1;
    let width = right - left;
    let height = bottom - top;

    if (movesHorizontally && movesVertically) {
      const widthChange = Math.abs(width / startGeometry.width - 1);
      const heightChange = Math.abs(height / startGeometry.height - 1);

      if (widthChange >= heightChange) {
        height = Math.max(minSize, width / aspectRatio);
        if (moveNorth) {
          top = bottom - height;
        } else {
          bottom = top + height;
        }
      } else {
        width = Math.max(minSize, height * aspectRatio);
        if (moveWest) {
          left = right - width;
        } else {
          right = left + width;
        }
      }
    } else if (movesHorizontally) {
      height = Math.max(minSize, width / aspectRatio);
      top = -height / 2;
      bottom = height / 2;
    } else if (movesVertically) {
      width = Math.max(minSize, height * aspectRatio);
      left = -width / 2;
      right = width / 2;
    }
  }

  const width = Math.max(minSize, right - left);
  const height = Math.max(minSize, bottom - top);
  const localCenter = {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
  };
  const nextCenter = rotateLocalPoint(
    startGeometry.center,
    localCenter,
    startGeometry.rotationDeg
  );
  const baseCenter = {
    x: baseBounds.x + baseBounds.width / 2,
    y: baseBounds.y + baseBounds.height / 2,
  };

  return {
    ...startDraft,
    dx: nextCenter.x - baseCenter.x,
    dy: nextCenter.y - baseCenter.y,
    scaleX: clamp(width / baseBounds.width * 100, 1, 300),
    scaleY: clamp(height / baseBounds.height * 100, 1, 300),
    rotationDeg: startGeometry.rotationDeg,
  };
};

const cropDocument = (doc, crop) => {
  const safeCrop = cropFromEdges(crop.x, crop.y, crop.x + crop.width, crop.y + crop.height, doc);
  const layers = doc.layers.map((layer) => {
    const canvas = createCanvas(safeCrop.width, safeCrop.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(layer.canvas, getLayerX(layer) - safeCrop.x, getLayerY(layer) - safeCrop.y);

    return {
      ...layer,
      canvas,
      x: 0,
      y: 0,
    };
  });

  return {
    ...doc,
    width: safeCrop.width,
    height: safeCrop.height,
    layers,
  };
};

const resizeDocument = (doc, width, height) => {
  const nextWidth = clampDimension(width);
  const nextHeight = clampDimension(height);
  const scaleX = nextWidth / doc.width;
  const scaleY = nextHeight / doc.height;

  const layers = doc.layers.map((layer) => {
    const rect = getResizedLayerRect(layer, scaleX, scaleY);
    const canvas = createCanvas(rect.width, rect.height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height);

    return {
      ...layer,
      canvas,
      x: rect.x,
      y: rect.y,
    };
  });

  return {
    ...doc,
    width: nextWidth,
    height: nextHeight,
    layers,
  };
};

const getLayerPoint = (layer, point) => ({
  x: point.x - getLayerX(layer),
  y: point.y - getLayerY(layer),
});

const updateLayer = (doc, layerId, updater) => ({
  ...doc,
  layers: doc.layers.map((layer) => (
    layer.id === layerId ? updater(layer) : layer
  )),
});

const getUniqueLayerIds = (layerIds) => (
  Array.from(new Set(layerIds.filter(Boolean)))
);

const areLayerIdListsEqual = (first, second) => (
  first.length === second.length && first.every((layerId, index) => layerId === second[index])
);

const reorderLayer = (doc, draggedLayerId, targetLayerId, placement) => {
  if (!draggedLayerId || !targetLayerId || draggedLayerId === targetLayerId) return doc;

  const draggedLayer = doc.layers.find((layer) => layer.id === draggedLayerId);
  if (!draggedLayer) return doc;

  const layersWithoutDragged = doc.layers.filter((layer) => layer.id !== draggedLayerId);
  const targetIndex = layersWithoutDragged.findIndex((layer) => layer.id === targetLayerId);
  if (targetIndex === -1) return doc;

  const nextIndex = placement === 'before' ? targetIndex + 1 : targetIndex;
  const layers = [...layersWithoutDragged];
  layers.splice(nextIndex, 0, draggedLayer);

  const isUnchanged = layers.every((layer, index) => layer.id === doc.layers[index]?.id);
  if (isUnchanged) return doc;

  return {
    ...doc,
    layers,
    activeLayerId: draggedLayerId,
  };
};

const editorReducer = (state, action) => {
  switch (action.type) {
    case 'commit': {
      const stateDoc = cloneDocument(action.doc);
      const historyDoc = cloneDocument(action.doc);
      const baseHistory = state.history.slice(0, state.historyIndex + 1);
      let history = [...baseHistory, historyDoc];

      if (history.length > HISTORY_LIMIT) {
        history = history.slice(history.length - HISTORY_LIMIT);
      }

      return {
        doc: stateDoc,
        history,
        historyIndex: history.length - 1,
      };
    }

    case 'setDoc':
      return {
        ...state,
        doc: action.doc,
      };

    case 'selectLayer':
      return {
        ...state,
        doc: {
          ...state.doc,
          activeLayerId: action.layerId,
        },
      };

    case 'undo': {
      if (state.historyIndex <= 0) return state;
      const historyIndex = state.historyIndex - 1;
      return {
        ...state,
        doc: cloneDocument(state.history[historyIndex]),
        historyIndex,
      };
    }

    case 'redo': {
      if (state.historyIndex >= state.history.length - 1) return state;
      const historyIndex = state.historyIndex + 1;
      return {
        ...state,
        doc: cloneDocument(state.history[historyIndex]),
        historyIndex,
      };
    }

    case 'reset':
      return {
        doc: createEmptyDocument(),
        history: [],
        historyIndex: -1,
      };

    default:
      return state;
  }
};

const loadImage = (url) => (
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  })
);

const isEditableShortcutTarget = (target) => {
  if (!target) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName?.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
};

const ToolButton = ({ icon: Icon, label, isActive, onClick, isDisabled = false }) => (
  <Tooltip label={label} placement="right" hasArrow>
    <IconButton
      aria-label={label}
      icon={<Icon size={18} />}
      onClick={onClick}
      isDisabled={isDisabled}
      variant={isActive ? 'solid' : 'ghost'}
      colorScheme={isActive ? 'blue' : 'gray'}
      size="sm"
    />
  </Tooltip>
);

const LayerThumbnail = ({ layer }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.globalAlpha = clamp(layer.opacity ?? 100, 0, 100) / 100;

    const scale = Math.min(canvas.width / layer.canvas.width, canvas.height / layer.canvas.height);
    const width = layer.canvas.width * scale;
    const height = layer.canvas.height * scale;
    ctx.drawImage(
      layer.canvas,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height
    );
    ctx.restore();
  }, [layer]);

  return (
    <canvas
      ref={canvasRef}
      width={64}
      height={44}
      style={{
        width: '64px',
        height: '44px',
        border: '1px solid #cbd5e1',
        backgroundColor: '#f8fafc',
        backgroundImage:
          'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)',
        backgroundSize: '12px 12px',
        backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
      }}
    />
  );
};

function UnifiedPhotoEditor() {
  const toast = useToast();
  const fileInputRef = useRef(null);
  const viewportRef = useRef(null);
  const displayCanvasRef = useRef(null);
  const interactionRef = useRef(null);
  const docRef = useRef(createEmptyDocument());
  const cropRef = useRef(null);
  const transformDraftRef = useRef(createDefaultTransformDraft());
  const selectedLayerIdsRef = useRef([]);
  const viewZoomRef = useRef(VIEW_ZOOM_DEFAULT);
  const viewOffsetRef = useRef(createDefaultViewOffset());
  const previousDocumentSizeRef = useRef({ width: 0, height: 0, hasDocument: false });
  const visualSignatureRef = useRef('');
  const layerCanvasIdsRef = useRef(new WeakMap());
  const nextLayerCanvasIdRef = useRef(1);

  const [{ doc, history, historyIndex }, dispatch] = useReducer(editorReducer, {
    doc: createEmptyDocument(),
    history: [],
    historyIndex: -1,
  });

  const [activeTool, setActiveTool] = useState(TOOLS.MOVE);
  const [brushColor, setBrushColor] = useState(DEFAULT_BRUSH_COLOR);
  const [brushSize, setBrushSize] = useState(8);
  const [crop, setCrop] = useState(null);
  const [aspectLocked, setAspectLocked] = useState(true);
  const [resizeDraft, setResizeDraft] = useState({ width: 0, height: 0, scale: 100 });
  const [transformDraft, setTransformDraft] = useState(createDefaultTransformDraft());
  const [viewZoom, setViewZoom] = useState(VIEW_ZOOM_DEFAULT);
  const [viewOffset, setViewOffset] = useState(createDefaultViewOffset);
  const [isSpacePanning, setIsSpacePanning] = useState(false);
  const [isViewDragging, setIsViewDragging] = useState(false);
  const [draggedLayerId, setDraggedLayerId] = useState(null);
  const [layerDropTarget, setLayerDropTarget] = useState(null);
  const [selectedLayerIds, setSelectedLayerIds] = useState([]);
  const [ocrDragSelection, setOcrDragSelection] = useState(null);

  const activeLayer = useMemo(() => getActiveLayer(doc), [doc]);
  const selectedLayerIdSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
  const selectedMoveLayers = useMemo(() => (
    doc.layers.filter((layer) => selectedLayerIdSet.has(layer.id))
  ), [doc.layers, selectedLayerIdSet]);
  const hasMultiLayerSelection = selectedMoveLayers.length > 1;
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;
  const documentWidth = doc.width;
  const documentHeight = doc.height;
  const documentLayerCount = doc.layers.length;
  const isResizePreview = activeTool === TOOLS.RESIZE && hasDocument(doc) && (
    resizeDraft.width !== doc.width || resizeDraft.height !== doc.height
  );
  const displayWidth = isResizePreview ? clampDimension(resizeDraft.width) : doc.width;
  const displayHeight = isResizePreview ? clampDimension(resizeDraft.height) : doc.height;
  const documentVisualSignature = useMemo(() => {
    if (!hasDocument(doc)) return 'empty';

    const layerSignatures = doc.layers.map((layer, index) => {
      let canvasId = layerCanvasIdsRef.current.get(layer.canvas);
      if (!canvasId) {
        canvasId = nextLayerCanvasIdRef.current;
        nextLayerCanvasIdRef.current += 1;
        layerCanvasIdsRef.current.set(layer.canvas, canvasId);
      }

      return [
        index,
        layer.id,
        getLayerX(layer),
        getLayerY(layer),
        layer.visible ? 1 : 0,
        layer.opacity ?? 100,
        layer.canvas.width,
        layer.canvas.height,
        canvasId,
      ].join(':');
    });

    return `${doc.width}x${doc.height}|${layerSignatures.join('|')}`;
  }, [doc]);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

  useEffect(() => {
    transformDraftRef.current = transformDraft;
  }, [transformDraft]);

  useEffect(() => {
    selectedLayerIdsRef.current = selectedLayerIds;
  }, [selectedLayerIds]);

  useEffect(() => {
    viewZoomRef.current = viewZoom;
  }, [viewZoom]);

  useEffect(() => {
    viewOffsetRef.current = viewOffset;
  }, [viewOffset]);

  useEffect(() => {
    const layerIds = new Set(doc.layers.map((layer) => layer.id));
    let nextSelectedLayerIds = selectedLayerIdsRef.current.filter((layerId) => (
      layerIds.has(layerId)
    ));

    if (doc.activeLayerId && !nextSelectedLayerIds.includes(doc.activeLayerId)) {
      nextSelectedLayerIds = [doc.activeLayerId];
    }

    if (!hasDocument(doc)) {
      nextSelectedLayerIds = [];
    }

    if (areLayerIdListsEqual(nextSelectedLayerIds, selectedLayerIdsRef.current)) return;

    selectedLayerIdsRef.current = nextSelectedLayerIds;
    setSelectedLayerIds(nextSelectedLayerIds);
  }, [doc]);

  const commitDocument = useCallback((nextDoc) => {
    docRef.current = nextDoc;
    dispatch({ type: 'commit', doc: nextDoc });
  }, []);

  const setDocumentTransient = useCallback((nextDoc) => {
    docRef.current = nextDoc;
    dispatch({ type: 'setDoc', doc: nextDoc });
  }, []);

  const updateSelectedLayerIds = useCallback((layerIds) => {
    const nextLayerIds = getUniqueLayerIds(layerIds);
    selectedLayerIdsRef.current = nextLayerIds;
    setSelectedLayerIds(nextLayerIds);
  }, []);

  const resetTransformDraft = useCallback(() => {
    const nextDraft = createDefaultTransformDraft();
    transformDraftRef.current = nextDraft;
    setTransformDraft(nextDraft);
  }, []);

  const getViewBounds = useCallback((
    targetZoom = viewZoomRef.current,
    renderedZoom = viewZoomRef.current
  ) => {
    const viewport = viewportRef.current;
    const canvas = displayCanvasRef.current;
    if (!viewport || !canvas || !hasDocument(docRef.current)) {
      return { maxX: 0, maxY: 0 };
    }

    const viewportRect = viewport.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const renderedZoomFactor = Math.max(renderedZoom / 100, 0.01);
    const targetZoomFactor = targetZoom / 100;
    const baseWidth = canvasRect.width / renderedZoomFactor;
    const baseHeight = canvasRect.height / renderedZoomFactor;
    const scaledWidth = baseWidth * targetZoomFactor;
    const scaledHeight = baseHeight * targetZoomFactor;

    return {
      maxX: Math.max(0, (scaledWidth - viewportRect.width) / 2),
      maxY: Math.max(0, (scaledHeight - viewportRect.height) / 2),
    };
  }, []);

  const clampViewOffset = useCallback((
    offset,
    targetZoom = viewZoomRef.current,
    renderedZoom = viewZoomRef.current
  ) => {
    const bounds = getViewBounds(targetZoom, renderedZoom);
    return {
      x: clamp(offset.x, -bounds.maxX, bounds.maxX),
      y: clamp(offset.y, -bounds.maxY, bounds.maxY),
    };
  }, [getViewBounds]);

  const updateViewOffset = useCallback((nextOffset) => {
    setViewOffset((current) => {
      const rawOffset = typeof nextOffset === 'function' ? nextOffset(current) : nextOffset;
      const clampedOffset = clampViewOffset(rawOffset);
      viewOffsetRef.current = clampedOffset;
      return areViewOffsetsEqual(current, clampedOffset) ? current : clampedOffset;
    });
  }, [clampViewOffset]);

  const updateViewZoom = useCallback((nextZoom) => {
    const renderedZoom = viewZoomRef.current;
    const clampedZoom = clamp(Math.round(nextZoom), VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);

    setViewZoom(clampedZoom);
    setViewOffset((current) => {
      const clampedOffset = clampViewOffset(current, clampedZoom, renderedZoom);
      viewOffsetRef.current = clampedOffset;
      return areViewOffsetsEqual(current, clampedOffset) ? current : clampedOffset;
    });
    viewZoomRef.current = clampedZoom;
  }, [clampViewOffset]);

  const resetView = useCallback(() => {
    const defaultOffset = createDefaultViewOffset();
    viewZoomRef.current = VIEW_ZOOM_DEFAULT;
    viewOffsetRef.current = defaultOffset;
    setViewZoom(VIEW_ZOOM_DEFAULT);
    setViewOffset(defaultOffset);
  }, []);

  const zoomIn = useCallback(() => {
    updateViewZoom(viewZoomRef.current + VIEW_ZOOM_STEP);
  }, [updateViewZoom]);

  const zoomOut = useCallback(() => {
    updateViewZoom(viewZoomRef.current - VIEW_ZOOM_STEP);
  }, [updateViewZoom]);

  const getCompositeCanvas = useCallback(() => makeCompositeCanvas(doc), [doc]);

  const {
    updateOutputSizes,
    resetExportState,
    ExportControls,
  } = useImageExportControls(getCompositeCanvas, toast, 'edited');
  const {
    ocrText,
    ocrWords,
    selectedOcrWordIds,
    selectedOcrText,
    ocrStatus,
    ocrStatusLabel,
    ocrProgress,
    ocrError,
    ocrConfidence,
    isOcrRunning,
    runOcr,
    cancelOcr,
    clearOcr,
    clearOcrSelection,
    setSelectedOcrWordIds,
    setOcrText,
  } = useBrowserOcr();
  const selectedOcrWordIdSet = useMemo(() => (
    new Set(selectedOcrWordIds)
  ), [selectedOcrWordIds]);
  const isViewPanning = activeTool === TOOLS.PAN || isSpacePanning;

  useEffect(() => {
    const previousSignature = visualSignatureRef.current;
    visualSignatureRef.current = documentVisualSignature;

    if (!previousSignature || previousSignature === documentVisualSignature) return;

    setOcrDragSelection(null);
    cancelOcr();
    clearOcr();
  }, [cancelOcr, clearOcr, documentVisualSignature]);

  const undoDocument = useCallback(() => {
    interactionRef.current = null;
    resetTransformDraft();
    dispatch({ type: 'undo' });
  }, [resetTransformDraft]);

  const redoDocument = useCallback(() => {
    interactionRef.current = null;
    resetTransformDraft();
    dispatch({ type: 'redo' });
  }, [resetTransformDraft]);

  const renderDisplay = useCallback(() => {
    const canvas = displayCanvasRef.current;
    if (!canvas || !hasDocument(doc)) return;

    if (canvas.width !== displayWidth) canvas.width = displayWidth;
    if (canvas.height !== displayHeight) canvas.height = displayHeight;

    const ctx = canvas.getContext('2d');
    const isGroupMove = activeTool === TOOLS.MOVE && hasMultiLayerSelection;
    const transformDraftForRender = isGroupMove
      ? getTranslationDraft(transformDraft)
      : transformDraft;
    const transformLayerId = activeTool === TOOLS.MOVE && !isGroupMove ? doc.activeLayerId : null;
    const transformLayerIds = isGroupMove
      ? new Set(selectedMoveLayers.map((layer) => layer.id))
      : null;
    renderDocument(ctx, doc, {
      resizeDimensions: isResizePreview ? { width: displayWidth, height: displayHeight } : null,
      transformLayerId,
      transformLayerIds,
      transformDraft: transformDraftForRender,
    });

    if (isGroupMove) {
      drawLayerGroupBounds(ctx, selectedMoveLayers, transformDraftForRender, doc);
    } else if (activeTool === TOOLS.MOVE && activeLayer) {
      drawLayerBounds(ctx, activeLayer, transformDraftForRender, doc);
    }

    if (activeTool === TOOLS.CROP) {
      drawCropOverlay(ctx, doc, crop);
    }
  }, [activeLayer, activeTool, crop, displayHeight, displayWidth, doc, hasMultiLayerSelection, isResizePreview, selectedMoveLayers, transformDraft]);

  useEffect(() => {
    renderDisplay();
  }, [renderDisplay]);

  useEffect(() => {
    updateOutputSizes();
  }, [doc, updateOutputSizes]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (isEditableShortcutTarget(event.target)) return;
      const key = event.key.toLowerCase();

      if (event.metaKey && key === 'z') {
        event.preventDefault();

        if (event.shiftKey) {
          redoDocument();
        } else {
          undoDocument();
        }
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const nextTool = TOOL_SHORTCUTS[key];
      if (!nextTool || !hasDocument(docRef.current)) return;

      event.preventDefault();
      setActiveTool(nextTool);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [redoDocument, undoDocument]);

  useEffect(() => {
    const isSpaceKey = (event) => event.code === 'Space' || event.key === ' ';

    const handleSpaceKeyDown = (event) => {
      if (!isSpaceKey(event) || isEditableShortcutTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!hasDocument(docRef.current)) return;

      event.preventDefault();
      if (!event.repeat) setIsSpacePanning(true);
    };

    const handleSpaceKeyUp = (event) => {
      if (!isSpaceKey(event)) return;

      event.preventDefault();
      setIsSpacePanning(false);
    };

    const handleWindowBlur = () => {
      setIsSpacePanning(false);
    };

    window.addEventListener('keydown', handleSpaceKeyDown);
    window.addEventListener('keyup', handleSpaceKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keydown', handleSpaceKeyDown);
      window.removeEventListener('keyup', handleSpaceKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    const nextDocumentSize = {
      width: documentWidth,
      height: documentHeight,
      hasDocument: documentWidth > 0 && documentHeight > 0 && documentLayerCount > 0,
    };
    const previousDocumentSize = previousDocumentSizeRef.current;
    previousDocumentSizeRef.current = nextDocumentSize;

    if (!nextDocumentSize.hasDocument) {
      resetView();
      return;
    }

    if (
      !previousDocumentSize.hasDocument ||
      previousDocumentSize.width !== nextDocumentSize.width ||
      previousDocumentSize.height !== nextDocumentSize.height
    ) {
      resetView();
    }
  }, [documentHeight, documentLayerCount, documentWidth, resetView]);

  useEffect(() => {
    const clampOffsetToViewport = () => updateViewOffset((current) => current);

    clampOffsetToViewport();
    window.addEventListener('resize', clampOffsetToViewport);
    return () => window.removeEventListener('resize', clampOffsetToViewport);
  }, [displayHeight, displayWidth, updateViewOffset]);

  useEffect(() => {
    if (documentWidth <= 0 || documentHeight <= 0 || documentLayerCount === 0) {
      setResizeDraft({ width: 0, height: 0, scale: 100 });
      return;
    }

    setResizeDraft({
      width: documentWidth,
      height: documentHeight,
      scale: 100,
    });
  }, [documentWidth, documentHeight, documentLayerCount]);

  useEffect(() => {
    resetTransformDraft();
  }, [activeTool, doc.activeLayerId, resetTransformDraft, selectedLayerIds]);

  useEffect(() => {
    if (activeTool !== TOOLS.CROP || !hasDocument(doc)) return;
    if (!crop || crop.width > doc.width || crop.height > doc.height) {
      setCrop(createDefaultCrop(doc));
    }
  }, [activeTool, crop, doc]);

  const importImageUrl = useCallback(async (url) => {
    try {
      const image = await loadImage(url);
      if (image.naturalWidth < 1 || image.naturalHeight < 1) {
        throw new Error('Image has invalid dimensions');
      }

      const currentDoc = docRef.current;
      const layer = createImageLayer(image, currentDoc, currentDoc.layers.length + 1);
      const nextDoc = hasDocument(currentDoc)
        ? {
            ...currentDoc,
            layers: [...currentDoc.layers, layer],
            activeLayerId: layer.id,
          }
        : {
            width: image.naturalWidth,
            height: image.naturalHeight,
            layers: [layer],
            activeLayerId: layer.id,
          };

      commitDocument(nextDoc);
      updateSelectedLayerIds([layer.id]);
      setCrop(null);
      setActiveTool(TOOLS.BRUSH);
      toast({
        title: hasDocument(currentDoc) ? 'Layer added' : 'Image loaded',
        description: hasDocument(currentDoc)
          ? 'The image was added as a new raster layer.'
          : 'The image is ready to edit.',
        status: 'success',
        duration: 2200,
        isClosable: true,
      });
    } catch (err) {
      toast({
        title: 'Import failed',
        description: 'Could not load that image.',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    } finally {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    }
  }, [commitDocument, toast, updateSelectedLayerIds]);

  const handleFiles = useCallback((files) => {
    const file = Array.from(files || []).find((candidate) => candidate.type.startsWith('image/'));
    if (!file) {
      toast({
        title: 'No image found',
        description: 'Choose an image file to import.',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
      return;
    }

    importImageUrl(URL.createObjectURL(file));
  }, [importImageUrl, toast]);

  const handleFileInputChange = useCallback((event) => {
    handleFiles(event.target.files);
    event.target.value = '';
  }, [handleFiles]);

  const handlePaste = useCallback((event) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;

    event.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    importImageUrl(URL.createObjectURL(blob));
  }, [importImageUrl]);

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    handleFiles(event.dataTransfer.files);
  }, [handleFiles]);

  const updateLayerMeta = useCallback((layerId, changes, saveToHistory = true) => {
    const currentDoc = docRef.current;
    const nextDoc = updateLayer(currentDoc, layerId, (layer) => ({
      ...layer,
      ...changes,
    }));

    if (saveToHistory) {
      commitDocument(nextDoc);
    } else {
      setDocumentTransient(nextDoc);
    }
  }, [commitDocument, setDocumentTransient]);

  const addBlankLayer = useCallback(() => {
    const currentDoc = docRef.current;
    if (!hasDocument(currentDoc)) {
      toast({
        title: 'Import an image first',
        description: 'A document size is needed before adding blank layers.',
        status: 'info',
        duration: 2600,
        isClosable: true,
      });
      return;
    }

    const layer = createLayer({
      name: `Layer ${currentDoc.layers.length + 1}`,
      width: currentDoc.width,
      height: currentDoc.height,
    });
    commitDocument({
      ...currentDoc,
      layers: [...currentDoc.layers, layer],
      activeLayerId: layer.id,
    });
    updateSelectedLayerIds([layer.id]);
  }, [commitDocument, toast, updateSelectedLayerIds]);

  const duplicateActiveLayer = useCallback(() => {
    const currentDoc = docRef.current;
    const layer = getActiveLayer(currentDoc);
    if (!layer) return;

    const index = currentDoc.layers.findIndex((candidate) => candidate.id === layer.id);
    const duplicate = {
      ...cloneLayer(layer),
      id: createLayerId(),
      name: `${layer.name} copy`,
    };
    const layers = [...currentDoc.layers];
    layers.splice(index + 1, 0, duplicate);
    commitDocument({
      ...currentDoc,
      layers,
      activeLayerId: duplicate.id,
    });
    updateSelectedLayerIds([duplicate.id]);
  }, [commitDocument, updateSelectedLayerIds]);

  const deleteActiveLayer = useCallback(() => {
    const currentDoc = docRef.current;
    const layer = getActiveLayer(currentDoc);
    if (!layer) return;

    if (currentDoc.layers.length === 1) {
      commitDocument(createEmptyDocument());
      updateSelectedLayerIds([]);
      setCrop(null);
      return;
    }

    const index = currentDoc.layers.findIndex((candidate) => candidate.id === layer.id);
    const layers = currentDoc.layers.filter((candidate) => candidate.id !== layer.id);
    const fallbackLayer = layers[Math.min(index, layers.length - 1)];
    commitDocument({
      ...currentDoc,
      layers,
      activeLayerId: fallbackLayer.id,
    });
    updateSelectedLayerIds([fallbackLayer.id]);
  }, [commitDocument, updateSelectedLayerIds]);

  const moveActiveLayer = useCallback((direction) => {
    const currentDoc = docRef.current;
    const index = currentDoc.layers.findIndex((layer) => layer.id === currentDoc.activeLayerId);
    if (index === -1) return;

    const nextIndex = direction === 'up' ? index + 1 : index - 1;
    if (nextIndex < 0 || nextIndex >= currentDoc.layers.length) return;

    const layers = [...currentDoc.layers];
    const [layer] = layers.splice(index, 1);
    layers.splice(nextIndex, 0, layer);
    commitDocument({
      ...currentDoc,
      layers,
    });
  }, [commitDocument]);

  const getCanvasPoint = useCallback((event, shouldClamp = true) => {
    const canvas = displayCanvasRef.current;
    const currentDoc = docRef.current;
    if (!canvas || !hasDocument(currentDoc)) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const point = {
      x: (event.clientX - rect.left) * currentDoc.width / rect.width,
      y: (event.clientY - rect.top) * currentDoc.height / rect.height,
    };

    if (!shouldClamp) return point;

    return {
      x: clamp(point.x, 0, currentDoc.width),
      y: clamp(point.y, 0, currentDoc.height),
    };
  }, []);

  const startStroke = useCallback((event) => {
    const currentDoc = docRef.current;
    const layer = getActiveLayer(currentDoc);
    const point = getCanvasPoint(event);
    if (!layer || !point) return;

    if (!layer.visible) {
      toast({
        title: 'Layer hidden',
        description: 'Make the active layer visible before drawing on it.',
        status: 'info',
        duration: 2200,
        isClosable: true,
      });
      return;
    }

    const ctx = layer.canvas.getContext('2d');
    const layerPoint = getLayerPoint(layer, point);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    ctx.strokeStyle = brushColor;
    ctx.globalCompositeOperation = activeTool === TOOLS.ERASER ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.moveTo(layerPoint.x, layerPoint.y);
    ctx.lineTo(layerPoint.x + 0.01, layerPoint.y + 0.01);
    ctx.stroke();

    interactionRef.current = {
      type: 'stroke',
      pointerId: event.pointerId,
      ctx,
      layerId: layer.id,
    };
    renderDisplay();
  }, [activeTool, brushColor, brushSize, getCanvasPoint, renderDisplay, toast]);

  const continueStroke = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.type !== 'stroke') return;

    const point = getCanvasPoint(event);
    if (!point) return;
    const layer = docRef.current.layers.find((candidate) => candidate.id === interaction.layerId);
    if (!layer) return;
    const layerPoint = getLayerPoint(layer, point);

    interaction.ctx.lineTo(layerPoint.x, layerPoint.y);
    interaction.ctx.stroke();
    renderDisplay();
  }, [getCanvasPoint, renderDisplay]);

  const finishStroke = useCallback(() => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.type !== 'stroke') return;

    interaction.ctx.closePath();
    interaction.ctx.restore();
    interactionRef.current = null;
    commitDocument(docRef.current);
  }, [commitDocument]);

  const startCropInteraction = useCallback((event) => {
    const currentDoc = docRef.current;
    const point = getCanvasPoint(event);
    const canvas = displayCanvasRef.current;
    if (!point || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const tolerance = Math.max(
      6,
      Math.min(currentDoc.width / rect.width, currentDoc.height / rect.height) * 10
    );
    const currentCrop = cropRef.current || createDefaultCrop(currentDoc);
    const mode = getCropHitMode(currentCrop, point, tolerance);
    const originCrop = mode === 'create'
      ? cropFromEdges(point.x, point.y, point.x + 1, point.y + 1, currentDoc)
      : currentCrop;

    if (mode === 'create') {
      setCrop(originCrop);
    }

    interactionRef.current = {
      type: 'crop',
      pointerId: event.pointerId,
      mode,
      startPoint: point,
      originCrop,
    };
  }, [getCanvasPoint]);

  const continueCropInteraction = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.type !== 'crop') return;

    const currentDoc = docRef.current;
    const point = getCanvasPoint(event);
    if (!point) return;

    const dx = point.x - interaction.startPoint.x;
    const dy = point.y - interaction.startPoint.y;

    if (interaction.mode === 'create') {
      setCrop(cropFromEdges(
        interaction.startPoint.x,
        interaction.startPoint.y,
        point.x,
        point.y,
        currentDoc
      ));
      return;
    }

    if (interaction.mode === 'move') {
      setCrop(moveCrop(interaction.originCrop, dx, dy, currentDoc));
      return;
    }

    setCrop(resizeCrop(interaction.originCrop, interaction.mode, dx, dy, currentDoc));
  }, [getCanvasPoint]);

  const finishCropInteraction = useCallback(() => {
    if (interactionRef.current?.type === 'crop') {
      interactionRef.current = null;
    }
  }, []);

  const startMoveInteraction = useCallback((event) => {
    const currentDoc = docRef.current;
    const point = getCanvasPoint(event, false);
    const canvas = displayCanvasRef.current;
    if (!point || !canvas) return;

    const startDraft = transformDraftRef.current;
    const rect = canvas.getBoundingClientRect();
    const tolerance = Math.max(
      6,
      Math.min(currentDoc.width / rect.width, currentDoc.height / rect.height) * 10
    );
    const selectedLayerIdSetForMove = new Set(selectedLayerIdsRef.current);
    const selectedLayersForMove = currentDoc.layers.filter((candidate) => (
      selectedLayerIdSetForMove.has(candidate.id)
    ));

    if (selectedLayersForMove.length > 1) {
      const groupBounds = getLayerGroupBounds(selectedLayersForMove);
      if (!groupBounds) return;

      const translationDraft = getTranslationDraft(startDraft);
      const translatedGroupBounds = {
        ...groupBounds,
        x: groupBounds.x + translationDraft.dx,
        y: groupBounds.y + translationDraft.dy,
      };

      if (!isPointInRect(point, translatedGroupBounds, tolerance)) return;

      interactionRef.current = {
        type: 'move',
        transformMode: 'groupMove',
        selectedLayerIds: selectedLayersForMove.map((candidate) => candidate.id),
        pointerId: event.pointerId,
        startPoint: point,
        startDraft: translationDraft,
      };
      return;
    }

    const layer = getActiveLayer(currentDoc);
    if (!layer) return;

    const startGeometry = getTransformedGeometry(layer, startDraft);
    const baseBounds = getLayerDocumentBounds(layer);
    if (!startGeometry || !baseBounds) return;

    const hit = getTransformHit(point, startGeometry, tolerance);
    if (!hit) return;

    interactionRef.current = {
      type: 'move',
      transformMode: hit.action,
      handle: hit.handle,
      pointerId: event.pointerId,
      startPoint: point,
      startDraft,
      startGeometry,
      baseBounds,
      startAngle: getAngleFromCenter(startGeometry.center, point),
    };
  }, [getCanvasPoint]);

  const continueMoveInteraction = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.type !== 'move') return;

    const point = getCanvasPoint(event, false);
    if (!point) return;

    let nextDraft = interaction.startDraft;

    if (interaction.transformMode === 'move' || interaction.transformMode === 'groupMove') {
      nextDraft = {
        ...interaction.startDraft,
        dx: interaction.startDraft.dx + point.x - interaction.startPoint.x,
        dy: interaction.startDraft.dy + point.y - interaction.startPoint.y,
      };
    }

    if (interaction.transformMode === 'resize') {
      nextDraft = getResizeTransformDraft(interaction, point, event.shiftKey);
    }

    if (interaction.transformMode === 'rotate') {
      const angle = getAngleFromCenter(interaction.startGeometry.center, point);
      nextDraft = {
        ...interaction.startDraft,
        rotationDeg: normalizeRotation(
          getDraftRotation(interaction.startDraft) + angle - interaction.startAngle
        ),
      };
    }

    transformDraftRef.current = nextDraft;
    setTransformDraft(nextDraft);
  }, [getCanvasPoint]);

  const applyActiveTransform = useCallback((draft = transformDraftRef.current) => {
    const currentDoc = docRef.current;
    const selectedLayerIdSetForMove = new Set(selectedLayerIdsRef.current);
    const selectedLayersForMove = currentDoc.layers.filter((candidate) => (
      selectedLayerIdSetForMove.has(candidate.id)
    ));

    if (selectedLayersForMove.length > 1) {
      const dx = Math.round(draft.dx ?? 0);
      const dy = Math.round(draft.dy ?? 0);

      if (dx === 0 && dy === 0) {
        resetTransformDraft();
        return;
      }

      const nextDoc = {
        ...currentDoc,
        layers: currentDoc.layers.map((candidate) => (
          selectedLayerIdSetForMove.has(candidate.id)
            ? {
                ...candidate,
                x: getLayerX(candidate) + dx,
                y: getLayerY(candidate) + dy,
              }
            : candidate
        )),
      };

      resetTransformDraft();
      commitDocument(nextDoc);
      return;
    }

    if (!hasTransform(draft)) return;

    const layer = getActiveLayer(currentDoc);
    if (!layer) return;

    const nextDoc = updateLayer(currentDoc, layer.id, (candidate) => ({
      ...rasterizeTransform(candidate, draft),
    }));

    resetTransformDraft();
    commitDocument(nextDoc);
  }, [commitDocument, resetTransformDraft]);

  const finishMoveInteraction = useCallback(() => {
    if (interactionRef.current?.type !== 'move') return;

    interactionRef.current = null;
    applyActiveTransform(transformDraftRef.current);
  }, [applyActiveTransform]);

  const startPanInteraction = useCallback((event) => {
    interactionRef.current = {
      type: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffset: viewOffsetRef.current,
    };
    setIsViewDragging(true);
  }, []);

  const continuePanInteraction = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.type !== 'pan') return;

    updateViewOffset({
      x: interaction.startOffset.x + event.clientX - interaction.startClientX,
      y: interaction.startOffset.y + event.clientY - interaction.startClientY,
    });
  }, [updateViewOffset]);

  const finishPanInteraction = useCallback(() => {
    if (interactionRef.current?.type !== 'pan') return;

    interactionRef.current = null;
    setIsViewDragging(false);
  }, []);

  const handlePointerDown = useCallback((event) => {
    if (!hasDocument(docRef.current)) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (isViewPanning) {
      startPanInteraction(event);
      return;
    }

    if (activeTool === TOOLS.BRUSH || activeTool === TOOLS.ERASER) {
      startStroke(event);
      return;
    }

    if (activeTool === TOOLS.CROP) {
      startCropInteraction(event);
      return;
    }

    if (activeTool === TOOLS.MOVE) {
      startMoveInteraction(event);
    }
  }, [activeTool, isViewPanning, startCropInteraction, startMoveInteraction, startPanInteraction, startStroke]);

  const handlePointerMove = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction) return;

    event.preventDefault();

    if (interaction.type === 'stroke') {
      continueStroke(event);
      return;
    }

    if (interaction.type === 'crop') {
      continueCropInteraction(event);
      return;
    }

    if (interaction.type === 'move') {
      continueMoveInteraction(event);
      return;
    }

    if (interaction.type === 'pan') {
      continuePanInteraction(event);
    }
  }, [continueCropInteraction, continueMoveInteraction, continuePanInteraction, continueStroke]);

  const handlePointerUp = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction) return;

    event.preventDefault();

    if (interaction.type === 'stroke') {
      finishStroke();
      return;
    }

    if (interaction.type === 'crop') {
      finishCropInteraction();
      return;
    }

    if (interaction.type === 'move') {
      finishMoveInteraction();
      return;
    }

    if (interaction.type === 'pan') {
      finishPanInteraction();
    }
  }, [finishCropInteraction, finishMoveInteraction, finishPanInteraction, finishStroke]);

  const applyCrop = useCallback(() => {
    const currentDoc = docRef.current;
    const currentCrop = cropRef.current;
    if (!hasDocument(currentDoc) || !currentCrop) return;

    const nextDoc = cropDocument(currentDoc, currentCrop);
    setCrop(null);
    setActiveTool(TOOLS.MOVE);
    commitDocument(nextDoc);
  }, [commitDocument]);

  const applyResize = useCallback(() => {
    const currentDoc = docRef.current;
    if (!hasDocument(currentDoc)) return;

    const nextDoc = resizeDocument(currentDoc, resizeDraft.width, resizeDraft.height);
    setActiveTool(TOOLS.MOVE);
    commitDocument(nextDoc);
  }, [commitDocument, resizeDraft.height, resizeDraft.width]);

  const handleRunOcr = useCallback(async () => {
    const canvas = getCompositeCanvas();
    if (!canvas) {
      toast({
        title: 'No image available',
        description: 'Import an image before running OCR.',
        status: 'info',
        duration: 2600,
        isClosable: true,
      });
      return;
    }

    try {
      const text = await runOcr(canvas);
      toast({
        title: text ? 'OCR complete' : 'No text found',
        description: text
          ? 'Recognized text is ready to copy.'
          : 'OCR finished, but no readable text was detected.',
        status: text ? 'success' : 'info',
        duration: 3000,
        isClosable: true,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;

      toast({
        title: 'OCR failed',
        description: err?.message || 'Could not recognize text in this image.',
        status: 'error',
        duration: 3500,
        isClosable: true,
      });
    }
  }, [getCompositeCanvas, runOcr, toast]);

  const handleCopyOcrText = useCallback(async () => {
    const text = ocrText.trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: 'Text copied',
        description: 'Recognized text was copied to the clipboard.',
        status: 'success',
        duration: 2600,
        isClosable: true,
      });
    } catch (err) {
      toast({
        title: 'Copy failed',
        description: 'Could not copy text to the clipboard.',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  }, [ocrText, toast]);

  const handleCopySelectedOcrText = useCallback(async () => {
    const text = selectedOcrText.trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: 'Selection copied',
        description: 'Selected OCR text was copied to the clipboard.',
        status: 'success',
        duration: 2600,
        isClosable: true,
      });
    } catch (err) {
      toast({
        title: 'Copy failed',
        description: 'Could not copy selected text to the clipboard.',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  }, [selectedOcrText, toast]);

  useEffect(() => {
    const handleCopyShortcut = (event) => {
      if (isEditableShortcutTarget(event.target)) return;
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'c' || !selectedOcrText.trim()) return;

      event.preventDefault();
      handleCopySelectedOcrText();
    };

    window.addEventListener('keydown', handleCopyShortcut);
    return () => window.removeEventListener('keydown', handleCopyShortcut);
  }, [handleCopySelectedOcrText, selectedOcrText]);

  const resetEditor = useCallback(() => {
    dispatch({ type: 'reset' });
    docRef.current = createEmptyDocument();
    updateSelectedLayerIds([]);
    setCrop(null);
    setActiveTool(TOOLS.MOVE);
    resetTransformDraft();
    resetView();
    resetExportState();
    clearOcr();
  }, [clearOcr, resetExportState, resetTransformDraft, resetView, updateSelectedLayerIds]);

  const updateResizeWidth = useCallback((value) => {
    const width = clampDimension(value);
    setResizeDraft((current) => {
      const height = aspectLocked && docRef.current.width > 0
        ? clampDimension(width * docRef.current.height / docRef.current.width)
        : current.height;
      return {
        width,
        height,
        scale: docRef.current.width ? Math.round(width / docRef.current.width * 100) : 100,
      };
    });
  }, [aspectLocked]);

  const updateResizeHeight = useCallback((value) => {
    const height = clampDimension(value);
    setResizeDraft((current) => {
      const width = aspectLocked && docRef.current.height > 0
        ? clampDimension(height * docRef.current.width / docRef.current.height)
        : current.width;
      return {
        width,
        height,
        scale: docRef.current.height ? Math.round(height / docRef.current.height * 100) : 100,
      };
    });
  }, [aspectLocked]);

  const updateResizeScale = useCallback((scale) => {
    setResizeDraft({
      width: clampDimension(docRef.current.width * scale / 100),
      height: clampDimension(docRef.current.height * scale / 100),
      scale,
    });
  }, []);

  const selectLayer = useCallback((layerId, options = {}) => {
    const { replaceSelection = true } = options;
    dispatch({ type: 'selectLayer', layerId });
    if (replaceSelection) {
      updateSelectedLayerIds([layerId]);
    }
  }, [updateSelectedLayerIds]);

  const toggleLayerSelection = useCallback((layerId, isSelected) => {
    const currentLayerIds = selectedLayerIdsRef.current;
    let nextLayerIds = isSelected
      ? getUniqueLayerIds([...currentLayerIds, layerId])
      : currentLayerIds.filter((candidateId) => candidateId !== layerId);

    if (nextLayerIds.length === 0) {
      nextLayerIds = [layerId];
    }

    updateSelectedLayerIds(nextLayerIds);

    if (isSelected) {
      dispatch({ type: 'selectLayer', layerId });
      return;
    }

    if (docRef.current.activeLayerId === layerId) {
      dispatch({ type: 'selectLayer', layerId: nextLayerIds[0] });
    }
  }, [updateSelectedLayerIds]);

  const handleLayerRowClick = useCallback((event, layerId) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      toggleLayerSelection(layerId, !selectedLayerIdsRef.current.includes(layerId));
      return;
    }

    selectLayer(layerId);
  }, [selectLayer, toggleLayerSelection]);

  const handleLayerDragStart = useCallback((event, layerId) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(LAYER_DRAG_TYPE, layerId);
    setDraggedLayerId(layerId);
    setLayerDropTarget(null);
    selectLayer(layerId, {
      replaceSelection: !selectedLayerIdsRef.current.includes(layerId),
    });
  }, [selectLayer]);

  const handleLayerDragOver = useCallback((event, targetLayerId) => {
    if (!draggedLayerId || draggedLayerId === targetLayerId) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';

    setLayerDropTarget((current) => {
      if (current?.layerId === targetLayerId && current?.placement === placement) {
        return current;
      }

      return {
        layerId: targetLayerId,
        placement,
      };
    });
  }, [draggedLayerId]);

  const handleLayerDrop = useCallback((event, targetLayerId) => {
    const sourceLayerId = draggedLayerId || event.dataTransfer.getData(LAYER_DRAG_TYPE);
    if (!sourceLayerId) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = event.currentTarget.getBoundingClientRect();
    const fallbackPlacement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const placement = layerDropTarget?.layerId === targetLayerId
      ? layerDropTarget.placement
      : fallbackPlacement;
    const currentDoc = docRef.current;
    const nextDoc = reorderLayer(currentDoc, sourceLayerId, targetLayerId, placement);

    setDraggedLayerId(null);
    setLayerDropTarget(null);

    if (nextDoc === currentDoc) return;
    commitDocument(nextDoc);
  }, [commitDocument, draggedLayerId, layerDropTarget]);

  const handleLayerDragEnd = useCallback(() => {
    setDraggedLayerId(null);
    setLayerDropTarget(null);
  }, []);

  const getOcrWordAtPoint = useCallback((point) => (
    [...ocrWords].reverse().find((word) => isPointInOcrWord(point, word)) || null
  ), [ocrWords]);

  const selectOcrWordsInRect = useCallback((rect) => {
    const selectedWordIds = ocrWords
      .filter((word) => doesRectIntersectOcrWord(rect, word))
      .map((word) => word.id);

    setSelectedOcrWordIds(selectedWordIds);
  }, [ocrWords, setSelectedOcrWordIds]);

  const handleOcrOverlayPointerDown = useCallback((event) => {
    if (!ocrWords.length) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const point = getCanvasPoint(event);
    if (!point) return;

    setOcrDragSelection({
      pointerId: event.pointerId,
      startPoint: point,
      currentPoint: point,
    });
  }, [getCanvasPoint, ocrWords.length]);

  const handleOcrOverlayPointerMove = useCallback((event) => {
    if (!ocrDragSelection || event.pointerId !== ocrDragSelection.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const point = getCanvasPoint(event);
    if (!point) return;

    const nextSelection = {
      ...ocrDragSelection,
      currentPoint: point,
    };
    const selectionRect = getSelectionRectFromPoints(
      nextSelection.startPoint,
      nextSelection.currentPoint
    );

    setOcrDragSelection(nextSelection);
    selectOcrWordsInRect(selectionRect);
  }, [getCanvasPoint, ocrDragSelection, selectOcrWordsInRect]);

  const handleOcrOverlayPointerUp = useCallback((event) => {
    if (!ocrDragSelection || event.pointerId !== ocrDragSelection.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch (err) {
      // Pointer capture may already be released by the browser.
    }

    const point = getCanvasPoint(event) || ocrDragSelection.currentPoint;
    const distance = getDistance(ocrDragSelection.startPoint, point);

    if (distance < 4) {
      const word = getOcrWordAtPoint(point);
      setSelectedOcrWordIds(word ? [word.id] : []);
    } else {
      selectOcrWordsInRect(getSelectionRectFromPoints(ocrDragSelection.startPoint, point));
    }

    setOcrDragSelection(null);
  }, [
    getCanvasPoint,
    getOcrWordAtPoint,
    ocrDragSelection,
    selectOcrWordsInRect,
    setSelectedOcrWordIds,
  ]);

  const handleOcrOverlayPointerCancel = useCallback((event) => {
    if (!ocrDragSelection || event.pointerId !== ocrDragSelection.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    setOcrDragSelection(null);
  }, [ocrDragSelection]);

  const toolCursor = useMemo(() => {
    if (isViewDragging) return 'grabbing';
    if (isViewPanning) return 'grab';
    if (activeTool === TOOLS.BRUSH || activeTool === TOOLS.ERASER) return 'crosshair';
    if (activeTool === TOOLS.CROP) return 'crosshair';
    if (activeTool === TOOLS.MOVE) return 'move';
    return 'default';
  }, [activeTool, isViewDragging, isViewPanning]);

  const activeLayerIndex = doc.layers.findIndex((layer) => layer.id === doc.activeLayerId);
  const hasOcrText = ocrText.trim().length > 0;
  const hasSelectedOcrText = selectedOcrText.trim().length > 0;
  const ocrSelectionRect = ocrDragSelection
    ? getSelectionRectFromPoints(ocrDragSelection.startPoint, ocrDragSelection.currentPoint)
    : null;

  return (
    <Box
      minH="100vh"
      bg="gray.100"
      color="gray.900"
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <VStack spacing={4} align="stretch" maxW="1680px" mx="auto" p={{ base: 3, md: 5 }}>
        <Flex gap={3} align="center" wrap="wrap">
          <Box>
            <Text fontSize={{ base: 'xl', md: '2xl' }} fontWeight="bold">
              Clipboard Photo Editor
            </Text>
            <HStack spacing={2} color="gray.600" fontSize="sm">
              <Badge colorScheme={hasDocument(doc) ? 'blue' : 'gray'}>
                {hasDocument(doc) ? `${doc.width} x ${doc.height}px` : 'No document'}
              </Badge>
              <Text>{doc.layers.length} layer{doc.layers.length === 1 ? '' : 's'}</Text>
            </HStack>
          </Box>

          <Flex flex="1" />

          <HStack spacing={2}>
            <Button
              leftIcon={<Upload size={17} />}
              colorScheme="blue"
              onClick={() => fileInputRef.current?.click()}
              size="sm"
            >
              Import
            </Button>
            <HStack
              spacing={1}
              border="1px solid"
              borderColor="gray.200"
              borderRadius="md"
              bg="white"
              p={1}
            >
              <Tooltip label="Zoom out" hasArrow>
                <IconButton
                  aria-label="Zoom out"
                  icon={<ZoomOut size={17} />}
                  onClick={zoomOut}
                  isDisabled={!hasDocument(doc) || viewZoom <= VIEW_ZOOM_MIN}
                  size="sm"
                  variant="ghost"
                />
              </Tooltip>
              <Text fontSize="sm" color="gray.700" minW="48px" textAlign="center">
                {viewZoom}%
              </Text>
              <Tooltip label="Reset zoom to 100%" hasArrow>
                <Button
                  aria-label="Reset zoom to 100%"
                  onClick={resetView}
                  isDisabled={!hasDocument(doc)}
                  size="sm"
                  variant="ghost"
                  px={2}
                >
                  100%
                </Button>
              </Tooltip>
              <Tooltip label="Zoom in" hasArrow>
                <IconButton
                  aria-label="Zoom in"
                  icon={<ZoomIn size={17} />}
                  onClick={zoomIn}
                  isDisabled={!hasDocument(doc) || viewZoom >= VIEW_ZOOM_MAX}
                  size="sm"
                  variant="ghost"
                />
              </Tooltip>
            </HStack>
            <Tooltip label="Undo" hasArrow>
              <IconButton
                aria-label="Undo"
                icon={<Undo2 size={18} />}
                onClick={undoDocument}
                isDisabled={!canUndo}
                size="sm"
              />
            </Tooltip>
            <Tooltip label="Redo" hasArrow>
              <IconButton
                aria-label="Redo"
                icon={<Redo2 size={18} />}
                onClick={redoDocument}
                isDisabled={!canRedo}
                size="sm"
              />
            </Tooltip>
            <Tooltip label="Reset" hasArrow>
              <IconButton
                aria-label="Reset"
                icon={<RotateCcw size={18} />}
                onClick={resetEditor}
                isDisabled={!hasDocument(doc)}
                colorScheme="red"
                variant="outline"
                size="sm"
              />
            </Tooltip>
          </HStack>
        </Flex>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileInputChange}
          style={{ display: 'none' }}
        />

        <Grid
          templateColumns={{ base: '1fr', lg: '64px minmax(0, 1fr) 340px' }}
          gap={4}
          alignItems="stretch"
        >
          <HStack
            display={{ base: 'flex', lg: 'none' }}
            overflowX="auto"
            bg="white"
            border="1px solid"
            borderColor="gray.200"
            borderRadius="md"
            p={2}
          >
            <ToolButton icon={MousePointer2} label="Move" isActive={activeTool === TOOLS.MOVE} onClick={() => setActiveTool(TOOLS.MOVE)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Hand} label="Pan" isActive={activeTool === TOOLS.PAN} onClick={() => setActiveTool(TOOLS.PAN)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Brush} label="Brush" isActive={activeTool === TOOLS.BRUSH} onClick={() => setActiveTool(TOOLS.BRUSH)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Eraser} label="Eraser" isActive={activeTool === TOOLS.ERASER} onClick={() => setActiveTool(TOOLS.ERASER)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Crop} label="Crop" isActive={activeTool === TOOLS.CROP} onClick={() => setActiveTool(TOOLS.CROP)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Maximize2} label="Resize" isActive={activeTool === TOOLS.RESIZE} onClick={() => setActiveTool(TOOLS.RESIZE)} isDisabled={!hasDocument(doc)} />
          </HStack>

          <VStack
            display={{ base: 'none', lg: 'flex' }}
            align="center"
            spacing={2}
            bg="white"
            border="1px solid"
            borderColor="gray.200"
            borderRadius="md"
            p={2}
          >
            <ToolButton icon={MousePointer2} label="Move" isActive={activeTool === TOOLS.MOVE} onClick={() => setActiveTool(TOOLS.MOVE)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Hand} label="Pan" isActive={activeTool === TOOLS.PAN} onClick={() => setActiveTool(TOOLS.PAN)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Brush} label="Brush" isActive={activeTool === TOOLS.BRUSH} onClick={() => setActiveTool(TOOLS.BRUSH)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Eraser} label="Eraser" isActive={activeTool === TOOLS.ERASER} onClick={() => setActiveTool(TOOLS.ERASER)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Crop} label="Crop" isActive={activeTool === TOOLS.CROP} onClick={() => setActiveTool(TOOLS.CROP)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Maximize2} label="Resize" isActive={activeTool === TOOLS.RESIZE} onClick={() => setActiveTool(TOOLS.RESIZE)} isDisabled={!hasDocument(doc)} />

            <Divider />

            <ToolButton icon={ImagePlus} label="Add Image Layer" onClick={() => fileInputRef.current?.click()} isDisabled={false} />
            <ToolButton icon={Plus} label="Add Blank Layer" onClick={addBlankLayer} isDisabled={!hasDocument(doc)} />
          </VStack>

          <Flex
            ref={viewportRef}
            position="relative"
            minH={{ base: '58vh', lg: 'calc(100vh - 150px)' }}
            bg="gray.900"
            border="1px solid"
            borderColor="gray.300"
            borderRadius="md"
            align="center"
            justify="center"
            overflow="hidden"
            p={{ base: 3, md: 5 }}
          >
            {isResizePreview && (
              <Badge
                position="absolute"
                top={3}
                left={3}
                zIndex={1}
                colorScheme="blue"
                pointerEvents="none"
              >
                Resize preview: {displayWidth} x {displayHeight}px
              </Badge>
            )}
            {!hasDocument(doc) ? (
              <VStack
                spacing={4}
                textAlign="center"
                color="white"
                border="2px dashed"
                borderColor="whiteAlpha.400"
                borderRadius="md"
                p={{ base: 8, md: 12 }}
                w="100%"
                maxW="560px"
              >
                <Upload size={36} />
                <Box>
                  <Text fontSize="lg" fontWeight="semibold">Paste, drop, or import an image</Text>
                  <Text color="whiteAlpha.700" fontSize="sm">
                    The first image creates the document. Later imports become new layers.
                  </Text>
                </Box>
                <Button colorScheme="blue" onClick={() => fileInputRef.current?.click()}>
                  Import Image
                </Button>
              </VStack>
            ) : (
              <Box
                position="relative"
                display="inline-block"
                maxW="100%"
                maxH="calc(100vh - 210px)"
                lineHeight={0}
                transform={`translate(${viewOffset.x}px, ${viewOffset.y}px) scale(${viewZoom / 100})`}
                transformOrigin="center center"
                transition={isViewDragging ? undefined : 'transform 120ms ease-out'}
                willChange="transform"
              >
                <canvas
                  ref={displayCanvasRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  style={{
                    maxWidth: '100%',
                    maxHeight: 'calc(100vh - 210px)',
                    width: 'auto',
                    height: 'auto',
                    display: 'block',
                    cursor: toolCursor,
                    touchAction: 'none',
                    backgroundColor: '#f8fafc',
                    backgroundImage:
                      'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)',
                    backgroundSize: '18px 18px',
                    backgroundPosition: '0 0, 0 9px, 9px -9px, -9px 0px',
                  }}
                />

                {ocrWords.length > 0 && (
                  <Box
                    as="svg"
                    aria-label="OCR text selection overlay"
                    viewBox={`0 0 ${doc.width} ${doc.height}`}
                    preserveAspectRatio="none"
                    position="absolute"
                    inset={0}
                    w="100%"
                    h="100%"
                    pointerEvents={isViewPanning ? 'none' : 'auto'}
                    cursor="text"
                    touchAction="none"
                    onPointerDown={handleOcrOverlayPointerDown}
                    onPointerMove={handleOcrOverlayPointerMove}
                    onPointerUp={handleOcrOverlayPointerUp}
                    onPointerCancel={handleOcrOverlayPointerCancel}
                  >
                    {ocrWords.map((word) => {
                      const rect = getWordRect(word);
                      const isSelected = selectedOcrWordIdSet.has(word.id);

                      return (
                        <rect
                          key={word.id}
                          x={rect.x}
                          y={rect.y}
                          width={rect.width}
                          height={rect.height}
                          rx={2}
                          fill={isSelected ? 'rgba(37, 99, 235, 0.28)' : 'rgba(59, 130, 246, 0.08)'}
                          stroke={isSelected ? '#1d4ed8' : 'rgba(37, 99, 235, 0.58)'}
                          strokeWidth={isSelected ? 2 : 1}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}

                    {ocrSelectionRect && (
                      <rect
                        x={ocrSelectionRect.x}
                        y={ocrSelectionRect.y}
                        width={ocrSelectionRect.width}
                        height={ocrSelectionRect.height}
                        fill="rgba(37, 99, 235, 0.16)"
                        stroke="#1d4ed8"
                        strokeWidth={1.5}
                        strokeDasharray="5 4"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </Box>
                )}
              </Box>
            )}
          </Flex>

          <VStack align="stretch" spacing={4} minW={0}>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="md" p={4}>
              <HStack mb={3}>
                <SlidersHorizontal size={18} />
                <Text fontWeight="bold">Tool Options</Text>
              </HStack>

              {!hasDocument(doc) && (
                <Text color="gray.600" fontSize="sm">Import an image to enable the editor tools.</Text>
              )}

              {hasDocument(doc) && (activeTool === TOOLS.BRUSH || activeTool === TOOLS.ERASER) && (
                <VStack align="stretch" spacing={4}>
                  <HStack justify="space-between">
                    <Text fontSize="sm">Color</Text>
                    <Input
                      type="color"
                      value={brushColor}
                      onChange={(event) => setBrushColor(event.target.value)}
                      isDisabled={activeTool === TOOLS.ERASER}
                      w="86px"
                      h="36px"
                      p={1}
                    />
                  </HStack>
                  <Box>
                    <HStack justify="space-between" mb={2}>
                      <Text fontSize="sm">Size</Text>
                      <Text fontSize="sm" color="gray.600">{brushSize}px</Text>
                    </HStack>
                    <Slider value={brushSize} min={1} max={80} onChange={setBrushSize}>
                      <SliderTrack><SliderFilledTrack /></SliderTrack>
                      <SliderThumb />
                    </Slider>
                  </Box>
                </VStack>
              )}

              {hasDocument(doc) && activeTool === TOOLS.PAN && (
                <VStack align="stretch" spacing={4}>
                  <HStack justify="space-between">
                    <Text fontSize="sm">View zoom</Text>
                    <Text fontSize="sm" color="gray.600">{viewZoom}%</Text>
                  </HStack>
                  <HStack>
                    <Tooltip label="Zoom out" hasArrow>
                      <IconButton
                        aria-label="Zoom out"
                        icon={<ZoomOut size={16} />}
                        onClick={zoomOut}
                        isDisabled={viewZoom <= VIEW_ZOOM_MIN}
                        size="sm"
                        flex={1}
                      />
                    </Tooltip>
                    <Button size="sm" onClick={resetView} flex={1}>
                      100%
                    </Button>
                    <Tooltip label="Zoom in" hasArrow>
                      <IconButton
                        aria-label="Zoom in"
                        icon={<ZoomIn size={16} />}
                        onClick={zoomIn}
                        isDisabled={viewZoom >= VIEW_ZOOM_MAX}
                        size="sm"
                        flex={1}
                      />
                    </Tooltip>
                  </HStack>
                </VStack>
              )}

              {hasDocument(doc) && activeTool === TOOLS.MOVE && (
                <VStack align="stretch" spacing={4}>
                  {hasMultiLayerSelection ? (
                    <Text fontSize="sm" color="gray.600">
                      {selectedMoveLayers.length} layers selected. Drag inside the group box to move them together.
                    </Text>
                  ) : (
                    <>
                      <Text fontSize="sm" color="gray.600">
                        Drag inside the box to move, drag handles to resize, and drag just outside the box to rotate.
                      </Text>
                      <Box>
                        <HStack justify="space-between" mb={2}>
                          <Text fontSize="sm">Uniform scale</Text>
                          <Text fontSize="sm" color="gray.600">
                            {Math.round((getDraftScaleX(transformDraft) + getDraftScaleY(transformDraft)) / 2)}%
                          </Text>
                        </HStack>
                        <Slider
                          value={Math.round((getDraftScaleX(transformDraft) + getDraftScaleY(transformDraft)) / 2)}
                          min={10}
                          max={300}
                          onChange={(scale) => setTransformDraft((current) => ({
                            ...current,
                            scaleX: scale,
                            scaleY: scale,
                          }))}
                        >
                          <SliderTrack><SliderFilledTrack /></SliderTrack>
                          <SliderThumb />
                        </Slider>
                      </Box>
                      <HStack justify="space-between" fontSize="sm">
                        <Text>Rotation</Text>
                        <Text color="gray.600">{Math.round(getDraftRotation(transformDraft))} deg</Text>
                      </HStack>
                      <HStack>
                        <Button
                          leftIcon={<Check size={16} />}
                          colorScheme="blue"
                          size="sm"
                          onClick={() => applyActiveTransform(transformDraft)}
                          isDisabled={!hasTransform(transformDraft)}
                          flex={1}
                        >
                          Apply
                        </Button>
                        <Button
                          leftIcon={<X size={16} />}
                          size="sm"
                          onClick={resetTransformDraft}
                          isDisabled={!hasTransform(transformDraft)}
                          flex={1}
                        >
                          Reset
                        </Button>
                      </HStack>
                    </>
                  )}
                </VStack>
              )}

              {hasDocument(doc) && activeTool === TOOLS.CROP && (
                <VStack align="stretch" spacing={4}>
                  <Text fontSize="sm" color="gray.600">
                    Drag the crop box or its handles, then apply it to the whole document.
                  </Text>
                  <HStack justify="space-between" fontSize="sm">
                    <Text>Selection</Text>
                    <Text color="gray.600">
                      {crop ? `${crop.width} x ${crop.height}px` : 'None'}
                    </Text>
                  </HStack>
                  <HStack>
                    <Button
                      leftIcon={<Check size={16} />}
                      colorScheme="blue"
                      size="sm"
                      onClick={applyCrop}
                      flex={1}
                    >
                      Apply Crop
                    </Button>
                    <Button
                      leftIcon={<RotateCcw size={16} />}
                      size="sm"
                      onClick={() => setCrop(createDefaultCrop(docRef.current))}
                      flex={1}
                    >
                      Reset
                    </Button>
                  </HStack>
                </VStack>
              )}

              {hasDocument(doc) && activeTool === TOOLS.RESIZE && (
                <VStack align="stretch" spacing={4}>
                  <Text fontSize="sm" color="gray.600">
                    Preview updates as you change dimensions. Apply Resize to save the change.
                  </Text>
                  <HStack>
                    <Box flex={1}>
                      <Text fontSize="sm" mb={1}>Width</Text>
                      <Input
                        aria-label="Resize width"
                        type="number"
                        min={MIN_DIMENSION}
                        max={MAX_DIMENSION}
                        value={resizeDraft.width}
                        onChange={(event) => updateResizeWidth(event.target.value)}
                      />
                    </Box>
                    <Box flex={1}>
                      <Text fontSize="sm" mb={1}>Height</Text>
                      <Input
                        aria-label="Resize height"
                        type="number"
                        min={MIN_DIMENSION}
                        max={MAX_DIMENSION}
                        value={resizeDraft.height}
                        onChange={(event) => updateResizeHeight(event.target.value)}
                      />
                    </Box>
                  </HStack>
                  <HStack justify="space-between">
                    <Text fontSize="sm">Lock aspect</Text>
                    <Switch aria-label="Lock aspect ratio" isChecked={aspectLocked} onChange={(event) => setAspectLocked(event.target.checked)} />
                  </HStack>
                  <Box>
                    <HStack justify="space-between" mb={2}>
                      <Text fontSize="sm">Scale</Text>
                      <Text fontSize="sm" color="gray.600">{resizeDraft.scale}%</Text>
                    </HStack>
                    <Slider aria-label="Resize scale" value={resizeDraft.scale} min={1} max={200} onChange={updateResizeScale}>
                      <SliderTrack><SliderFilledTrack /></SliderTrack>
                      <SliderThumb />
                    </Slider>
                  </Box>
                  <Button
                    leftIcon={<Check size={16} />}
                    colorScheme="blue"
                    size="sm"
                    onClick={applyResize}
                  >
                    Apply Resize
                  </Button>
                </VStack>
              )}
            </Box>

            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="md" p={4}>
              <HStack mb={3}>
                <Layers size={18} />
                <Text fontWeight="bold">Layers</Text>
                <Flex flex="1" />
                <Tooltip label="Add image layer" hasArrow>
                  <IconButton
                    aria-label="Add image layer"
                    icon={<ImagePlus size={16} />}
                    size="xs"
                    onClick={() => fileInputRef.current?.click()}
                  />
                </Tooltip>
                <Tooltip label="Add blank layer" hasArrow>
                  <IconButton
                    aria-label="Add blank layer"
                    icon={<Plus size={16} />}
                    size="xs"
                    onClick={addBlankLayer}
                    isDisabled={!hasDocument(doc)}
                  />
                </Tooltip>
              </HStack>

              <HStack spacing={2} mb={3}>
                <Tooltip label="Duplicate layer" hasArrow>
                  <IconButton aria-label="Duplicate layer" icon={<Copy size={16} />} size="xs" onClick={duplicateActiveLayer} isDisabled={!activeLayer} />
                </Tooltip>
                <Tooltip label="Move layer up" hasArrow>
                  <IconButton aria-label="Move layer up" icon={<ArrowUp size={16} />} size="xs" onClick={() => moveActiveLayer('up')} isDisabled={activeLayerIndex === -1 || activeLayerIndex >= doc.layers.length - 1} />
                </Tooltip>
                <Tooltip label="Move layer down" hasArrow>
                  <IconButton aria-label="Move layer down" icon={<ArrowDown size={16} />} size="xs" onClick={() => moveActiveLayer('down')} isDisabled={activeLayerIndex <= 0} />
                </Tooltip>
                <Tooltip label="Delete layer" hasArrow>
                  <IconButton aria-label="Delete layer" icon={<Trash2 size={16} />} size="xs" onClick={deleteActiveLayer} isDisabled={!activeLayer} colorScheme="red" variant="outline" />
                </Tooltip>
              </HStack>

              {!hasDocument(doc) ? (
                <Text color="gray.600" fontSize="sm">Layers appear after importing an image.</Text>
              ) : (
                <VStack align="stretch" spacing={2} maxH="34vh" overflowY="auto">
                  {[...doc.layers].reverse().map((layer) => {
                    const isActive = layer.id === doc.activeLayerId;
                    const isSelectedForMove = selectedLayerIdSet.has(layer.id);
                    const isDragging = layer.id === draggedLayerId;
                    const isDropBefore = layerDropTarget?.layerId === layer.id &&
                      layerDropTarget?.placement === 'before';
                    const isDropAfter = layerDropTarget?.layerId === layer.id &&
                      layerDropTarget?.placement === 'after';
                    return (
                      <Box
                        key={layer.id}
                        border="1px solid"
                        borderColor={isActive ? 'blue.400' : isSelectedForMove ? 'cyan.300' : 'gray.200'}
                        bg={isActive ? 'blue.50' : isSelectedForMove ? 'cyan.50' : 'white'}
                        borderRadius="md"
                        boxShadow={
                          isDropBefore
                            ? 'inset 0 3px 0 #3182ce'
                            : isDropAfter
                              ? 'inset 0 -3px 0 #3182ce'
                              : undefined
                        }
                        opacity={isDragging ? 0.55 : 1}
                        p={2}
                        onClick={(event) => handleLayerRowClick(event, layer.id)}
                        onDragOver={(event) => handleLayerDragOver(event, layer.id)}
                        onDrop={(event) => handleLayerDrop(event, layer.id)}
                        cursor="pointer"
                      >
                        <HStack align="center" spacing={2}>
                          <Checkbox
                            aria-label={`Select ${layer.name} for move`}
                            isChecked={isSelectedForMove}
                            size="sm"
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => toggleLayerSelection(layer.id, event.target.checked)}
                          />
                          <Tooltip label="Drag to reorder" hasArrow>
                            <Box
                              aria-label="Drag layer"
                              color="gray.500"
                              cursor={isDragging ? 'grabbing' : 'grab'}
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                              flexShrink={0}
                              h="44px"
                              w="18px"
                              draggable
                              onClick={(event) => event.stopPropagation()}
                              onDragStart={(event) => handleLayerDragStart(event, layer.id)}
                              onDragEnd={handleLayerDragEnd}
                            >
                              <GripVertical size={16} />
                            </Box>
                          </Tooltip>
                          <LayerThumbnail layer={layer} />
                          <Box flex={1} minW={0}>
                            <Input
                              value={layer.name}
                              size="sm"
                              fontWeight={isActive ? 'semibold' : 'normal'}
                              onChange={(event) => updateLayerMeta(layer.id, { name: event.target.value }, false)}
                              onBlur={() => commitDocument(docRef.current)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur();
                              }}
                            />
                            <HStack mt={2} spacing={2}>
                              <Tooltip label={layer.visible ? 'Hide layer' : 'Show layer'} hasArrow>
                                <IconButton
                                  aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
                                  icon={layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                                  size="xs"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    updateLayerMeta(layer.id, { visible: !layer.visible }, true);
                                  }}
                                />
                              </Tooltip>
                              <Box flex={1}>
                                <Slider
                                  value={layer.opacity}
                                  min={0}
                                  max={100}
                                  onChange={(opacity) => updateLayerMeta(layer.id, { opacity }, false)}
                                  onChangeEnd={(opacity) => updateLayerMeta(layer.id, { opacity }, true)}
                                >
                                  <SliderTrack><SliderFilledTrack /></SliderTrack>
                                  <SliderThumb />
                                </Slider>
                              </Box>
                              <Text fontSize="xs" color="gray.600" w="38px" textAlign="right">
                                {layer.opacity}%
                              </Text>
                            </HStack>
                          </Box>
                        </HStack>
                      </Box>
                    );
                  })}
                </VStack>
              )}
            </Box>

            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="md" p={4}>
              <HStack mb={3}>
                <ScanText size={18} />
                <Text fontWeight="bold">OCR</Text>
                <Tooltip
                  label="OCR runs locally in your browser against the current canvas. The image is not uploaded; only the OCR engine and English language data may download and cache in your browser."
                  hasArrow
                  placement="top"
                >
                  <Box
                    as="span"
                    display="inline-flex"
                    alignItems="center"
                    color="gray.500"
                    cursor="help"
                    tabIndex={0}
                  >
                    <Info size={15} />
                  </Box>
                </Tooltip>
                <Flex flex="1" />
                <Badge colorScheme="gray">English</Badge>
              </HStack>

              {!hasDocument(doc) ? (
                <Text color="gray.600" fontSize="sm">
                  Import an image to enable OCR.
                </Text>
              ) : (
                <VStack align="stretch" spacing={3}>
                  <HStack>
                    <Button
                      leftIcon={<ScanText size={16} />}
                      colorScheme="blue"
                      size="sm"
                      onClick={handleRunOcr}
                      isLoading={isOcrRunning}
                      loadingText="Reading"
                      isDisabled={isOcrRunning}
                      flex={1}
                    >
                      Run OCR
                    </Button>
                    <Button
                      leftIcon={isOcrRunning ? <X size={16} /> : <Trash2 size={16} />}
                      size="sm"
                      onClick={isOcrRunning ? cancelOcr : clearOcr}
                      isDisabled={!isOcrRunning && !hasOcrText && !ocrError}
                      variant="outline"
                    >
                      {isOcrRunning ? 'Cancel' : 'Clear'}
                    </Button>
                  </HStack>

                  {(isOcrRunning || ocrStatus === 'succeeded' || ocrStatus === 'canceled') && (
                    <Box>
                      <HStack justify="space-between" mb={1}>
                        <Text fontSize="sm" color="gray.600">
                          {ocrStatusLabel || 'Ready'}
                        </Text>
                        {isOcrRunning && (
                          <Text fontSize="sm" color="gray.600">
                            {ocrProgress}%
                          </Text>
                        )}
                        {!isOcrRunning && ocrConfidence !== null && (
                          <Text fontSize="sm" color="gray.600">
                            {ocrConfidence}% confidence
                          </Text>
                        )}
                      </HStack>
                      {isOcrRunning && (
                        <Progress value={ocrProgress} size="sm" borderRadius="full" />
                      )}
                    </Box>
                  )}

                  {ocrError && (
                    <Text color="red.600" fontSize="sm">
                      {ocrError}
                    </Text>
                  )}

                  <Textarea
                    value={ocrText}
                    onChange={(event) => setOcrText(event.target.value)}
                    placeholder="Recognized text"
                    minH="132px"
                    resize="vertical"
                    fontFamily="mono"
                    fontSize="sm"
                  />

                  {selectedOcrWordIds.length > 0 && (
                    <HStack justify="space-between">
                      <Text fontSize="sm" color="gray.600">
                        {selectedOcrWordIds.length} word{selectedOcrWordIds.length === 1 ? '' : 's'} selected
                      </Text>
                      <Button size="xs" variant="ghost" onClick={clearOcrSelection}>
                        Clear Selection
                      </Button>
                    </HStack>
                  )}

                  <Button
                    leftIcon={<Copy size={16} />}
                    size="sm"
                    colorScheme="blue"
                    variant="outline"
                    onClick={handleCopySelectedOcrText}
                    isDisabled={!hasSelectedOcrText}
                  >
                    Copy Selection
                  </Button>

                  <Button
                    leftIcon={<Copy size={16} />}
                    size="sm"
                    onClick={handleCopyOcrText}
                    isDisabled={!hasOcrText}
                  >
                    Copy All Text
                  </Button>
                </VStack>
              )}
            </Box>

            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="md" p={4}>
              <Text fontWeight="bold" mb={3}>Export</Text>
              {hasDocument(doc) ? (
                <ExportControls />
              ) : (
                <Text color="gray.600" fontSize="sm">
                  Import an image to enable copy and download controls.
                </Text>
              )}
            </Box>
          </VStack>
        </Grid>

        <Text textAlign="center" fontSize="xs" color="gray.500">by Alex Zidros</Text>
      </VStack>
    </Box>
  );
}

export default UnifiedPhotoEditor;
