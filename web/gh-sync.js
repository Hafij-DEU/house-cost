// GitHub sync: the shared data is one JSON file in a (private) repo, read and
// written through the REST contents API. Every save is a commit, so the repo's
// history doubles as a timestamped log of every change.
(function (root) {
  'use strict';

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  class SyncError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  /** cfg: {owner, repo, path, branch, token}; fetchImpl is injectable for tests. */
  function client(cfg, fetchImpl) {
    const doFetch = fetchImpl || root.fetch.bind(root);
    const api = cfg.api || 'https://api.github.com';
    const contents = path => `${api}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/` +
      path.split('/').map(encodeURIComponent).join('/');
    const url = contents(cfg.path);
    const ref = cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '';
    const headers = extra => ({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + cfg.token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    });

    /** Text in the app language when i18n.js is loaded (browser), else the English given. */
    const say = (key, english) => (root.I18n ? root.I18n.t(key) : english);

    async function fail(res) {
      let msg = res.statusText || 'HTTP ' + res.status;
      try { msg = (await res.json()).message || msg; } catch (e) { /* not JSON */ }
      if (res.status === 401) msg = say('gs.401', 'Token not accepted (expired or wrong).') + ' ' + msg;
      if (res.status === 404) msg = say('gs.404', 'Repo not found, or the token has no access to it.') + ' ' + msg;
      if (res.status === 403) msg = say('gs.403', 'Token may not write here (needs Contents: read and write).') + ' ' + msg;
      throw new SyncError(msg, res.status);
    }

    /** Returns {data, sha}; data is null when the file does not exist yet. */
    async function pull() {
      // no-store: a cached GET would hide a housemate's newest commit.
      const res = await doFetch(url + ref, { headers: headers(), cache: 'no-store' });
      if (res.status === 404) {
        // 404 is either "no file yet" or "no repo access"; ask the repo to tell them apart.
        const repoRes = await doFetch(`${api}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`,
          { headers: headers(), cache: 'no-store' });
        if (repoRes.ok) return { data: null, sha: null };
        return fail(repoRes);
      }
      if (!res.ok) return fail(res);
      const meta = await res.json();
      let text;
      if (meta.content) {
        text = base64ToUtf8(meta.content);
      } else {
        // Files over 1 MB come without inline content; fetch the raw body instead.
        const raw = await doFetch(url + ref, { headers: headers({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
        if (!raw.ok) return fail(raw);
        text = await raw.text();
      }
      return { data: JSON.parse(text), sha: meta.sha };
    }

    /** Writes the file; throws SyncError with status 409 when someone else committed first. */
    async function push(data, sha, message) {
      const body = { message, content: utf8ToBase64(JSON.stringify(data, null, 1) + '\n') };
      if (sha) body.sha = sha;
      if (cfg.branch) body.branch = cfg.branch;
      const res = await doFetch(url, {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      // GitHub answers 409 for a stale sha, or 422 when a sha is missing for an existing file.
      if (res.status === 409 || (res.status === 422 && !sha)) throw new SyncError('conflict', 409);
      if (!res.ok) return fail(res);
      return (await res.json()).content.sha;
    }

    /** Uploads a binary file (base64) once; an existing file at that path counts as done. */
    async function putFile(path, base64, message) {
      const body = { message, content: base64 };
      if (cfg.branch) body.branch = cfg.branch;
      const res = await doFetch(contents(path), {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      // 422 without a sha: the file is already there (same id = same bytes).
      if (res.status === 422) return false;
      if (!res.ok) return fail(res);
      return true;
    }

    /** Downloads a file's bytes; null when it is not in the repo (yet). */
    async function getFile(path) {
      const res = await doFetch(contents(path) + ref, {
        headers: headers({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store',
      });
      if (res.status === 404) return null;
      if (!res.ok) return fail(res);
      return new Uint8Array(await res.arrayBuffer());
    }

    /** Removes a file; a file that is already gone is fine. */
    async function deleteFile(path, message) {
      const meta = await doFetch(contents(path) + ref, { headers: headers(), cache: 'no-store' });
      if (meta.status === 404) return false;
      if (!meta.ok) return fail(meta);
      const body = { message, sha: (await meta.json()).sha };
      if (cfg.branch) body.branch = cfg.branch;
      const res = await doFetch(contents(path), {
        method: 'DELETE',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      if (res.status === 404) return false;
      if (!res.ok) return fail(res);
      return true;
    }

    /** True when the repo is private; the shared file must never land in a public repo. */
    async function isPrivate() {
      const res = await doFetch(`${api}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`,
        { headers: headers(), cache: 'no-store' });
      if (!res.ok) return fail(res);
      return (await res.json()).private === true;
    }

    const historyUrl = `https://github.com/${cfg.owner}/${cfg.repo}/commits/${cfg.branch || 'HEAD'}/${cfg.path}`;
    return { pull, push, putFile, getFile, deleteFile, isPrivate, historyUrl };
  }

  /**
   * One sync round: pull, merge into local, push if local has anything the
   * remote lacks. On a race with another device it pulls and merges again.
   * H is the HouseCost logic module. Returns {pulledChanges, pushed}.
   */
  async function syncRound(gh, H, state, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await gh.pull();
      let pulledChanges = false;
      if (data) {
        H.validateState(JSON.parse(JSON.stringify(data)));
        pulledChanges = H.merge(state, data);
      }
      const out = H.exportShared(state);
      if (data && H.sameShared(out, data)) return { pulledChanges, pushed: false };
      try {
        await gh.push(out, sha, message || 'House Cost update');
        return { pulledChanges, pushed: true };
      } catch (e) {
        if (e.status !== 409) throw e;
      }
    }
    throw new SyncError(root.I18n ? root.I18n.t('gs.busy') : 'Another device kept saving at the same time; try again.', 409);
  }

  const api = { client, syncRound, SyncError, utf8ToBase64, base64ToUtf8 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GhSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
