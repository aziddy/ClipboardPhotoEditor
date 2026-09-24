export const TEXT_FONTS = ['sans-serif', 'serif', 'monospace'];
export const TEXT_LIMIT = 10000;
export const DEFAULT_TEXT = {
  value: '', fontFamily: 'sans-serif', fontSize: 32, color: '#000000',
  bold: false, italic: false, align: 'left',
};

export const isTextLayer = (layer) => layer?.type === 'text';
export const textFont = (text) => `${text.italic ? 'italic ' : ''}${text.bold ? 'bold ' : ''}${text.fontSize}px ${text.fontFamily}`;

export const normalizeText = (text) => ({
  ...DEFAULT_TEXT, ...text,
  value: String(text.value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    '),
  fontFamily: TEXT_FONTS.includes(text.fontFamily) ? text.fontFamily : DEFAULT_TEXT.fontFamily,
  fontSize: Math.max(1, Math.min(512, Math.round(Number(text.fontSize) || 32))),
  align: ['left', 'center', 'right'].includes(text.align) ? text.align : 'left',
});

// Store the measured layout with the layer so the worker, DOM editor, and
// exports use the same line positions. No bitmap is needed for editable text.
export const measureTextLayout = (ctx, text) => {
  if (text.value.length > TEXT_LIMIT) throw new Error(`Text is limited to ${TEXT_LIMIT.toLocaleString()} characters.`);
  ctx.font = textFont(text);
  const lines = text.value.split('\n').map((line) => line.replace(/\t/g, '    '));
  const metrics = ctx.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent ?? text.fontSize * 0.8;
  const descent = metrics.fontBoundingBoxDescent ?? text.fontSize * 0.2;
  const lineHeight = text.fontSize * 1.2;
  const padding = Math.ceil(text.fontSize * 0.2) + 2;
  const width = Math.ceil(Math.max(text.fontSize, ...lines.map((line) => ctx.measureText(line).width)) + padding * 2);
  const height = Math.ceil(lines.length * lineHeight + padding * 2);
  if (width > 12000 || height > 12000) throw new Error('Text must fit within 12,000 pixels per side. Use shorter lines or a smaller font.');
  return { lines, width, height, padding, lineHeight, baseline: padding + (lineHeight - ascent - descent) / 2 + ascent };
};

export const updateTextLayer = (layer, changes, ctx) => {
  const text = normalizeText({ ...layer.text, ...changes });
  const textLayout = measureTextLayout(ctx, text);
  return { ...layer, type: 'text', text, textLayout,
    sourceBounds: { x: 0, y: 0, width: textLayout.width, height: textLayout.height } };
};

export const drawTextLayer = (ctx, layer) => {
  const { text, textLayout: layout } = layer;
  ctx.font = textFont(text);
  ctx.fillStyle = text.color;
  ctx.textAlign = text.align;
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'ltr';
  const x = text.align === 'center' ? layout.width / 2
    : text.align === 'right' ? layout.width - layout.padding : layout.padding;
  layout.lines.forEach((line, index) => ctx.fillText(line, x, layout.baseline + index * layout.lineHeight));
};

export const textSignature = (layer) => isTextLayer(layer) ? JSON.stringify(layer.text) : layer.rasterId;
