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
  Divider,
} from '@chakra-ui/react';
import { useImageUpload } from '../utils/imageUpload';
import { 
  copyToClipboard, 
  downloadImage, 
  getOutputSizes, 
  createResizedCanvas 
} from '../utils/imageExport';

function ClipboardPhotoResizer() {
  const [image, setImage] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(100);
  const [outputSizes, setOutputSizes] = useState({ png: '0.00', jpg: '0.00' });
  const [jpegQuality, setJpegQuality] = useState(90);
  const [previewUrl, setPreviewUrl] = useState(null);
  const toast = useToast();

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
    setOutputSizes({ png: '0.00', jpg: '0.00' });
    setPreviewUrl(null);
    toast({
      title: 'Reset Complete',
      description: 'Ready for a new image',
      status: 'info',
      duration: 2000,
    });
  }, [toast]);

  // Update preview and output sizes whenever scale or quality changes
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
        const sizes = await getOutputSizes(canvas, jpegQuality / 100);
        if (isCurrent) {
          setOutputSizes(sizes);
        }
      } catch (err) {
        console.error('Error updating preview and sizes:', err);
      }
    };

    updatePreviewAndSizes();
    
    return () => {
      isCurrent = false;
    };
  }, [scale, jpegQuality, image, dimensions]);

  const handleCopyToPNG = useCallback(async () => {
    if (!image) return;
    const canvas = createResizedCanvas(image, dimensions, scale);
    if (canvas) {
      await copyToClipboard(canvas, 'image/png', 1, toast);
    }
  }, [image, dimensions, scale, toast]);

  const handleCopyToJPG = useCallback(async () => {
    if (!image) return;
    const canvas = createResizedCanvas(image, dimensions, scale);
    if (canvas) {
      await copyToClipboard(canvas, 'image/jpeg', jpegQuality / 100, toast);
    }
  }, [image, dimensions, scale, jpegQuality, toast]);

  const handleDownloadPNG = useCallback(async () => {
    if (!image) return;
    const canvas = createResizedCanvas(image, dimensions, scale);
    if (canvas) {
      await downloadImage(canvas, 'image/png', 1, 'resized-image', toast);
    }
  }, [image, dimensions, scale, toast]);

  const handleDownloadJPEG = useCallback(async () => {
    if (!image) return;
    const canvas = createResizedCanvas(image, dimensions, scale);
    if (canvas) {
      await downloadImage(canvas, 'image/jpeg', jpegQuality / 100, 'resized-image', toast);
    }
  }, [image, dimensions, scale, jpegQuality, toast]);

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

              <HStack w="100%" justify="space-between" align="center">
                <Text>JPEG Quality:</Text>
                <Slider
                  value={jpegQuality}
                  onChange={setJpegQuality}
                  min={10}
                  max={100}
                  width="200px"
                >
                  <SliderTrack>
                    <SliderFilledTrack />
                  </SliderTrack>
                  <SliderThumb />
                </Slider>
                <Text>{jpegQuality}%</Text>
              </HStack>

              <HStack w="100%" justify="space-between">
                <Text>Dimensions:</Text>
                <Text>
                  {Math.round(dimensions.width * scale / 100)} x {Math.round(dimensions.height * scale / 100)} px
                </Text>
              </HStack>

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
                <Text fontWeight="bold">Copy to Clipboard:</Text>
                <HStack w="100%" spacing={4}>
                  <Button 
                    colorScheme="blue" 
                    onClick={handleCopyToPNG}
                    flex={1}
                  >
                    Copy as PNG
                  </Button>
                  <Button 
                    colorScheme="orange" 
                    onClick={handleCopyToJPG}
                    flex={1}
                  >
                    Copy as JPG
                  </Button>
                </HStack>
              </VStack>

              <VStack w="100%" spacing={3}>
                <Text fontWeight="bold">Download:</Text>
                <HStack w="100%" spacing={4}>
                  <Button 
                    colorScheme="green" 
                    onClick={handleDownloadPNG}
                    flex={1}
                  >
                    Download PNG
                  </Button>
                  <Button 
                    colorScheme="purple" 
                    onClick={handleDownloadJPEG}
                    flex={1}
                  >
                    Download JPEG
                  </Button>
                </HStack>
              </VStack>

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
