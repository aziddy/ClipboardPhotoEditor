/**
 * Utility functions for exporting images in different formats
 */

/**
 * Calculate the size of a canvas when exported to a specific format
 * @param {HTMLCanvasElement} canvas - The canvas element
 * @param {string} format - The image format ('image/png' or 'image/jpeg')
 * @param {number} quality - Quality for JPEG (0-1), ignored for PNG
 * @returns {Promise<{blob: Blob, sizeInMB: string}>}
 */
export const calculateImageSize = (canvas, format = 'image/png', quality = 0.9) => {
  return new Promise((resolve) => {
    if (!canvas) {
      resolve({ blob: null, sizeInMB: '0.00' });
      return;
    }
    
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve({ blob: null, sizeInMB: '0.00' });
        return;
      }
      const sizeInMB = (blob.size / (1024 * 1024)).toFixed(2);
      resolve({ blob, sizeInMB });
    }, format, quality);
  });
};

/**
 * Copy an image to clipboard in specified format
 * @param {HTMLCanvasElement} canvas - The canvas element
 * @param {string} format - The image format ('image/png' or 'image/jpeg')
 * @param {number} quality - Quality for JPEG (0-1), ignored for PNG
 * @param {function} toast - Toast notification function
 * @returns {Promise<boolean>} - Success status
 */
export const copyToClipboard = async (canvas, format = 'image/png', quality = 0.9, toast) => {
  if (!canvas) {
    toast({
      title: 'Error',
      description: 'No image to copy',
      status: 'error',
      duration: 3000,
      isClosable: true,
    });
    return false;
  }

  try {
    // Always use PNG for clipboard operations as browsers only support PNG
    const { blob } = await calculateImageSize(canvas, 'image/png');
    
    if (!blob) {
      throw new Error('Failed to create image blob');
    }

    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob
      })
    ]);
    
    const formatName = format === 'image/png' ? 'PNG' : 'JPG';
    toast({
      title: 'Success',
      description: `Image copied to clipboard as ${formatName}`,
      status: 'success',
      duration: 3000,
      isClosable: true,
    });
    return true;
  } catch (err) {
    console.error('Clipboard error:', err);
    const formatName = format === 'image/png' ? 'PNG' : 'JPG';
    toast({
      title: 'Error',
      description: `Failed to copy image to clipboard as ${formatName}`,
      status: 'error',
      duration: 3000,
      isClosable: true,
    });
    return false;
  }
};

/**
 * Download an image in specified format
 * @param {HTMLCanvasElement} canvas - The canvas element
 * @param {string} format - The image format ('image/png' or 'image/jpeg')
 * @param {number} quality - Quality for JPEG (0-1), ignored for PNG
 * @param {string} filename - Base filename without extension
 * @param {function} toast - Toast notification function
 * @returns {Promise<boolean>} - Success status
 */
export const downloadImage = async (canvas, format = 'image/png', quality = 0.9, filename = 'edited-image', toast) => {
  if (!canvas) {
    toast({
      title: 'Error',
      description: 'No image to download',
      status: 'error',
      duration: 3000,
      isClosable: true,
    });
    return false;
  }

  try {
    const { blob } = await calculateImageSize(canvas, format, quality);
    
    if (!blob) {
      throw new Error('Failed to create image blob');
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    const extension = format === 'image/png' ? 'png' : 'jpg';
    link.download = `${filename}.${extension}`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    const formatName = format === 'image/png' ? 'PNG' : 'JPEG';
    toast({
      title: 'Success',
      description: `Image downloaded successfully as ${formatName}`,
      status: 'success',
      duration: 3000,
      isClosable: true,
    });
    return true;
  } catch (err) {
    console.error('Download error:', err);
    const formatName = format === 'image/png' ? 'PNG' : 'JPEG';
    toast({
      title: 'Error',
      description: `Failed to download image as ${formatName}`,
      status: 'error',
      duration: 3000,
      isClosable: true,
    });
    return false;
  }
};

/**
 * Get the output size for both PNG and JPG formats
 * @param {HTMLCanvasElement} canvas - The canvas element
 * @param {number} jpegQuality - Quality for JPEG (0-1)
 * @returns {Promise<{png: string, jpg: string}>} - Sizes in MB for both formats
 */
export const getOutputSizes = async (canvas, jpegQuality = 0.9) => {
  if (!canvas) {
    return { png: '0.00', jpg: '0.00' };
  }

  try {
    const [pngResult, jpgResult] = await Promise.all([
      calculateImageSize(canvas, 'image/png'),
      calculateImageSize(canvas, 'image/jpeg', jpegQuality)
    ]);

    return {
      png: pngResult.sizeInMB,
      jpg: jpgResult.sizeInMB
    };
  } catch (err) {
    console.error('Error calculating output sizes:', err);
    return { png: '0.00', jpg: '0.00' };
  }
};

/**
 * Create a canvas from image cropping parameters
 * @param {HTMLImageElement} imageRef - The source image element
 * @param {Object} crop - Crop parameters with x, y, width, height
 * @returns {HTMLCanvasElement|null} - The cropped canvas or null if invalid
 */
export const createCroppedCanvas = (imageRef, crop) => {
  if (!imageRef || !crop || !crop.width || !crop.height) {
    return null;
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
      return null;
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

    return canvas;
  } catch (err) {
    console.error('Error creating cropped canvas:', err);
    return null;
  }
};

/**
 * Create a resized canvas from an image
 * @param {HTMLImageElement} image - The source image
 * @param {Object} dimensions - Original dimensions {width, height}
 * @param {number} scale - Scale factor (0-100)
 * @returns {HTMLCanvasElement|null} - The resized canvas or null if invalid
 */
export const createResizedCanvas = (image, dimensions, scale) => {
  if (!image || !dimensions || scale <= 0) {
    return null;
  }

  try {
    const canvas = document.createElement('canvas');
    const scaleFactor = scale / 100;
    canvas.width = Math.round(dimensions.width * scaleFactor);
    canvas.height = Math.round(dimensions.height * scaleFactor);
    
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (err) {
    console.error('Error creating resized canvas:', err);
    return null;
  }
}; 