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
} from '@chakra-ui/react';
import { useImageUpload } from '../utils/imageUpload';
import { createCroppedCanvas } from '../utils/imageExport';
import { useImageExportControls } from '../utils/useImageExportControls';

function ClipboardPhotoCropper() {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState();
  const [imageRef, setImageRef] = useState(null);
  const toast = useToast();
  const debounceTimeoutRef = useRef(null);

  // Canvas source function for the export hook
  const getCanvas = useCallback(() => {
    if (!imageRef || !crop || !crop.width || !crop.height) {
      return null;
    }
    return createCroppedCanvas(imageRef, crop);
  }, [imageRef, crop]);

  // Use the export controls hook
  const { updateOutputSizes, debouncedUpdateOutputSizes, resetExportState, ExportControls } = useImageExportControls(
    getCanvas,
    toast,
    'cropped'
  );

  // Use the shared image upload hook  
  const { fileInputRef, handlePaste, renderFileUploadUI } = useImageUpload(setImage, null, toast);

  const resetApp = useCallback(() => {
    setImage(null);
    setCrop(undefined);
    setImageRef(null);
    resetExportState();
  }, [resetExportState]);

  const debouncedUpdateForCrop = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    
    debounceTimeoutRef.current = setTimeout(() => {
      updateOutputSizes();
    }, 200); // 200ms debounce
  }, [updateOutputSizes]);

  // Update sizes when crop changes
  React.useEffect(() => {
    debouncedUpdateForCrop();
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [crop, debouncedUpdateForCrop]);

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
              <ExportControls />

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