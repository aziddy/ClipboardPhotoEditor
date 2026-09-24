import { DEFAULT_TEXT, drawTextLayer, measureTextLayout, updateTextLayer } from './textLayers';
import { applyLayerTransform, cloneLayer, cropDocument, editorReducer, getLayerDocumentBounds, resizeDocument } from './editorLayers';
import { RasterEngine } from './rasterEngine';
import { MemoryRasterStorage } from './rasterStorage';

const context = () => ({
  measureText: (line) => ({ width: line.length * 16, fontBoundingBoxAscent: 26, fontBoundingBoxDescent: 6 }),
  fillText: jest.fn(), save: jest.fn(), restore: jest.fn(), setTransform: jest.fn(),
});
const textLayer = (changes = {}) => updateTextLayer({
  id: 'text', name: 'Text', text: DEFAULT_TEXT, transform: [1, 0, 0, 1, 20, 30], visible: true, opacity: 70,
}, { value: 'Hello\nworld', ...changes }, context());
const documentWithText = () => ({ width: 600, height: 480, layers: [textLayer()], activeLayerId: 'text' });

test('multiline layout preserves empty lines and expands tabs consistently', () => {
  const layer = textLayer({ value: 'A\r\n\n\tB', bold: true, italic: true, align: 'center' });
  expect(layer.text.value).toBe('A\n\n    B');
  expect(layer.textLayout.lines).toEqual(['A', '', '    B']);
  expect(layer.textLayout.height).toBe(Math.ceil(3 * 32 * 1.2 + layer.textLayout.padding * 2));
  const ctx = context();
  drawTextLayer(ctx, layer);
  expect(ctx.font).toBe('italic bold 32px sans-serif');
  expect(ctx.fillText.mock.calls.map(([line, x]) => [line, x])).toEqual(layer.textLayout.lines.map((line) => [line, layer.textLayout.width / 2]));
});

test('text limits reject oversized content before allocating image surfaces', () => {
  expect(() => measureTextLayout(context(), { ...DEFAULT_TEXT, value: 'x'.repeat(10001) })).toThrow('characters');
  expect(() => measureTextLayout(context(), { ...DEFAULT_TEXT, value: 'x'.repeat(1000) })).toThrow('12,000');
  expect(textLayer({ fontSize: 0 }).text.fontSize).toBe(32);
});

test('text transforms and crop keep editable content without raster allocations', async () => {
  const doc = documentWithText();
  const transformed = applyLayerTransform(doc.layers[0], { scaleX: 200, scaleY: 200, rotationDeg: 30 });
  expect(transformed.text.value).toBe(doc.layers[0].text.value);
  expect(getLayerDocumentBounds(transformed).width).toBeGreaterThan(doc.layers[0].sourceBounds.width);
  const resized = resizeDocument(doc, 1200, 960);
  expect(resized.layers[0].transform).toEqual([2, 0, 0, 2, 40, 60]);
  const crop = { x: 10, y: 20, width: 200, height: 100 };
  const engine = new RasterEngine(new MemoryRasterStorage());
  const cropped = await engine.crop({ doc, crop });
  expect(cropped).toEqual(cropDocument(doc, crop));
  expect(cropped.layers[0].transform).toEqual([1, 0, 0, 1, 10, 10]);
  expect(cropped.layers[0].text.value).toBe('Hello\nworld');
  expect(engine.versions.size).toBe(0);
});

test('history and duplicates keep independent text and layout snapshots', () => {
  const doc = documentWithText();
  let state = editorReducer({ doc, history: [], historyIndex: -1 }, { type: 'commit', doc });
  const copy = cloneLayer(doc.layers[0]);
  copy.text.value = 'Independent'; copy.textLayout.lines[0] = 'Independent';
  expect(doc.layers[0].text.value).toBe('Hello\nworld');
  expect(doc.layers[0].textLayout.lines[0]).toBe('Hello');
  const edited = { ...doc, layers: [updateTextLayer(doc.layers[0], { value: 'Changed', color: '#ff0000' }, context())] };
  state = editorReducer(state, { type: 'commit', doc: edited });
  state = editorReducer(state, { type: 'undo' });
  expect(state.doc.layers[0].text.value).toBe('Hello\nworld');
  state = editorReducer(state, { type: 'redo' });
  expect(state.doc.layers[0].text.value).toBe('Changed');
});

test('worker draws text at the destination transform and refuses direct brush edits', async () => {
  const engine = new RasterEngine(new MemoryRasterStorage());
  const layer = textLayer();
  const ctx = context();
  await engine.renderLayer(ctx, layer, [2, 0, 0, 2, 0, 0], 1200, 960, true);
  expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 40, 60);
  expect(ctx.globalAlpha).toBe(0.7);
  expect(ctx.fillText).toHaveBeenCalledTimes(2);
  expect(engine.versions.size).toBe(0);
  await expect(engine.beginStroke({ layer })).rejects.toThrow('Convert text');
});
