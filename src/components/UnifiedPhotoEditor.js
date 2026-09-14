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
import { createRasterClient } from '../utils/rasterClient';
import { importRasterBlob } from '../utils/rasterImport';
import { getEditorViewport } from '../utils/editorViewport';
import { useBrowserOcr } from '../utils/useBrowserOcr';
import {
  MAX_DIMENSION,
  applyLayerTransform,
  clamp,
  clampDimension,
  cloneLayer,
  createDefaultTransformDraft,
  createEmptyDocument,
  createLayerId,
  createRasterLayer,
  multiplyTransforms,
  cropFromEdges,
  editorReducer,
  getActiveLayer,
  getDraftRotation,
  getDraftScaleX,
  getDraftScaleY,
  getLayerDocumentBounds,
  getLayerGroupBounds,
  getLocalPoint,
  getTransformedGeometry,
  hasDocument,
  hasTransform,
  normalizeRotation,
  resizeDocument,
  rotateLocalPoint,
  toDegrees,
  translateLayer,
  updateLayer,
} from '../utils/editorLayers';

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

const createDefaultViewOffset = () => ({ x: 0, y: 0 });

const areViewOffsetsEqual = (first, second) => (
  first.x === second.x && first.y === second.y
);

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

const getTranslationDraft = (draft) => ({
  ...createDefaultTransformDraft(),
  dx: draft?.dx ?? 0,
  dy: draft?.dy ?? 0,
});

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

