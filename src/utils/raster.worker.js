/* eslint-env worker */
/* eslint-disable no-restricted-globals -- This module runs exclusively in a Worker. */
import { RasterEngine } from './rasterEngine';
import { createRasterStorage } from './rasterStorage';

let engine;
let queue = Promise.resolve();
let disposed = false;

self.onmessage = ({ data: { id, method, args } }) => {
  if (method === 'dispose') {
    disposed = true;
    if (engine) engine.canceled = true;
  }
  queue = queue.then(async () => {
    try {
      if (method === 'init') {
        engine = new RasterEngine(await createRasterStorage(args.sessionId), (event) => self.postMessage({ event }));
      } else {
        if (disposed && method !== 'dispose') throw Object.assign(new Error('Editor was reset.'), { name: 'AbortError' });
        if (!engine || typeof engine[method] !== 'function') throw new Error('Image worker is unavailable.');
      }
      const result = method === 'init' ? engine.stats() : await engine[method](args);
      self.postMessage({ id, result, stats: engine.stats() }, result?.bitmap ? [result.bitmap] : []);
    } catch (error) {
      self.postMessage({ id, error: { name: error.name, message: error.message }, stats: engine?.stats() });
    }
  });
};
