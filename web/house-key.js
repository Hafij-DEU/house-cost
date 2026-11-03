// House key: the sync settings (data repo + access token) sealed with a
// password, so an APK sent to housemates can set itself up on first start.
// The sealed file is web/house-key.json, made by tools/make-house-key.mjs and
// never committed (see .gitignore): a short password only holds up while the
// file stays private. PBKDF2-SHA256 derives an AES-256-GCM key; a wrong
// password fails the GCM check.
(function (root) {
  'use strict';
  const ITERATIONS = 600000;
  const subtle = () => root.crypto.subtle;

  const toB64 = bytes => {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  const fromB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  async function deriveKey(password, salt, iterations, usage) {
    const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }

  /** settings: {repo, token}. Returns the JSON-ready sealed object. */
  async function seal(settings, password) {
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITERATIONS, 'encrypt');
    const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify({ repo: settings.repo, token: settings.token }))));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
  }

  /** Returns {repo, token}, or null when the password is wrong. */
  async function open(sealed, password) {
    if (!sealed || sealed.v !== 1) throw new Error('Unknown house key format');
    const key = await deriveKey(password, fromB64(sealed.salt), sealed.iter, 'decrypt');
    let plain;
    try {
      plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv) }, key, fromB64(sealed.data));
    } catch (e) {
      return null;
    }
    const out = JSON.parse(new TextDecoder().decode(plain));
    if (!out.repo || !out.token) throw new Error('House key is incomplete');
    return out;
  }

  const api = { seal, open, ITERATIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HouseKey = api;
})(typeof window !== 'undefined' ? window : globalThis);
