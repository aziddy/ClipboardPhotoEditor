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
} from '@chakra-ui/react';

function App() {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState();
  const [scale, setScale] = useState(1);
  const [imageRef, setImageRef] = useState(null);
  const toast = useToast();

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
      canvas.toBlob(async (blob) => {
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
      }, 'image/png');
    } catch (err) {
      toast({
        title: 'Error',
        description: 'Failed to save image to clipboard',
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

            <HStack w="100%" spacing={4}>
              <Text minW="80px">Scale:</Text>
              <Slider
                value={scale}
                min={0.5}
                max={2}
                step={0.1}
                onChange={setScale}
              >
                <SliderTrack>
                  <SliderFilledTrack />
                </SliderTrack>
                <SliderThumb />
              </Slider>
            </HStack>

            <Button
              colorScheme="blue"
              onClick={saveToClipboard}
              isDisabled={!crop}
            >
              Save to Clipboard
            </Button>
          </VStack>
        )}
      </VStack>
    </Box>
  );
}

export default App; 