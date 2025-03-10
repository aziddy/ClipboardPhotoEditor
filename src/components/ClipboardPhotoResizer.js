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

function ClipboardPhotoResizer() {
  const [image, setImage] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(100);
  const [fileSize, setFileSize] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const toast = useToast();

  const resetApp = useCallback(() => {
    setImage(null);
    setDimensions({ width: 0, height: 0 });
    setScale(100);
    setFileSize(0);
    setPreviewUrl(null);
    toast({
      title: 'Reset Complete',
      description: 'Ready for a new image',
      status: 'info',
      duration: 2000,
    });
  }, [toast]);

  const handlePaste = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const items = e.clipboardData.items;
    const item = [...items].find(item => item.type.startsWith('image/'));
    
    if (!item) {
      toast({
        title: 'Error',
        description: 'No image found in clipboard',
        status: 'error',
        duration: 3000,
      });
      return;
    }

    const file = item.getAsFile();
    const img = new Image();
    img.src = URL.createObjectURL(file);
    
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
      setFileSize(file.size);
    };
  }, [toast]);

  const processImage = useCallback(() => {
    if (!image) return null;
    
    const canvas = document.createElement('canvas');
    const scaleFactor = scale / 100;
    canvas.width = Math.round(dimensions.width * scaleFactor);
    canvas.height = Math.round(dimensions.height * scaleFactor);
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    
    return canvas;
  }, [image, dimensions, scale]);

  // Update preview and file size whenever scale changes
  React.useEffect(() => {
    let isCurrent = true;
    
    const updatePreviewAndSize = async () => {
      if (!image) return;
      
      const canvas = processImage();
      if (!canvas) return;

      try {
        // Update preview URL
        const newPreviewUrl = canvas.toDataURL('image/png');
        if (isCurrent) {
          setPreviewUrl(newPreviewUrl);
        }

        // Update file size
        const blob = await new Promise((resolve) => {
          canvas.toBlob(resolve, 'image/png');
        });
        
        if (isCurrent && blob) {
          setFileSize(blob.size);
        }
      } catch (err) {
        console.error('Error updating preview and file size:', err);
      }
    };

    updatePreviewAndSize();
    
    return () => {
      isCurrent = false;
    };
  }, [scale, processImage, image]);

  const copyToClipboard = useCallback(async () => {
    const canvas = processImage();
    if (!canvas) return;

    try {
      // Convert canvas to data URL
      const dataUrl = canvas.toDataURL('image/png');
      
      // Create a temporary image element
      const tempImg = document.createElement('img');
      tempImg.src = dataUrl;
      
      // Wait for the image to load
      await new Promise((resolve) => {
        tempImg.onload = resolve;
      });

      try {
        // Create a temporary canvas with the image
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = tempImg.width;
        tempCanvas.height = tempImg.height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(tempImg, 0, 0);
        
        // Try to copy to clipboard using the newer API
        tempCanvas.toBlob(async (blob) => {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({
                'image/png': blob
              })
            ]);
            
            toast({
              title: 'Success',
              description: 'Image copied to clipboard',
              status: 'success',
              duration: 2000,
            });
          } catch (clipError) {
            // If modern API fails, try copying as PNG data URL
            try {
              const pngDataUrl = tempCanvas.toDataURL('image/png');
              await navigator.clipboard.writeText(pngDataUrl);
              
              toast({
                title: 'Success',
                description: 'Image copied as data URL',
                status: 'success',
                duration: 2000,
              });
            } catch (textError) {
              // If all clipboard methods fail, offer download
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = 'edited-image.png';
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
              URL.revokeObjectURL(url);
              
              toast({
                title: 'Clipboard Access Denied',
                description: 'Image has been downloaded instead. Your browser may be restricting clipboard access.',
                status: 'warning',
                duration: 5000,
              });
            }
          }
        }, 'image/png');
      } catch (err) {
        throw new Error('Failed to process image for clipboard');
      }
    } catch (err) {
      console.error('Clipboard error:', err);
      toast({
        title: 'Error',
        description: 'Failed to copy to clipboard. Your browser may be restricting clipboard access.',
        status: 'error',
        duration: 3000,
      });
    }
  }, [processImage, toast]);

  const downloadAsPNG = useCallback(async () => {
    const canvas = processImage();
    if (!canvas) return;

    const link = document.createElement('a');
    link.download = 'edited-image.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, [processImage]);

  return (
    <Box p={6} maxW="800px" mx="auto" onPaste={(e) => {
      e.stopPropagation();
      handlePaste(e);
    }}>
      <VStack spacing={6} align="stretch">
        <Text fontSize="2xl" fontWeight="bold">Clipboard Photo Resizer</Text>
        
        {!image && (
          <Box p={10} border="2px dashed" borderColor="gray.300" borderRadius="md" textAlign="center">
            <Text>Paste an image from your clipboard (Ctrl/Cmd + V)</Text>
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
                <Text>Output Size:</Text>
                <Text>{(fileSize / (1024 * 1024)).toFixed(2)} MB</Text>
              </HStack>

              <HStack w="100%" justify="space-between">
                <Text>Dimensions:</Text>
                <Text>
                  {Math.round(dimensions.width * scale / 100)} x {Math.round(dimensions.height * scale / 100)} px
                </Text>
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
                  onClick={copyToClipboard} 
                  flex={1}
                >
                  Copy to Clipboard
                </Button>
                <Button 
                  colorScheme="green" 
                  onClick={downloadAsPNG} 
                  flex={1}
                >
                  Download as PNG
                </Button>
              </HStack>
            </VStack>
          </>
        )}
      </VStack>
    </Box>
  );
}

export default ClipboardPhotoResizer;
