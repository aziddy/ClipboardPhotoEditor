export const getEditorViewport = (doc, width, height, zoom = 100, offset = { x: 0, y: 0 }, pixelRatio = 1) => {
  const fit = Math.min(Math.max(1, width - 32) / Math.max(1, doc.width), Math.max(1, height - 32) / Math.max(1, doc.height));
  const scale = fit * zoom / 100;
  const x = (width - doc.width * scale) / 2 + offset.x;
  const y = (height - doc.height * scale) / 2 + offset.y;
  return {
    scale, x, y, width: doc.width * scale, height: doc.height * scale,
    pixelWidth: Math.max(1, Math.round(width * pixelRatio)),
    pixelHeight: Math.max(1, Math.round(height * pixelRatio)),
    matrix: [scale * pixelRatio, 0, 0, scale * pixelRatio, x * pixelRatio, y * pixelRatio],
    maxX: Math.max(0, (doc.width * scale - width) / 2),
    maxY: Math.max(0, (doc.height * scale - height) / 2),
  };
};
