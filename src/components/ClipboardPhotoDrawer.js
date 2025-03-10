import React, { useState, useCallback, useRef, useEffect } from 'react';
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
  IconButton,
  Tooltip,
} from '@chakra-ui/react';

function ClipboardPhotoDrawer() {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState();
  const [imageRef, setImageRef] = useState(null);
  const [imageSize, setImageSize] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingColor, setDrawingColor] = useState('#FF0000');
  const [strokeSize, setStrokeSize] = useState(5);
  const [isEraser, setIsEraser] = useState(false);
  const [drawingHistory, setDrawingHistory] = useState([]);
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState(-1);
  
  const canvasRef = useRef(null);
  const contextRef = useRef(null);
  const toast = useToast();


  const undo = useCallback(() => {
    if (currentHistoryIndex <= 0) return;
    
    const newIndex = currentHistoryIndex - 1;
    setCurrentHistoryIndex(newIndex);
    
    const img = new Image();
    img.src = drawingHistory[newIndex];
    img.onload = () => {
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0);
    };
  }, [currentHistoryIndex, drawingHistory]);

  // Initialize canvas context
  useEffect(() => {
    if (canvasRef.current && image) {
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      
      // Enable anti-aliasing
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = isEraser ? '#ffffff' : drawingColor;
      context.lineWidth = strokeSize;
      
      contextRef.current = context;
      
      // Load the initial image onto canvas
      const img = new Image();
      img.src = image;
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        context.drawImage(img, 0, 0);
        // Re-apply context settings after canvas resize
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = isEraser ? '#ffffff' : drawingColor;
        context.lineWidth = strokeSize;
        saveToHistory();
      };
    }
  }, [image]);

  // Update context when color or stroke size changes
  useEffect(() => {
    if (contextRef.current) {
      contextRef.current.strokeStyle = isEraser ? '#ffffff' : drawingColor;
      contextRef.current.lineWidth = strokeSize;
    }
  }, [drawingColor, strokeSize, isEraser]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo]);

  const saveToHistory = useCallback(() => {
    if (!canvasRef.current) return;
    
    const newHistory = drawingHistory.slice(0, currentHistoryIndex + 1);
    newHistory.push(canvasRef.current.toDataURL());
    setDrawingHistory(newHistory);
    setCurrentHistoryIndex(newHistory.length - 1);
  }, [drawingHistory, currentHistoryIndex]);


  const startDrawing = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    contextRef.current.beginPath();
    contextRef.current.moveTo(x, y);
    setIsDrawing(true);
  }, []);

  const draw = useCallback((e) => {
    if (!isDrawing) return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    contextRef.current.lineTo(x, y);
    contextRef.current.stroke();
  }, [isDrawing]);

  const stopDrawing = useCallback(() => {
    if (!isDrawing) return;
    
    contextRef.current.closePath();
    setIsDrawing(false);
    saveToHistory();
  }, [isDrawing, saveToHistory]);

  const resetApp = useCallback(() => {
    setImage(null);
    setCrop(undefined);
    setImageRef(null);
    setImageSize(null);
    setIsDrawing(false);
    setDrawingColor('#FF0000');
    setStrokeSize(5);
    setIsEraser(false);
    setDrawingHistory([]);
    setCurrentHistoryIndex(-1);
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
    e.preventDefault(); // Prevent default paste behavior
    e.stopPropagation(); // Stop event from bubbling up
    
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

  // Update size when crop changes
  React.useEffect(() => {
    updateImageSize();
  }, [crop, updateImageSize]);

  // Modify saveToClipboard to use canvas content
  const saveToClipboard = useCallback(async () => {
    if (!canvasRef.current) return;

    try {
      const blob = await new Promise(resolve => canvasRef.current.toBlob(resolve, 'image/png'));
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
  }, [toast]);

  // Modify downloadImage to use canvas content
  const downloadImage = useCallback(async () => {
    if (!canvasRef.current) return;

    try {
      const url = canvasRef.current.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = url;
      link.download = 'edited-image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

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
  }, [toast]);

  return (
    <Box p={6} maxW="800px" mx="auto" onPaste={(e) => {
      e.stopPropagation();
      handlePaste(e);
    }}>
      <VStack spacing={6} align="stretch">
        <Text fontSize="2xl" fontWeight="bold">
          Photo Editor
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
            <Text>Paste an image from your clipboard (Ctrl/Cmd + V)</Text>
          </Box>
        )}

        {image && (
          <VStack spacing={4} onPaste={(e) => {
            e.stopPropagation();
            handlePaste(e);
          }}>
            <Box borderRadius="md" overflow="hidden" position="relative">
              <canvas
                ref={canvasRef}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                style={{
                  border: '1px solid #E2E8F0',
                  borderRadius: '0.375rem',
                  cursor: isEraser ? 'crosshair' : 'pointer',
                }}
              />
            </Box>

            <VStack w="100%" spacing={4}>
              <HStack w="100%" justify="space-between" align="center">
                <Text>Drawing Color:</Text>
                <Input
                  type="color"
                  value={drawingColor}
                  onChange={(e) => setDrawingColor(e.target.value)}
                  width="100px"
                  disabled={isEraser}
                />
              </HStack>

              <HStack w="100%" justify="space-between" align="center">
                <Text>Stroke Size:</Text>
                <Slider
                  value={strokeSize}
                  onChange={setStrokeSize}
                  min={1}
                  max={50}
                  width="200px"
                >
                  <SliderTrack>
                    <SliderFilledTrack />
                  </SliderTrack>
                  <SliderThumb />
                </Slider>
                <Text>{strokeSize}px</Text>
              </HStack>

              <HStack w="100%" spacing={4}>
                <Button
                  colorScheme={isEraser ? 'pink' : 'blue'}
                  onClick={() => setIsEraser(!isEraser)}
                  flex={1}
                >
                  {isEraser ? 'Eraser Mode' : 'Drawing Mode'}
                </Button>
                <Button
                  colorScheme="gray"
                  onClick={undo}
                  isDisabled={currentHistoryIndex <= 0}
                  flex={1}
                >
                  Undo (Cmd+Z)
                </Button>
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

export default ClipboardPhotoDrawer; 