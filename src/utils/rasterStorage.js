export const TILE_SIZE = 512;
export const RASTER_MEMORY_LIMIT = 96 * 1024 * 1024;
export const RASTER_SCRATCH_RESERVE = 16 * 1024 * 1024;
export const RASTER_DIRTY_LIMIT = 32 * 1024 * 1024;
export const DISK_LIMIT = 2 * 1024 * 1024 * 1024;
export const MEMORY_STORAGE_LIMIT = 256 * 1024 * 1024;
const STORAGE_NAME = 'clipboard-photo-rasters-v1';

export const storageFull = () => Object.assign(
  new Error('Temporary image storage is full. Remove a layer or export and reset the editor.'),
  { name: 'QuotaExceededError' }
);

export class RasterCache {
  constructor(limit = RASTER_MEMORY_LIMIT - RASTER_SCRATCH_RESERVE) {
    this.limit = limit;
    this.bytes = 0;
    this.peakBytes = 0;
    this.entries = new Map();
  }

  get(id) {
    const value = this.entries.get(id);
    if (value) {
      this.entries.delete(id);
      this.entries.set(id, value);
    }
    return value;
  }

  set(id, data) {
    this.delete(id);
    if (data.byteLength > this.limit) return;
    while (this.bytes + data.byteLength > this.limit) {
      this.delete(this.entries.keys().next().value);
    }
    this.entries.set(id, data);
    this.bytes += data.byteLength;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
  }

  setLimit(limit) {
    this.limit = Math.max(0, limit);
    while (this.bytes > this.limit) this.delete(this.entries.keys().next().value);
  }

  delete(id) {
    const value = this.entries.get(id);
    if (value) this.bytes -= value.byteLength;
    this.entries.delete(id);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

export class MemoryRasterStorage {
  constructor(limit = MEMORY_STORAGE_LIMIT) {
    this.kind = 'memory';
    this.limit = limit;
    this.bytes = 0;
    this.files = new Map();
  }

  async write(id, data) {
    if (this.bytes + data.byteLength > this.limit) throw storageFull();
    this.files.set(id, data);
    this.bytes += data.byteLength;
  }

  async read(id) {
    const data = this.files.get(id);
    if (!data) throw new Error('Temporary image data is missing. Please import the image again.');
    return data;
  }

  async remove(id) {
    this.bytes -= this.files.get(id)?.byteLength || 0;
    this.files.delete(id);
  }

  async dispose() {
    this.files.clear();
    this.bytes = 0;
  }
}

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error('Image storage transaction was aborted.'));
  transaction.onerror = () => reject(transaction.error);
});

// A lock is held for the lifetime of a session, including while its tab is hidden.
// Without Web Locks, leave other sessions alone rather than guessing from timestamps.
const acquireSessionLock = async (id) => {
  if (typeof navigator === 'undefined' || !navigator.locks) return () => {};
  let release;
  let acquired;
  const ready = new Promise((resolve) => { acquired = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const lockRequest = navigator.locks.request(`${STORAGE_NAME}:${id}`, async () => {
    acquired();
    await held;
  });
  await Promise.race([ready, lockRequest]);
  return async () => { release(); await lockRequest; };
};

const ifAbandoned = async (id, cleanup) => {
  if (typeof navigator === 'undefined' || !navigator.locks) return;
  await navigator.locks.request(`${STORAGE_NAME}:${id}`, { ifAvailable: true }, async (lock) => {
    if (lock) await cleanup();
  });
};

const createOpfsStorage = async (sessionId) => {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(STORAGE_NAME, { create: true });
  const release = await acquireSessionLock(sessionId);
  let session;
  try {
    session = await directory.getDirectoryHandle(sessionId, { create: true });
    const probe = await session.getFileHandle('probe', { create: true });
    const access = await probe.createSyncAccessHandle();
    try {
      if (access.write(new Uint8Array([1])) !== 1) throw new Error('Storage probe failed.');
      access.flush();
    } finally { access.close(); }
    await session.removeEntry('probe');
    for await (const [id, handle] of directory.entries()) {
      if (id !== sessionId && handle.kind === 'directory') {
        await ifAbandoned(id, () => directory.removeEntry(id, { recursive: true })).catch(() => {});
      }
    }
  } catch (error) {
    await directory.removeEntry(sessionId, { recursive: true }).catch(() => {});
    await release();
    throw error;
  }
  return {
    kind: 'opfs',
    limit: DISK_LIMIT,
    async write(id, data) {
      let access;
      try {
        const file = await session.getFileHandle(id, { create: true });
        access = await file.createSyncAccessHandle();
        let offset = 0;
        while (offset < data.byteLength) {
          const written = access.write(data.subarray(offset), { at: offset });
          if (written <= 0) throw storageFull();
          offset += written;
        }
        access.truncate(data.byteLength);
        access.flush();
      } catch (error) {
        access?.close();
        await session.removeEntry(id).catch(() => {});
        throw error;
      }
      access.close();
    },
    async read(id) {
      const file = await session.getFileHandle(id);
      return new Uint8ClampedArray(await (await file.getFile()).arrayBuffer());
    },
    async remove(id) { await session.removeEntry(id).catch((error) => { if (error.name !== 'NotFoundError') throw error; }); },
    async dispose() {
      try { await directory.removeEntry(sessionId, { recursive: true }); }
      finally { await release(); }
    },
  };
};

const createIndexedDbStorage = async (sessionId) => {
  const release = await acquireSessionLock(sessionId);
  let database;
  try {
    const request = indexedDB.open(STORAGE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('tiles');
      request.result.createObjectStore('sessions');
    };
    database = await requestResult(request);
    const transaction = database.transaction('sessions', 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('sessions').put(true, sessionId);
    await done;
  } catch (error) {
    database?.close();
    await release();
    throw error;
  }
  const removeSession = async (id) => {
    const transaction = database.transaction(['tiles', 'sessions'], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('tiles').delete(IDBKeyRange.bound(`${id}/`, `${id}/\uffff`));
    transaction.objectStore('sessions').delete(id);
    await done;
  };
  try {
    const ids = await requestResult(database.transaction('sessions').objectStore('sessions').getAllKeys());
    for (const id of ids) {
      if (id !== sessionId) await ifAbandoned(id, () => removeSession(id));
    }
  } catch (error) { /* Stale-session cleanup can be retried on the next visit. */ }
  return {
    kind: 'indexeddb',
    limit: DISK_LIMIT,
    async write(id, data) {
      const transaction = database.transaction('tiles', 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore('tiles').put(data, `${sessionId}/${id}`);
      await done;
    },
    async read(id) {
      const data = await requestResult(database.transaction('tiles').objectStore('tiles').get(`${sessionId}/${id}`));
      if (!data) throw new Error('Temporary image data is missing. Please import the image again.');
      return data;
    },
    async remove(id) {
      const transaction = database.transaction('tiles', 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore('tiles').delete(`${sessionId}/${id}`);
      await done;
    },
    async dispose() {
      try { await removeSession(sessionId); }
      finally { database.close(); await release(); }
    },
  };
};

export const createRasterStorage = async (sessionId) => {
  try { return await createOpfsStorage(sessionId); }
  catch (error) {
    try { return await createIndexedDbStorage(sessionId); }
    catch (fallbackError) { return new MemoryRasterStorage(); }
  }
};
