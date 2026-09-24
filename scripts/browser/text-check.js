// Opt-in browser regression checks against the production editor and its worker.
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const until = async (condition) => {
  for (let i = 0; i < 300; i += 1) { if (condition()) return; await pause(); }
  throw new Error('Timed out waiting for the editor');
};
const visible = (element) => element.getClientRects().length > 0;
const button = (name) => [...document.querySelectorAll('button')].find((element) => visible(element)
  && (element.getAttribute('aria-label') === name || element.textContent.trim() === name));
const idle = async () => {
  await until(() => document.querySelector('#root > [aria-busy]')?.getAttribute('aria-busy') !== 'true');
  await pause(250);
};
const click = async (name) => {
  const element = button(name);
  assert(element && !element.disabled, `Button unavailable: ${name}`);
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  element.focus(); element.click(); await pause(); await idle();
};
const input = async (selector, value) => {
  const element = document.querySelector(selector);
  assert(element, `Input missing: ${selector}`);
  element.focus();
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, String(value));
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  await pause();
};
const keys = async (key, options = {}) => {
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  await pause(); await idle();
};
const layerCount = () => document.querySelectorAll('input[aria-label^="Layer name:"]').length;
const sidebar = () => document.querySelector('#layer-text-content');
const inline = () => document.querySelector('textarea[aria-label="Edit text on image"]');
const pointer = (type, point) => {
  const canvas = document.querySelector('canvas');
  canvas.setPointerCapture = () => {};
  canvas.dispatchEvent(new PointerEvent(type, { pointerId: 5, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
    clientX: point.x, clientY: point.y }));
};
const drag = async (from, to) => {
  pointer('pointerdown', from); await pause(); pointer('pointermove', to); await pause();
  pointer('pointerup', to); await idle();
};
const doubleClick = async (point) => {
  document.querySelector('canvas').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: point.x, clientY: point.y }));
  await idle(); assert(inline(), 'Double-click did not open the inline editor');
};
const blobs = new Map(), downloads = [];
const createURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const url = createURL(blob); blobs.set(url, blob); return url; };
const anchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download) downloads.push(blobs.get(this.href)); else anchorClick.call(this);
};
const exported = async (format = 'PNG') => {
  await click(`Download ${format}`);
  await until(() => downloads.length > 0);
  const blob = downloads.pop(), bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
  return { canvas, data: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, type: blob.type };
};
const difference = (a, b) => {
  assert(a.data.length === b.data.length, 'Export dimensions differ');
  let sum = 0; for (let i = 0; i < a.data.length; i += 1) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / a.data.length;
};
const redPixels = ({ data }) => {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100) count += 1;
  return count;
};
const results = [];
const check = async (name, run) => {
  document.title = `Checking text: ${name}`;
  try { results.push({ name, passed: true, detail: await run() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); throw error; }
};
let original;
try {
  await until(() => button('Import'));
  const fixture = document.createElement('canvas'); fixture.width = 600; fixture.height = 480;
  const ctx = fixture.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 600, 480);
  const transfer = new DataTransfer();
  transfer.items.add(new File([await new Promise((resolve) => fixture.toBlob(resolve))], 'text-fixture.png', { type: 'image/png' }));
  const fileInput = document.querySelector('input[type=file]'); fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true })); await pause(); await idle();
  original = await exported();

  await check('Sidebar and inline share multiline content and styles', async () => {
    await click('Text'); await input('#layer-text-content', 'Editable text\nSecond line');
    await input('#text-font', 'serif'); await input('#text-size', 40);
    await input('[aria-label="Text color"]', '#ff0000'); await input('#text-alignment', 'center');
    for (const label of ['Bold', 'Italic']) {
      const checkbox = [...document.querySelectorAll('label')].find((element) => element.textContent === label);
      checkbox.click(); await pause();
    }
    await click('Edit on image');
    assert(inline()?.value === 'Editable text\nSecond line', 'Inline value differs');
    const inlineRect = inline().getBoundingClientRect();
    assert(inlineRect.bottom > 0 && inlineRect.top < window.innerHeight, 'Focused inline text is outside the viewport');
    assert(getComputedStyle(inline()).fontStyle === 'italic', 'Italic style missing');
    assert(getComputedStyle(inline()).fontWeight === '700', 'Bold style missing');
    await input('textarea[aria-label="Edit text on image"]', 'Editable text\nBoth editors');
    assert(sidebar().value === inline().value, 'Sidebar did not follow inline edit');
    await keys('Enter', { metaKey: true });
    assert(!inline() && layerCount() === 2, 'Text did not finish');
    const output = await exported(); assert(redPixels(output) > 500, 'Styled text is absent from PNG');
    return { redPixels: redPixels(output) };
  });
  await check('One undo removes the whole session and redo restores exact PNG', async () => {
    const before = await exported(); await click('Undo');
    assert(layerCount() === 1, 'Text edits created multiple history steps');
    assert(difference(original, await exported()) === 0, 'Undo changed the image');
    await click('Redo'); assert(difference(before, await exported()) === 0, 'Redo changed text pixels');
  });
  await check('Canvas placement, movement, rotation, and zoom preserve inline editing', async () => {
    await click('Text'); await click('New text layer');
    document.querySelector('canvas').scrollIntoView({ block: 'center' });
    const canvasRect = document.querySelector('canvas').getBoundingClientRect();
    const fit = Math.min((canvasRect.width - 32) / 600, (canvasRect.height - 32) / 480);
    const point = { x: canvasRect.left + (canvasRect.width - 600 * fit) / 2 + 100 * fit,
      y: canvasRect.top + (canvasRect.height - 480 * fit) / 2 + 80 * fit };
    pointer('pointerdown', point); await idle();
    assert(inline(), 'Click did not place text');
    await input('textarea[aria-label="Edit text on image"]', 'Placed\ntext');
    const box = inline().getBoundingClientRect();
    assert(Math.abs(box.left - point.x) < 1 && Math.abs(box.top - point.y) < 1, 'Text was not placed at the click');
    await keys('Enter', { metaKey: true });
    const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const moved = { x: center.x + 45, y: center.y + 30 };
    await drag(center, moved); await doubleClick(moved);
    const movedBox = inline().getBoundingClientRect();
    assert(Math.abs(movedBox.left - box.left - 45) < 1, 'Move lost text placement');
    await keys('Enter', { metaKey: true });
    const radius = movedBox.height / 2 + 20;
    await drag({ x: moved.x, y: moved.y - radius }, { x: moved.x + radius, y: moved.y });
    await doubleClick(moved);
    const matrix = new DOMMatrix(getComputedStyle(inline().parentElement).transform);
    assert(Math.abs(matrix.a) < 0.01 && matrix.b > 0, 'Inline editor did not follow rotation');
    await keys('Enter', { metaKey: true }); await click('Zoom in');
    await click('Edit text'); await click('Edit on image');
    const zoomed = new DOMMatrix(getComputedStyle(inline().parentElement).transform);
    assert(zoomed.b > matrix.b && inline().value === 'Placed\ntext', 'Zoom lost the transformed editor');
    await click('Cancel'); await click('Reset zoom to 100%'); await click('Delete layer');
  });
  await check('Escape discards existing edits and empty new layers', async () => {
    const before = await exported(); await click('Edit text');
    await input('#layer-text-content', 'Discard this'); await keys('Escape');
    assert(difference(before, await exported()) === 0, 'Cancel did not restore text');
    await click('Text'); await click('New text layer'); await click('Add text');
    assert(layerCount() === 2, 'An empty text layer was kept');
  });
  await check('Export finishes an inline draft without hiding text', async () => {
    await click('Edit text'); await click('Edit on image');
    await input('textarea[aria-label="Edit text on image"]', 'Exported inline\nBoth editors');
    const output = await exported(); assert(redPixels(output) > 500, 'Export omitted inline text');
    assert(!inline() && button('Edit text'), 'Export left a stale editor');
  });
  await check('Duplicate has independent editable text', async () => {
    const before = await exported(); await click('Duplicate layer');
    assert(layerCount() === 3, 'Duplicate missing'); await click('Edit text');
    await input('#layer-text-content', 'Independent duplicate'); await keys('Enter', { ctrlKey: true });
    await click('Delete layer'); assert(layerCount() === 2, 'Duplicate not deleted');
    assert(difference(before, await exported()) === 0, 'Duplicate changed original text');
  });
  await check('Resize and crop preserve editable text', async () => {
    await click('Resize'); await input('[aria-label="Resize width"]', 1200); await click('Apply Resize');
    let output = await exported(); assert(output.canvas.width === 1200 && redPixels(output) > 2000, 'Resize lost sharp text');
    await click('Crop'); await click('Apply Crop');
    output = await exported(); assert(output.canvas.width === 960, 'Crop dimensions incorrect');
    await click('Edit text'); assert(sidebar().value === 'Exported inline\nBoth editors', 'Crop flattened text');
    await click('Cancel'); await click('Undo'); await click('Undo');
  });
  await check('Brush requires explicit conversion; conversion is undoable', async () => {
    await click('Move'); const before = await exported(); await click('Brush');
    assert(button('Convert to image layer'), 'Brush destroyed editable text');
    await click('Convert to image layer');
    assert(!button('Edit text'), 'Conversion kept the text editor');
    const converted = await exported();
    assert(difference(before, converted) < 0.25, 'Conversion changed text appearance');
    await click('Undo'); await click('Edit text');
    assert(sidebar().value === 'Exported inline\nBoth editors', 'Undo did not restore editable text');
    await click('Cancel');
    return { conversionMeanDifference: difference(before, converted) };
  });
  await check('Deleting text content is undoable and JPEG includes text', async () => {
    await click('Edit text'); await input('#layer-text-content', ''); await click('Done');
    assert(layerCount() === 1, 'Empty existing text not removed'); await click('Undo');
    const jpeg = await exported('JPEG');
    assert(jpeg.type === 'image/jpeg' && redPixels(jpeg) > 500, 'JPEG omitted text');
  });
  await check('Reset cancels an active text draft', async () => {
    await click('Edit text'); await input('#layer-text-content', 'Reset draft');
    await click('Reset'); assert(layerCount() === 0 && !inline() && !sidebar(), 'Reset kept text');
  });
} catch (error) {
  if (!results.some((result) => !result.passed)) results.push({ name: 'Setup', passed: false, error: error.stack });
} finally {
  URL.createObjectURL = createURL; HTMLAnchorElement.prototype.click = anchorClick;
}
const output = { kind: window.innerWidth < 600 ? 'text-mobile' : 'text', userAgent: navigator.userAgent,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  passed: results.filter((result) => result.passed).length, total: results.length, results };
await fetch('/ui-results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(output) });
document.title = `${output.passed}/${output.total} text checks passed`;
const report = document.createElement('pre'); report.id = 'text-results'; report.textContent = JSON.stringify(output, null, 2); document.body.append(report);
