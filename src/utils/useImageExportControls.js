import { useState, useCallback, useEffect } from 'react';
import {
  Button,
  VStack,
  Text,
  HStack,
  Divider,
} from '@chakra-ui/react';
import { 
  copyToClipboard, 
  downloadImage, 
  getOutputSizes 
} from './imageExport';
import QualitySlider from './QualitySlider';

/**
 * Custom hook that provides image export functionality and UI components
 * @param {function|object} canvasSource - Either a canvas ref or a function that returns a canvas
 * @param {function} toast - Toast notification function
 * @param {string} downloadPrefix - Prefix for downloaded filenames (e.g., 'cropped', 'resized', 'drawn')
 * @returns {object} - Object containing state, handlers, and UI components
 */
export const useImageExportControls = (canvasSource, toast, downloadPrefix = 'edited') => {
  const [outputSizes, setOutputSizes] = useState({ png: '0.00', jpg: '0.00' });
  const [jpegQuality, setJpegQuality] = useState(90);

  // Get canvas from either ref or function
  const getCanvas = useCallback(() => {
    if (typeof canvasSource === 'function') {
      return canvasSource();
    }
    return canvasSource?.current || null;
  }, [canvasSource]);

  // Update output sizes based on current canvas and quality
  const updateOutputSizes = useCallback(async () => {
    const canvas = getCanvas();
    if (!canvas) {
      setOutputSizes({ png: '0.00', jpg: '0.00' });
      return;
    }

    try {
      const sizes = await getOutputSizes(canvas, jpegQuality / 100);
      setOutputSizes(sizes);
    } catch (err) {
      setOutputSizes({ png: '0.00', jpg: '0.00' });
      console.error('Error updating output sizes:', err);
    }
  }, [getCanvas, jpegQuality]);

  // Update sizes when quality changes
  useEffect(() => {
    updateOutputSizes();
  }, [jpegQuality, updateOutputSizes]);

  // Export handlers
  const handleCopyToPNG = useCallback(async () => {
    const canvas = getCanvas();
    if (canvas) {
      await copyToClipboard(canvas, 'image/png', 1, toast);
    }
  }, [getCanvas, toast]);

  const handleCopyToJPG = useCallback(async () => {
    const canvas = getCanvas();
    if (canvas) {
      await copyToClipboard(canvas, 'image/jpeg', jpegQuality / 100, toast);
    }
  }, [getCanvas, jpegQuality, toast]);

  const handleDownloadPNG = useCallback(async () => {
    const canvas = getCanvas();
    if (canvas) {
      await downloadImage(canvas, 'image/png', 1, `${downloadPrefix}-image`, toast);
    }
  }, [getCanvas, downloadPrefix, toast]);

  const handleDownloadJPEG = useCallback(async () => {
    const canvas = getCanvas();
    if (canvas) {
      await downloadImage(canvas, 'image/jpeg', jpegQuality / 100, `${downloadPrefix}-image`, toast);
    }
  }, [getCanvas, downloadPrefix, jpegQuality, toast]);

  // Reset function
  const resetExportState = useCallback(() => {
    setOutputSizes({ png: '0.00', jpg: '0.00' });
    setJpegQuality(90);
  }, []);

  // Quality change handler
  const handleQualityChange = useCallback((newQuality) => {
    setJpegQuality(newQuality);
  }, []);

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
        <HStack w="100%" justify="space-between">
          <Text>PNG:</Text>
          <Text>{outputSizes.png} MB</Text>
        </HStack>
        <HStack w="100%" justify="space-between">
          <Text>JPG:</Text>
          <Text>{outputSizes.jpg} MB</Text>
        </HStack>
      </VStack>

      <Divider />

      <VStack w="100%" spacing={3}>
        {/* <Text fontWeight="bold">Copy to Clipboard:</Text> */}
        <HStack w="100%" spacing={4}>
          <Button 
            colorScheme="blue" 
            onClick={handleCopyToPNG}
            flex={1}
          >
            Copy as PNG
          </Button>
          <Button 
            color="white" 
            bg="blue.300"
            onClick={handleCopyToJPG}
            flex={1}
          >
            Copy as JPEG
          </Button>
        </HStack>
      </VStack>

      <VStack w="100%" spacing={3}>
        {/* <Text fontWeight="bold">Download:</Text> */}
        <HStack w="100%" spacing={4}>
          <Button 
            colorScheme="green" 
            onClick={handleDownloadPNG}
            flex={1}
          >
            Download PNG
          </Button>
          <Button 
            color="white" 
            bg="green.300"
            onClick={handleDownloadJPEG}
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