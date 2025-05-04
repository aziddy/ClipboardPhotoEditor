import { useCallback, useRef } from 'react';
import { Button, Text } from '@chakra-ui/react';

/**
 * Custom hook for handling image uploads from clipboard or file input
 * @param {function} setImage - Function to set the image state
 * @param {function} setImageSize - Function to set the image size state 
 * @param {object} toast - Chakra UI toast object
 * @returns {object} - Object containing handlers and references
 */
export const useImageUpload = (setImage, setImageSize, toast) => {
  const fileInputRef = useRef(null);

  // Handle clipboard paste events
  const handlePaste = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItem = Array.from(items).find(
      item => item.type.indexOf('image') !== -1
    );

    if (imageItem) {
      const blob = imageItem.getAsFile();
      const url = URL.createObjectURL(blob);
      setImage(url);
      if (setImageSize) {
        setImageSize((blob.size / (1024 * 1024)).toFixed(2));
      }
    } else {
      toast({
        title: 'Error',
        description: 'No image found in clipboard',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  }, [toast, setImage, setImageSize]);

  // Handle file upload from file input
  const handleFileUpload = useCallback((e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setImage(url);
      if (setImageSize) {
        setImageSize((file.size / (1024 * 1024)).toFixed(2));
      }
    } else if (file) {
      toast({
        title: 'Error',
        description: 'Selected file is not an image',
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  }, [toast, setImage, setImageSize]);

  // Render file upload UI
  const renderFileUploadUI = () => (
    <>
      <Button 
        colorScheme="blue"
        onClick={() => fileInputRef.current?.click()}
      >
        📎 Upload Image
      </Button>
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        onChange={handleFileUpload}
        style={{ display: 'none' }}
      />
      <Text fontSize="sm" color="gray.500">
        (Recommended for iOS users)
      </Text>
    </>
  );

  return {
    fileInputRef,
    handlePaste,
    handleFileUpload,
    renderFileUploadUI
  };
}; 