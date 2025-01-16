import React, { useState, useCallback } from 'react';
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
  Badge,
} from '@chakra-ui/react';

function App() {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState();
  const [scale, setScale] = useState(1);
  const [imageRef, setImageRef] = useState(null);
  const [imageSize, setImageSize] = useState(null);
  const toast = useToast();

  const resetApp = useCallback(() => {
    setImage(null);
    setCrop(undefined);
    setScale(1);
    setImageRef(null);
    setImageSize(null);
  }, []);

  const calculateImageSize = useCallback((canvas) => {
    return new Promise((resolve) => {
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

  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItem = Array.from(items).find(
      item => item.type.indexOf('image') !== -1
    );

    if (imageItem) {
      const blob = imageItem.getAsFile();
      const url = URL.createObjectURL(blob);
      setImage(url);
      setImageSize((blob.size / (1024 * 1024)).toFixed(2));
    } else {
      toast({
        title: 'Error',
        description: 'No image found in clipboard',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  }, [toast]);

  const updateImageSize = useCallback(() => {
    if (!imageRef || !crop || !crop.width || !crop.height) {
      setImageSize(null);
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      const scaleX = imageRef.naturalWidth / imageRef.width;
      const scaleY = imageRef.naturalHeight / imageRef.height;

      canvas.width = crop.width;
      canvas.height = crop.height;
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
        crop.width,
        crop.height
      );

      calculateImageSize(canvas);
    } catch (err) {
      setImageSize(null);
      console.error('Error updating image size:', err);
    }
  }, [imageRef, crop, calculateImageSize]);

  // Update size when crop or scale changes
  React.useEffect(() => {
    updateImageSize();
  }, [crop, scale, updateImageSize]);

  const saveToClipboard = useCallback(async () => {
    if (!imageRef || !crop) return;

    const canvas = document.createElement('canvas');
    const scaleX = imageRef.naturalWidth / imageRef.width;
    const scaleY = imageRef.naturalHeight / imageRef.height;

    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(
      imageRef,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.width * scaleX,
      crop.height * scaleY,
      0,
      0,
      crop.width,
      crop.height
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

    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(
      imageRef,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.width * scaleX,
      crop.height * scaleY,
      0,
      0,
      crop.width,
      crop.height
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
    <Box 
      p={8} 
      minH="100vh" 
      bg="gray.50"
      onPaste={handlePaste}
    >
      <VStack spacing={6} align="center">
        <Text fontSize="2xl" fontWeight="bold">
          Clipboard Photo Editor
        </Text>
        
        {!image && (
          <Box 
            p={10} 
            border="2px dashed" 
            borderColor="gray.300" 
            borderRadius="md"
            textAlign="center"
          >
            <Text>Paste an image from your clipboard (Ctrl/Cmd + V)</Text>
          </Box>
        )}

        {image && (
          <VStack spacing={4} w="100%" maxW="800px">
            <ReactCrop
              crop={crop}
              onChange={c => setCrop(c)}
              aspect={undefined}
            >
              <img
                ref={ref => setImageRef(ref)}
                src={image}
                style={{ transform: `scale(${scale})` }}
                alt="Clipboard"
              />
            </ReactCrop>

            <HStack spacing={4}>
              <Button colorScheme="blue" onClick={saveToClipboard}>
                Save to Clipboard
              </Button>
              <Button colorScheme="green" onClick={downloadImage}>
                Download
              </Button>
              <Button colorScheme="red" onClick={resetApp}>
                Reset
              </Button>
            </HStack>

            <Text fontSize="sm" color="gray.500">
              Image size: {imageSize ? `${imageSize} MB` : 'Unknown'}
            </Text>

            <Box w="100%" maxW="300px">
              <Text mb={2}>Scale</Text>
              <Slider
                value={scale}
                min={0.1}
                max={3}
                step={0.1}
                onChange={setScale}
              >
                <SliderTrack>
                  <SliderFilledTrack />
                </SliderTrack>
                <SliderThumb />
              </Slider>
            </Box>
          </VStack>
        )}
        <Text fontSize="sm" color="gray.500">by Alex Zidros</Text>
      </VStack>
    </Box>
  );
}

export default App; 