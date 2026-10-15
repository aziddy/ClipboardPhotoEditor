import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useTextEditing } from './useTextEditing';
import { editorReducer } from './editorLayers';

let root, editing, state, docRef, selection, commits;
const preview = (doc) => { docRef.current = doc; state = { ...state, doc }; };
const commit = (doc) => { commits += 1; state = editorReducer(state, { type: 'commit', doc }); docRef.current = state.doc; };
const select = (ids) => { selection.current = ids; };
const Probe = () => { editing = useTextEditing({ doc: state.doc, docRef, onCommit: commit, onPreview: preview, onSelection: select, selectedLayerIdsRef: selection }); return null; };
// This hook test uses ReactDOM directly, without Testing Library.
// eslint-disable-next-line testing-library/no-unnecessary-act
const run = (action) => act(() => { action?.(); root.render(<Probe />); });

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (line) => ({ width: line.length * 16 }) });
  const doc = { width: 600, height: 480, activeLayerId: 'image', layers: [{ id: 'image', rasterId: 'pixels', name: 'Background', transform: [1, 0, 0, 1, 0, 0] }] };
  state = editorReducer({ doc, history: [], historyIndex: -1 }, { type: 'commit', doc });
  docRef = { current: state.doc }; selection = { current: ['image'] }; commits = 0;
  root = createRoot(document.createElement('div')); run();
});
afterEach(() => { act(() => root.unmount()); jest.restoreAllMocks(); });

test('sidebar and inline edits share a draft and commit one undo step', () => {
  run(() => editing.begin());
  run(() => editing.place({ x: 10, y: 15 }));
  expect(editing.session.inline).toBe(true);
  expect(editing.layer.transform).toEqual([1, 0, 0, 1, 10, 15]);
  run(() => editing.update({ value: 'Hello' }));
  run(() => editing.update({ value: 'Hello world', bold: true }));
  expect(commits).toBe(0);
  run(() => editing.finish());
  expect(commits).toBe(1);
  expect(state.history).toHaveLength(2);
  expect(editorReducer(state, { type: 'undo' }).doc.layers).toHaveLength(1);
});

test('cancel and empty new text restore the original document and selection', () => {
  run(() => editing.begin()); run(() => editing.update({ value: 'Discard' }));
  run(() => editing.cancel());
  expect(state.doc.layers).toHaveLength(1); expect(selection.current).toEqual(['image']);
  run(() => editing.begin()); run(() => editing.finish());
  expect(state.doc.layers).toHaveLength(1); expect(commits).toBe(0);
});

test('unchanged edits are not history steps; clearing existing text is undoable', () => {
  run(() => editing.begin()); run(() => editing.update({ value: 'Keep' })); run(() => editing.finish());
  const id = state.doc.activeLayerId;
  run(() => editing.begin(id)); run(() => editing.finish()); expect(commits).toBe(1);
  run(() => editing.begin(id)); run(() => editing.update({ value: '' })); run(() => editing.finish());
  expect(state.doc.layers).toHaveLength(1); expect(commits).toBe(2);
  expect(editorReducer(state, { type: 'undo' }).doc.layers[1].text.value).toBe('Keep');
});

test('clicks away end editing only once there is text to keep', () => {
  expect(editing.isClickAway({ x: 300, y: 300 })).toBe(false);
  run(() => editing.place({ x: 10, y: 15 }));
  expect(editing.isClickAway({ x: 300, y: 300 })).toBe(false);
  run(() => editing.update({ value: 'Hi' }));
  expect(editing.isClickAway({ x: 14, y: 20 })).toBe(false);
  expect(editing.isClickAway({ x: 300, y: 300 })).toBe(true);
  expect(editing.isClickAway(null)).toBe(true);
  run(() => editing.finish());
  run(() => editing.begin(state.doc.activeLayerId));
  expect(editing.isClickAway({ x: 300, y: 300 })).toBe(true);
});
