import React, { useState } from 'react';
import {
  Box,
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  VStack,
  Text,
} from '@chakra-ui/react';
import ClipboardPhotoCropper from './components/ClipboardPhotoCropper';
import ClipboardPhotoResizer from './components/ClipboardPhotoResizer';

function App() {
  const [tabIndex, setTabIndex] = useState(0);

  return (
    <Box p={8} minH="100vh" bg="gray.50">
      <VStack spacing={6} align="center" maxW="1000px" mx="auto">
        <Text fontSize="3xl" fontWeight="bold">
          Clipboard Photo Editor
        </Text>

        <Tabs 
          isFitted 
          variant="enclosed" 
          w="100%" 
          index={tabIndex} 
          onChange={setTabIndex}
        >
          <TabList mb="1em">
            <Tab>Photo Resizer</Tab>
            <Tab>Photo Cropper</Tab>
          </TabList>

          <TabPanels>
            <TabPanel p={0}>
              <ClipboardPhotoResizer />
            </TabPanel>
            <TabPanel p={0}>
              <ClipboardPhotoCropper />
            </TabPanel>
          </TabPanels>
        </Tabs>

        <Text fontSize="sm" color="gray.500">by Alex Zidros</Text>
      </VStack>
    </Box>
  );
}

export default App; 