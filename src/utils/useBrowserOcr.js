import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TESSERACT_VERSION = '7.0.0';
const OCR_MIN_LONG_EDGE = 1600;
const OCR_MAX_LONG_EDGE = 4200;
const OCR_CANCELED_MESSAGE = 'OCR was canceled.';

const createInitialOcrState = () => ({
  text: '',
  words: [],
  selectedWordIds: [],
  status: 'idle',
  statusLabel: '',
  progress: 0,
  error: '',
  confidence: null,
});

const getSelectedOcrText = (words, selectedWordIds) => {
  if (!words.length || !selectedWordIds.length) return '';

  const selectedWordIdSet = new Set(selectedWordIds);
  const selectedWords = words
    .filter((word) => selectedWordIdSet.has(word.id))
    .sort((first, second) => first.order - second.order);

  const lines = [];
  let currentLineId = null;
  let currentLineWords = [];

  selectedWords.forEach((word) => {
    if (currentLineId !== word.lineId) {
      if (currentLineWords.length) {
        lines.push(currentLineWords.join(' '));
      }
      currentLineId = word.lineId;
      currentLineWords = [];
    }

    currentLineWords.push(word.text);
  });

  if (currentLineWords.length) {
    lines.push(currentLineWords.join(' '));
  }

  return lines.join('\n');
};

const normalizeBbox = (bbox, scale) => ({
  x0: bbox.x0 / scale,
  y0: bbox.y0 / scale,
  x1: bbox.x1 / scale,
  y1: bbox.y1 / scale,
});

const normalizeOcrWords = (blocks, scale) => {
  if (!Array.isArray(blocks)) return [];

  const words = [];
  blocks.forEach((block, blockIndex) => {
    block.paragraphs?.forEach((paragraph, paragraphIndex) => {
      paragraph.lines?.forEach((line, lineIndex) => {
        const lineId = `line-${blockIndex}-${paragraphIndex}-${lineIndex}`;

        line.words?.forEach((word, wordIndex) => {
          const text = word.text?.trim();
          if (!text || !word.bbox) return;

          const bbox = normalizeBbox(word.bbox, scale);
          if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) return;

          words.push({
            id: `word-${blockIndex}-${paragraphIndex}-${lineIndex}-${wordIndex}`,
            text,
            confidence: Number.isFinite(word.confidence) ? Math.round(word.confidence) : null,
            bbox,
            lineId,
            order: words.length,
          });
        });
      });
    });
  });

  return words;
};

const formatStatusLabel = (status) => {
  if (!status) return 'Processing';
  return status
    .split(' ')
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join(' ');
};

const getOcrScale = (width, height) => {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) return 1;

  if (longEdge < OCR_MIN_LONG_EDGE) {
    return Math.min(2, OCR_MIN_LONG_EDGE / longEdge);
  }

  if (longEdge > OCR_MAX_LONG_EDGE) {
    return OCR_MAX_LONG_EDGE / longEdge;
  }

  return 1;
};

const prepareCanvasForOcr = (sourceCanvas) => {
  if (!sourceCanvas || sourceCanvas.width < 1 || sourceCanvas.height < 1) {
    return null;
  }

  const scale = getOcrScale(sourceCanvas.width, sourceCanvas.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);

  return {
    canvas,
    scale,
  };
};

