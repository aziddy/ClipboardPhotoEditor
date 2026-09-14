import { copyImageBlob } from './imageExport';

test('clipboard write receives a promised PNG during the user gesture', async () => {
  let resolve;
  const image = new Promise((complete) => { resolve = complete; });
  const write = jest.fn(async ([item]) => { await item.data['image/png']; });
  const clipboard = navigator.clipboard;
  const ClipboardItem = global.ClipboardItem;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
  global.ClipboardItem = class {
    constructor(data) { this.data = data; }
  };
  try {
    const toast = jest.fn();
    const job = copyImageBlob(image, toast);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0][0].data['image/png']).toBe(image);
    resolve(new Blob(['png'], { type: 'image/png' }));
    await expect(job).resolves.toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  } finally {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    global.ClipboardItem = ClipboardItem;
  }
});
