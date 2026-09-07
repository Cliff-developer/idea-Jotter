// Idea Jotter — sync via a private GitHub Gist.
// Each device stores its own token in localStorage; the gist ID (created on
// first sync) is also stored locally so subsequent syncs update the same file.
const Sync = (() => {
  'use strict';

  const TOKEN_KEY = 'ij_gh_token';
  const GIST_KEY = 'ij_gh_gist_id';
  const LAST_SYNC_KEY = 'ij_last_sync';
  const FILENAME = 'idea-jotter-data.json';

  let syncTimer = null;
  let onRemoteMerge = null;
  let getLocalEntries = null;
  let statusEl = null;
  let syncing = false;

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
  function getGistId() { return localStorage.getItem(GIST_KEY) || ''; }
  function setGistId(id) { localStorage.setItem(GIST_KEY, id); }
  function isConfigured() { return !!getToken(); }
  function lastSync() { return localStorage.getItem(LAST_SYNC_KEY) || ''; }

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(dataUrl) {
    const [meta, data] = dataUrl.split(',');
    const mime = (meta.match(/data:(.*);base64/) || [, 'application/octet-stream'])[1];
    const bytes = atob(data);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function serializeEntries(entries) {
    const out = [];
    for (const e of entries) {
      const copy = { ...e };
      if (e.audio && e.audio.blob) {
        copy.audio = { duration: e.audio.duration, dataUrl: await blobToBase64(e.audio.blob) };
      }
      out.push(copy);
    }
    return out;
  }

  function deserializeEntries(list) {
    return (list || []).map((e) => {
      const copy = { ...e };
      if (e.audio && e.audio.dataUrl) {
        copy.audio = { duration: e.audio.duration, blob: base64ToBlob(e.audio.dataUrl) };
      }
      if (!copy.reminders) copy.reminders = [];
      if (!copy.updatedAt) copy.updatedAt = copy.createdAt;
      if (typeof copy.deleted !== 'boolean') copy.deleted = false;
      return copy;
    });
  }

  async function ghFetch(path, options = {}) {
    const res = await fetch('https://api.github.com' + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + getToken(),
        Accept: 'application/vnd.github+json',
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
      if (res.status === 401) throw new Error('Token rejected — check it has the "gist" scope and hasn\u2019t expired.');
      throw new Error(`GitHub API ${res.status}${detail ? ': ' + detail : ''}`);
    }
    return res.json();
  }

  async function createGist(payload) {
    const data = await ghFetch('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: 'Idea Jotter sync data (private — do not share this link)',
        public: false,
        files: { [FILENAME]: { content: JSON.stringify(payload) } }
      })
    });
    setGistId(data.id);
    return data;
  }

  async function fetchGist() {
    const id = getGistId();
    if (!id) return null;
    const data = await ghFetch(`/gists/${id}`);
    const file = data.files[FILENAME];
    if (!file) return null;
    let content = file.content;
    if (file.truncated) {
      const rawRes = await fetch(file.raw_url, { headers: { Authorization: 'Bearer ' + getToken() } });
      content = await rawRes.text();
    }
    return JSON.parse(content);
  }

  async function pushGist(payload) {
    const id = getGistId();
    if (!id) return createGist(payload);
    return ghFetch(`/gists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: { [FILENAME]: { content: JSON.stringify(payload) } } })
    });
  }

  // Whole-entry last-write-wins merge, keyed by id. Good enough for a
  // single-user, two-device tool — it doesn't merge field-by-field.
  function mergeEntries(local, remote) {
    const map = new Map();
    (remote || []).forEach((e) => map.set(e.id, e));
    (local || []).forEach((e) => {
      const r = map.get(e.id);
      if (!r) { map.set(e.id, e); return; }
      const lt = new Date(e.updatedAt || e.createdAt).getTime();
      const rt = new Date(r.updatedAt || r.createdAt).getTime();
      map.set(e.id, lt >= rt ? e : r);
    });
    return Array.from(map.values());
  }

  async function listGists() {
    const gists = [];
    let page = 1;
    // Paginate defensively — most accounts have far fewer than a few hundred gists.
    while (page <= 5) {
      const batch = await ghFetch(`/gists?per_page=100&page=${page}`);
      gists.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return gists;
  }

  async function gistExists(id) {
    try { await ghFetch(`/gists/${id}`); return true; }
    catch { return false; }
  }

  // Finds an existing gist that already holds our data file, so a second
  // device using the same token attaches to the first device's gist instead
  // of silently creating its own. Also recovers automatically if the
  // previously-linked gist was deleted on GitHub.
  async function resolveGistId() {
    const cached = getGistId();
    if (cached) {
      if (await gistExists(cached)) return cached;
      resetGistId(); // stale link — fall through and rediscover/create fresh
    }
    try {
      const gists = await listGists();
      const matches = gists.filter((g) => g.files && g.files[FILENAME]);
      if (matches.length === 0) return '';
      // If more than one exists (e.g. from the bug where two devices each
      // created their own), prefer the oldest as the canonical one.
      matches.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      setGistId(matches[0].id);
      return matches[0].id;
    } catch {
      return '';
    }
  }

  function gistUrl() {
    const id = getGistId();
    return id ? `https://gist.github.com/${id}` : '';
  }

  async function sync() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    if (syncing) return { ok: false, reason: 'already-syncing' };
    syncing = true;
    setStatus('Syncing…');
    try {
      await resolveGistId();
      const localRaw = getLocalEntries ? getLocalEntries() : [];
      let remotePayload = null;
      try { remotePayload = await fetchGist(); } catch { /* no gist yet, or fetch failed — will create/overwrite on push */ }
      const remoteEntries = remotePayload ? deserializeEntries(remotePayload.entries || []) : [];
      const merged = mergeEntries(localRaw, remoteEntries);

      if (onRemoteMerge) await onRemoteMerge(merged);

      const payload = { app: 'idea-jotter', syncedAt: new Date().toISOString(), entries: await serializeEntries(merged) };
      await pushGist(payload);

      localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
      setStatus('Synced just now');
      return { ok: true };
    } catch (err) {
      setStatus('Sync failed: ' + err.message);
      return { ok: false, error: err };
    } finally {
      syncing = false;
    }
  }

  function scheduleSync(delay = 3000) {
    if (!isConfigured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay);
  }

  function init({ getEntries, onMerge, statusElement }) {
    getLocalEntries = getEntries;
    onRemoteMerge = onMerge;
    statusEl = statusElement || null;
  }

  function resetGistId() { localStorage.removeItem(GIST_KEY); }

  return { init, sync, scheduleSync, isConfigured, setToken, getGistId, setGistIdManual: setGistId, resetGistId, gistUrl, lastSync };
})();
