import React, { useEffect, useRef } from 'react';
import { Box, Button, Checkbox, FormControl, FormLabel, HStack, Input, Select, Text, Textarea, VStack } from '@chakra-ui/react';
import { TEXT_FONTS, TEXT_LIMIT } from '../utils/textLayers';

export const TextControls = ({ editing, onDone, onCancel, onNew, onEdit, canEdit, onConvert, onKeyDown }) => {
  const inputRef = useRef(null);
  const { layer, session, update, error, showInline } = editing;
  useEffect(() => {
    if (session && !session.inline) inputRef.current?.focus();
  }, [session]);
  if (!layer) return (
    <VStack align="stretch" spacing={3}>
      {canEdit && <Button onClick={onEdit}>Edit text</Button>}
      <Button onClick={onNew}>New text layer</Button>
      <Text fontSize="sm" color="gray.600">Click the image to place text, or choose New text layer to start in the center.</Text>
    </VStack>
  );
  const text = layer.text;
  return (
    <VStack data-text-editor="true" align="stretch" spacing={3} onKeyDown={onKeyDown}>
      <FormControl>
        <FormLabel fontSize="sm" htmlFor="layer-text-content">Text</FormLabel>
        <Textarea id="layer-text-content" ref={inputRef} value={text.value} maxLength={TEXT_LIMIT}
          placeholder="Type your text" wrap="off" rows={3} onChange={(event) => update({ value: event.target.value })} />
      </FormControl>
      <HStack align="end">
        <FormControl>
          <FormLabel fontSize="sm" htmlFor="text-font">Font</FormLabel>
          <Select id="text-font" size="sm" value={text.fontFamily} onChange={(event) => update({ fontFamily: event.target.value })}>
            {TEXT_FONTS.map((font) => <option key={font} value={font}>{font === 'sans-serif' ? 'Sans serif' : font === 'serif' ? 'Serif' : 'Monospace'}</option>)}
          </Select>
        </FormControl>
        <FormControl maxW="85px">
          <FormLabel fontSize="sm" htmlFor="text-size">Size (px)</FormLabel>
          <Input id="text-size" size="sm" type="number" min={1} max={512} value={text.fontSize}
            onChange={(event) => update({ fontSize: event.target.value })} />
        </FormControl>
      </HStack>
      <HStack justify="space-between">
        <Checkbox isChecked={text.bold} onChange={(event) => update({ bold: event.target.checked })}>Bold</Checkbox>
        <Checkbox isChecked={text.italic} onChange={(event) => update({ italic: event.target.checked })}>Italic</Checkbox>
        <Input aria-label="Text color" type="color" value={text.color} w="60px" h="32px" p={1}
          onChange={(event) => update({ color: event.target.value })} />
      </HStack>
      <FormControl>
        <FormLabel fontSize="sm" htmlFor="text-alignment">Alignment</FormLabel>
        <Select id="text-alignment" size="sm" value={text.align} onChange={(event) => update({ align: event.target.value })}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </Select>
      </FormControl>
      {error && <Text role="alert" color="red.600" fontSize="sm">{error}</Text>}
      <HStack>
        <Button colorScheme="blue" size="sm" onClick={onDone}>{session.isNew ? 'Add text' : 'Done'}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="outline" onClick={showInline}>Edit on image</Button>
      </HStack>
      <Button size="sm" variant="outline" onClick={onNew}>New text layer</Button>
      {!session.isNew && <Button size="sm" variant="outline" onClick={onConvert}>Convert to image layer</Button>}
      <Text fontSize="xs" color="gray.600">Enter adds a line. ⌘/Ctrl+Enter or clicking outside the text finishes. Escape cancels. Use Move to position, resize, or rotate text.</Text>
    </VStack>
  );
};

export const InlineTextEditor = ({ layer, matrix, onChange, onKeyDown }) => {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, [layer.id]);
  const { text, textLayout: layout } = layer;
  return (
    <Box data-text-editor="true" position="absolute" left={0} top={0}
      style={{ transform: `matrix(${matrix.join(',')})`, transformOrigin: '0 0', width: layout.width, height: layout.height }}>
      <textarea ref={ref} aria-label="Edit text on image" value={text.value} maxLength={TEXT_LIMIT} wrap="off"
        placeholder="Type text" onChange={(event) => onChange({ value: event.target.value })} onKeyDown={onKeyDown}
        style={{ display: 'block', boxSizing: 'border-box', width: '100%', height: '100%', minWidth: 0,
          padding: layout.padding, border: 0, outline: '1px solid #3182ce', borderRadius: 0, resize: 'none',
          overflow: 'hidden', background: 'transparent', color: text.color, caretColor: text.color,
          fontFamily: text.fontFamily, fontSize: text.fontSize, fontWeight: text.bold ? 'bold' : 'normal',
          fontStyle: text.italic ? 'italic' : 'normal', lineHeight: `${layout.lineHeight}px`, textAlign: text.align,
          opacity: layer.opacity / 100, whiteSpace: 'pre', tabSize: 4 }} />
    </Box>
  );
};
