import React, { useState, useCallback } from 'react';
import { HStack, Text } from '@chakra-ui/react';

const QualitySlider = ({ initialValue = 90, onQualityChange }) => {
  const [value, setValue] = useState(initialValue);

  const handleChange = useCallback((e) => {
    const newValue = parseInt(e.target.value);
    setValue(newValue);
  }, []);

  const handleEnd = useCallback((e) => {
    const newValue = parseInt(e.target.value);
    setValue(newValue);
    onQualityChange(newValue);
  }, [onQualityChange]);

  return (
    <HStack w="100%" justify="space-between" align="center">
      <Text>JPEG Quality:</Text>
      <input
        type="range"
        min="10"
        max="100"
        value={value}
        onChange={handleChange}
        onMouseUp={handleEnd}
        onTouchEnd={handleEnd}
        style={{
          width: '200px',
          height: '8px',
          borderRadius: '4px',
          backgroundColor: '#E2E8F0',
          outline: 'none',
          WebkitAppearance: 'none',
          cursor: 'pointer',
        }}
      />
      <Text>{value}%</Text>
    </HStack>
  );
};

export default QualitySlider; 