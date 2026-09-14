// Opt-in production-UI checks. This script is injected before the app bundle.
// Pixel readback adds some overhead: timings are conservative canvas-present
// measurements, not compositor/display-hardware timestamps.
(() => {
  const params = new URLSearchParams(window.location.search);
  const nativeDevicePixelRatio = window.devicePixelRatio;
  const requestedDevicePixelRatio = params.get('dpr') === '1' ? 1 : params.get('dpr') === '2' ? 2 : null;
  let dprOverrideApplied = false, dprOverrideError = null;
  if (requestedDevicePixelRatio !== null) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
      if (descriptor && !descriptor.configurable) throw new Error('window.devicePixelRatio is not configurable');
      // Test only the app's raster allocation/coordinate branch. The physical
      // display density and browser compositing scale remain unchanged.
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true, enumerable: descriptor?.enumerable ?? true,
        get: () => requestedDevicePixelRatio,
      });
      dprOverrideApplied = true;
    } catch (error) { dprOverrideError = error.message; }
  }
  const dprSuffix = requestedDevicePixelRatio === 1 ? '-dpr-one' : requestedDevicePixelRatio === 2 ? '-dpr-two' : '';
  const mode = params.get('latencycheck') === 'stress' ? 'stress' : 'normal';
  const cases = ['all', 'continuous', 'rapid', 'blank', 'eraser', 'reset', 'barriers', 'transformed'];
  const selectedCase = cases.includes(params.get('case')) ? params.get('case') : 'all';
  const controls = { delayMs: Math.min(2000, Math.max(0, Number(params.get('delayms')) || 0)), workers: [] };
  const visibilityTransitions = [];
  const foreground = () => document.visibilityState === 'visible' && document.hasFocus();
  const recordVisibility = (event) => visibilityTransitions.push({
    time: Date.now(), performanceTime: performance.now(), event: event.type,
    visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
  });
  document.addEventListener('visibilitychange', recordVisibility);
  window.addEventListener('focus', recordVisibility);
  window.addEventListener('blur', recordVisibility);
  const NativeWorker = window.Worker;
  const mutations = new Set(['beginStroke', 'strokePoints', 'finishStroke']);

  // Delay outgoing mutation RPCs in FIFO order. This simulates a backed-up
  // persistence queue without making browser storage or production code fake.
  window.Worker = class LatencyWorker extends EventTarget {
    constructor(url, options) {
      super();
      this.worker = new NativeWorker(url, options);
      this.queue = [];
      this.requests = new Map();
      this.trace = [];
      this.peakPending = 0;
      this.stats = null;
      this.timer = null;
      this.closed = false;
      controls.workers.push(this);
      this.worker.onmessage = (event) => {
        if (this.requests.get(event.data?.id) === 'finishStroke' && !event.data.error && event.data.result?.rasterId) {
          const { rasterId, sourceBounds, sourceWidth, sourceHeight } = event.data.result;
          this.lastFinishedRaster = { rasterId, sourceBounds, sourceWidth, sourceHeight };
        }
        if (event.data?.id) this.requests.delete(event.data.id);
        if (event.data?.stats) this.stats = event.data.stats;
        const forwarded = new MessageEvent('message', { data: event.data });
        this.dispatchEvent(forwarded);
        this.onmessage?.(forwarded);
      };
      this.worker.onerror = (event) => {
        const forwarded = new ErrorEvent('error', { message: event.message, error: event.error });
        this.dispatchEvent(forwarded);
        this.onerror?.(forwarded);
      };
      this.worker.onmessageerror = (event) => {
        const forwarded = new MessageEvent('messageerror', { data: event.data });
        this.dispatchEvent(forwarded);
        this.onmessageerror?.(forwarded);
      };
    }

    postMessage(message, transfer) {
      if (this.closed) return;
      this.requests.set(message.id, message.method);
      this.trace.push({ time: performance.now(), method: message.method, format: message.args?.format });
      this.peakPending = Math.max(this.peakPending, this.requests.size);
      this.queue.push({ message, transfer, delay: mutations.has(message.method) ? controls.delayMs : 0 });
      this.drain();
    }

    drain() {
      if (this.timer !== null || this.closed) return;
      while (this.queue.length) {
        const next = this.queue.shift();
        if (next.delay) {
          this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.closed) this.worker.postMessage(next.message, next.transfer);
            this.drain();
          }, next.delay);
          return;
        }
        this.worker.postMessage(next.message, next.transfer);
      }
    }

    terminate() {
      this.closed = true;
      clearTimeout(this.timer);
      this.timer = null;
      this.queue.length = 0;
      this.requests.clear();
      this.worker.terminate();
    }
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const visible = (element) => element.getClientRects().length > 0;
  const button = (name) => [...document.querySelectorAll('button')].find((element) => visible(element) && (element.getAttribute('aria-label') === name || element.textContent.trim() === name));
  const editorRoot = () => document.querySelector('#root > [aria-busy]');
  const main = () => document.querySelector('[data-editor-display="true"]') || document.querySelector('#root canvas');
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
  const workerPending = () => controls.workers.reduce((sum, worker) => sum + worker.requests.size, 0);
  const observations = () => ({
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    nativeDevicePixelRatio, requestedDevicePixelRatio,
    devicePixelRatio: window.devicePixelRatio, dprOverrideApplied, dprOverrideError,
    pendingRpc: workerPending(),
    peakPendingRpc: Math.max(0, ...controls.workers.map((worker) => worker.peakPending)),
    saving: editorRoot()?.dataset.saving ?? null,
    pendingStrokes: editorRoot()?.dataset.pendingStrokes ?? null,
    workers: controls.workers.map((worker) => ({ closed: worker.closed, stats: worker.stats })),
  });
  const until = async (condition, message = 'Timed out waiting for the editor', timeout = 60000) => {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (condition()) return;
      await wait(20);
    }
    throw new Error(message);
  };
  const waitForForeground = async () => {
    if (foreground()) return;
    document.title = 'Waiting for foreground — drawing latency checks';
    await until(foreground, 'Bring the drawing test window to the foreground to continue', 600000);
  };
  const startGate = async () => {
    if (params.get('autostart') === '1') { await waitForForeground(); return; }
    document.title = `Ready: ${mode} drawing latency checks`;
    const start = document.createElement('button');
    start.id = 'latency-start'; start.textContent = 'Ready—click to run tests';
    start.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10000;padding:12px 20px;background:#fff;color:#111;border:2px solid #2563eb;border-radius:6px;font:16px system-ui;cursor:pointer;';
    document.body.append(start);
    await new Promise((resolve) => start.addEventListener('click', () => {
      if (!foreground()) { start.textContent = 'Bring this window forward, then click to run tests'; return; }
      start.remove(); resolve();
    }));
  };
  const settled = async () => {
    await until(() => editorRoot()?.getAttribute('aria-busy') !== 'true' && editorRoot()?.dataset.saving !== 'true' && Number(editorRoot()?.dataset.pendingStrokes || 0) === 0 && workerPending() === 0);
    await frame(); await frame();
  };
  const click = async (name, waitForWork = true) => {
    const target = button(name);
    assert(target && !target.disabled, 'Button unavailable: ' + name);
    target.click();
    await frame();
    if (waitForWork) await settled();
  };
  const dimensions = () => {
    const match = document.querySelector('#root').textContent.match(/(\d+)\s*x\s*(\d+)px/i);
    assert(match, 'Document dimensions unavailable');
    return { width: Number(match[1]), height: Number(match[2]) };
  };
  const geometry = (zoom = 100) => {
    const canvas = main();
    assert(canvas, 'Display canvas unavailable');
    const rect = canvas.getBoundingClientRect();
    const doc = dimensions();
    const scale = Math.min((rect.width - 32) / doc.width, (rect.height - 32) / doc.height) * zoom / 100;
    return { canvas, rect, scale, x: (rect.width - doc.width * scale) / 2, y: (rect.height - doc.height * scale) / 2 };
  };
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const setInput = (input, value) => {
    nativeValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const sliderTo = async (slider, value) => {
    assert(slider, 'Slider unavailable');
    for (let i = 0; i < 400; i += 1) {
      const current = Number(slider.getAttribute('aria-valuenow'));
      if (current === value) return;
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: current < value ? 'ArrowRight' : 'ArrowLeft', bubbles: true }));
      await frame();
    }
    throw new Error('Slider did not reach ' + value);
  };
  const importImage = async (width, height, color = 'white') => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    canvas.width = 1; canvas.height = 1;
    const data = new DataTransfer();
    data.items.add(new File([blob], 'latency-fixture.png', { type: 'image/png' }));
    const input = document.querySelector('input[type=file]');
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await frame(); await settled();
  };
  const fixture = async (large = mode === 'stress') => {
    if (main()) await click('Reset');
    await importImage(600, 480);
    if (large) await importImage(4000, 3000);
    await click('Brush');
    const color = document.querySelector('input[type=color]');
    if (color) setInput(color, '#ff2b2b');
    await frame();
    const size = [...document.querySelectorAll('[role=slider]')].find((slider) => visible(slider) && slider.getAttribute('aria-valuemax') === '80');
    await sliderTo(size, large ? 80 : 8);
    await settled();
  };

  const pointer = (view, type, point, id = 1) => {
    // Synthetic events do not establish a browser pointer capture target.
    view.canvas.setPointerCapture = () => {};
    view.canvas.releasePointerCapture = () => {};
    view.canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
      clientX: view.rect.left + view.x + point.x * view.scale,
      clientY: view.rect.top + view.y + point.y * view.scale,
    }));
  };
  const pixel = (view, point) => {
    const x = Math.floor((view.x + point.x * view.scale) * view.canvas.width / view.rect.width);
    const y = Math.floor((view.y + point.y * view.scale) * view.canvas.height / view.rect.height);
    const data = view.canvas.getContext('2d').getImageData(x, y, 1, 1).data;
    const result = [...data];
    // The editor may present a separate transparent preview over its display.
    for (const overlay of document.querySelectorAll('[data-editor-live-preview="true"]')) {
      if (!visible(overlay)) continue;
      const bounds = overlay.getBoundingClientRect();
      const ox = Math.floor((view.rect.left + view.x + point.x * view.scale - bounds.left) * overlay.width / bounds.width);
      const oy = Math.floor((view.rect.top + view.y + point.y * view.scale - bounds.top) * overlay.height / bounds.height);
      const top = overlay.getContext('2d').getImageData(ox, oy, 1, 1).data;
      const alpha = top[3] / 255;
      for (let channel = 0; channel < 3; channel += 1) result[channel] = Math.round(top[channel] * alpha + result[channel] * (1 - alpha));
      result[3] = Math.round((alpha + result[3] / 255 * (1 - alpha)) * 255);
    }
    return result;
  };
  const red = (value) => value[0] > 180 && value[0] - value[1] > 25 && value[0] - value[2] > 25;
  const near = (a, b, tolerance = 3) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
  const layerRow = (name) => [...document.querySelectorAll('input')].find((input) => input.value === name)?.parentElement.parentElement.parentElement;
  const captureDownload = async (action) => {
    const create = URL.createObjectURL.bind(URL), originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click, blobs = new Map();
    let result = null;
    URL.createObjectURL = (blob) => { const url = create(blob); blobs.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) result = blobs.get(this.href);
      else originalClick.call(this);
    };
    try {
      await action();
      await until(() => result, 'Download did not produce a Blob');
      await settled();
      return result;
    } finally {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
      for (const url of blobs.keys()) URL.revokeObjectURL(url);
      blobs.clear();
    }
  };
  const blobPixels = async (blob, points) => {
    const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    try {
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      return points.map((point) => [...ctx.getImageData(Math.floor(point.x), Math.floor(point.y), 1, 1).data]);
    } finally { bitmap.close(); canvas.width = 1; canvas.height = 1; }
  };

  const results = [];
  const report = async (complete = false) => {
    const result = {
      kind: `latency-${mode}-${selectedCase}${Number(params.get('delayms')) > 0 ? '-delayed' : ''}${dprSuffix}`, complete, mode, selectedCase,
      delayMs: Number(params.get('delayms')) || 0, time: Date.now(),
      userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
      nativeDevicePixelRatio, requestedDevicePixelRatio, dprOverrideApplied, dprOverrideError,
      passed: results.filter((test) => test.passed).length,
      invalid: results.filter((test) => test.invalid).length,
      failed: results.filter((test) => !test.passed && !test.invalid).length,
      total: results.length, results,
    };
    window.latencyResults = result;
    let status = document.getElementById('latency-results');
    if (!status) {
      status = document.createElement('pre'); status.id = 'latency-results';
      status.style.cssText = 'position:fixed;bottom:6px;left:6px;z-index:9999;max-width:460px;max-height:140px;overflow:auto;background:#fff;color:#111;padding:8px;border:1px solid #777;font:11px monospace;pointer-events:none;';
      document.body.append(status);
    }
    status.textContent = JSON.stringify({ mode, complete, passed: result.passed, invalid: result.invalid, failed: result.failed, total: result.total, tests: results.map(({ name, passed, invalid, invalidReason, error, summary }) => ({ name, passed, invalid, invalidReason, error, summary })) }, null, 2);
    document.title = complete ? `${result.passed}/${result.total}${result.invalid ? ` (${result.invalid} invalid)` : ''} ${mode} drawing latency checks` : `Running ${mode} drawing latency checks`;
    await fetch('/results', { method: 'POST', body: JSON.stringify(result) });
  };
  const check = async (key, name, run) => {
    if (selectedCase !== 'all' && selectedCase !== key) return;
    await waitForForeground();
    document.title = `Running ${mode} drawing latency checks`;
    const visibilityStart = visibilityTransitions.length;
    const result = { name, key, passed: false, startedAt: Date.now() };
    try { Object.assign(result, await run()); result.passed = true; }
    catch (error) { result.error = error.stack; if (error.detail) Object.assign(result, error.detail); }
    result.visibilityTransitions = visibilityTransitions.slice(visibilityStart);
    const lostForeground = result.visibilityTransitions.some((event) => event.visibilityState !== 'visible' || !event.hasFocus) || !foreground();
    const lateDispatch = result.summary?.maxDispatchLateness > 1000;
    const invalidDpr = requestedDevicePixelRatio !== null && (!dprOverrideApplied || window.devicePixelRatio !== requestedDevicePixelRatio);
    if (lostForeground || lateDispatch || invalidDpr) {
      result.passed = false; result.invalid = true;
      result.invalidReason = invalidDpr
        ? 'The requested test-only devicePixelRatio override was unavailable: ' + dprOverrideError
        : lostForeground
          ? 'The page became hidden or lost focus during this case; background scheduling invalidates its timing.'
          : 'Input dispatch fell over 1000 ms behind schedule; rerun in a foreground native window before judging drawing latency.';
    }
    result.completedAt = Date.now(); results.push(result); await report();
  };
  const assertWithDetail = (condition, message, detail) => {
    if (!condition) throw Object.assign(new Error(message), { detail });
  };

  const continuous = async () => {
    await fixture();
    const view = geometry();
    const count = 600, duration = 5000, spacing = duration / count;
    const samples = [], frameTimes = [], observerFrames = [];
    const futureProbes = new Map();
    // Keep GPU copies together and read only this private, sparse staging row.
    // Reading the full display context per event serializes the GPU pipeline
    // and makes the measurement itself block the input stream.
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = count + 8; probeCanvas.height = 1;
    const probeContext = probeCanvas.getContext('2d', { willReadFrequently: false });
    probeContext.imageSmoothingEnabled = false;
    let active = true, next = 0, timer, animationFrame, observerError;
    const started = performance.now();
    const startedAt = Date.now();
    const pointAt = (index) => {
      const row = Math.floor(index / 50), column = index % 50;
      return { x: 50 + (row % 2 ? 49 - column : column) * 500 / 49, y: 30 + row * 33 };
    };
    const probeAt = (point) => mode === 'stress' ? { x: point.x, y: point.y + 39.2 } : point;
    const scan = () => {
      if (!active) return;
      const scanStarted = performance.now(); frameTimes.push(scanStarted - started);
      try {
        const probes = samples.filter((sample) => sample.visibleAt === null && !sample.prepainted).map((sample) => ({ point: sample.probe, sample }));
        // Prepaint status comes from the preceding frame, never a synchronous
        // display read in the input timer. Normal centers and stress lower-edge
        // probes are geometrically distinct from preceding sample footprints.
        for (let index = next; index < Math.min(count, next + 8); index += 1) probes.push({ point: probeAt(pointAt(index)), futureIndex: index });
        if (probes.length) {
          probeContext.clearRect(0, 0, probeCanvas.width, 1);
          const surfaces = [{ canvas: view.canvas, bounds: view.rect }, ...[...document.querySelectorAll('[data-editor-live-preview="true"]')].filter(visible).map((canvas) => ({ canvas, bounds: canvas.getBoundingClientRect() }))];
          for (const { canvas, bounds } of surfaces) {
            probes.forEach(({ point }, index) => {
              const clientX = view.rect.left + view.x + point.x * view.scale;
              const clientY = view.rect.top + view.y + point.y * view.scale;
              const x = Math.floor((clientX - bounds.left) * canvas.width / bounds.width);
              const y = Math.floor((clientY - bounds.top) * canvas.height / bounds.height);
              probeContext.drawImage(canvas, x, y, 1, 1, index, 0, 1, 1);
            });
          }
          const copiedAt = performance.now();
          const values = probeContext.getImageData(0, 0, probes.length, 1).data;
          const observedAt = performance.now();
          probes.forEach(({ sample, futureIndex }, index) => {
            const painted = red(values.subarray(index * 4, index * 4 + 4));
            if (sample && painted) sample.visibleAt = observedAt - started;
            if (futureIndex !== undefined) futureProbes.set(futureIndex, { painted, at: observedAt - started });
          });
          observerFrames.push({
            at: scanStarted - started, probes: probes.length,
            copyMs: copiedAt - scanStarted, readbackMs: observedAt - copiedAt,
            totalMs: performance.now() - scanStarted,
          });
        }
      } catch (error) {
        observerError = error; active = false;
      }
      if (active) animationFrame = requestAnimationFrame(scan);
    };
    animationFrame = requestAnimationFrame(scan);
    try {
      await new Promise((resolve, reject) => {
        const send = () => {
          try {
            const point = pointAt(next), priorProbe = futureProbes.get(next);
            const sample = {
              index: next, intendedAt: next * spacing, sentAt: performance.now() - started,
              point, probe: probeAt(point), prepainted: priorProbe?.painted || false,
              prepaintObservedAt: priorProbe?.at ?? null, visibleAt: null,
            };
            futureProbes.delete(next); samples.push(sample);
            pointer(view, next === 0 ? 'pointerdown' : 'pointermove', point);
            next += 1;
            if (next === count) { resolve(); return; }
            timer = setTimeout(send, Math.max(0, started + next * spacing - performance.now()));
          } catch (error) { reject(error); }
        };
        send();
      });
      clearTimeout(timer);
      const visibleBeforeRelease = samples.filter((sample) => sample.visibleAt !== null).length;
      pointer(view, 'pointerup', pointAt(count - 1));
      const releasedAt = performance.now();
      await settled();
      const settledAt = performance.now();
      await wait(120);
      active = false;
      const measured = samples.filter((sample) => !sample.prepainted && sample.visibleAt !== null);
      const missing = samples.filter((sample) => !sample.prepainted && sample.visibleAt === null);
      const latencies = measured.map((sample) => sample.visibleAt - sample.sentAt);
      const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]);
      const p95 = percentile(latencies, 0.95), maximum = Math.max(0, ...latencies);
      const summary = {
        samples: count, measured: measured.length, prepainted: samples.filter((sample) => sample.prepainted).length,
        missing: missing.length, visibleBeforeRelease, inputToVisibleP50: percentile(latencies, 0.5),
        inputToVisibleP95: p95, inputToVisibleMax: maximum,
        longestFrameGap: Math.max(0, ...intervals), pointerupToSettled: settledAt - releasedAt,
        intendedInputDuration: duration, actualInputDuration: samples[samples.length - 1].sentAt,
        maxDispatchLateness: Math.max(...samples.map((sample) => sample.sentAt - sample.intendedAt)),
        observerReadbacks: observerFrames.length,
        observerTotalCpuMs: observerFrames.reduce((sum, entry) => sum + entry.totalMs, 0),
        observerP95CpuMs: percentile(observerFrames.map((entry) => entry.totalMs), 0.95),
        observerMaxCpuMs: Math.max(0, ...observerFrames.map((entry) => entry.totalMs)),
        observerMaxProbes: Math.max(0, ...observerFrames.map((entry) => entry.probes)),
        ...observations(),
      };
      const detail = { summary, startedAt, samples, frameTimes, observerFrames };
      assertWithDetail(!observerError, 'Pixel observer failed: ' + observerError?.message, detail);
      assertWithDetail(measured.length >= (mode === 'stress' ? 60 : 550), 'Too few distinct painted samples to establish responsiveness', detail);
      assertWithDetail(missing.length === 0, 'Input samples never appeared on the display', detail);
      assertWithDetail(visibleBeforeRelease >= measured.length * 0.8, 'Drawing was deferred until pointerup', detail);
      assertWithDetail(p95 <= (mode === 'stress' ? 100 : 50), 'Input-to-visible p95 exceeded the drawing budget', detail);
      assertWithDetail(maximum < (mode === 'stress' ? 250 : 100), 'A displayed input exceeded the maximum drawing delay', detail);
      assertWithDetail(summary.longestFrameGap < 250, 'Animation frames stalled for at least 250 ms', detail);
      for (const worker of controls.workers) {
        const stats = worker.stats;
        if (stats?.tileMemoryLimit) assertWithDetail(stats.peakResidentTileBytes <= stats.tileMemoryLimit, 'Resident tile memory exceeded its budget', detail);
        if (stats?.dirtyLimit) assertWithDetail(stats.peakDirtyBytes <= stats.dirtyLimit, 'Unpersisted tile memory exceeded its budget', detail);
      }
      return detail;
    } finally {
      active = false; clearTimeout(timer); cancelAnimationFrame(animationFrame);
      probeCanvas.width = 1; probeCanvas.height = 1;
    }
  };

  const rapid = async () => {
    await fixture(false);
    const view = geometry(), points = [], before = pixel(view, { x: 100, y: 80 });
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      const point = { x: 90 + (i % 5) * 100, y: 70 + Math.floor(i / 5) * 90 };
      points.push(point);
      pointer(view, 'pointerdown', point, i + 10);
      await wait(20);
      pointer(view, 'pointermove', { x: point.x + 8, y: point.y + 4 }, i + 10);
      await wait(20);
      pointer(view, 'pointerup', { x: point.x + 8, y: point.y + 4 }, i + 10);
      await wait(40);
    }
    const submittedIn = performance.now() - started;
    await settled();
    const missing = points.flatMap((point, index) => red(pixel(view, point)) ? [] : [index]);
    assertWithDetail(missing.length === 0, 'Rapid strokes were dropped: ' + missing.join(', '), { summary: { submittedIn, missing, ...observations() } });
    for (let i = 19; i >= 0; i -= 1) {
      await click('Undo');
      assert(near(pixel(view, points[i]), before), `Undo did not remove stroke ${i + 1} independently`);
      if (i > 0) assert(red(pixel(view, points[i - 1])), `Undo removed more than one rapid stroke at ${i + 1}`);
    }
    return { summary: { strokes: 20, independentUndoSteps: 20, submittedIn, ...observations() } };
  };

  const blankEndpoint = async () => {
    await fixture(false); await click('Add Blank Layer'); await click('Brush');
    const view = geometry(), from = { x: 100, y: 100 }, to = { x: 400, y: 300 };
    const previousDelay = controls.delayMs; controls.delayMs = Math.max(250, previousDelay);
    try {
      pointer(view, 'pointerdown', from, 40);
      await wait(40);
      const releasedAt = performance.now();
      pointer(view, 'pointerup', to, 40);
      await until(() => red(pixel(view, to)), 'Pointerup endpoint was omitted from the blank layer', 3000);
      const latency = performance.now() - releasedAt;
      await settled();
      assertWithDetail(red(pixel(view, from)) && red(pixel(view, to)), 'Persisted blank-layer stroke lost its new bounds or endpoint', { summary: { pointerupEndpointLatency: latency } });
      assertWithDetail(latency <= 100, 'Pointerup endpoint waited for persistence', { summary: { pointerupEndpointLatency: latency } });
      await click('Undo');
      assert(!red(pixel(view, to)), 'Undo failed for a newly painted blank layer');
      await click('Redo');
      assert(red(pixel(view, to)), 'Redo clipped newly painted blank-layer bounds');

      await click('Add Blank Layer'); await click('Brush');
      const canceledView = geometry();
      const acceptedFrom = { x: 460, y: 100 }, acceptedTo = { x: 500, y: 100 };
      const misleadingSegment = { x: 250, y: 50 };
      const beforeCancelPath = pixel(canceledView, misleadingSegment);
      assert(!red(beforeCancelPath), 'Cancellation fixture overlaps previous paint');
      pointer(canceledView, 'pointerdown', acceptedFrom, 41);
      pointer(canceledView, 'pointermove', acceptedTo, 41);
      await frame();
      // Browsers may cancel with default coordinates. Those coordinates are
      // not another accepted drawing sample and must not extend the stroke.
      canceledView.canvas.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: 41, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: 0, bubbles: true, cancelable: true,
      }));
      await frame();
      const cancelPreview = {
        acceptedStart: pixel(canceledView, acceptedFrom),
        acceptedEnd: pixel(canceledView, acceptedTo),
        misleadingSegment: pixel(canceledView, misleadingSegment),
      };
      assertWithDetail(red(cancelPreview.acceptedStart) && red(cancelPreview.acceptedEnd) && near(cancelPreview.misleadingSegment, beforeCancelPath), 'Pointer cancellation changed the accepted live prefix or painted toward default coordinates', { summary: { cancelPreview } });
      await settled();
      const cancelCommitted = {
        acceptedStart: pixel(canceledView, acceptedFrom),
        acceptedEnd: pixel(canceledView, acceptedTo),
        misleadingSegment: pixel(canceledView, misleadingSegment),
      };
      const finishedRaster = controls.workers.filter((worker) => !worker.closed).map((worker) => worker.lastFinishedRaster).find(Boolean);
      const bounds = finishedRaster?.sourceBounds;
      assertWithDetail(red(cancelCommitted.acceptedStart) && red(cancelCommitted.acceptedEnd) && near(cancelCommitted.misleadingSegment, beforeCancelPath), 'Persisted cancellation stroke differs from its accepted prefix', { summary: { cancelPreview, cancelCommitted, finishedRaster } });
      assertWithDetail(bounds && bounds.x >= 450 && bounds.y >= 90 && bounds.y + bounds.height <= 110 && bounds.x + bounds.width >= 500, 'Canceled stroke source bounds include unaccepted default coordinates or omit the accepted endpoint', { summary: { finishedRaster } });
      await click('Undo');
      assert(!red(pixel(canceledView, acceptedTo)) && near(pixel(canceledView, misleadingSegment), beforeCancelPath), 'Undo did not remove only the canceled stroke prefix');
      await click('Redo');
      assert(red(pixel(canceledView, acceptedTo)) && near(pixel(canceledView, misleadingSegment), beforeCancelPath), 'Redo introduced unaccepted cancellation coordinates');
      return { summary: { pointerupEndpointLatency: latency, cancelPreview, cancelCommitted, finishedRaster, artificialMutationDelay: controls.delayMs, ...observations() } };
    } finally { controls.delayMs = previousDelay; }
  };

  const eraserMiddle = async () => {
    if (main()) await click('Reset');
    await importImage(600, 480, '#008000');
    await importImage(600, 480, '#0000ff');
    await importImage(600, 480, '#ff0000');
    const row = (name) => [...document.querySelectorAll('input')].find((input) => input.value === name)?.parentElement.parentElement.parentElement;
    const middle = row('Image 2'), top = row('Image 3');
    assert(middle && top, 'Layer controls unavailable');
    await sliderTo(top.querySelector('[role=slider]'), 25);
    await sliderTo(middle.querySelector('[role=slider]'), 45);
    middle.click(); await frame(); await settled();
    await click('Eraser');
    const size = [...document.querySelectorAll('[role=slider]')].find((slider) => visible(slider) && slider.getAttribute('aria-valuemax') === '80');
    await sliderTo(size, 20); await settled();
    const view = geometry(), point = { x: 300, y: 240 }, before = pixel(view, point);
    const previousDelay = controls.delayMs; controls.delayMs = Math.max(250, previousDelay);
    try {
      pointer(view, 'pointerdown', point, 50);
      const started = performance.now();
      await until(() => pixel(view, point)[2] < before[2] - 30, 'Live eraser did not reveal the lower layer', 3000);
      const latency = performance.now() - started, live = pixel(view, point);
      assertWithDetail(Math.abs(live[0] - before[0]) <= 3 && live[1] > before[1] + 20 && live[3] === 255, 'Live eraser affected another layer or applied opacity incorrectly', { summary: { before, live, latency } });
      pointer(view, 'pointerup', point, 50);
      await settled();
      const committed = pixel(view, point);
      assertWithDetail(near(live, committed), 'Eraser preview changed after persistence', { summary: { before, live, committed, latency } });
      assertWithDetail(latency <= 100, 'Eraser preview waited for persistence', { summary: { latency } });
      return { summary: { before, live, committed, latency, ...observations() } };
    } finally { controls.delayMs = previousDelay; }
  };

  const pendingReset = async () => {
    await fixture(false);
    const view = geometry(), previousDelay = controls.delayMs;
    controls.delayMs = Math.max(250, previousDelay);
    try {
      pointer(view, 'pointerdown', { x: 100, y: 100 }, 60);
      pointer(view, 'pointermove', { x: 400, y: 300 }, 60);
      pointer(view, 'pointerup', { x: 400, y: 300 }, 60);
      const pendingAtReset = observations();
      const reset = button('Reset'); assert(reset && !reset.disabled, 'Reset unavailable during pending drawing');
      reset.click();
      await wait(controls.delayMs * 4 + 200); await settled();
      assert(!main() && button('Undo')?.disabled, 'Reset allowed pending paint to restore the document');
      return { summary: { pendingAtReset, afterReset: observations() } };
    } finally { controls.delayMs = previousDelay; }
  };

  const pendingBarriers = async () => {
    await fixture(false); await importImage(600, 480); await click('Brush');
    const view = geometry(), previousDelay = controls.delayMs;
    controls.delayMs = Math.max(250, previousDelay);
    const checkpoints = [], pendingBeforeActions = [];
    const shortStroke = async (point, id) => {
      pointer(view, 'pointerdown', point, id);
      pointer(view, 'pointermove', { x: point.x + 20, y: point.y }, id);
      pointer(view, 'pointerup', { x: point.x + 40, y: point.y }, id);
      // Real clicks arrive in a later input event. Give React one frame to
      // replace any export/tool controls, then look up the current button.
      // The artificial delay keeps persistence pending across that frame.
      await frame();
      const pending = {
        stroke: id, saving: editorRoot()?.dataset.saving,
        pendingStrokes: Number(editorRoot()?.dataset.pendingStrokes || 0),
        mutationRpc: controls.workers.reduce((sum, worker) => sum + [...worker.requests.values()].filter((method) => mutations.has(method)).length, 0),
      };
      pendingBeforeActions.push(pending);
      assert(pending.saving === 'true' || pending.pendingStrokes > 0 || pending.mutationRpc > 0, 'Stroke finished before the pending-action check could start');
      return { x: point.x + 40, y: point.y };
    };
    try {
      const first = await shortStroke({ x: 80, y: 80 }, 70);
      const sizeStart = performance.now(), sizeButton = button('Calculate sizes');
      assert(sizeButton && !sizeButton.disabled, 'Calculate sizes unavailable while a released stroke is pending');
      sizeButton.click();
      await settled();
      await until(() => !button('Calculate sizes')?.disabled, 'Size calculation did not finish');
      const text = document.querySelector('#root').textContent;
      const formats = controls.workers.flatMap((worker) => worker.trace).filter((event) => event.time >= sizeStart && event.method === 'exportBlob').map((event) => event.format);
      assertWithDetail(/PNG:\s*[0-9.]+\s*MB/.test(text) && /JPG:\s*[0-9.]+\s*MB/.test(text), 'A pending stroke prevented PNG or JPEG size from publishing', { summary: { formats, checkpoints } });
      assertWithDetail(formats.includes('image/png') && formats.includes('image/jpeg'), 'Calculate sizes did not encode both formats after flushing the stroke', { summary: { formats, checkpoints } });
      assert(red(pixel(view, first)), 'Calculate sizes discarded the pending stroke endpoint');
      checkpoints.push('Calculate sizes flushes once and publishes PNG and JPEG');

      const second = await shortStroke({ x: 80, y: 140 }, 71);
      const blob = await captureDownload(() => {
        const download = button('Download PNG');
        assert(download && !download.disabled, 'Download unavailable during pending stroke');
        download.click();
      });
      const exported = await blobPixels(blob, [first, second]);
      assert(exported.every(red), 'PNG export omitted a pending stroke endpoint');
      checkpoints.push('PNG Blob contains previous and just-released stroke endpoints');

      const undone = await shortStroke({ x: 80, y: 200 }, 72);
      button('Undo').click(); await frame(); await settled();
      assert(!red(pixel(view, undone)) && red(pixel(view, second)), 'Undo during persistence did not remove exactly the newly released stroke');
      await click('Redo');
      assert(red(pixel(view, undone)), 'Redo did not restore the stroke undone while pending');
      await click('Undo');
      const branch = await shortStroke({ x: 250, y: 200 }, 73);
      // Redo is enabled before the new pending edit commits. Flushing that edit
      // must invalidate the old redo branch before applying the redo action.
      const redo = button('Redo'); assert(redo && !redo.disabled, 'Redo branch unavailable for the pending-redo check');
      redo.click(); await frame(); await settled();
      assert(red(pixel(view, branch)) && !red(pixel(view, undone)), 'Redo during pending drawing restored a stale branch or lost the new stroke');
      checkpoints.push('Pending Undo/Redo preserve individual strokes and invalidate stale redo');

      const selected = await shortStroke({ x: 80, y: 280 }, 74);
      const background = layerRow('Background'); assert(background, 'Background layer controls unavailable');
      background.click(); await frame(); await settled();
      assert(document.querySelector('[aria-label="Select Background for move"]')?.checked, 'Pending layer change did not select the requested layer');
      assert(red(pixel(view, selected)), 'Changing layers lost pending pixels on the previous active layer');
      layerRow('Image 2').click(); await frame(); await settled();
      checkpoints.push('Layer selection waits for pending pixels without changing their layer');

      const zoomed = await shortStroke({ x: 250, y: 320 }, 75);
      button('Zoom in').click(); await frame(); await settled();
      const zoomView = geometry(125);
      assert(red(pixel(zoomView, zoomed)), 'A pending view zoom lost or displaced the stroke');
      await click('Reset zoom to 100%');
      assert(red(pixel(geometry(), zoomed)), 'Resetting the view did not restore the same document pixels');
      checkpoints.push('View zoom waits for pending drawing and preserves document coordinates');
      return { summary: { checkpoints, pendingBeforeActions, artificialMutationDelay: controls.delayMs, exportedBytes: blob.size, ...observations() } };
    } catch (error) {
      if (!error.detail) error.detail = { summary: { checkpoints, pendingBeforeActions, ...observations() } };
      else error.detail.summary.pendingBeforeActions = pendingBeforeActions;
      throw error;
    } finally { controls.delayMs = previousDelay; }
  };

  const transformedClipping = async () => {
    await fixture(false); await importImage(300, 200, '#0000ff'); await click('Move');
    const scale = [...document.querySelectorAll('[role=slider]')].find((slider) => visible(slider) && slider.getAttribute('aria-valuemax') === '300');
    await sliderTo(scale, 50); await click('Apply');
    const view = geometry(), center = { x: 300, y: 240 };
    // The centered source is now 150×100. Start outside the top-left corner,
    // beyond the resize handle tolerance but inside the rotation hit region.
    const tolerance = Math.max(6, 10 / view.scale);
    const from = { x: center.x - 75 - tolerance * 1.5, y: center.y - 50 - tolerance * 1.5 };
    const radians = Math.PI / 6, dx = from.x - center.x, dy = from.y - center.y;
    const to = { x: center.x + dx * Math.cos(radians) - dy * Math.sin(radians), y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians) };
    pointer(view, 'pointerdown', from, 80); pointer(view, 'pointermove', to, 80);
    await frame(); pointer(view, 'pointerup', to, 80); await frame(); await settled();
    await click('Brush');
    const size = [...document.querySelectorAll('[role=slider]')].find((slider) => visible(slider) && slider.getAttribute('aria-valuemax') === '80');
    await sliderTo(size, 20); await settled();
    const probes = [{ x: 330, y: 240 }, { x: 360, y: 240 }, { x: 378, y: 240 }, { x: 402, y: 240 }, { x: 420, y: 240 }];
    const before = probes.map((point) => pixel(view, point));
    assert(before[2][2] > 200 && before[2][0] < 40, 'Rotation setup did not produce the expected transformed source boundary');
    const previousDelay = controls.delayMs; controls.delayMs = Math.max(250, previousDelay);
    try {
      pointer(view, 'pointerdown', { x: 280, y: 240 }, 81);
      pointer(view, 'pointermove', { x: 420, y: 240 }, 81);
      await until(() => red(pixel(view, probes[0])), 'Transformed stroke did not appear before persistence', 3000);
      const live = probes.map((point) => pixel(view, point));
      assertWithDetail(live.slice(0, 3).every(red) && near(live[3], before[3]) && near(live[4], before[4]), 'Live brush escaped the transformed native source rectangle', { summary: { before, live } });
      pointer(view, 'pointerup', { x: 420, y: 240 }, 81); await settled();
      const committed = probes.map((point) => pixel(view, point));
      assertWithDetail(committed.every((value, index) => near(value, live[index], 5)), 'Scaled/rotated preview changed after persistence', { summary: { before, live, committed } });
      const blob = await captureDownload(() => button('Download PNG').click());
      const exported = await blobPixels(blob, probes);
      assertWithDetail(exported.slice(0, 3).every(red) && near(exported[3], [255, 255, 255, 255]) && near(exported[4], [255, 255, 255, 255]), 'Export clipped a valid transformed stroke or painted outside the source', { summary: { before, live, committed, exported } });
      await click('Undo');
      assert(before.every((value, index) => near(pixel(view, probes[index]), value, 5)), 'Transformed stroke undo failed to restore the source');
      await click('Redo');
      assert(committed.every((value, index) => near(pixel(view, probes[index]), value, 5)), 'Transformed stroke redo changed saved pixels');
      return { summary: { before, live, committed, exported, rotationDegrees: 30, scalePercent: 50, ...observations() } };
    } finally { controls.delayMs = previousDelay; }
  };

  const run = async () => {
    try {
      await until(() => button('Import'));
      await startGate();
      await check('continuous', 'Continuous input paints during a five-second 120 Hz stream', continuous);
      await check('rapid', 'Twenty rapid strokes are retained as independent undo steps', rapid);
      await check('blank', 'Blank-layer endpoints, canceled prefixes and bounds survive delayed persistence', blankEndpoint);
      await check('eraser', 'Live eraser preserves middle-layer opacity and layers above and below', eraserMiddle);
      await check('reset', 'Reset cancels pending stroke persistence and previews', pendingReset);
      await check('barriers', 'Pending drawing survives sizes, export, Undo/Redo, layer selection and view changes', pendingBarriers);
      await check('transformed', 'Scaled and rotated live strokes obey native source clipping and saved pixels', transformedClipping);
      assert(results.length > 0, 'Unknown latency case: ' + selectedCase);
    } catch (error) { results.push({ name: 'Harness', passed: false, error: error.stack }); }
    await report(true);
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();