const LayerThumbnail = ({ layer, client }) => {
  const canvasRef = useRef(null);
  const queueRef = useRef({ running: false, latest: null, generation: 0 });
  useEffect(() => {
    const queue = queueRef.current;
    const generation = ++queue.generation;
    const bounds = getLayerDocumentBounds(layer);
    const canvas = canvasRef.current;
    if (!bounds || !canvas) return undefined;
    const scale = Math.min(64 / bounds.width, 44 / bounds.height);
    const thumbnailDoc = {
      width: Math.ceil(bounds.width), height: Math.ceil(bounds.height),
      layers: [{ ...translateLayer(layer, -bounds.x, -bounds.y), visible: true }],
    };
    queue.latest = { client, generation, options: {
      doc: thumbnailDoc, width: 64, height: 44,
      view: [scale, 0, 0, scale, (64 - bounds.width * scale) / 2, (44 - bounds.height * scale) / 2],
    } };
    const drain = async () => {
      if (queue.running) return;
      queue.running = true;
      try {
        while (queue.latest) {
          const request = queue.latest;
          queue.latest = null;
          try {
            const { bitmap } = await request.client.call('render', request.options);
            try {
              if (request.generation !== queue.generation) continue;
              const ctx = canvas.getContext('2d');
              ctx.clearRect(0, 0, 64, 44); ctx.drawImage(bitmap, 0, 0);
            } finally { bitmap.close(); }
          } catch (error) { /* A removed layer or reset can cancel its thumbnail. */ }
        }
      } finally {
        queue.running = false;
      }
    };
    drain();
    return () => { queue.generation += 1; queue.latest = null; canvas.width = 64; };
  }, [layer, client]);
  return <canvas ref={canvasRef} width={64} height={44} style={{ width: '64px', height: '44px', border: '1px solid #cbd5e1', background: '#f8fafc' }} />;
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
  const previousHasDocumentRef = useRef(false);
  const visualSignatureRef = useRef('');
  const rasterClientRef = useRef(null);
  const editorEpochRef = useRef(0);
  const busyRef = useRef(false);
  const jobQueueRef = useRef(Promise.resolve());
  const queuedJobsRef = useRef(0);
  const renderQueueRef = useRef({ running: false, latest: null, generation: 0 });
  const [isBusy, setIsBusy] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });

  const [{ doc, history, historyIndex }, dispatch] = useReducer(editorReducer, {
    doc: createEmptyDocument(),
    history: [],
    historyIndex: -1,
  });

  const createClient = useCallback(() => createRasterClient((event) => {
    if (event.type === 'historyTrimmed') {
      dispatch({ type: 'dropHistory', keys: event.keys });
      if (!toast.isActive('storage-history')) toast({ id: 'storage-history', title: 'Older undo steps cleared', description: 'Space was freed for the current edit.', status: 'info', duration: 4000 });
    } else if (event.type === 'memoryFallback') {
      toast({ title: 'Temporary storage unavailable', description: 'Editing is using a limited memory cache. Fewer large images and undo steps may fit.', status: 'info', duration: 6000 });
    } else if (event.type === 'error') {
      toast({ title: 'Image processing stopped', description: event.message, status: 'error', duration: 6000 });
    }
  }), [toast]);
  if (!rasterClientRef.current) rasterClientRef.current = createClient();

  useEffect(() => {
    rasterClientRef.current = createClient();
    const renderQueue = renderQueueRef.current;
    return () => {
      editorEpochRef.current += 1;
      interactionRef.current?.resolveDone?.();
      interactionRef.current = null;
      renderQueue.generation += 1;
      renderQueue.latest = null;
      rasterClientRef.current.dispose().catch(() => {});
    };
  }, [createClient]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const observer = new ResizeObserver(() => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!history.length && !doc.layers.length) return;
    const rasters = (document) => document.layers.map((layer) => layer.rasterId);
    rasterClientRef.current.call('retain', {
      documents: history.map((document) => ({ key: document.revisionId, rasters: rasters(document) })),
      current: rasters(doc), currentKey: history[historyIndex]?.revisionId,
    }).catch((error) => { if (error.name !== 'AbortError') console.error(error); });
  }, [doc, history, historyIndex]);

  const runPixelOperation = useCallback((label, operation) => {
    // Keep at most one waiting import alongside the active operation. Clipboard
    // Blobs can own substantial memory even before the worker decodes them.
    if (queuedJobsRef.current >= 2) {
      if (!toast.isActive('image-queue')) toast({ id: 'image-queue', title: 'Images are still loading', description: 'Wait for these images to finish before adding another.', status: 'info', duration: 3000 });
      return Promise.resolve();
    }
    queuedJobsRef.current += 1;
    const epoch = editorEpochRef.current;
    const client = rasterClientRef.current;
    const strokeDone = interactionRef.current?.type === 'stroke' ? interactionRef.current.done : Promise.resolve();
    const result = jobQueueRef.current.then(async () => {
      await strokeDone;
      if (epoch !== editorEpochRef.current) return;
      busyRef.current = true; setIsBusy(true);
      try { return await operation(client, () => epoch === editorEpochRef.current); }
      catch (error) {
        if (epoch === editorEpochRef.current && error.name !== 'AbortError') toast({ title: label, description: error.message, status: 'error', duration: 4500 });
      } finally {
        if (epoch === editorEpochRef.current) {
          queuedJobsRef.current -= 1;
          busyRef.current = false; setIsBusy(false);
        }
      }
    });
    jobQueueRef.current = result.catch(() => {});
    return result;
  }, [toast]);

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
  const documentVisualSignature = useMemo(() => `${doc.width}x${doc.height}|${doc.layers.map((layer) => [layer.id, layer.rasterId, ...layer.transform, layer.visible, layer.opacity].join(':')).join('|')}`, [doc]);
  const viewport = getEditorViewport(
    { width: displayWidth, height: displayHeight }, viewportSize.width, viewportSize.height,
    viewZoom, viewOffset, window.devicePixelRatio || 1
  );

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

    return getEditorViewport(docRef.current, viewport.clientWidth, viewport.clientHeight, targetZoom);

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

  const exportProvider = useMemo(() => ({
    revision: documentVisualSignature,
    exportBlob: async (format, quality) => {
      if (!hasDocument(doc)) return null;
      if (busyRef.current) throw new Error('Wait for the current image operation to finish.');
      return rasterClientRef.current.call('exportBlob', { doc, format, quality });
    },
  }), [doc, documentVisualSignature]);
  const { resetExportState, ExportControls } = useImageExportControls(exportProvider, toast, 'edited', { automaticSizeUpdates: false });
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
    if (busyRef.current) return;
    interactionRef.current = null;
    resetTransformDraft();
    dispatch({ type: 'undo' });
  }, [resetTransformDraft]);

  const redoDocument = useCallback(() => {
    if (busyRef.current) return;
    interactionRef.current = null;
    resetTransformDraft();
    dispatch({ type: 'redo' });
  }, [resetTransformDraft]);

  const renderDisplay = useCallback((renderDoc = doc) => {
    const canvas = displayCanvasRef.current;
    if (!canvas || !hasDocument(renderDoc)) return;
    const isGroupMove = activeTool === TOOLS.MOVE && hasMultiLayerSelection;
    const draft = isGroupMove ? getTranslationDraft(transformDraft) : transformDraft;
    const ids = new Set(isGroupMove ? selectedMoveLayers.map((layer) => layer.id) : activeTool === TOOLS.MOVE ? [renderDoc.activeLayerId] : []);
    const drawingDoc = { ...renderDoc, layers: renderDoc.layers.map((layer) => ids.has(layer.id) ? applyLayerTransform(layer, draft) : layer) };
    const view = getEditorViewport({ width: displayWidth, height: displayHeight }, viewportSize.width, viewportSize.height, viewZoom, viewOffset, window.devicePixelRatio || 1);
    const matrix = multiplyTransforms(view.matrix, [displayWidth / renderDoc.width, 0, 0, displayHeight / renderDoc.height, 0, 0]);
    const queue = renderQueueRef.current;
    const generation = ++queue.generation;
    const epoch = editorEpochRef.current;
    queue.latest = { drawingDoc, matrix, view, generation, epoch, client: rasterClientRef.current, drawOverlay: (ctx) => {
      ctx.save(); ctx.setTransform(...matrix);
      if (isGroupMove) drawLayerGroupBounds(ctx, selectedMoveLayers, draft, renderDoc);
      else if (activeTool === TOOLS.MOVE && activeLayer) drawLayerBounds(ctx, activeLayer, draft, renderDoc);
      if (activeTool === TOOLS.CROP) drawCropOverlay(ctx, renderDoc, crop);
      ctx.restore();
    } };
    if (queue.running) return;
    queue.running = true;
    const drain = async () => {
      try {
        while (queue.latest) {
          const request = queue.latest; queue.latest = null;
          try {
            const { bitmap } = await request.client.call('render', { doc: request.drawingDoc, width: request.view.pixelWidth, height: request.view.pixelHeight, view: request.matrix });
            try {
              if (request.epoch !== editorEpochRef.current || request.generation !== queue.generation) continue;
              if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
              if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
              const ctx = canvas.getContext('2d');
              ctx.resetTransform(); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0);
              request.drawOverlay(ctx);
            } finally { bitmap.close(); }
          } catch (error) {
            if (request.epoch === editorEpochRef.current && error.name !== 'AbortError' && !toast.isActive('render-error')) toast({ id: 'render-error', title: 'Could not display image', description: error.message, status: 'error', duration: 5000 });
          }
        }
      } finally { queue.running = false; }
    };
    drain();
  }, [activeLayer, activeTool, crop, displayHeight, displayWidth, doc, hasMultiLayerSelection, selectedMoveLayers, toast, transformDraft, viewportSize, viewOffset, viewZoom]);

  useEffect(() => { renderDisplay(); }, [renderDisplay]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (busyRef.current) return;
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
    const documentExists = documentWidth > 0 && documentHeight > 0 && documentLayerCount > 0;
    const previouslyHadDocument = previousHasDocumentRef.current;
    previousHasDocumentRef.current = documentExists;

    if (!documentExists || !previouslyHadDocument) {
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

  const importImageBlob = useCallback((blob) => runPixelOperation('Import failed', async (client, isCurrent) => {
    const source = await importRasterBlob(client, blob);
    if (!isCurrent()) return;
    const currentDoc = docRef.current;
    const layer = createRasterLayer(source, currentDoc, currentDoc.layers.length + 1);
    const nextDoc = hasDocument(currentDoc)
      ? { ...currentDoc, layers: [...currentDoc.layers, layer], activeLayerId: layer.id }
      : { width: source.sourceWidth, height: source.sourceHeight, layers: [layer], activeLayerId: layer.id };
    commitDocument(nextDoc); updateSelectedLayerIds([layer.id]); setCrop(null); setActiveTool(TOOLS.BRUSH);
    toast({ title: hasDocument(currentDoc) ? 'Layer added' : 'Image loaded', status: 'success', duration: 2200 });
  }), [commitDocument, runPixelOperation, toast, updateSelectedLayerIds]);

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

    importImageBlob(file);
  }, [importImageBlob, toast]);

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
    importImageBlob(blob);
  }, [importImageBlob]);

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

  const addBlankLayer = useCallback(() => runPixelOperation('Could not add layer', async (client, isCurrent) => {
    const currentDoc = docRef.current;
    if (!hasDocument(currentDoc)) return;
    const source = await client.call('blank', { width: currentDoc.width, height: currentDoc.height });
    if (!isCurrent()) return;
    const layer = { ...createRasterLayer(source, currentDoc, currentDoc.layers.length + 1), name: `Layer ${currentDoc.layers.length + 1}` };
    commitDocument({ ...currentDoc, layers: [...currentDoc.layers, layer], activeLayerId: layer.id });
    updateSelectedLayerIds([layer.id]);
  }), [commitDocument, runPixelOperation, updateSelectedLayerIds]);

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

    const view = getEditorViewport(currentDoc, rect.width, rect.height, viewZoomRef.current, viewOffsetRef.current);
    const point = {
      x: (event.clientX - rect.left - view.x) / view.scale,
      y: (event.clientY - rect.top - view.y) / view.scale,
    };

    if (!shouldClamp) return point;

    return {
      x: clamp(point.x, 0, currentDoc.width),
      y: clamp(point.y, 0, currentDoc.height),
    };
  }, []);

  const drainStroke = useCallback(async (stroke) => {
    if (stroke.processing) return;
    stroke.processing = true;
    try {
      let source = await stroke.started;
      if (stroke.epoch !== editorEpochRef.current) return;
      while (true) {
        if (stroke.points.length) source = await stroke.client.call('strokePoints', { points: stroke.points.splice(0, 128) });
        if (stroke.epoch !== editorEpochRef.current) return;
        const currentSource = source;
        const nextDoc = updateLayer(stroke.baseDoc, stroke.layerId, (layer) => ({ ...layer, ...currentSource }));
        setDocumentTransient(nextDoc);
        if (stroke.points.length) continue;
        if (stroke.ended) {
          await stroke.client.call('finishStroke');
          if (stroke.epoch !== editorEpochRef.current) return;
          interactionRef.current = null;
          commitDocument(nextDoc);
          busyRef.current = false; setIsBusy(false); stroke.resolveDone();
        }
        break;
      }
    } catch (error) {
      await stroke.client.call('abortStroke').catch(() => {});
      if (stroke.epoch === editorEpochRef.current) {
        interactionRef.current = null;
        setDocumentTransient(stroke.baseDoc);
        busyRef.current = false; setIsBusy(false);
        if (error.name !== 'AbortError') toast({ title: 'Could not finish stroke', description: error.message, status: 'error' });
      }
      stroke.resolveDone();
    } finally { stroke.processing = false; }
  }, [commitDocument, setDocumentTransient, toast]);

  const startStroke = useCallback((event) => {
    if (busyRef.current) return;
    const currentDoc = docRef.current;
    const layer = getActiveLayer(currentDoc);
    const point = getCanvasPoint(event, false);
    if (!layer || !point || point.x < 0 || point.y < 0 || point.x > currentDoc.width || point.y > currentDoc.height) return;
    if (!layer.visible) { toast({ title: 'Layer hidden', description: 'Make the active layer visible before drawing on it.', status: 'info' }); return; }
    const client = rasterClientRef.current;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const stroke = {
      type: 'stroke', layerId: layer.id, pointerId: event.pointerId, baseDoc: currentDoc,
      epoch: editorEpochRef.current, client, points: [], ended: false, processing: false, done, resolveDone,
      started: client.call('beginStroke', { layer, point, size: brushSize, color: brushColor, erase: activeTool === TOOLS.ERASER }),
    };
    interactionRef.current = stroke;
    busyRef.current = true; setIsBusy(true);
    drainStroke(stroke);
  }, [activeTool, brushColor, brushSize, drainStroke, getCanvasPoint, toast]);

  const continueStroke = useCallback((event) => {
    const stroke = interactionRef.current;
    if (!stroke || stroke.type !== 'stroke' || stroke.ended || stroke.pointerId !== event.pointerId) return;
    const coalesced = event.nativeEvent?.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [event];
    events.forEach((sample) => { const point = getCanvasPoint(sample); if (point) stroke.points.push(point); });
    drainStroke(stroke);
  }, [drainStroke, getCanvasPoint]);

  const finishStroke = useCallback(() => {
    const stroke = interactionRef.current;
    if (!stroke || stroke.type !== 'stroke') return;
    stroke.ended = true; drainStroke(stroke);
  }, [drainStroke]);

  const startCropInteraction = useCallback((event) => {
    const currentDoc = docRef.current;
    const point = getCanvasPoint(event);
    const canvas = displayCanvasRef.current;
    if (!point || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const tolerance = Math.max(
      6,
      10 / getEditorViewport(currentDoc, rect.width, rect.height, viewZoomRef.current).scale
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
      10 / getEditorViewport(currentDoc, rect.width, rect.height, viewZoomRef.current).scale
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
            ? translateLayer(candidate, dx, dy)
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
      ...applyLayerTransform(candidate, draft),
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
    if (!interaction || interaction.pointerId !== event.pointerId) return;

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
    if (!interaction || interaction.pointerId !== event.pointerId) return;

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

  const applyCrop = useCallback(() => runPixelOperation('Could not crop image', async (client, isCurrent) => {
    const currentDoc = docRef.current;
    const currentCrop = cropRef.current;
    if (!hasDocument(currentDoc) || !currentCrop) return;
    const safeCrop = cropFromEdges(currentCrop.x, currentCrop.y, currentCrop.x + currentCrop.width, currentCrop.y + currentCrop.height, currentDoc);
    const nextDoc = await client.call('crop', { doc: currentDoc, crop: safeCrop });
    if (!isCurrent()) return;
    setCrop(null); setActiveTool(TOOLS.MOVE); commitDocument(nextDoc);
  }), [commitDocument, runPixelOperation]);

  const applyResize = useCallback(() => {
    const currentDoc = docRef.current;
    if (!hasDocument(currentDoc)) return;

    const nextDoc = resizeDocument(currentDoc, resizeDraft.width, resizeDraft.height);
    setActiveTool(TOOLS.MOVE);
    commitDocument(nextDoc);
  }, [commitDocument, resizeDraft.height, resizeDraft.width]);

  const handleRunOcr = useCallback(async () => {
    if (!hasDocument(docRef.current) || busyRef.current) {
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
      const epoch = editorEpochRef.current;
      const sourceDoc = docRef.current;
      const input = await rasterClientRef.current.call('ocrInput', { doc: sourceDoc });
      if (epoch !== editorEpochRef.current || sourceDoc !== docRef.current) return;
      const text = await runOcr(input);
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
  }, [runOcr, toast]);

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
    editorEpochRef.current += 1;
    if (displayCanvasRef.current) {
      displayCanvasRef.current.width = 1;
      displayCanvasRef.current.height = 1;
    }
    interactionRef.current?.resolveDone?.();
    interactionRef.current = null;
    renderQueueRef.current.generation += 1;
    renderQueueRef.current.latest = null;
    const previous = rasterClientRef.current;
    rasterClientRef.current = createClient();
    previous.dispose().catch(() => {});
    jobQueueRef.current = Promise.resolve();
    queuedJobsRef.current = 0;
    busyRef.current = false; setIsBusy(false);
    cancelOcr();
    dispatch({ type: 'reset' });
    docRef.current = createEmptyDocument();
    updateSelectedLayerIds([]);
    setCrop(null);
    setActiveTool(TOOLS.MOVE);
    resetTransformDraft();
    resetView();
    resetExportState();
    clearOcr();
  }, [cancelOcr, clearOcr, createClient, resetExportState, resetTransformDraft, resetView, updateSelectedLayerIds]);

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
      aria-busy={isBusy}
      onKeyDownCapture={(event) => {
        if (busyRef.current && !event.target.closest('[data-editor-reset]')) { event.preventDefault(); event.stopPropagation(); }
      }}
      onPointerDownCapture={(event) => {
        if (busyRef.current && !event.target.closest('canvas, [data-editor-reset]')) { event.preventDefault(); event.stopPropagation(); }
      }}
      onClickCapture={(event) => {
        if (busyRef.current && !event.target.closest('[data-editor-reset]')) { event.preventDefault(); event.stopPropagation(); }
      }}
    >
      <VStack spacing={4} align="stretch" w="100%" p={{ base: 3, md: 5 }}>
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
              {isBusy && <Text color="blue.600" role="status">Processing image…</Text>}
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
                data-editor-reset="true"
                onClick={resetEditor}
                isDisabled={!hasDocument(doc) && !isBusy}
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
            h={{ base: '58vh', lg: 'calc(100vh - 150px)' }}
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
            {isBusy && <Badge position="absolute" top={3} right={3} zIndex={2} colorScheme="blue" pointerEvents="none">Processing image…</Badge>}
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
              <Box position="absolute" inset={0} lineHeight={0}>
                <Box
                  position="absolute" pointerEvents="none"
                  left={`${viewport.x}px`} top={`${viewport.y}px`} w={`${viewport.width}px`} h={`${viewport.height}px`}
                  bg="#f8fafc"
                  backgroundImage="linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)"
                  backgroundSize="18px 18px" backgroundPosition="0 0, 0 9px, 9px -9px, -9px 0px"
                />
                <canvas
                  ref={displayCanvasRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: toolCursor, touchAction: 'none' }}
                />

                {ocrWords.length > 0 && (
                  <Box
                    as="svg"
                    aria-label="OCR text selection overlay"
                    viewBox={`0 0 ${doc.width} ${doc.height}`}
                    preserveAspectRatio="none"
                    position="absolute"
                    left={`${viewport.x}px`} top={`${viewport.y}px`}
                    w={`${viewport.width}px`} h={`${viewport.height}px`}
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
                          <LayerThumbnail layer={layer} client={rasterClientRef.current} />
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
