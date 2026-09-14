import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useImageExportControls } from './useImageExportControls';
import { calculateImageSize, copyImageBlob, downloadImageBlob } from './imageExport';

jest.mock('@chakra-ui/react', () => ({}));
jest.mock('./imageExport', () => ({
  calculateImageSize: jest.fn(),
  downloadImageBlob: jest.fn(),
  copyImageBlob: jest.fn(),
}));

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};
const sizedBlob = (size) => new Blob([new Uint8Array(size * 1024 * 1024)]);
let root;
let controls;
const toast = jest.fn();
const Probe = ({ source }) => {
  controls = useImageExportControls(source, toast, 'test', { automaticSizeUpdates: false });
  return null;
};
// ReactDOM's root API needs act; this test does not use Testing Library.
// eslint-disable-next-line testing-library/no-unnecessary-act
const render = (source) => act(() => { root.render(<Probe source={source} />); });

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  jest.clearAllMocks();
});
afterEach(() => act(() => root.unmount()));

test('editing and quality changes do not automatically encode images', () => {
  const exportBlob = jest.fn();
  render({ revision: 'first', exportBlob });
  render({ revision: 'edited', exportBlob });
  act(() => controls.setJpegQuality(55));
  expect(exportBlob).not.toHaveBeenCalled();
  expect(controls.outputSizes).toEqual({ png: null, jpg: null });
});

test('requested sizes encode sequentially and share a concurrent PNG request', async () => {
  const png = deferred();
  const exportBlob = jest.fn((format) => format === 'image/png' ? png.promise : Promise.resolve(sizedBlob(2)));
  render({ revision: 'first', exportBlob });
  let sizes;
  let download;
  act(() => { sizes = controls.updateOutputSizes(); download = controls.handleDownloadPNG(); });
  expect(exportBlob.mock.calls).toEqual([['image/png', 1]]);
  await act(async () => { png.resolve(sizedBlob(1)); await Promise.all([sizes, download]); });
  expect(exportBlob.mock.calls).toEqual([['image/png', 1], ['image/jpeg', 0.9]]);
  expect(downloadImageBlob).toHaveBeenCalledTimes(1);
  expect(controls.outputSizes).toEqual({ png: '1.00', jpg: '2.00' });
  act(() => controls.setJpegQuality(40));
  expect(controls.outputSizes).toEqual({ png: '1.00', jpg: null });
  expect(exportBlob).toHaveBeenCalledTimes(2);
});

test.each(['edit', 'reset'])('a stale size request cannot publish results or queue JPEG after %s', async (change) => {
  const pending = deferred();
  const exportBlob = jest.fn(() => pending.promise);
  render({ revision: 'first', exportBlob });
  let job;
  act(() => { job = controls.updateOutputSizes(); });
  if (change === 'edit') render({ revision: 'second', exportBlob });
  else act(() => controls.resetExportState());
  await act(async () => { pending.resolve(sizedBlob(1)); await job; });
  expect(controls.outputSizes).toEqual({ png: null, jpg: null });
  expect(exportBlob).toHaveBeenCalledTimes(1);
});

test('legacy canvas providers still export both formats on request', async () => {
  const canvas = document.createElement('canvas');
  calculateImageSize.mockResolvedValue({ blob: sizedBlob(1) });
  render({ current: canvas });
  await act(async () => controls.updateOutputSizes());
  expect(calculateImageSize.mock.calls).toEqual([[canvas, 'image/png', 1], [canvas, 'image/jpeg', 0.9]]);
});

test.each(['before', 'after'])('sizes follow a pending stroke commit when React renders %s encoding finishes', async (renderTiming) => {
  const pending = deferred();
  let currentRevision = 'before-stroke';
  const getRevision = () => currentRevision;
  const exportBlob = jest.fn((format) => format === 'image/png' ? pending.promise
    : Promise.resolve({ blob: sizedBlob(2), revision: currentRevision }));
  render({ revision: currentRevision, getRevision, exportBlob });
  let job;
  act(() => { job = controls.updateOutputSizes(); });
  currentRevision = 'committed-stroke';
  if (renderTiming === 'before') render({ revision: currentRevision, getRevision, exportBlob });
  await act(async () => {
    pending.resolve({ blob: sizedBlob(1), revision: currentRevision });
    await job;
  });
  if (renderTiming === 'after') render({ revision: currentRevision, getRevision, exportBlob });
  expect(exportBlob.mock.calls).toEqual([['image/png', 1], ['image/jpeg', 0.9]]);
  expect(controls.outputSizes).toEqual({ png: '1.00', jpg: '2.00' });
});

test('an acknowledged export revision cannot publish sizes for a subsequent unrelated edit', async () => {
  const pending = deferred();
  let currentRevision = 'before-stroke';
  const getRevision = () => currentRevision;
  const exportBlob = jest.fn(() => pending.promise);
  render({ revision: currentRevision, getRevision, exportBlob });
  let job;
  act(() => { job = controls.updateOutputSizes(); });
  currentRevision = 'newer-edit';
  render({ revision: currentRevision, getRevision, exportBlob });
  await act(async () => {
    pending.resolve({ blob: sizedBlob(1), revision: 'committed-stroke' });
    await job;
  });
  expect(exportBlob).toHaveBeenCalledTimes(1);
  expect(controls.outputSizes).toEqual({ png: null, jpg: null });
});

test('copy receives its Blob promise during the click while an export revision barrier is pending', async () => {
  const pending = deferred();
  let suppliedBlob;
  copyImageBlob.mockImplementation((promise) => promise.then((blob) => { suppliedBlob = blob; return true; }));
  const exportBlob = jest.fn(() => pending.promise);
  render({ revision: 'first', exportBlob });
  let job;
  act(() => { job = controls.handleCopyToPNG(); });
  expect(copyImageBlob).toHaveBeenCalledTimes(1);
  expect(copyImageBlob.mock.calls[0][0]).toBeInstanceOf(Promise);
  expect(suppliedBlob).toBeUndefined();
  const blob = sizedBlob(1);
  await act(async () => { pending.resolve({ blob, revision: 'first' }); await job; });
  expect(suppliedBlob).toBe(blob);
});
