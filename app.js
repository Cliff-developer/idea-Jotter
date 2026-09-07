// Idea Jotter — app logic
(() => {
  'use strict';

  const PRIORITIES = ['high', 'medium', 'low'];
  const REMINDER_OFFSETS = [
    { stage: '1h', ms: 60 * 60 * 1000, label: '1 hour before' },
    { stage: '15m', ms: 15 * 60 * 1000, label: '15 minutes before' },
    { stage: 'due', ms: 0, label: 'at the deadline' }
  ];

  let entries = [];
  let currentTab = 'all';
  let currentSort = 'date';
  let pendingAudio = null; // { blob, duration }
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStart = null;
  let recordTimerInt = null;
  let activeSheetEntryId = null;
  const timeouts = new Map(); // entryId+stage -> timeout id

  const $ = (sel) => document.querySelector(sel);
  const feedList = $('#entryList');
  const emptyState = $('#emptyState');
  const captureInput = $('#captureInput');
  const sortRow = $('#sortRow');

  function uuid() {
    return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function nowISO() { return new Date().toISOString(); }

  // ---------- Rendering ----------

  function fmtWhen(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + time;
  }

  function fmtDeadline(iso) {
    const d = new Date(iso);
    const now = new Date();
    const overdue = d < now;
    const label = d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return { label: (overdue ? 'Overdue · ' : 'Due ') + label, overdue };
  }

  function fmtDuration(sec) {
    sec = Math.round(sec || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function visibleEntries() {
    let list = entries.filter(e => !e.deleted);
    if (currentTab === 'ideas') list = list.filter(e => e.type === 'idea');
    if (currentTab === 'tasks') list = list.filter(e => e.type === 'task');

    if (currentTab === 'tasks' && currentSort === 'priority') {
      const rank = { high: 0, medium: 1, low: 2 };
      list.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3);
      });
    } else if (currentTab === 'tasks' && currentSort === 'deadline') {
      list.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return new Date(a.deadline) - new Date(b.deadline);
      });
    } else {
      list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    return list;
  }

  function render() {
    const list = visibleEntries();
    feedList.innerHTML = '';
    emptyState.hidden = list.length > 0;
    sortRow.hidden = currentTab !== 'tasks';

    list.forEach(entry => {
      const li = document.createElement('li');
      li.className = 'entry' + (entry.done ? ' task-done' : '');
      li.dataset.id = entry.id;

      const meta = document.createElement('div');
      meta.className = 'entry-meta';

      if (entry.type === 'task' && entry.priority) {
        const dot = document.createElement('span');
        dot.className = 'priority-dot ' + entry.priority;
        meta.appendChild(dot);
      }

      const when = document.createElement('span');
      when.textContent = fmtWhen(entry.createdAt);
      meta.appendChild(when);

      if (entry.type === 'task' && entry.deadline) {
        const dl = fmtDeadline(entry.deadline);
        const tag = document.createElement('span');
        tag.className = 'deadline-tag' + (dl.overdue && !entry.done ? ' overdue' : '');
        tag.textContent = '· ' + dl.label;
        meta.appendChild(tag);
      }

      li.appendChild(meta);

      if (entry.text) {
        const p = document.createElement('div');
        p.className = 'entry-text';
        p.textContent = entry.text;
        li.appendChild(p);
      }

      if (entry.audio) {
        const row = document.createElement('div');
        row.className = 'entry-voice';
        const btn = document.createElement('button');
        btn.className = 'voice-play';
        btn.innerHTML = playIconSVG();
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleAudioPlayback(entry, btn); });
        row.appendChild(btn);
        const dur = document.createElement('span');
        dur.className = 'voice-duration';
        dur.textContent = fmtDuration(entry.audio.duration);
        row.appendChild(dur);
        li.appendChild(row);
      }

      li.addEventListener('click', () => openDetailSheet(entry.id));
      feedList.appendChild(li);
    });
  }

  function playIconSVG() {
    return '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  }
  function pauseIconSVG() {
    return '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  }

  let currentAudioEl = null;
  let currentAudioBtn = null;
  function toggleAudioPlayback(entry, btn) {
    if (currentAudioEl && currentAudioBtn === btn) {
      if (!currentAudioEl.paused) { currentAudioEl.pause(); return; }
      currentAudioEl.play();
      return;
    }
    if (currentAudioEl) { currentAudioEl.pause(); currentAudioBtn.innerHTML = playIconSVG(); }
    const url = URL.createObjectURL(entry.audio.blob);
    const audio = new Audio(url);
    currentAudioEl = audio;
    currentAudioBtn = btn;
    btn.innerHTML = pauseIconSVG();
    audio.play();
    audio.addEventListener('pause', () => { btn.innerHTML = playIconSVG(); });
    audio.addEventListener('ended', () => { btn.innerHTML = playIconSVG(); URL.revokeObjectURL(url); });
  }

  // ---------- Tabs & sort ----------

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      currentTab = tab.dataset.tab;
      render();
    });
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentSort = chip.dataset.sort;
      render();
    });
  });

  // ---------- Capture bar ----------

  let captureType = 'idea';
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      captureType = btn.dataset.type;
      captureInput.placeholder = captureType === 'task' ? 'What needs to get done?' : 'Type an idea…';
    });
  });

  captureInput.addEventListener('input', () => {
    captureInput.style.height = 'auto';
    captureInput.style.height = Math.min(captureInput.scrollHeight, 100) + 'px';
  });

  $('#saveBtn').addEventListener('click', saveCapture);
  captureInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveCapture(); }
  });

  async function saveCapture() {
    const text = captureInput.value.trim();
    if (!text && !pendingAudio) return;

    const createdAt = nowISO();
    const entry = {
      id: uuid(),
      type: captureType,
      text: text,
      audio: pendingAudio,
      priority: null,
      deadline: null,
      reminders: [],
      done: false,
      deleted: false,
      createdAt,
      updatedAt: createdAt
    };

    await DB.put(entry);
    entries.unshift(entry);
    captureInput.value = '';
    captureInput.style.height = 'auto';
    pendingAudio = null;
    render();
    Sync.scheduleSync();

    if (entry.type === 'task') {
      // Open detail sheet right away so priority/deadline can be set
      openDetailSheet(entry.id);
    }
  }

  // ---------- Voice recording ----------

  const micBtn = $('#micBtn');
  const recordingBar = $('#recordingBar');
  const recTime = $('#recTime');

  micBtn.addEventListener('click', startRecording);
  $('#stopRecBtn').addEventListener('click', () => stopRecording(true));
  $('#cancelRecBtn').addEventListener('click', () => stopRecording(false));

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.start();
      recordStart = Date.now();
      recordingBar.hidden = false;
      recTime.textContent = '0:00';
      recordTimerInt = setInterval(() => {
        recTime.textContent = fmtDuration((Date.now() - recordStart) / 1000);
      }, 250);
    } catch (err) {
      alert('Could not access the microphone. Check that this app has microphone permission.');
    }
  }

  function stopRecording(keep) {
    if (!mediaRecorder) return;
    const duration = (Date.now() - recordStart) / 1000;
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    clearInterval(recordTimerInt);
    recordingBar.hidden = true;

    mediaRecorder.onstop = () => {
      if (keep && recordedChunks.length) {
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        pendingAudio = { blob, duration };
        captureInput.placeholder = 'Voice memo attached — add a note (optional)…';
        captureInput.focus();
      }
      mediaRecorder = null;
    };
  }

  // ---------- Detail sheet ----------

  const sheetOverlay = $('#sheetOverlay');
  const sheetBody = $('#sheetBody');

  function openDetailSheet(id) {
    activeSheetEntryId = id;
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    sheetBody.innerHTML = '';

    if (entry.text) {
      const label = document.createElement('div');
      label.className = 'field-label';
      label.textContent = entry.type === 'task' ? 'Task' : 'Idea';
      const text = document.createElement('div');
      text.className = 'detail-text';
      text.textContent = entry.text;
      sheetBody.appendChild(label);
      sheetBody.appendChild(text);
    }

    if (entry.audio) {
      const row = document.createElement('div');
      row.className = 'entry-voice';
      row.style.marginTop = '14px';
      const btn = document.createElement('button');
      btn.className = 'voice-play';
      btn.innerHTML = playIconSVG();
      btn.addEventListener('click', () => toggleAudioPlayback(entry, btn));
      row.appendChild(btn);
      const dur = document.createElement('span');
      dur.className = 'voice-duration';
      dur.textContent = fmtDuration(entry.audio.duration);
      row.appendChild(dur);
      sheetBody.appendChild(row);
    }

    if (entry.type === 'task') {
      const pLabel = document.createElement('div');
      pLabel.className = 'field-label';
      pLabel.textContent = 'Priority';
      sheetBody.appendChild(pLabel);

      const pRow = document.createElement('div');
      pRow.className = 'priority-row';
      PRIORITIES.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'priority-option' + (entry.priority === p ? ' selected' : '');
        btn.innerHTML = `<span class="priority-dot ${p}"></span>${p[0].toUpperCase() + p.slice(1)}`;
        btn.addEventListener('click', () => {
          captureFormState(entry);
          entry.priority = entry.priority === p ? null : p;
          openDetailSheet(id);
        });
        pRow.appendChild(btn);
      });
      sheetBody.appendChild(pRow);

      const dLabelRow = document.createElement('div');
      dLabelRow.className = 'field-label-row';
      const dLabel = document.createElement('span');
      dLabel.className = 'field-label';
      dLabel.textContent = 'Deadline';
      dLabelRow.appendChild(dLabel);
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'clear-deadline-btn';
      clearBtn.textContent = 'Clear';
      dLabelRow.appendChild(clearBtn);
      sheetBody.appendChild(dLabelRow);

      const dInput = document.createElement('input');
      dInput.type = 'datetime-local';
      dInput.id = 'deadlineInput';
      dInput.className = 'deadline-input';
      // Pre-fill with the real current date/time (rounded to the next 5 min,
      // 1 hour out) so there's nothing to manually type in most of the time —
      // just nudge it, or hit Clear if this task has no deadline.
      dInput.value = entry.deadline ? toLocalInputValue(new Date(entry.deadline)) : toLocalInputValue(suggestedDeadline());
      clearBtn.addEventListener('click', () => { dInput.value = ''; });
      sheetBody.appendChild(dInput);

      const doneRow = document.createElement('label');
      doneRow.className = 'complete-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!entry.done;
      cb.addEventListener('change', () => { entry.done = cb.checked; });
      doneRow.appendChild(cb);
      doneRow.appendChild(document.createTextNode('Mark as completed'));
      sheetBody.appendChild(doneRow);
    }

    const actions = document.createElement('div');
    actions.className = 'sheet-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'sheet-btn primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => saveDetailSheet(entry));
    actions.appendChild(saveBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'sheet-btn danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteEntry(entry.id));
    actions.appendChild(delBtn);

    sheetBody.appendChild(actions);
    sheetOverlay.hidden = false;
  }

  function toLocalInputValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Real current time, pushed 1 hour out and rounded to the nearest 5
  // minutes — a sensible starting deadline so the field is never blank.
  function suggestedDeadline() {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 60);
    d.setSeconds(0, 0);
    const m = d.getMinutes();
    d.setMinutes(m - (m % 5));
    return d;
  }

  // Preserve whatever's currently in the deadline field before the sheet
  // gets rebuilt (e.g. from a priority click), so in-progress edits aren't lost.
  function captureFormState(entry) {
    const dEl = document.getElementById('deadlineInput');
    if (dEl) entry.deadline = dEl.value ? new Date(dEl.value).toISOString() : null;
  }

  async function saveDetailSheet(entry) {
    if (entry.type === 'task') {
      const dEl = document.getElementById('deadlineInput');
      entry.deadline = (dEl && dEl.value) ? new Date(dEl.value).toISOString() : null;
    }
    entry.updatedAt = nowISO();
    entry.reminders = [];
    await DB.put(entry);
    scheduleReminders(entry);
    sheetOverlay.hidden = true;
    render();
    Sync.scheduleSync();
  }

  async function deleteEntry(id) {
    // Soft-delete: keep a tombstone locally so a GitHub sync propagates the
    // deletion to the other device instead of the entry silently reappearing.
    const entry = entries.find(e => e.id === id);
    if (entry) {
      entry.deleted = true;
      entry.updatedAt = nowISO();
      await DB.put(entry);
    }
    clearScheduledReminders(id);
    sheetOverlay.hidden = true;
    render();
    Sync.scheduleSync();
  }

  sheetOverlay.addEventListener('click', (e) => { if (e.target === sheetOverlay) sheetOverlay.hidden = true; });

  // ---------- Menu: export / import / notifications ----------

  const menuOverlay = $('#menuOverlay');
  $('#menuBtn').addEventListener('click', () => { menuOverlay.hidden = false; updateNotifStatus(); updateSyncStatus(); });
  menuOverlay.addEventListener('click', (e) => { if (e.target === menuOverlay) menuOverlay.hidden = true; });

  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importData);
  $('#notifBtn').addEventListener('click', enableNotifications);

  $('#saveTokenBtn').addEventListener('click', async () => {
    const input = $('#ghTokenInput');
    const val = input.value.trim();
    Sync.setToken(val);
    input.value = '';
    input.placeholder = val ? 'Token saved on this device' : 'GitHub token (gist scope)';
    updateSyncStatus();
    if (val) {
      const result = await Sync.sync();
      if (result.ok) render();
    }
  });

  $('#syncNowBtn').addEventListener('click', async () => {
    const result = await Sync.sync();
    if (result.ok) render();
  });

  function updateSyncStatus() {
    const el = $('#syncStatus');
    if (!Sync.isConfigured()) { el.textContent = 'Not set up on this device yet.'; return; }
    const last = Sync.lastSync();
    el.textContent = last ? 'Last synced ' + fmtWhen(last) : 'Configured — not synced yet.';
  }

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
    const mime = meta.match(/data:(.*);base64/)[1];
    const bytes = atob(data);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function exportData() {
    const out = [];
    for (const e of entries) {
      const copy = { ...e };
      if (e.audio) {
        copy.audio = { duration: e.audio.duration, dataUrl: await blobToBase64(e.audio.blob) };
      }
      out.push(copy);
    }
    const payload = { app: 'idea-jotter', exportedAt: nowISO(), entries: out };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `idea-jotter-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    menuOverlay.hidden = true;
  }

  async function importData(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const text = await file.text();
    let payload;
    try { payload = JSON.parse(text); } catch { alert('That file could not be read as a backup.'); return; }
    const incoming = (payload.entries || []).map(e => {
      const copy = { ...e };
      if (e.audio && e.audio.dataUrl) {
        copy.audio = { duration: e.audio.duration, blob: base64ToBlob(e.audio.dataUrl) };
      }
      if (!copy.reminders) copy.reminders = [];
      if (!copy.updatedAt) copy.updatedAt = copy.createdAt;
      if (typeof copy.deleted !== 'boolean') copy.deleted = false;
      return copy;
    });

    const replace = confirm('Restore backup:\nOK = merge with current entries\nCancel = replace all current entries');
    if (replace) {
      await DB.mergeAll(incoming);
    } else {
      await DB.replaceAll(incoming);
    }
    entries = await DB.all();
    entries.forEach(scheduleReminders);
    render();
    menuOverlay.hidden = true;
    ev.target.value = '';
    Sync.scheduleSync();
  }

  // ---------- Notifications & reminders ----------

  function updateNotifStatus() {
    const status = $('#notifStatus');
    if (!('Notification' in window)) {
      status.textContent = 'Notifications are not supported in this browser.';
    } else if (Notification.permission === 'granted') {
      status.textContent = 'Reminders are on. You\u2019ll be notified as task deadlines approach while the app is open or recently used.';
    } else if (Notification.permission === 'denied') {
      status.textContent = 'Notifications are blocked. Enable them for this site in your browser settings.';
    } else {
      status.textContent = 'Not enabled yet.';
    }
  }

  async function enableNotifications() {
    if (!('Notification' in window)) { alert('This browser does not support notifications.'); return; }
    const perm = await Notification.requestPermission();
    updateNotifStatus();
    if (perm === 'granted') {
      entries.forEach(scheduleReminders);
      if ('serviceWorker' in navigator && 'periodicSync' in navigator.serviceWorker) {
        try {
          const reg = await navigator.serviceWorker.ready;
          await reg.periodicSync.register('check-deadlines', { minInterval: 15 * 60 * 1000 });
        } catch (e) { /* periodic sync not permitted; local timers still work while app is open */ }
      }
    }
  }

  function clearScheduledReminders(entryId) {
    for (const key of Array.from(timeouts.keys())) {
      if (key.startsWith(entryId + ':')) { clearTimeout(timeouts.get(key)); timeouts.delete(key); }
    }
  }

  function scheduleReminders(entry) {
    clearScheduledReminders(entry.id);
    if (entry.type !== 'task' || !entry.deadline || entry.done || entry.deleted) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const deadlineTs = new Date(entry.deadline).getTime();
    entry.reminders = entry.reminders || [];

    REMINDER_OFFSETS.forEach(({ stage, ms, label }) => {
      const fireAt = deadlineTs - ms;
      const already = entry.reminders.find(r => r.stage === stage && r.sent);
      if (already) return;
      const delay = fireAt - Date.now();
      if (delay < 0) return; // in the past — skip, don't spam on load
      if (delay > 2 ** 31 - 1) return; // setTimeout max delay guard

      const key = entry.id + ':' + stage;
      const id = setTimeout(() => fireReminder(entry.id, stage, label), delay);
      timeouts.set(key, id);
    });
  }

  async function fireReminder(entryId, stage, label) {
    const entry = entries.find(e => e.id === entryId) || await DB.get(entryId);
    if (!entry || entry.done) return;
    const title = stage === 'due' ? 'Deadline reached' : 'Deadline coming up';
    const body = (entry.text || 'Task').slice(0, 120) + (stage === 'due' ? '' : ` — ${label}`);

    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: entryId + '-' + stage });
    } else if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: 'icons/icon-192.png' });
    }

    entry.reminders = entry.reminders || [];
    const existing = entry.reminders.find(r => r.stage === stage);
    if (existing) existing.sent = true; else entry.reminders.push({ stage, sent: true });
    await DB.put(entry);
  }

  // Catch up on any reminders that should have fired while the app was closed
  async function catchUpMissedReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    for (const entry of entries) {
      if (entry.type !== 'task' || !entry.deadline || entry.done || entry.deleted) continue;
      const deadlineTs = new Date(entry.deadline).getTime();
      for (const { stage, ms, label } of REMINDER_OFFSETS) {
        const fireAt = deadlineTs - ms;
        const sent = (entry.reminders || []).some(r => r.stage === stage && r.sent);
        if (!sent && fireAt <= now && fireAt > now - 24 * 60 * 60 * 1000) {
          await fireReminder(entry.id, stage, label);
        }
      }
    }
  }

  // ---------- Init ----------

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    entries = await DB.all();
    render();
    entries.forEach(scheduleReminders);
    catchUpMissedReminders();

    Sync.init({
      getEntries: () => entries,
      onMerge: async (merged) => {
        await DB.replaceAll(merged);
        entries = merged;
        entries.forEach(scheduleReminders);
        render();
        catchUpMissedReminders();
      },
      statusElement: null
    });
    if (Sync.isConfigured()) Sync.sync().then((r) => { if (r.ok) updateSyncStatus(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        catchUpMissedReminders();
        if (Sync.isConfigured()) Sync.sync().then((r) => { if (r.ok) render(); });
      }
    });
  }

  init();
})();
