import { createLayerId } from './editorLayers';

const closeBitmaps = (result) => {
  result?.bitmap?.close();
  result?.bitmaps?.forEach((bitmap) => bitmap.close());
};

export const createRasterClient = (onEvent = () => {}) => {
  let worker;
  let ready;
  let disposed = false;
  let nextId = 0;
  let latestStats = null;
  let fatalError = null;
  const pending = new Map();
  const post = (method, args = {}, transfer = []) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    try { worker.postMessage({ id, method, args }, transfer); }
    catch (error) { pending.delete(id); reject(error); }
  });
  const initialize = () => {
    if (ready) return ready;
    worker = new Worker(new URL('./raster.worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
      if (data.event) { if (!disposed) onEvent(data.event); return; }
      if (data.stats) latestStats = data.stats;
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (!request) { closeBitmaps(data.result); return; }
      if (disposed && request.method !== 'init' && request.method !== 'dispose') {
        closeBitmaps(data.result);
        request.reject(Object.assign(new Error('Editor was reset.'), { name: 'AbortError' }));
        return;
      }
      if (data.error) request.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
      else request.resolve(data.result);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The image worker stopped. Reset the editor to continue.');
      fatalError = error;
      pending.forEach((request) => request.reject(error)); pending.clear();
      worker.terminate();
      onEvent({ type: 'error', message: error.message });
    };
    ready = post('init', { sessionId: createLayerId() }).then((stats) => {
      if (!disposed && stats.backend === 'memory') onEvent({ type: 'memoryFallback' });
      return stats;
    });
    return ready;
  };
  return {
    async call(method, args, transfer) {
      if (disposed) throw Object.assign(new Error('Editor was reset.'), { name: 'AbortError' });
      if (fatalError) throw fatalError;
      await initialize();
      if (disposed) throw Object.assign(new Error('Editor was reset.'), { name: 'AbortError' });
      if (fatalError) throw fatalError;
      return post(method, args, transfer);
    },
    stats: () => latestStats,
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (!worker) return;
      try { if (!fatalError) { await ready; await post('dispose'); } }
      finally {
        worker.terminate();
        pending.forEach((request) => request.reject(Object.assign(new Error('Editor was reset.'), { name: 'AbortError' })));
        pending.clear();
      }
    },
  };
};
