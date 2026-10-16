import { useRef, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Avatar picker.
 *
 * DESIGN DECISION (ADR-015): the image is downscaled in the browser
 * before it is uploaded.
 *
 * A photo straight from a phone camera is 3 to 8 MB. Uploading that on
 * a metered connection could cost someone more than a week of data for
 * a picture displayed at 96 pixels, which would make a mockery of every
 * other bandwidth decision in this system.
 *
 * The canvas resize produces roughly 6 KB of WebP: about a thousandth
 * of the original. It also means the server never has to run image
 * processing, so there is no sharp or ImageMagick dependency and no
 * image-decoder attack surface on the server.
 *
 * The server still validates independently (magic bytes, size ceiling,
 * format allow-list). Client-side processing is a courtesy to the
 * participant's data bundle, never a security control: anyone can post
 * to the endpoint directly.
 */

const TARGET_PX = 256;
const QUALITY = 0.82;

async function downscale(file) {
  const bitmap = await createImageBitmap(file);

  // Square crop from the centre. Faces are usually centred, and a
  // non-square avatar either distorts or gets cropped unpredictably by
  // CSS later.
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_PX;
  canvas.height = TARGET_PX;

  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, sx, sy, side, side, 0, 0, TARGET_PX, TARGET_PX);
  bitmap.close?.();

  // WebP where supported, JPEG otherwise. Both are on the server's
  // allow-list. WebP is roughly 30% smaller at the same quality.
  const preferred = 'image/webp';
  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, preferred, QUALITY);
  });

  if (blob && blob.type === preferred) return blob;

  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', QUALITY);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(blob);
  });
}

export function AvatarPicker({ userId, currentUrl, fullName, onChange }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [savedBytes, setSavedBytes] = useState(null);

  const initials = (fullName ?? '?')
    .split(' ').slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);

    if (!file.type.startsWith('image/')) {
      setError('Choose an image file.');
      return;
    }

    setBusy(true);
    try {
      const original = file.size;
      const resized = await downscale(file);
      const base64 = await blobToBase64(resized);

      const result = await api.uploadAvatar(userId, base64);

      setPreview(URL.createObjectURL(resized));
      setSavedBytes({ from: original, to: resized.size });
      onChange?.(result.avatarUrl);
    } catch (uploadError) {
      setError(uploadError.message ?? 'That picture could not be uploaded.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAvatar(userId);
      setPreview(null);
      setSavedBytes(null);
      onChange?.(null);
    } catch (removeError) {
      setError(removeError.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = preview ?? currentUrl;

  return (
    <div className="avatar-picker">
      <div className="avatar-large" aria-hidden={Boolean(shown)}>
        {shown
          ? <img src={shown} alt="" width="96" height="96" />
          : <span>{initials}</span>}
      </div>

      <div className="avatar-controls">
        <input
          ref={inputRef}
          type="file"
          id="avatar-file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFile}
          className="visually-hidden"
        />
        <label htmlFor="avatar-file" className="btn btn-plain">
          {busy ? 'Working' : shown ? 'Change picture' : 'Add a picture'}
        </label>

        {shown && (
          <button type="button" className="btn btn-quiet" onClick={handleRemove} disabled={busy}>
            Remove
          </button>
        )}

        <p className="muted avatar-note">
          {savedBytes
            ? `Resized from ${(savedBytes.from / 1024 / 1024).toFixed(1)} MB to ${(savedBytes.to / 1024).toFixed(0)} KB before uploading.`
            : 'Pictures are resized on your device before upload, so they cost very little data.'}
        </p>

        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
