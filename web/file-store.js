// Local bytes of attached photos/PDFs, in IndexedDB (localStorage is far too
// small). Keyed by the file record id from state.files.
(function (root) {
  'use strict';
  const DB = 'housecost-files', STORE = 'blobs';
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage full?'));
    });
  }

  const put = (id, blob) => run('readwrite', s => s.put(blob, id));
  const get = id => run('readonly', s => s.get(id)).then(b => b || null);
  const del = id => run('readwrite', s => s.delete(id));
  const keys = () => run('readonly', s => s.getAllKeys());

  /** Photos get resized to at most 1600 px and saved as JPEG; PDFs stay as they are. */
  async function prepare(file) {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || !root.createImageBitmap) return file;
    try {
      const img = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob || blob.size >= file.size) return file;
      const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      return new File([blob], name, { type: 'image/jpeg' });
    } catch (e) {
      return file; // a format the browser cannot decode: keep the original
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  root.FileStore = { put, get, del, keys, prepare, blobToBase64, blobToDataUrl };
})(window);
