import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Button,
  VStack,
  Text,
  HStack,
  Divider,
  Tooltip,
} from '@chakra-ui/react';
import { 
  calculateImageSize,
  copyImageBlob,
  downloadImageBlob
} from './imageExport';
import QualitySlider from './QualitySlider';

/**
 * Format size display to show KB in brackets when under 1MB
 * @param {string} sizeInMB - Size in MB as string
 * @returns {string} - Formatted size string
 */
const formatSizeDisplay = (sizeInMB) => {
  if (sizeInMB == null) return '—';
  const size = parseFloat(sizeInMB);
  if (size < 1 && size > 0) {
    const sizeInKB = (size * 1024).toFixed(1);
    return `${sizeInMB} MB (${sizeInKB} KB)`;
  }
  return `${sizeInMB} MB`;
};

/**
 * Custom hook that provides image export functionality and UI components
 * @param {function|object} canvasSource - Either a canvas ref or a function that returns a canvas
 * @param {function} toast - Toast notification function
 * @param {string} downloadPrefix - Prefix for downloaded filenames (e.g., 'cropped', 'resized', 'drawn')
 * @returns {object} - Object containing state, handlers, and UI components
 */
export const useImageExportControls = (canvasSource, toast, downloadPrefix = 'edited', { automaticSizeUpdates = true } = {}) => {
  const [outputSizes, setOutputSizes] = useState({ png: null, jpg: null });
  const [jpegQuality, setJpegQuality] = useState(90);
  const [isExportBusy, setIsExportBusy] = useState(false);
  const generationRef = useRef(0);
  const revisionRef = useRef(canvasSource?.revision ?? canvasSource);
  const qualityRef = useRef(jpegQuality);
  const jobsRef = useRef(new Map());
  const busyCountRef = useRef(0);
  const revision = canvasSource?.revision ?? canvasSource;
  revisionRef.current = revision;
  qualityRef.current = jpegQuality;

  useEffect(() => { setOutputSizes({ png: null, jpg: null }); }, [revision]);
  useEffect(() => { setOutputSizes((current) => ({ ...current, jpg: null })); }, [jpegQuality]);
  useEffect(() => () => {
    generationRef.current += 1;
    jobsRef.current.clear();
  }, []);

  const getBlob = useCallback((format, quality) => {
    const generation = generationRef.current;
    const key = `${format}:${quality}`;
    const existing = jobsRef.current.get(key);
    if (existing?.revision === revision && existing.generation === generation) return existing.promise;
    const promise = (async () => {
      let blob;
      if (typeof canvasSource?.exportBlob === 'function') {
        blob = await canvasSource.exportBlob(format, quality);
      } else {
        const canvas = await (typeof canvasSource === 'function' ? canvasSource() : canvasSource?.current);
        blob = (await calculateImageSize(canvas, format, quality)).blob;
      }
      if (!blob) throw new Error('No image is available to export.');
      if (generation === generationRef.current && revision === revisionRef.current && (format === 'image/png' || quality === qualityRef.current / 100)) {
        setOutputSizes((current) => ({ ...current, [format === 'image/png' ? 'png' : 'jpg']: (blob.size / (1024 * 1024)).toFixed(2) }));
      }
      return blob;
    })();
    jobsRef.current.set(key, { promise, revision, generation });
    const clear = () => { if (jobsRef.current.get(key)?.promise === promise) jobsRef.current.delete(key); };
    promise.then(clear, clear);
    return promise;
  }, [canvasSource, revision]);

  const trackJob = useCallback((job) => {
    const generation = generationRef.current;
    busyCountRef.current += 1; setIsExportBusy(true);
    return job.finally(() => {
      if (generation !== generationRef.current) return;
      busyCountRef.current -= 1;
      setIsExportBusy(busyCountRef.current > 0);
    });
  }, []);

  const updateOutputSizes = useCallback(() => trackJob((async () => {
    const generation = generationRef.current;
    try {
      await getBlob('image/png', 1);
      if (generation !== generationRef.current || revision !== revisionRef.current || jpegQuality !== qualityRef.current) return;
      await getBlob('image/jpeg', jpegQuality / 100);
    } catch (error) {
      if (error.name !== 'AbortError' && !automaticSizeUpdates) toast({ title: 'Could not calculate sizes', description: error.message, status: 'error' });
    }
  })()), [automaticSizeUpdates, getBlob, jpegQuality, revision, toast, trackJob]);

  useEffect(() => {
    if (automaticSizeUpdates) updateOutputSizes();
  }, [automaticSizeUpdates, updateOutputSizes]);

  const handleCopyToPNG = useCallback(() => {
    // Call write during the click. Safari accepts a promised Blob but does not
    // preserve activation across an awaited disk read or render.
    return trackJob(copyImageBlob(getBlob('image/png', 1), toast));
  }, [getBlob, toast, trackJob]);
  const handleCopyToJPG = handleCopyToPNG;

  const download = useCallback((format, quality) => trackJob((async () => {
    try {
      const blob = await getBlob(format, quality);
      return downloadImageBlob(blob, format, `${downloadPrefix}-image`, toast);
    } catch (error) {
      if (error.name !== 'AbortError') toast({ title: 'Download failed', description: error.message, status: 'error' });
      return false;
    }
  })()), [downloadPrefix, getBlob, toast, trackJob]);
  const handleDownloadPNG = useCallback(() => download('image/png', 1), [download]);
  const handleDownloadJPEG = useCallback(() => download('image/jpeg', jpegQuality / 100), [download, jpegQuality]);

  const resetExportState = useCallback(() => {
    generationRef.current += 1; jobsRef.current.clear(); busyCountRef.current = 0;
    setIsExportBusy(false); setOutputSizes({ png: null, jpg: null }); setJpegQuality(90);
  }, []);
  const handleQualityChange = useCallback((quality) => setJpegQuality(quality), []);

  // UI Components
  const ExportControls = () => (
    <>
      <QualitySlider 
        initialValue={jpegQuality}
        onQualityChange={handleQualityChange}
      />

      <Divider />

      <VStack w="100%" spacing={2}>
        <Text fontWeight="bold">Output Sizes:</Text>
        {!automaticSizeUpdates && <Button size="sm" onClick={updateOutputSizes} isLoading={isExportBusy}>Calculate sizes</Button>}
        <HStack w="100%" justify="space-between">
          <Text>PNG:</Text>
          <Text>{formatSizeDisplay(outputSizes.png)}</Text>
        </HStack>
        <HStack w="100%" justify="space-between">
          <Text>JPG:</Text>
          <Text>{formatSizeDisplay(outputSizes.jpg)}</Text>
        </HStack>
      </VStack>

      <Divider />

      <VStack w="100%" spacing={3} align="stretch">
        <HStack w="100%" spacing={4}>
          <Button 
            colorScheme="blue" 
            onClick={handleCopyToPNG}
            isDisabled={isExportBusy}
            flex={1}
          >
            Copy as PNG
          </Button>
          <Tooltip 
            label="Browsers only support PNG format for clipboard operations" 
            placement="top"
            hasArrow
          >
            <Button 
              color="white" 
              bg="blue.300"
              onClick={handleCopyToJPG}
              flex={1}
              isDisabled={true}
              opacity={0.6}
            >
              Copy as JPEG
            </Button>
          </Tooltip>
        </HStack>

        <HStack w="100%" spacing={4}>
          <Button 
            colorScheme="green" 
            onClick={handleDownloadPNG}
            isDisabled={isExportBusy}
            flex={1}
          >
            Download PNG
          </Button>
          <Button 
            color="white" 
            bg="green.400"
            onClick={handleDownloadJPEG}
            isDisabled={isExportBusy}
            flex={1}
          >
            Download JPEG
          </Button>
        </HStack>
      </VStack>
    </>
  );

  return {
    // State
    outputSizes,
    jpegQuality,
    setJpegQuality,
    
    // Functions
    updateOutputSizes,
    resetExportState,
    handleCopyToPNG,
    handleCopyToJPG,
    handleDownloadPNG,
    handleDownloadJPEG,
    
    // UI Components
    ExportControls,
  };
}; 
