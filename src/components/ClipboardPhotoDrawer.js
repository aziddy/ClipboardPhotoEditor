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
  Divider,
} from '@chakra-ui/react';
import { useImageUpload } from '../utils/imageUpload';
import { 
  copyToClipboard, 
  downloadImage, 
  getOutputSizes 
} from '../utils/imageExport';

function ClipboardPhotoDrawer() {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState();
  const [imageRef, setImageRef] = useState(null);
  const [outputSizes, setOutputSizes] = useState({ png: '0.00', jpg: '0.00' });
  const [jpegQuality, setJpegQuality] = useState(90);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingColor, setDrawingColor] = useState('#FF0000');
  const [strokeSize, setStrokeSize] = useState(5);
  const [isEraser, setIsEraser] = useState(false);
  const [drawingHistory, setDrawingHistory] = useState([]);
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState(-1);
  
  const canvasRef = useRef(null);
  const contextRef = useRef(null);
  const toast = useToast();

  // Use the shared image upload hook
  const { fileInputRef, handlePaste, renderFileUploadUI } = useImageUpload(setImage, null, toast);

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
        updateOutputSizes();
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

  const updateOutputSizes = useCallback(async () => {
    if (!canvasRef.current) {
      setOutputSizes({ png: '0.00', jpg: '0.00' });
      return;
    }

    try {
      const sizes = await getOutputSizes(canvasRef.current, jpegQuality / 100);
      setOutputSizes(sizes);
    } catch (err) {
      setOutputSizes({ png: '0.00', jpg: '0.00' });
      console.error('Error updating output sizes:', err);
    }
  }, [jpegQuality]);

  // Update sizes when quality changes
  useEffect(() => {
    updateOutputSizes();
  }, [jpegQuality, updateOutputSizes]);

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
    updateOutputSizes();
  }, [isDrawing, saveToHistory, updateOutputSizes]);

  const resetApp = useCallback(() => {
    setImage(null);
    setCrop(undefined);
    setImageRef(null);
    setOutputSizes({ png: '0.00', jpg: '0.00' });
    setIsDrawing(false);
    setDrawingColor('#FF0000');
    setStrokeSize(5);
    setIsEraser(false);
    setDrawingHistory([]);
    setCurrentHistoryIndex(-1);
  }, []);

  const handleCopyToPNG = useCallback(async () => {
    if (!canvasRef.current) return;
    await copyToClipboard(canvasRef.current, 'image/png', 1, toast);
  }, [toast]);

  const handleCopyToJPG = useCallback(async () => {
    if (!canvasRef.current) return;
    await copyToClipboard(canvasRef.current, 'image/jpeg', jpegQuality / 100, toast);
  }, [jpegQuality, toast]);

  const handleDownloadPNG = useCallback(async () => {
    if (!canvasRef.current) return;
    await downloadImage(canvasRef.current, 'image/png', 1, 'drawn-image', toast);
  }, [toast]);

  const handleDownloadJPEG = useCallback(async () => {
    if (!canvasRef.current) return;
    await downloadImage(canvasRef.current, 'image/jpeg', jpegQuality / 100, 'drawn-image', toast);
  }, [jpegQuality, toast]);

  return (
    <Box p={6} maxW="800px" mx="auto" onPaste={(e) => {
      e.stopPropagation();
      handlePaste(e);
    }}>
      <VStack spacing={6} align="stretch">
        <Text fontSize="2xl" fontWeight="bold">
          Photo Drawer
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

export default ClipboardPhotoDrawer; 