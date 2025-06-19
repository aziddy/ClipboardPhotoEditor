import React, { useState, useCallback, useRef } from 'react';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import {
  Box,
  Button,
  VStack,
  Text,
  useToast,
  HStack,
  Slider,
  SliderTrack,
  SliderFilledTrack,
  SliderThumb,
  Input,
  Divider,
} from '@chakra-ui/react';
import { useImageUpload } from '../utils/imageUpload';
import { 
  copyToClipboard, 
  downloadImage, 
  getOutputSizes, 
  createCroppedCanvas 
} from '../utils/imageExport';

function ClipboardPhotoCropper() {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState();
  const [imageRef, setImageRef] = useState(null);
  const [outputSizes, setOutputSizes] = useState({ png: '0.00', jpg: '0.00' });
  const [jpegQuality, setJpegQuality] = useState(90);
  const toast = useToast();
  const debounceTimeoutRef = useRef(null);
  
  // Use the shared image upload hook  
  const { fileInputRef, handlePaste, renderFileUploadUI } = useImageUpload(setImage, null, toast);

  const resetApp = useCallback(() => {
    setImage(null);
    setCrop(undefined);
    setImageRef(null);
    setOutputSizes({ png: '0.00', jpg: '0.00' });
  }, []);

  const updateOutputSizes = useCallback(async () => {
    if (!imageRef || !crop || !crop.width || !crop.height) {
      setOutputSizes({ png: '0.00', jpg: '0.00' });
      return;
    }

    try {
      const canvas = createCroppedCanvas(imageRef, crop);
      if (!canvas) {
        setOutputSizes({ png: '0.00', jpg: '0.00' });
        return;
      }

      const sizes = await getOutputSizes(canvas, jpegQuality / 100);
      setOutputSizes(sizes);
    } catch (err) {
      setOutputSizes({ png: '0.00', jpg: '0.00' });
      console.error('Error updating output sizes:', err);
    }
  }, [imageRef, crop, jpegQuality]);

  const debouncedUpdateOutputSizes = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    
    debounceTimeoutRef.current = setTimeout(() => {
      updateOutputSizes();
    }, 200); // 200ms debounce
  }, [updateOutputSizes]);

  // Update sizes when crop or quality changes
  React.useEffect(() => {
    debouncedUpdateOutputSizes();
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [crop, jpegQuality, debouncedUpdateOutputSizes]);

  const handleCopyToPNG = useCallback(async () => {
    if (!imageRef || !crop) return;
    const canvas = createCroppedCanvas(imageRef, crop);
    if (canvas) {
      await copyToClipboard(canvas, 'image/png', 1, toast);
    }
  }, [imageRef, crop, toast]);

  const handleCopyToJPG = useCallback(async () => {
    if (!imageRef || !crop) return;
    const canvas = createCroppedCanvas(imageRef, crop);
    if (canvas) {
      await copyToClipboard(canvas, 'image/jpeg', jpegQuality / 100, toast);
    }
  }, [imageRef, crop, jpegQuality, toast]);

  const handleDownloadPNG = useCallback(async () => {
    if (!imageRef || !crop) return;
    const canvas = createCroppedCanvas(imageRef, crop);
    if (canvas) {
      await downloadImage(canvas, 'image/png', 1, 'cropped-image', toast);
    }
  }, [imageRef, crop, toast]);

  const handleDownloadJPEG = useCallback(async () => {
    if (!imageRef || !crop) return;
    const canvas = createCroppedCanvas(imageRef, crop);
    if (canvas) {
      await downloadImage(canvas, 'image/jpeg', jpegQuality / 100, 'cropped-image', toast);
    }
  }, [imageRef, crop, jpegQuality, toast]);

  return (
    <Box p={6} maxW="800px" mx="auto" onPaste={(e) => {
      e.stopPropagation();
      handlePaste(e);
    }}>
      <VStack spacing={6} align="stretch">
        <Text fontSize="2xl" fontWeight="bold">
          Photo Cropper
        </Text>
        
        {!image && (
          <Box 
            p={10} 
            border="2px dashed" 
            borderColor="gray.300" 
            borderRadius="md"
            textAlign="center"
            onPaste={(e) => {
              e.stopPropagation();
              handlePaste(e);
            }}
          >
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
          <VStack spacing={4} onPaste={(e) => {
            e.stopPropagation();
            handlePaste(e);
          }}>
            <Box borderRadius="md" overflow="hidden">
              <ReactCrop
                crop={crop}
                onChange={c => setCrop(c)}
                aspect={undefined}
              >
                <img
                  ref={ref => setImageRef(ref)}
                  src={image}
                  alt="Clipboard"
                />
              </ReactCrop>
            </Box>

            <VStack w="100%" spacing={4}>
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
          </VStack>
        )}
      </VStack>
    </Box>
  );
}

export default ClipboardPhotoCropper; 