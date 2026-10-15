import { useCallback, useRef, useState } from 'react';
import { createEmptyDocument, createLayerId, invertTransform, transformPoint } from './editorLayers';
import { DEFAULT_TEXT, isTextLayer, updateTextLayer } from './textLayers';

export const findTextAtPoint = (doc, point) => [...doc.layers].reverse().find((layer) => {
  if (!isTextLayer(layer) || !layer.visible || layer.opacity <= 0) return false;
  const local = transformPoint(invertTransform(layer.transform), point);
  return local.x >= 0 && local.y >= 0 && local.x <= layer.textLayout.width && local.y <= layer.textLayout.height;
});

export const useTextEditing = ({ doc, docRef, onCommit, onPreview, onSelection, selectedLayerIdsRef }) => {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const sessionRef = useRef(null);
  const contextRef = useRef(null);
  const setCurrentSession = useCallback((next) => {
    sessionRef.current = next; setSession(next);
  }, []);
  const measure = useCallback((layer, changes) => {
    if (!contextRef.current) contextRef.current = document.createElement('canvas').getContext('2d');
    return updateTextLayer(layer, changes, contextRef.current);
  }, []);

  const finish = useCallback(() => {
    const current = sessionRef.current;
    if (!current) return;
    const working = docRef.current;
    const layer = working.layers.find((candidate) => candidate.id === current.layerId);
    setCurrentSession(null); setError('');
    if (!layer) return;
    if (!layer.text.value.trim()) {
      if (current.isNew) {
        onPreview(current.baseDoc); onSelection(current.selection);
      } else {
        const layers = working.layers.filter((candidate) => candidate.id !== layer.id);
        const next = layers.length ? { ...working, layers, activeLayerId: layers[layers.length - 1].id } : createEmptyDocument();
        onCommit(next); onSelection(next.activeLayerId ? [next.activeLayerId] : []);
      }
      return;
    }
    const original = current.baseDoc.layers.find((candidate) => candidate.id === layer.id);
    if (!original || JSON.stringify(original.text) !== JSON.stringify(layer.text)
      || original.transform.some((value, index) => value !== layer.transform[index])) onCommit(working);
  }, [docRef, onCommit, onPreview, onSelection, setCurrentSession]);

  const cancel = useCallback(() => {
    const current = sessionRef.current;
    if (!current) return;
    setCurrentSession(null); setError('');
    onPreview(current.baseDoc); onSelection(current.selection);
  }, [onPreview, onSelection, setCurrentSession]);

  const begin = useCallback((layerId = null, point = null, inline = false) => {
    finish();
    const baseDoc = docRef.current;
    if (!baseDoc.layers.length) return;
    const existing = baseDoc.layers.find((layer) => layer.id === layerId && isTextLayer(layer));
    const layer = existing || measure({ id: createLayerId(), name: 'Text', visible: true, opacity: 100,
      transform: [1, 0, 0, 1, 0, 0], text: DEFAULT_TEXT }, {});
    const centered = !existing && !point;
    if (!existing) layer.transform = [1, 0, 0, 1,
      point?.x ?? (baseDoc.width - layer.textLayout.width) / 2,
      point?.y ?? (baseDoc.height - layer.textLayout.height) / 2];
    setCurrentSession({ layerId: layer.id, baseDoc, isNew: !existing, inline, centered,
      selection: [...selectedLayerIdsRef.current] });
    setError('');
    onPreview({ ...baseDoc, layers: existing ? baseDoc.layers : [...baseDoc.layers, layer], activeLayerId: layer.id });
    onSelection([layer.id]);
  }, [docRef, finish, measure, onPreview, onSelection, selectedLayerIdsRef, setCurrentSession]);

  const update = useCallback((changes) => {
    const current = sessionRef.current;
    if (!current) return;
    const working = docRef.current;
    const layer = working.layers.find((candidate) => candidate.id === current.layerId);
    if (!layer) return;
    try {
      const next = measure(layer, changes);
      if (current.centered) next.transform = [1, 0, 0, 1,
        (working.width - next.textLayout.width) / 2, (working.height - next.textLayout.height) / 2];
      setError('');
      onPreview({ ...working, layers: working.layers.map((candidate) => candidate.id === layer.id ? next : candidate) });
    } catch (failure) { setError(failure.message); }
  }, [docRef, measure, onPreview]);

  const place = useCallback((point) => {
    const current = sessionRef.current;
    const hit = findTextAtPoint(docRef.current, point);
    if (current && (current.layerId === hit?.id || (current.isNew && !hit))) {
      const working = docRef.current;
      setCurrentSession({ ...current, inline: true, centered: false });
      if (!hit) onPreview({ ...working, layers: working.layers.map((layer) => layer.id === current.layerId
        ? { ...layer, transform: [1, 0, 0, 1, point.x, point.y] } : layer) });
    } else begin(hit?.id, point, true);
  }, [begin, docRef, onPreview, setCurrentSession]);

  // A click away from text that has been typed (or is being re-edited) should end editing
  // rather than move or replace it. `point` is null for clicks outside the image.
  const isClickAway = useCallback((point) => {
    const current = sessionRef.current;
    if (!current) return false;
    const working = docRef.current;
    if (point && findTextAtPoint(working, point)?.id === current.layerId) return false;
    const layer = working.layers.find((candidate) => candidate.id === current.layerId);
    return !current.isNew || Boolean(layer?.text.value);
  }, [docRef]);

  const showInline = useCallback(() => {
    if (sessionRef.current) setCurrentSession({ ...sessionRef.current, inline: true });
  }, [setCurrentSession]);

  return { session, sessionRef, error, begin, finish, cancel, update, place, isClickAway, showInline,
    layer: session ? doc.layers.find((layer) => layer.id === session.layerId) : null };
};
