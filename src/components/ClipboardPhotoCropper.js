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
} from '@chakra-ui/react';
import { useImageUpload } from '../utils/imageUpload';

function ClipboardPhotoCropper() {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState();
  const [imageRef, setImageRef] = useState(null);
  const [imageSize, setImageSize] = useState(null);
  const toast = useToast();
  const debounceTimeoutRef = useRef(null);
  
  // Use the shared image upload hook
  const { fileInputRef, handlePaste, renderFileUploadUI } = useImageUpload(setImage, setImageSize, toast);

  const resetApp = useCallback(() => {
    setImage(null);
    setCrop(undefined);
    setImageRef(null);
    setImageSize(null);
  }, []);

  const calculateImageSize = useCallback((canvas) => {
    return new Promise((resolve) => {
      console.log('calculateImageSize');
      if (!canvas) {
        setImageSize(null);
        resolve(null);
        return;
      }
      
      canvas.toBlob((blob) => {
        if (!blob) {
          setImageSize(null);
          resolve(null);
          return;
        }
        const sizeInMB = (blob.size / (1024 * 1024)).toFixed(2);
        setImageSize(sizeInMB);
        resolve(blob);
      }, 'image/png');
    });
  }, []);

  const updateImageSize = useCallback(() => {
    if (!imageRef || !crop || !crop.width || !crop.height) {
      setImageSize(null);
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      const scaleX = imageRef.naturalWidth / imageRef.width;
      const scaleY = imageRef.naturalHeight / imageRef.height;

      const outputWidth = Math.round(crop.width * scaleX);
      const outputHeight = Math.round(crop.height * scaleY);

      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        setImageSize(null);
        return;
      }

      ctx.drawImage(
        imageRef,
        crop.x * scaleX,
        crop.y * scaleY,
        crop.width * scaleX,
        crop.height * scaleY,
        0,
        0,
        outputWidth,
        outputHeight
      );

      calculateImageSize(canvas);
    } catch (err) {
      setImageSize(null);
      console.error('Error updating image size:', err);
    }
  }, [imageRef, crop, calculateImageSize]);

  const debouncedUpdateImageSize = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    
    debounceTimeoutRef.current = setTimeout(() => {
      updateImageSize();
    }, 200); // 200ms debounce
  }, [updateImageSize]);

  // Update size when crop changes
  React.useEffect(() => {
    debouncedUpdateImageSize();
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [crop, debouncedUpdateImageSize]);

  const saveToClipboard = useCallback(async () => {
    if (!imageRef || !crop) return;

    const canvas = document.createElement('canvas');
    const scaleX = imageRef.naturalWidth / imageRef.width;
    const scaleY = imageRef.naturalHeight / imageRef.height;

    // Calculate output dimensions
    const outputWidth = Math.round(crop.width * scaleX);
    const outputHeight = Math.round(crop.height * scaleY);

    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');

    console.log('Original dimensions:', {
      naturalWidth: imageRef.naturalWidth,
      naturalHeight: imageRef.naturalHeight,
      displayWidth: imageRef.width,
      displayHeight: imageRef.height,
      cropWidth: crop.width,
      cropHeight: crop.height,
      outputWidth,
      outputHeight
    });

    ctx.drawImage(
      imageRef,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.width * scaleX,
      crop.height * scaleY,
      0,
      0,
      outputWidth,
      outputHeight
    );

    try {
      const blob = await calculateImageSize(canvas);
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob
        })
      ]);
      toast({
        title: 'Success',
        description: 'Image saved to clipboard',
        status: 'success',
        duration: 3000,
        isClosable: true,
      });
    } catch (err) {
      toast({
        title: 'Error',
        description: 'Failed to save image to clipboard',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  }, [imageRef, crop, toast, calculateImageSize]);

  const downloadImage = useCallback(async () => {
    if (!imageRef || !crop) return;

    const canvas = document.createElement('canvas');
    const scaleX = imageRef.naturalWidth / imageRef.width;
    const scaleY = imageRef.naturalHeight / imageRef.height;

    const outputWidth = Math.round(crop.width * scaleX);
    const outputHeight = Math.round(crop.height * scaleY);

    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(
      imageRef,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.width * scaleX,
      crop.height * scaleY,
      0,
      0,
      outputWidth,
      outputHeight
    );

    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'edited-image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast({
        title: 'Success',
        description: 'Image downloaded successfully',
        status: 'success',
        duration: 3000,
        isClosable: true,
      });
    } catch (err) {
      toast({
        title: 'Error',
        description: 'Failed to download image',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  }, [imageRef, crop, toast]);

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
              <HStack w="100%" justify="space-between">
                <Text>Image size:</Text>
                <Text>{imageSize ? `${imageSize} MB` : 'Unknown'}</Text>
              </HStack>

              <HStack w="100%" spacing={4}>
                <Button 
                  colorScheme="red" 
                  onClick={resetApp}
                  flex={1}
                >
                  Reset
                </Button>
                <Button 
                  colorScheme="blue" 
                  onClick={saveToClipboard}
                  flex={1}
                >
                  Copy to Clipboard
                </Button>
                <Button 
                  colorScheme="green" 
                  onClick={downloadImage}
                  flex={1}
                >
                  Download as PNG
                </Button>
              </HStack>
            </VStack>
          </VStack>
        )}
      </VStack>
    </Box>
  );
}

export default ClipboardPhotoCropper; 