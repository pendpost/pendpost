import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadAssetFile } from './api.js';
import { useT } from './i18n.js';

// Upload errors arrive as raw server strings (api.js wraps the server message).
// Map the known fragments to a stable i18n key; everything else falls back to a
// generic key so the owner never sees a raw server string. Lifted verbatim from
// the Assets library (its only prior home) so every upload surface maps the same.
export function uploadErrorKey(raw) {
  const msg = String(raw || '').toLowerCase();
  if (msg.includes('too large') || msg.includes('413') || msg.includes('exceed')) return 'assets.upload.errorTooLarge';
  if (msg.includes('unsupported') || msg.includes('content-type') || msg.includes('type')) return 'assets.upload.errorFormat';
  if (msg.includes('filename') || msg.includes('invalid_input') || msg.includes('invalid')) return 'assets.upload.errorFilename';
  if (msg.includes('exists') || msg.includes('already')) return 'assets.upload.errorExists';
  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('econnrefused')) return 'assets.upload.errorUnreachable';
  return 'assets.upload.errorGeneric';
}

// The shared media-upload engine. The drag/drop + file-upload logic first proven
// in the Assets library, lifted so the Composer picker, the carousel, and the
// post detail reuse ONE implementation instead of each growing its own.
//
// - `dragging` + `dragHandlers` drive a dashed drop overlay (spread the handlers
//   on the persistent panel root; a hidden overlay can't hear its own dragover).
//   A depth counter tracks nested dragenter/dragleave so moving across children
//   never flickers the overlay mid-drag. Non-file drags are ignored (M8).
// - `uploads` is the per-file status list ({name, state, error?}); errors are
//   already localized here, so callers just render `u.error`.
// - `onUploaded(name)` fires once per SUCCESSFULLY uploaded file, in order - the
//   caller attaches it (set a media path, append a carousel slide, write a post).
export function useAssetUpload({ onUploaded } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState([]); // [{name, state:'uploading'|'done'|'error', error?}]
  const inputRef = useRef(null);
  const dragDepth = useRef(0);

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    for (const file of files) {
      setUploads((u) => [...u.filter((x) => x.name !== file.name), { name: file.name, state: 'uploading' }]);
      try {
        // eslint-disable-next-line no-await-in-loop
        await uploadAssetFile(file);
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, state: 'done' } : x)));
        queryClient.invalidateQueries({ queryKey: ['assets'] });
        if (onUploaded) onUploaded(file.name);
      } catch (err) {
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, state: 'error', error: t(uploadErrorKey(err.message)) } : x)));
      }
    }
  };

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const dragHandlers = {
    onDragEnter: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e) => {
      // preventDefault is what makes the element a valid drop target; only for files.
      if (hasFiles(e)) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
  };

  // Auto-clear finished rows after ~2s so the status list does not linger; error
  // rows persist (the caller dismisses them via the per-row X).
  useEffect(() => {
    if (!uploads.some((u) => u.state === 'done')) return undefined;
    const timer = setTimeout(() => setUploads((u) => u.filter((x) => x.state !== 'done')), 2000);
    return () => clearTimeout(timer);
  }, [uploads]);

  const openPicker = () => inputRef.current?.click();
  const dismissUpload = (name) => setUploads((u) => u.filter((x) => x.name !== name));
  const clearUploads = () => setUploads([]);

  return { dragging, uploads, dragHandlers, handleFiles, openPicker, inputRef, dismissUpload, clearUploads };
}