export const useBrowserOcr = () => {
  const [ocrState, setOcrState] = useState(createInitialOcrState);
  const workerRef = useRef(null);
  const workerPromiseRef = useRef(null);
  const isRunningRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const isMountedRef = useRef(true);

  const safeSetOcrState = useCallback((updater) => {
    if (!isMountedRef.current) return;
    setOcrState(updater);
  }, []);

  const terminateWorker = useCallback(async () => {
    const worker = workerRef.current;
    const workerPromise = workerPromiseRef.current;

    workerRef.current = null;
    workerPromiseRef.current = null;

    try {
      if (worker) {
        await worker.terminate();
        return;
      }

      if (workerPromise) {
        const resolvedWorker = await workerPromise;
        await resolvedWorker.terminate();
      }
    } catch (err) {
      console.error('OCR worker termination failed:', err);
    }
  }, []);

  const getWorker = useCallback(async () => {
    if (workerRef.current) return workerRef.current;

    if (!workerPromiseRef.current) {
      workerPromiseRef.current = import('tesseract.js')
        .then(async ({ createWorker }) => {
          const worker = await createWorker('eng', 1, {
            workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
            corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`,
            langPath: 'https://tessdata.projectnaptha.com/4.0.0',
            logger: (message) => {
              if (!isRunningRef.current) return;

              const progress = Number.isFinite(message?.progress)
                ? Math.round(message.progress * 100)
                : 0;
              const statusLabel = formatStatusLabel(message?.status);
              const status = message?.status === 'recognizing text'
                ? 'recognizing'
                : 'loading';

              safeSetOcrState((current) => ({
                ...current,
                status,
                statusLabel,
                progress,
                error: '',
              }));
            },
          });

          await worker.setParameters({
            preserve_interword_spaces: '1',
          });

          workerRef.current = worker;
          return worker;
        })
        .catch((err) => {
          workerPromiseRef.current = null;
          throw err;
        });
    }

    return workerPromiseRef.current;
  }, [safeSetOcrState]);

  const runOcr = useCallback(async (sourceCanvas) => {
    if (isRunningRef.current) {
      throw new Error('OCR is already running.');
    }

    const preparedOcrCanvas = prepareCanvasForOcr(sourceCanvas);
    if (!preparedOcrCanvas) {
      throw new Error('No image is available for OCR.');
    }

    isRunningRef.current = true;
    cancelRequestedRef.current = false;
    safeSetOcrState((current) => ({
      ...current,
      status: 'preparing',
      statusLabel: 'Preparing Image',
      progress: 0,
      error: '',
      confidence: null,
    }));

    try {
      const worker = await getWorker();

      safeSetOcrState((current) => ({
        ...current,
        status: 'recognizing',
        statusLabel: 'Recognizing Text',
        progress: Math.max(current.progress, 1),
      }));

      const result = await worker.recognize(
        preparedOcrCanvas.canvas,
        {},
        {
          text: true,
          blocks: true,
        }
      );
      const text = result?.data?.text?.trim() || '';
      const words = normalizeOcrWords(result?.data?.blocks, preparedOcrCanvas.scale);
      const confidence = Number.isFinite(result?.data?.confidence)
        ? Math.round(result.data.confidence)
        : null;

      safeSetOcrState((current) => ({
        ...current,
        text,
        words,
        selectedWordIds: [],
        status: 'succeeded',
        statusLabel: text ? 'Text Recognized' : 'No Text Found',
        progress: 100,
        error: '',
        confidence,
      }));

      return text;
    } catch (err) {
      if (cancelRequestedRef.current) {
        const abortError = new Error(OCR_CANCELED_MESSAGE);
        abortError.name = 'AbortError';
        safeSetOcrState((current) => ({
          ...current,
          status: 'canceled',
          statusLabel: 'OCR Canceled',
          progress: 0,
          error: '',
          confidence: null,
        }));
        throw abortError;
      }

      safeSetOcrState((current) => ({
        ...current,
        status: 'error',
        statusLabel: 'OCR Failed',
        progress: 0,
        error: err?.message || 'OCR failed.',
        confidence: null,
      }));
      throw err;
    } finally {
      isRunningRef.current = false;
      cancelRequestedRef.current = false;
    }
  }, [getWorker, safeSetOcrState]);

  const clearOcr = useCallback(() => {
    safeSetOcrState(createInitialOcrState);
  }, [safeSetOcrState]);

  const setOcrText = useCallback((text) => {
    safeSetOcrState((current) => ({
      ...current,
      text,
      error: '',
    }));
  }, [safeSetOcrState]);

  const setSelectedOcrWordIds = useCallback((wordIds) => {
    safeSetOcrState((current) => ({
      ...current,
      selectedWordIds: Array.from(new Set(wordIds)),
    }));
  }, [safeSetOcrState]);

  const clearOcrSelection = useCallback(() => {
    safeSetOcrState((current) => ({
      ...current,
      selectedWordIds: [],
    }));
  }, [safeSetOcrState]);

  const cancelOcr = useCallback(async () => {
    if (!isRunningRef.current && !workerPromiseRef.current) return;

    cancelRequestedRef.current = true;
    isRunningRef.current = false;
    safeSetOcrState((current) => ({
      ...current,
      status: 'canceled',
      statusLabel: 'OCR Canceled',
      progress: 0,
      error: '',
      confidence: null,
    }));
    await terminateWorker();
  }, [safeSetOcrState, terminateWorker]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      isRunningRef.current = false;
      cancelRequestedRef.current = true;
      terminateWorker();
    };
  }, [terminateWorker]);

  const selectedOcrText = useMemo(() => (
    getSelectedOcrText(ocrState.words, ocrState.selectedWordIds)
  ), [ocrState.selectedWordIds, ocrState.words]);

  return {
    ocrText: ocrState.text,
    ocrWords: ocrState.words,
    selectedOcrWordIds: ocrState.selectedWordIds,
    selectedOcrText,
    ocrStatus: ocrState.status,
    ocrStatusLabel: ocrState.statusLabel,
    ocrProgress: ocrState.progress,
    ocrError: ocrState.error,
    ocrConfidence: ocrState.confidence,
    isOcrRunning: isRunningRef.current || ['preparing', 'loading', 'recognizing'].includes(ocrState.status),
    runOcr,
    cancelOcr,
    clearOcr,
    clearOcrSelection,
    setSelectedOcrWordIds,
    setOcrText,
  };
};
