if (new URLSearchParams(window.location.search).get('uicheck') === 'ocr') {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(300);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1200, 600);
  ctx.fillStyle = 'black';
  ctx.font = '64px Arial';
  ctx.fillText('Original image details', 70, 180);
  ctx.fillText('Clipboard photo editor', 70, 300);
  const blob = await new Promise(r => canvas.toBlob(r));
  canvas.width = 1;
  canvas.height = 1;
  const data = new DataTransfer();
  data.items.add(new File([blob], 'ocr-fixture.png', {
    type: 'image/png'
  }));
  const input = document.querySelector('input[type=file]');
  input.files = data.files;
  input.dispatchEvent(new Event('change', {
    bubbles: true
  }));
  document.title = 'OCR fixture ready';
} else {
  const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const until = async fn => {
    for (let i = 0; i < 1500; i++) {
      if (fn()) return;
      await pause();
    }
    throw new Error('Timed out waiting for UI');
  };
  const visible = element => element.getClientRects().length > 0;
  const button = name => [...document.querySelectorAll('button')].find(b => visible(b) && (b.getAttribute('aria-label') === name || b.textContent.trim() === name));
  const idle = async () => {
    await until(() => document.querySelector('#root > [aria-busy]')?.getAttribute('aria-busy') !== 'true');
    await pause(300);
  };
  const dims = () => {
    const m = document.querySelector('#root').textContent.match(/(\d+)\s*x\s*(\d+)px/i);
    return m ? {
      width: +m[1],
      height: +m[2]
    } : {
      width: 0,
      height: 0
    };
  };
  const click = async name => {
    const b = button(name);
    assert(b && !b.disabled, 'Button unavailable: ' + name);
    b.click();
    await pause(80);
    await idle();
  };
  const main = () => document.querySelector('canvas');
  const results = [];
  const checkLimit = Number(new URLSearchParams(window.location.search).get('limit')) || Infinity;
  const check = async (name, fn) => {
    if (results.length >= checkLimit) return;
    document.title = 'Checking: ' + name;
    await fetch('/ui-results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'ui-progress', userAgent: navigator.userAgent, phase: name, results }),
    });
    try {
      const detail = await fn();
      results.push({
        name,
        passed: true,
        detail
      });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: error.message + '\n' + error.stack
      });
    }
  };
  const copyCanvas = source => {
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d').drawImage(source, 0, 0);
    return c;
  };
  const different = (a, b) => {
    assert(a.width === b.width && a.height === b.height, 'Dimensions differ');
    const x = a.getContext('2d').getImageData(0, 0, a.width, a.height).data,
      y = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
    return sum / x.length;
  };
  const displayDifference = (a, b) => {
    assert(a.width === b.width && a.height === b.height, 'Display dimensions differ');
    const x = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    const y = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    let max = 0, changed = 0, sum = 0;
    for (let i = 0; i < x.length; i += 1) {
      const delta = Math.abs(x[i] - y[i]);
      max = Math.max(max, delta); sum += delta;
      if (delta) changed += 1;
    }
    return { max, changed, mean: sum / x.length };
  };
  // Viewport compositing can round an antialiased channel by one unit. Source
  // PNG comparisons below remain exact; this tolerance cannot hide lost ink.
  const sameDisplay = (a, b) => {
    const difference = displayDifference(a, b);
    return difference.max <= 1 && difference.mean <= 0.001;
  };
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const setInput = async (element, value) => {
    nativeValue.call(element, String(value));
    element.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    await pause(80);
  };
  const importedImage = async name => {
    const canvas = document.createElement('canvas');
    canvas.width = name === 'detail' ? 2400 : 600;
    canvas.height = name === 'detail' ? 1920 : 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (name === 'detail') {
      for (let y = 0; y < canvas.height; y += 4) {
        for (let x = 0; x < canvas.width; x += 4) {
          ctx.fillStyle = (x + y) % 8 ? '#ffffff' : '#333333';
          ctx.fillRect(x, y, 4, 4);
        }
      }
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(940, 800, 500, 210);
      ctx.fillStyle = '#ffffff';
      ctx.font = '48px Arial';
      ctx.fillText('Original detail', 980, 900);
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    canvas.width = 1;
    canvas.height = 1;
    return new File([blob], name + '.png', {
      type: 'image/png'
    });
  };
  const transfer = file => {
    const d = new DataTransfer();
    d.items.add(file);
    return d;
  };
  const importFile = async (name, mode = 'upload') => {
    const file = await importedImage(name),
      data = transfer(file);
    if (mode === 'paste') {
      window.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true
      }));
    } else if (mode === 'drop') {
      document.querySelector('#root').firstElementChild.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data,
        bubbles: true,
        cancelable: true
      }));
    } else {
      const input = document.querySelector('input[type=file]');
      input.files = data.files;
      input.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }
    await pause(80);
    await idle();
  };
  const sliderTo = async (slider, value) => {
    for (let i = 0; i < 350; i++) {
      const current = Number(slider.getAttribute('aria-valuenow'));
      if (current === value) {
        await idle();
        return;
      }
      slider.dispatchEvent(new KeyboardEvent('keydown', {
        key: current < value ? 'ArrowRight' : 'ArrowLeft',
        bubbles: true
      }));
      await pause(5);
    }
    throw new Error('Slider did not reach ' + value);
  };
  const scale = async value => {
    await click('Move');
    const slider = [...document.querySelectorAll('[role=slider]')].find(s => visible(s) && s.getAttribute('aria-valuemax') === '300');
    assert(slider, 'Move scale missing');
    await sliderTo(slider, value);
    await click('Apply');
  };
  const stroke = async (tool, from, to, pointerType = 'mouse') => {
    await click(tool);
    const c = main();
    const rect = c.getBoundingClientRect();
    const d = dims();
    const fit = Math.min((rect.width - 32) / d.width, (rect.height - 32) / d.height);
    const left = (rect.width - d.width * fit) / 2,
      top = (rect.height - d.height * fit) / 2;
    c.setPointerCapture = () => {};
    const emit = (type, p) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 1,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      bubbles: true,
      cancelable: true,
      clientX: rect.left + left + p.x * fit,
      clientY: rect.top + top + p.y * fit
    }));
    emit('pointerdown', from);
    await pause(50);
    emit('pointermove', to);
    await pause(50);
    emit('pointerup', to);
    await pause(50);
    await idle();
  };
  const blobMap = new Map();
  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => {
    const u = originalCreate(b);
    blobMap.set(u, b);
    return u;
  };
  const exports = [];
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      exports.push({
        name: this.download,
        blob: blobMap.get(this.href)
      });
    } else {
      originalAnchorClick.call(this);
    }
  };
  const imageFromBlob = async blob => {
    const img = new Image();
    img.src = originalCreate(blob);
    await img.decode();
    return img;
  };
  const exportedCanvas = async () => {
    await click('Download PNG');
    const image = await imageFromBlob(exports.pop().blob);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
  };
  let enlarged, drawn;
  try {
    await until(() => button('Import'));
    await check('Upload starts the document at 600×480', async () => {
      await importFile('background');
      assert(dims().width === 600 && dims().height === 480, 'Document size incorrect');
      assert(document.body.textContent.includes('1 layer'), 'Layer missing');
    });
    await check('Paste adds a fitted full-resolution image layer', async () => {
      await importFile('detail', 'paste');
      assert(document.body.textContent.includes('2 layers'), 'Pasted layer missing');
    });
    await check('Move slider retains original detail in PNG output', async () => {
      await scale(200);
      await scale(200);
      await click('Brush');
      enlarged = copyCanvas(main());
      await click('Download PNG');
      await until(() => exports.length > 0);
      const image = await imageFromBlob(exports.pop().blob);
      const out = document.createElement('canvas');
      out.width = 600;
      out.height = 480;
      out.getContext('2d').drawImage(image, 0, 0);
      const file = await importedImage('detail'),
        img = await imageFromBlob(file),
        ref = document.createElement('canvas');
      ref.width = 600;
      ref.height = 480;
      ref.getContext('2d').drawImage(img, -900, -720);
      const error = different(out, ref);
      assert(error === 0, 'Enlargement differs from original: ' + error);
      return {
        meanPixelDifference: error
      };
    });
    await check('Brush edits render immediately and survive undo/redo', async () => {
      await stroke('Brush', {
        x: 220,
        y: 280
      }, {
        x: 370,
        y: 330
      });
      drawn = copyCanvas(main());
      assert(different(drawn, enlarged) > .1, 'Brush made no visible edit');
      await click('Undo');
      assert(sameDisplay(main(), enlarged), 'Undo changed original pixels');
      await click('Redo');
      assert(sameDisplay(main(), drawn), 'Redo did not restore brush pixels');
    });
    await check('Duplicate and eraser edits do not change the original layer', async () => {
      const originalPixels = await exportedCanvas();
      await click('Duplicate layer');
      assert(document.body.textContent.includes('3 layers'), 'Duplicate missing');
      await stroke('Eraser', {
        x: 250,
        y: 290
      }, {
        x: 340,
        y: 320
      });
      await click('Delete layer');
      await click('Brush');
      const difference = displayDifference(main(), drawn);
      const remainingPixels = await exportedCanvas();
      const nativeDifference = different(originalPixels, remainingPixels);
      const afterExportDifference = different(main(), drawn);
      originalPixels.width = 1; remainingPixels.width = 1;
      assert(nativeDifference === 0, 'Erasing duplicate altered source pixels: ' + nativeDifference);
      assert(difference.max <= 1 && difference.mean <= 0.001, 'Original display changed: ' + JSON.stringify(difference));
      return { displayDifference: difference, afterExportDifference, nativeDifference };
    });
    await check('Layer opacity and visibility remain functional', async () => {
      const eye = button('Hide layer');
      assert(eye, 'Visibility control missing');
      eye.click();
      await pause(400);
      assert(different(main(), drawn) > .1, 'Hiding had no visible effect');
      await click('Show layer');
      assert(sameDisplay(main(), drawn), 'Showing changed pixels');
      const inputs = [...document.querySelectorAll('input')].filter(x => x.value === 'Image 2');
      assert(inputs.length === 1, 'Layer controls missing');
      const row = inputs[0].parentElement.parentElement;
      const slider = row.querySelector('[role=slider]');
      await sliderTo(slider, 50);
      assert(different(main(), drawn) > .1, 'Opacity had no effect');
      await sliderTo(slider, 100);
      await until(() => sameDisplay(main(), drawn));
      assert(sameDisplay(main(), drawn), 'Opacity did not restore output');
    });
    await check('Document resize down and back preserves the composed pixels', async () => {
      for (const width of [300, 600]) {
        await click('Resize');
        await setInput(document.querySelector('[aria-label="Resize width"]'), width);
        await click('Apply Resize');
        assert(dims().width === width, 'Resize not applied');
      }
      await click('Brush');
      assert(sameDisplay(main(), drawn), 'Resize discarded pixels');
    });
    await check('Crop changes dimensions and undo restores the complete image', async () => {
      await click('Crop');
      await click('Apply Crop');
      assert(dims().width === 480 && dims().height === 384, 'Crop dimensions incorrect');
      await click('Undo');
      await click('Brush');
      assert(sameDisplay(main(), drawn), 'Crop undo lost pixels');
    });
    await check('Explicit output sizes do not run automatically', async () => {
      assert(button('Calculate sizes'), 'Size calculation control missing');
      await click('Calculate sizes');
      await until(() => !button('Calculate sizes').disabled);
      assert(document.body.textContent.includes(' MB'), 'Sizes missing');
    });
    await check('PNG/JPEG downloads and JPEG quality use the composed document', async () => {
      await click('Download PNG');
      await until(() => exports.some(e => e.name.endsWith('.png')));
      const png = exports.find(e => e.name.endsWith('.png'));
      assert(png.blob?.type === 'image/png', 'PNG export missing');
      const image = await imageFromBlob(png.blob);
      assert(image.naturalWidth === 600 && image.naturalHeight === 480, 'PNG size incorrect');
      await click('Download JPEG');
      await until(() => exports.some(e => e.name.endsWith('.jpg')));
      const jpg = exports.find(e => e.name.endsWith('.jpg'));
      assert(jpg.blob?.type === 'image/jpeg', 'JPEG export missing');
      const quality = document.querySelector('input[type=range]');
      assert(quality, 'JPEG quality control missing');
      await setInput(quality, 30);
      quality.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true
      }));
      await pause(80);
      await click('Download JPEG');
      await until(() => exports.length === 3);
      assert(exports[exports.length - 1].blob.size < jpg.blob.size, 'Quality did not reduce JPEG size');
      return exports.map(e => ({
        name: e.name,
        bytes: e.blob.size
      }));
    });
    await check('Reset clears the document and history', async () => {
      await click('Reset');
      assert(!main(), 'Canvas survived reset');
      assert(button('Undo').disabled, 'Undo survived reset');
    });
    await check('Drop imports an image and touch strokes edit the active layer', async () => {
      await importFile('background', 'drop');
      assert(dims().width === 600, 'Drop failed');
      const before = copyCanvas(main());
      await stroke('Brush', {
        x: 100,
        y: 100
      }, {
        x: 300,
        y: 200
      }, 'touch');
      assert(different(main(), before) > .1, 'Touch stroke failed');
    });
    await check('Reset cancels an in-flight import and accepts a new image', async () => {
      await click('Reset');
      const input = document.querySelector('input[type=file]');
      input.files = transfer(await importedImage('detail')).files;
      input.dispatchEvent(new Event('change', {
        bubbles: true
      }));
      await pause(5);
      button('Reset').click();
      await pause(700);
      assert(!main(), 'Canceled import restored an old document');
      await importFile('background');
      assert(dims().width === 600 && dims().height === 480, 'Import after cancellation failed');
    });
    await check('Reset cancels an in-flight brush stroke', async () => {
      await click('Brush');
      const canvas = main();
      const rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture = () => {};
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 2,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 1,
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }));
      await pause(5);
      button('Reset').click();
      await pause(700);
      assert(!main() && button('Undo').disabled, 'Canceled stroke restored a document');
    });
    // Leave the reported large-image scenario visible for inspection.
    if (!button('Reset').disabled) await click('Reset');
    await importFile('background');
    await importFile('detail', 'paste');
    await scale(200);
    await scale(200);
    await click('Brush');
  } catch (error) {
    results.push({
      name: 'Harness completion',
      passed: false,
      error: error.stack
    });
  }
  const output = {
    kind: 'ui',
    complete: true,
    passed: results.filter(r => r.passed).length,
    total: results.length,
    results,
    userAgent: navigator.userAgent
  };
  window.editorUiResults = output;
  const status = document.createElement('pre');
  status.textContent = JSON.stringify(output, null, 2);
  status.style.cssText = 'white-space:pre-wrap;background:#eff6ff;padding:16px;border:2px solid #2563eb;margin:16px';
  status.id = 'editor-ui-results';
  document.body.append(status);
  document.title = output.passed + '/' + output.total + ' editor UI tests passed';
  await fetch('/ui-results', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(output)
  });
}
