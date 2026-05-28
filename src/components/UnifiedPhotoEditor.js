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
  Divider,
  Flex,
  Grid,
  HStack,
  IconButton,
  Input,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Switch,
  Text,
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
  ImagePlus,
  Layers,
  Maximize2,
  MousePointer2,
  Plus,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { useImageExportControls } from '../utils/useImageExportControls';

const HISTORY_LIMIT = 30;
const MAX_DIMENSION = 12000;
const MIN_DIMENSION = 1;
const DEFAULT_BRUSH_COLOR = '#ff2b2b';

const TOOLS = {
  MOVE: 'move',
  BRUSH: 'brush',
  ERASER: 'eraser',
  CROP: 'crop',
  RESIZE: 'resize',
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
};

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

const renderLayer = (ctx, layer, transformDraft = null) => {
  const opacity = clamp(layer.opacity ?? 100, 0, 100) / 100;
  if (!layer.visible || opacity <= 0) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  if (transformDraft && hasTransform(transformDraft)) {
    drawTransformedLayer(ctx, layer, transformDraft);
  } else {
    ctx.drawImage(layer.canvas, getLayerX(layer), getLayerY(layer));
  }

  ctx.restore();
};

const renderDocument = (ctx, doc, options = {}) => {
  ctx.clearRect(0, 0, doc.width, doc.height);

  doc.layers.forEach((layer) => {
    const transformDraft = layer.id === options.transformLayerId
      ? options.transformDraft
      : null;
    renderLayer(ctx, layer, transformDraft);
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

const hasTransform = (draft) => (
  Math.round(draft.dx) !== 0 ||
  Math.round(draft.dy) !== 0 ||
  Math.round(draft.scale) !== 100
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

const getTransformedBounds = (layer, draft) => {
  const bounds = getLayerDocumentBounds(layer);
  if (!bounds) return null;

  const scale = clamp(draft.scale, 10, 300) / 100;
  const nextWidth = bounds.width * scale;
  const nextHeight = bounds.height * scale;
  const centerX = bounds.x + bounds.width / 2 + draft.dx;
  const centerY = bounds.y + bounds.height / 2 + draft.dy;

  return {
    x: centerX - nextWidth / 2,
    y: centerY - nextHeight / 2,
    width: nextWidth,
    height: nextHeight,
  };
};

const drawTransformedLayer = (ctx, layer, draft) => {
  const bounds = getLayerBounds(layer.canvas);
  if (!bounds) return;

  const nextBounds = getTransformedBounds(layer, draft);
  if (!nextBounds) return;

  ctx.drawImage(
    layer.canvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    nextBounds.x,
    nextBounds.y,
    nextBounds.width,
    nextBounds.height
  );
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

  const nextBounds = getTransformedBounds(layer, draft);
  if (!nextBounds) return layer;

  const nextWidth = Math.max(1, Math.round(nextBounds.width));
  const nextHeight = Math.max(1, Math.round(nextBounds.height));
  const nextCanvas = createCanvas(nextWidth, nextHeight);
  const ctx = nextCanvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    layer.canvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    nextWidth,
    nextHeight
  );

  return {
    ...layer,
    canvas: nextCanvas,
    x: Math.round(nextBounds.x),
    y: Math.round(nextBounds.y),
  };
};

const drawLayerBounds = (ctx, layer, draft, doc) => {
  const bounds = hasTransform(draft)
    ? getTransformedBounds(layer, draft)
    : getLayerDocumentBounds(layer);
  if (!bounds) return;

  const lineWidth = Math.max(2, Math.round(Math.min(doc.width, doc.height) / 600));
  ctx.save();
  ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#2563eb';
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
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
    const canvas = createCanvas(
      Math.max(1, Math.round(layer.canvas.width * scaleX)),
      Math.max(1, Math.round(layer.canvas.height * scaleY))
    );
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height);

    return {
      ...layer,
      canvas,
      x: Math.round(getLayerX(layer) * scaleX),
      y: Math.round(getLayerY(layer) * scaleY),
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
  const displayCanvasRef = useRef(null);
  const interactionRef = useRef(null);
  const docRef = useRef(createEmptyDocument());
  const cropRef = useRef(null);
  const transformDraftRef = useRef({ dx: 0, dy: 0, scale: 100 });

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
  const [transformDraft, setTransformDraft] = useState({ dx: 0, dy: 0, scale: 100 });

  const activeLayer = useMemo(() => getActiveLayer(doc), [doc]);
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;
  const documentWidth = doc.width;
  const documentHeight = doc.height;
  const documentLayerCount = doc.layers.length;

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

  useEffect(() => {
    transformDraftRef.current = transformDraft;
  }, [transformDraft]);

  const commitDocument = useCallback((nextDoc) => {
    docRef.current = nextDoc;
    dispatch({ type: 'commit', doc: nextDoc });
  }, []);

  const setDocumentTransient = useCallback((nextDoc) => {
    docRef.current = nextDoc;
    dispatch({ type: 'setDoc', doc: nextDoc });
  }, []);

  const getCompositeCanvas = useCallback(() => makeCompositeCanvas(doc), [doc]);

  const {
    updateOutputSizes,
    resetExportState,
    ExportControls,
  } = useImageExportControls(getCompositeCanvas, toast, 'edited');

  const undoDocument = useCallback(() => {
    interactionRef.current = null;
    transformDraftRef.current = { dx: 0, dy: 0, scale: 100 };
    setTransformDraft({ dx: 0, dy: 0, scale: 100 });
    dispatch({ type: 'undo' });
  }, []);

  const redoDocument = useCallback(() => {
    interactionRef.current = null;
    transformDraftRef.current = { dx: 0, dy: 0, scale: 100 };
    setTransformDraft({ dx: 0, dy: 0, scale: 100 });
    dispatch({ type: 'redo' });
  }, []);

  const renderDisplay = useCallback(() => {
    const canvas = displayCanvasRef.current;
    if (!canvas || !hasDocument(doc)) return;

    if (canvas.width !== doc.width) canvas.width = doc.width;
    if (canvas.height !== doc.height) canvas.height = doc.height;

    const ctx = canvas.getContext('2d');
    const transformLayerId = activeTool === TOOLS.MOVE ? doc.activeLayerId : null;
    renderDocument(ctx, doc, {
      transformLayerId,
      transformDraft,
    });

    if (activeTool === TOOLS.MOVE && activeLayer) {
      drawLayerBounds(ctx, activeLayer, transformDraft, doc);
    }

    if (activeTool === TOOLS.CROP) {
      drawCropOverlay(ctx, doc, crop);
    }
  }, [activeLayer, activeTool, crop, doc, transformDraft]);

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
    setTransformDraft({ dx: 0, dy: 0, scale: 100 });
  }, [doc.activeLayerId, activeTool]);

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
  }, [commitDocument, toast]);

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
  }, [commitDocument, toast]);

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
  }, [commitDocument]);

  const deleteActiveLayer = useCallback(() => {
    const currentDoc = docRef.current;
    const layer = getActiveLayer(currentDoc);
    if (!layer) return;

    if (currentDoc.layers.length === 1) {
      commitDocument(createEmptyDocument());
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
  }, [commitDocument]);

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

  const getCanvasPoint = useCallback((event) => {
    const canvas = displayCanvasRef.current;
    const currentDoc = docRef.current;
    if (!canvas || !hasDocument(currentDoc)) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    return {
      x: clamp((event.clientX - rect.left) * currentDoc.width / rect.width, 0, currentDoc.width),
      y: clamp((event.clientY - rect.top) * currentDoc.height / rect.height, 0, currentDoc.height),
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
    const layer = getActiveLayer(currentDoc);
    const point = getCanvasPoint(event);
    if (!layer || !point) return;

    interactionRef.current = {
      type: 'move',
      pointerId: event.pointerId,
      startPoint: point,
      startDraft: transformDraftRef.current,
    };
  }, [getCanvasPoint]);

  const continueMoveInteraction = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.type !== 'move') return;

    const point = getCanvasPoint(event);
    if (!point) return;

    const nextDraft = {
      ...interaction.startDraft,
      dx: interaction.startDraft.dx + point.x - interaction.startPoint.x,
      dy: interaction.startDraft.dy + point.y - interaction.startPoint.y,
    };
    transformDraftRef.current = nextDraft;
    setTransformDraft(nextDraft);
  }, [getCanvasPoint]);

  const applyActiveTransform = useCallback((draft = transformDraftRef.current) => {
    if (!hasTransform(draft)) return;

    const currentDoc = docRef.current;
    const layer = getActiveLayer(currentDoc);
    if (!layer) return;

    const nextDoc = updateLayer(currentDoc, layer.id, (candidate) => ({
      ...rasterizeTransform(candidate, draft),
    }));

    setTransformDraft({ dx: 0, dy: 0, scale: 100 });
    transformDraftRef.current = { dx: 0, dy: 0, scale: 100 };
    commitDocument(nextDoc);
  }, [commitDocument]);

  const finishMoveInteraction = useCallback(() => {
    if (interactionRef.current?.type !== 'move') return;

    interactionRef.current = null;
    applyActiveTransform(transformDraftRef.current);
  }, [applyActiveTransform]);

  const handlePointerDown = useCallback((event) => {
    if (!hasDocument(docRef.current)) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

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
  }, [activeTool, startCropInteraction, startMoveInteraction, startStroke]);

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
    }
  }, [continueCropInteraction, continueMoveInteraction, continueStroke]);

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
    }
  }, [finishCropInteraction, finishMoveInteraction, finishStroke]);

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

  const resetEditor = useCallback(() => {
    dispatch({ type: 'reset' });
    docRef.current = createEmptyDocument();
    setCrop(null);
    setActiveTool(TOOLS.MOVE);
    setTransformDraft({ dx: 0, dy: 0, scale: 100 });
    resetExportState();
  }, [resetExportState]);

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

  const selectLayer = useCallback((layerId) => {
    dispatch({ type: 'selectLayer', layerId });
  }, []);

  const toolCursor = useMemo(() => {
    if (activeTool === TOOLS.BRUSH || activeTool === TOOLS.ERASER) return 'crosshair';
    if (activeTool === TOOLS.CROP) return 'crosshair';
    if (activeTool === TOOLS.MOVE) return 'move';
    return 'default';
  }, [activeTool]);

  const activeLayerIndex = doc.layers.findIndex((layer) => layer.id === doc.activeLayerId);

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
            <ToolButton icon={Brush} label="Brush" isActive={activeTool === TOOLS.BRUSH} onClick={() => setActiveTool(TOOLS.BRUSH)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Eraser} label="Eraser" isActive={activeTool === TOOLS.ERASER} onClick={() => setActiveTool(TOOLS.ERASER)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Crop} label="Crop" isActive={activeTool === TOOLS.CROP} onClick={() => setActiveTool(TOOLS.CROP)} isDisabled={!hasDocument(doc)} />
            <ToolButton icon={Maximize2} label="Resize" isActive={activeTool === TOOLS.RESIZE} onClick={() => setActiveTool(TOOLS.RESIZE)} isDisabled={!hasDocument(doc)} />

            <Divider />

            <ToolButton icon={ImagePlus} label="Add Image Layer" onClick={() => fileInputRef.current?.click()} isDisabled={false} />
            <ToolButton icon={Plus} label="Add Blank Layer" onClick={addBlankLayer} isDisabled={!hasDocument(doc)} />
          </VStack>

          <Flex
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

              {hasDocument(doc) && activeTool === TOOLS.MOVE && (
                <VStack align="stretch" spacing={4}>
                  <Text fontSize="sm" color="gray.600">
                    Drag the active layer on the canvas. Use scale when you need to resize only this layer.
                  </Text>
                  <Box>
                    <HStack justify="space-between" mb={2}>
                      <Text fontSize="sm">Layer scale</Text>
                      <Text fontSize="sm" color="gray.600">{transformDraft.scale}%</Text>
                    </HStack>
                    <Slider
                      value={transformDraft.scale}
                      min={10}
                      max={300}
                      onChange={(scale) => setTransformDraft((current) => ({ ...current, scale }))}
                    >
                      <SliderTrack><SliderFilledTrack /></SliderTrack>
                      <SliderThumb />
                    </Slider>
                  </Box>
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
                      onClick={() => setTransformDraft({ dx: 0, dy: 0, scale: 100 })}
                      isDisabled={!hasTransform(transformDraft)}
                      flex={1}
                    >
                      Reset
                    </Button>
                  </HStack>
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
                  <HStack>
                    <Box flex={1}>
                      <Text fontSize="sm" mb={1}>Width</Text>
                      <Input
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
                    <Switch isChecked={aspectLocked} onChange={(event) => setAspectLocked(event.target.checked)} />
                  </HStack>
                  <Box>
                    <HStack justify="space-between" mb={2}>
                      <Text fontSize="sm">Scale</Text>
                      <Text fontSize="sm" color="gray.600">{resizeDraft.scale}%</Text>
                    </HStack>
                    <Slider value={resizeDraft.scale} min={1} max={200} onChange={updateResizeScale}>
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
                    return (
                      <Box
                        key={layer.id}
                        border="1px solid"
                        borderColor={isActive ? 'blue.400' : 'gray.200'}
                        bg={isActive ? 'blue.50' : 'white'}
                        borderRadius="md"
                        p={2}
                        onClick={() => selectLayer(layer.id)}
                        cursor="pointer"
                      >
                        <HStack align="center" spacing={2}>
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
