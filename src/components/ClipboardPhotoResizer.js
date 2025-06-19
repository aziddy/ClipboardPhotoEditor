import React, { useState, useCallback } from 'react';
import {
  Box,
  Button,
  VStack,
  HStack,
  Text,
  Slider,
  SliderTrack,
  SliderFilledTrack,
  SliderThumb,
  useToast,
} from '@chakra-ui/react';
import { useImageUpload } from '../utils/imageUpload';
import { createResizedCanvas } from '../utils/imageExport';
import { useImageExportControls } from '../utils/useImageExportControls';

function ClipboardPhotoResizer() {
  const [image, setImage] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(100);
  const [previewUrl, setPreviewUrl] = useState(null);
  const toast = useToast();

  // Canvas source function for the export hook
  const getCanvas = useCallback(() => {
    if (!image) return null;
    return createResizedCanvas(image, dimensions, scale);
  }, [image, dimensions, scale]);

  // Use the export controls hook
  const { updateOutputSizes, resetExportState, ExportControls } = useImageExportControls(
    getCanvas,
    toast,
    'resized'
  );

  // Use the shared image upload hook
  const { handlePaste, renderFileUploadUI } = useImageUpload(
    // We need to handle image setting differently in this component
    (url) => {
      const img = new Image();
      img.src = url;
      img.onload = () => {
        if (img.width < 10 || img.height < 10) {
          toast({
            title: 'Error',
            description: 'Image dimensions must be at least 10x10 pixels',
            status: 'error',
            duration: 3000,
          });
          return;
        }
        
        setImage(img);
        setDimensions({ width: img.width, height: img.height });
      };
    }, 
    // We don't need to set file size in the hook anymore
    null,
    toast
  );

  const resetApp = useCallback(() => {
    setImage(null);
    setDimensions({ width: 0, height: 0 });
    setScale(100);
    setPreviewUrl(null);
    resetExportState();
    toast({
      title: 'Reset Complete',
      description: 'Ready for a new image',
      status: 'info',
      duration: 2000,
    });
  }, [resetExportState, toast]);

  // Update preview and output sizes whenever scale changes
  React.useEffect(() => {
    let isCurrent = true;
    
    const updatePreviewAndSizes = async () => {
      if (!image) return;
      
      const canvas = createResizedCanvas(image, dimensions, scale);
      if (!canvas) return;

      try {
        // Update preview URL
        const newPreviewUrl = canvas.toDataURL('image/png');
        if (isCurrent) {
          setPreviewUrl(newPreviewUrl);
        }

        // Update output sizes
        updateOutputSizes();
      } catch (err) {
        console.error('Error updating preview and sizes:', err);
      }
    };

    updatePreviewAndSizes();
    
    return () => {
      isCurrent = false;
    };
  }, [scale, image, dimensions, updateOutputSizes]);

  return (
    <Box p={6} maxW="800px" mx="auto" onPaste={(e) => {
      e.stopPropagation();
      handlePaste(e);
    }}>
      <VStack spacing={6} align="stretch">
        <Text fontSize="2xl" fontWeight="bold">Clipboard Photo Resizer</Text>
        
        {!image && (
          <Box p={10} border="2px dashed" borderColor="gray.300" borderRadius="md" textAlign="center">
            <VStack spacing={4}>
              <Text>Paste an image from your clipboard (Ctrl/Cmd + V)</Text>
              
              <HStack>
                <Text>Or</Text>
              </HStack>
              
              {renderFileUploadUI()}
            </VStack>
          </Box>
        )}

        {image && (
          <>
            <Box borderRadius="md" overflow="hidden">
              <img
                src={previewUrl || image.src}
                alt="Preview"
                style={{
                  width: '100%',
                  height: 'auto',
                  objectFit: 'contain',
                }}
              />
            </Box>

            <VStack spacing={4}>
              <HStack w="100%" justify="space-between">
                <Text>Scale: {scale}%</Text>
                <Slider
                  value={scale}
                  onChange={setScale}
                  min={1}
                  max={100}
                  w="70%"
                >
                  <SliderTrack>
                    <SliderFilledTrack />
                  </SliderTrack>
                  <SliderThumb />
                </Slider>
              </HStack>

              <HStack w="100%" justify="space-between">
                <Text>Dimensions:</Text>
                <Text>
                  {Math.round(dimensions.width * scale / 100)} x {Math.round(dimensions.height * scale / 100)} px
                </Text>
              </HStack>

              <ExportControls />

              <Button 
                colorScheme="red" 
                onClick={resetApp}
                w="100%"
              >
                Reset
              </Button>
            </VStack>
          </>
        )}
      </VStack>
    </Box>
  );
}

export default ClipboardPhotoResizer;
