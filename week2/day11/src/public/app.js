/**
 * Front end for the memory agent.
 *
 * Talks only to this application's own /api — never to DeepSeek, and never
 * sees the API key. The server is the source of truth: the chat is rebuilt from
 * short-term memory on every load, and all counts come from the server.
 *
 * Nothing here uses innerHTML. Every piece of chat and memory content is set
 * with textContent, so text that looks like HTML is shown, never run.
 */
(() => {
  'use strict';

  const TAGS = { user: 'you asked', assistant: 'agent answered' };

  const LAYERS = [
    { id: 'shortTerm', label: 'Short-term memory', purpose: 'The current conversation.' },
    { id: 'work', label: 'Work memory', purpose: 'The current task: requirements, decisions, constraints, progress.' },
    { id: 'longTerm', label: 'Long-term memory', purpose: 'Profile, preferences, solutions and knowledge kept across tasks.' },
  ];

  const WORK_LABELS = {
    task: 'task',
    currentState: 'current state',
    requirements: 'requirement',
    constraints: 'constraint',
    decisions: 'decision',
    results: 'result',
    todos: 'TODO',
    entities: 'file/entity',
  };

  const PREVIEW_DELAY_MS = 250;
  const MAX_CHARS = 8000;

  const $ = (id) => document.getElementById(id);
  const el = {
    chat: $('chat'),
    messages: $('messages'),
    empty: $('empty-state'),
    form: $('form'),
    input: $('message'),
    ask: $('ask'),
    error: $('error'),
    banner: $('status-banner'),
    model: $('model-label'),
    composerContext: $('composer-context'),
    contextTotal: $('tokens-context'),
    breakdown: $('breakdown'),
    lastRequest: $('last-request'),
    lastEstimate: $('last-estimate'),
    lastActual: $('last-actual'),
    lastAnswer: $('last-answer'),
    openSettings: $('open-settings'),
    dialog: $('settings-dialog'),
    settingsLayers: $('settings-layers'),
    settingsStatus: $('settings-status'),
    settingsSave: $('settings-save'),
    settingsCancel: $('settings-cancel'),
    settingsClose: $('settings-close'),
    contextPreview: $('context-preview'),
    layerTemplate: $('layer-template'),
  };

  const state = {
    busy: false,
    previewTimer: null,
    previewSeq: 0,
    storageModes: [],
    layers: [],
    tokenCounts: null,
    draft: {},
  };

  // --- Helpers ---------------------------------------------------------------

  const numberFormat = new Intl.NumberFormat('en-US');
  const approx = (n) => `~${numberFormat.format(Math.max(0, Math.round(Number(n) || 0)))}`;
  const pad = (n) => String(n).padStart(2, '0');

  /** "15.09.2026 10:32", in the viewer's time zone. Stored values are ISO 8601. */
  function formatDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function shorten(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /**
   * JSON over fetch, with every failure turned into an Error carrying a
   * readable message — the server's own when it sent one.
   */
  async function api(url, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('Unable to reach the server. Is it running?');
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) throw new Error(payload?.error || `The server responded with HTTP ${response.status}.`);
    if (!payload) throw new Error('The server sent a response that could not be read.');
    return payload;
  }

  // --- Chat ----------------------------------------------------------------

  /**
   * Message text as paragraphs, with ``` fenced blocks shown as code. Built
   * from text nodes only — this is formatting, not HTML rendering.
   */
  function renderText(container, text) {
    const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let match;
    while ((match = fence.exec(text)) !== null) {
      appendParagraph(container, text.slice(last, match.index));
      const pre = node('pre', 'code-block');
      pre.append(node('code', null, match[2].replace(/\n$/, '')));
      container.append(pre);
      last = fence.lastIndex;
    }
    appendParagraph(container, text.slice(last));
  }

  function appendParagraph(container, chunk) {
    const text = chunk.replace(/^\n+|\n+$/g, '');
    if (text.trim()) container.append(node('p', 'bubble__text', text));
  }

  function createBubble(message, updates) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const bubble = node('article', `bubble bubble--${role}`);

    const head = node('header', 'bubble__head');
    head.append(node('span', 'bubble__tag', TAGS[role]));
    const time = node('time', 'bubble__time', formatDateTime(message.timestamp));
    time.dateTime = message.timestamp;
    head.append(time);

    const body = node('div', 'bubble__body');
    renderText(body, message.content);

    bubble.append(head, body);
    const notes = describeMemoryUpdates(updates);
    if (notes.length) {
      const list = node('ul', 'bubble__memory');
      list.setAttribute('aria-label', 'Saved to memory');
      for (const note of notes) list.append(node('li', null, note));
      bubble.append(list);
    }
    return bubble;
  }

  function createPendingBubble() {
    const bubble = node('article', 'bubble bubble--assistant bubble--pending');
    const head = node('header', 'bubble__head');
    head.append(node('span', 'bubble__tag', 'agent is thinking'));
    const dots = node('div', 'thinking');
    dots.setAttribute('aria-label', 'Waiting for DeepSeek');
    for (let i = 0; i < 3; i += 1) dots.append(node('i'));
    bubble.append(head, dots);
    return bubble;
  }

  function describeMemoryUpdates(updates) {
    const notes = [];
    for (const u of updates?.work ?? []) {
      notes.push(`Work memory · ${WORK_LABELS[u.field] ?? u.field}: ${u.value}`);
    }
    for (const u of updates?.longTerm ?? []) {
      if (u.category === 'profile') notes.push(`Long-term memory · ${u.key.replace(/_/g, ' ')}: ${u.value}`);
      if (u.category === 'preferences') notes.push(`Long-term memory · preference: ${u.value}`);
      if (u.category === 'knowledge') notes.push(`Long-term memory · knowledge [${u.topic}]: ${u.fact}`);
      if (u.category === 'solutions') notes.push(`Long-term memory · solution: ${shorten(u.problem, 90)}`);
    }
    return notes;
  }

  function appendToChat(element) {
    el.messages.append(element);
    el.empty.hidden = true;
    return element;
  }

  function renderHistory(messages) {
    el.messages.replaceChildren(...messages.map((message) => createBubble(message)));
    el.empty.hidden = messages.length > 0;
  }

  /** Scrolls the chat pane only; the page itself cannot scroll. */
  function scrollToBottom() {
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function clearError() {
    el.error.hidden = true;
    el.error.textContent = '';
  }

  function showBanner(message) {
    el.banner.textContent = message;
    el.banner.hidden = false;
  }

  /** Grow the textarea with its content, up to the CSS max-height. */
  function autoResize() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
  }

  function updateAskButton() {
    el.ask.disabled = state.busy || el.input.value.trim().length === 0;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.ask.setAttribute('aria-busy', String(busy));
    updateAskButton();
  }

  async function ask(text) {
    clearError();
    setBusy(true);

    // Shown at once, stamped with the local clock until the server's stamp arrives.
    const userBubble = appendToChat(createBubble({ role: 'user', content: text, timestamp: new Date().toISOString() }));
    el.input.value = '';
    autoResize();
    const pending = appendToChat(createPendingBubble());
    scrollToBottom();

    try {
      const data = await api('/api/chat', { method: 'POST', body: { message: text } });
      pending.remove();
      userBubble.replaceWith(createBubble(data.request));
      appendToChat(createBubble(data.reply, data.memoryUpdates));
      renderLastRequest(data.tokenCounts, data.usage);
      renderTokenCounts(data.memoryTokenCounts);
      loadMemory();
    } catch (err) {
      // Nothing was stored. Say so on the bubble and give the text back.
      pending.remove();
      userBubble.classList.add('bubble--failed');
      userBubble.append(node('p', 'bubble__failure', 'Not sent — nothing was saved.'));
      if (!el.input.value) {
        el.input.value = text;
        autoResize();
      }
      showError(err.message);
    } finally {
      setBusy(false);
      scrollToBottom();
      schedulePreview(0);
      el.input.focus();
    }
  }

  // --- Memory panel ----------------------------------------------------------

  function renderTokenCounts(counts) {
    if (!counts) return;
    state.tokenCounts = counts;
    for (const { id } of LAYERS) $(`tokens-${id}`).textContent = approx(counts[id]);

    el.contextTotal.textContent = `${approx(counts.currentContext)} tokens`;
    el.composerContext.textContent = approx(counts.currentContext);

    const b = counts.breakdown ?? {};
    const rows = [
      ['System instructions', b.system],
      ['Long-term memory', b.longTerm],
      ['Work memory', b.work],
      ['Short-term memory', b.shortTerm],
      ['Your question', b.request],
      ['Headers and chat markers', b.framing],
    ];
    el.breakdown.replaceChildren(...rows.map(([label, value]) => {
      const item = node('li');
      item.append(node('span', null, label), node('span', 'num', approx(value)));
      return item;
    }));
  }

  function renderLastRequest(tokenCounts, usage) {
    const exact = (n) => (Number.isInteger(n) ? numberFormat.format(n) : 'not reported');
    el.lastEstimate.textContent = approx(tokenCounts.currentContext);
    el.lastActual.textContent = exact(usage?.promptTokens);
    el.lastAnswer.textContent = exact(usage?.completionTokens);
    el.lastRequest.hidden = false;
  }

  function modeLabel(mode) {
    return state.storageModes.find((m) => m.mode === mode)?.label ?? mode;
  }

  function renderLayerMeta() {
    for (const layer of state.layers) {
      let text = layer.enabled ? modeLabel(layer.storage) : 'Disabled — not sent';
      if (layer.id === 'shortTerm' && layer.enabled) {
        text += ` · ${layer.contents.length} / ${layer.maxMessages} messages`;
      }
      $(`meta-${layer.id}`).textContent = text;
      $(`stat-${layer.id}`).classList.toggle('is-disabled', !layer.enabled);
    }
  }

  function applyMemoryOverview(data) {
    state.storageModes = data.storageModes;
    state.layers = data.layers;
    renderLayerMeta();
    // The overview counts an empty draft; a typed question needs its own preview.
    if (el.input.value.trim()) schedulePreview(0);
    else renderTokenCounts(data.tokenCounts);
  }

  async function loadMemory() {
    try {
      applyMemoryOverview(await api('/api/memory'));
    } catch (err) {
      showError(`Could not load memory: ${err.message}`);
    }
  }

  function schedulePreview(delay = PREVIEW_DELAY_MS) {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(refreshPreview, delay);
  }

  /** Ask the server what the draft would cost. Stale answers are ignored. */
  async function refreshPreview() {
    const seq = ++state.previewSeq;
    try {
      const data = await api('/api/context/preview', {
        method: 'POST',
        body: { message: el.input.value.slice(0, MAX_CHARS) },
      });
      if (seq === state.previewSeq) renderTokenCounts(data.tokenCounts);
    } catch {
      // Keep the last numbers; a real problem surfaces when the question is sent.
    }
  }

  async function loadHistory() {
    try {
      const data = await api('/api/history');
      renderHistory(data.messages);
      scrollToBottom();
    } catch (err) {
      showError(`Could not load the conversation: ${err.message}`);
    }
  }

  async function loadStatus() {
    try {
      const status = await api('/api/status');
      el.model.textContent = status.deepseek.model;
      if (!status.deepseek.configured) {
        showBanner('DeepSeek API key is missing. Set DEEPSEEK_API_KEY on the server and restart it; until then questions cannot be answered.');
      }
    } catch (err) {
      showBanner(err.message);
    }
  }

  // --- Settings dialog -------------------------------------------------------

  function setSettingsStatus(message, isError = false) {
    el.settingsStatus.textContent = message;
    el.settingsStatus.classList.toggle('is-error', isError);
  }

  function savedLayerSettings(layer) {
    return layer.id === 'shortTerm'
      ? { storage: layer.storage, maxMessages: layer.maxMessages }
      : { storage: layer.storage };
  }

  /** Rebuild the layer cards. `keepDraft` preserves unsaved edits across a refresh. */
  function buildLayerCards(keepDraft = false) {
    const previous = state.draft;
    state.draft = Object.fromEntries(state.layers.map((layer) => [
      layer.id,
      keepDraft && previous[layer.id] ? previous[layer.id] : savedLayerSettings(layer),
    ]));
    el.settingsLayers.replaceChildren(...state.layers.map(createLayerCard));
    updateSaveButton();
  }

  function createLayerCard(layer) {
    const card = el.layerTemplate.content.firstElementChild.cloneNode(true);
    const find = (selector) => card.querySelector(selector);
    const meta = LAYERS.find((l) => l.id === layer.id);
    const draft = state.draft[layer.id];

    find('.layer-card__title').textContent = meta.label;
    find('.layer-card__purpose').textContent = meta.purpose;
    find('.layer-card__tokens').textContent = `${approx(state.tokenCounts?.[layer.id])} tokens`;

    const select = find('.layer-card__storage');
    for (const mode of state.storageModes) {
      const option = node('option', null, mode.label);
      option.value = mode.mode;
      select.append(option);
    }
    select.value = draft.storage;

    const note = find('.layer-card__note');
    const describeMode = () => {
      const mode = state.storageModes.find((m) => m.mode === select.value);
      const where = select.value === 'json' && layer.location ? ` Files: ${layer.location}/` : '';
      note.textContent = `${mode?.description ?? ''}${where}`;
    };
    describeMode();
    select.addEventListener('change', () => {
      draft.storage = select.value;
      describeMode();
      updateSaveButton();
    });

    if (layer.id === 'shortTerm') {
      const field = find('.layer-card__max');
      const input = find('.layer-card__max-input');
      field.hidden = false;
      input.value = String(draft.maxMessages);
      input.addEventListener('input', () => {
        draft.maxMessages = Number(input.value);
        updateSaveButton();
      });
    }

    const contents = find('.layer-card__contents');
    find('.layer-card__contents pre').textContent = layer.enabled
      ? JSON.stringify(layer.contents, null, 2)
      : 'This layer is disabled: nothing is read from or written to storage.';
    contents.querySelector('summary').textContent = layer.enabled ? 'Show contents' : 'Contents (disabled)';

    const clear = find('.layer-card__clear');
    clear.textContent = `Clear ${meta.label.toLowerCase()}`;
    clear.disabled = !layer.enabled;
    if (!layer.enabled) clear.title = 'The layer is disabled, so there is nothing in use to clear.';

    if (layer.id === 'longTerm') {
      const confirm = find('.confirm');
      clear.addEventListener('click', () => {
        clear.hidden = true;
        confirm.hidden = false;
        find('.confirm__no').focus();
      });
      find('.confirm__no').addEventListener('click', () => {
        confirm.hidden = true;
        clear.hidden = false;
      });
      find('.confirm__yes').addEventListener('click', () => clearLayer(layer.id, meta.label, true));
    } else {
      clear.addEventListener('click', () => clearLayer(layer.id, meta.label, false));
    }

    return card;
  }

  function draftIsValid() {
    const max = state.draft.shortTerm?.maxMessages;
    return Number.isInteger(max) && max >= 2 && max <= 500;
  }

  function draftIsDirty() {
    return state.layers.some((layer) => {
      const draft = state.draft[layer.id];
      return draft.storage !== layer.storage
        || (layer.id === 'shortTerm' && draft.maxMessages !== layer.maxMessages);
    });
  }

  function updateSaveButton() {
    const dirty = draftIsDirty();
    const valid = draftIsValid();
    el.settingsSave.disabled = !dirty || !valid;
    if (dirty && !valid) setSettingsStatus('Max messages must be a whole number from 2 to 500.', true);
    else if (dirty) setSettingsStatus('Unsaved changes.');
    else if (el.settingsStatus.classList.contains('is-error') || el.settingsStatus.textContent === 'Unsaved changes.') {
      setSettingsStatus('');
    }
  }

  async function saveSettings() {
    el.settingsSave.disabled = true;
    setSettingsStatus('Saving…');
    try {
      const data = await api('/api/settings', { method: 'POST', body: { memory: state.draft } });
      applyMemoryOverview(data);
      buildLayerCards();
      setSettingsStatus('Saved.');
      // A different storage can hold a different conversation.
      await loadHistory();
      loadContextPreview();
    } catch (err) {
      setSettingsStatus(err.message, true);
      el.settingsSave.disabled = !draftIsDirty() || !draftIsValid();
    }
  }

  async function clearLayer(layerId, label, confirmed) {
    setSettingsStatus(`Clearing ${label.toLowerCase()}…`);
    try {
      const data = await api('/api/memory/clear', { method: 'POST', body: { layer: layerId, confirm: confirmed } });
      applyMemoryOverview(data);
      buildLayerCards(true);
      setSettingsStatus(`${label} cleared.`);
      if (layerId === 'shortTerm') await loadHistory();
      loadContextPreview();
    } catch (err) {
      setSettingsStatus(err.message, true);
    }
  }

  async function loadContextPreview() {
    try {
      const data = await api('/api/context/preview', {
        method: 'POST',
        body: { message: el.input.value.slice(0, MAX_CHARS), includeMessages: true },
      });
      el.contextPreview.textContent = data.messages
        .map((m) => `──── ${m.role.toUpperCase()} ────\n${m.content}`)
        .join('\n\n');
    } catch (err) {
      el.contextPreview.textContent = `Could not build the preview: ${err.message}`;
    }
  }

  async function openSettings() {
    setSettingsStatus('');
    try {
      applyMemoryOverview(await api('/api/memory'));
    } catch (err) {
      showError(`Could not load memory settings: ${err.message}`);
      return;
    }
    buildLayerCards();
    loadContextPreview();
    el.dialog.showModal();
  }

  // --- Events ------------------------------------------------------------------

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.input.value.trim();
    if (state.busy || !text) return;
    ask(text);
  });

  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      el.form.requestSubmit();
    }
  });

  el.input.addEventListener('input', () => {
    autoResize();
    updateAskButton();
    schedulePreview();
    if (!el.error.hidden) clearError();
  });

  el.openSettings.addEventListener('click', openSettings);
  el.settingsSave.addEventListener('click', saveSettings);
  el.settingsCancel.addEventListener('click', () => el.dialog.close());
  el.settingsClose.addEventListener('click', () => el.dialog.close());
  // Clicking the backdrop (outside the frame) closes the dialog.
  el.dialog.addEventListener('click', (event) => {
    if (event.target === el.dialog) el.dialog.close();
  });

  window.addEventListener('resize', scrollToBottom);

  autoResize();
  updateAskButton();
  loadStatus();
  loadHistory();
  loadMemory();
  el.input.focus();
})();
