/**
 * Front end for the agent.
 *
 * Talks only to this application's own /api — never to DeepSeek, and it never
 * sees the API key. The server is the source of truth: the chat is rebuilt from
 * the stored conversation on every load, and every token count comes from the
 * server, computed on the context that will actually be sent.
 *
 * Nothing here uses innerHTML. Every piece of chat, profile and memory content
 * is set with textContent, so text that looks like HTML is shown, never run.
 */
(() => {
  'use strict';

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
    openProfile: $('open-profile'),
    profileDot: $('profile-dot'),
    openMemory: $('open-memory'),

    profileDialog: $('profile-dialog'),
    profileForm: $('profile-form'),
    profileFields: $('profile-fields'),
    profileMeta: $('profile-meta'),
    profileStatus: $('profile-status'),
    profileClear: $('profile-clear'),
    profileDelete: $('profile-delete'),
    profileConfirm: $('profile-confirm'),
    profileDeleteYes: $('profile-delete-yes'),
    profileDeleteNo: $('profile-delete-no'),
    profileClose: $('profile-close'),

    memoryDialog: $('memory-dialog'),
    memoryLayers: $('memory-layers'),
    memoryStatus: $('memory-status'),
    memorySave: $('memory-save'),
    memoryCancel: $('memory-cancel'),
    memoryClose: $('memory-close'),
    contextPreview: $('context-preview'),
    layerTemplate: $('layer-template'),
  };

  const state = {
    busy: false,
    previewTimer: null,
    previewSeq: 0,
    tokens: null,
    profile: null,
    profileFields: [],
    memory: null,
    settingsDraft: {},
  };

  // --- Helpers ---------------------------------------------------------------

  const numberFormat = new Intl.NumberFormat('en-US');
  const approx = (n) => `~${numberFormat.format(Math.max(0, Math.round(Number(n) || 0)))}`;
  const pad = (n) => String(n).padStart(2, '0');

  /** "2026-09-16 09:15", in the reader's own time zone. Stored values are ISO 8601. */
  function formatDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

  // --- Chat ------------------------------------------------------------------

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

  /**
   * One chat bubble from a stored conversation entry. The tag ("you asked",
   * "agent answered") and the timestamp come from the server's record, so what
   * is on screen is what is on disk.
   */
  function createBubble(entry, updates) {
    const bubble = node('article', `bubble bubble--${entry.type}`);

    const head = node('header', 'bubble__head');
    head.append(node('span', 'bubble__tag', entry.tag));
    const time = node('time', 'bubble__time', formatDateTime(entry.timestamp));
    time.dateTime = entry.timestamp;
    head.append(time);

    const body = node('div', 'bubble__body');
    renderText(body, entry.content);

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
    const bubble = node('article', 'bubble bubble--assistant');
    const head = node('header', 'bubble__head');
    head.append(node('span', 'bubble__tag', 'agent is thinking'));
    const dots = node('div', 'thinking');
    dots.setAttribute('aria-label', 'Waiting for DeepSeek');
    dots.append(node('span'), node('span'), node('span'));
    bubble.append(head, dots);
    return bubble;
  }

  /** Plain sentences describing what the exchange saved, for the bubble footer. */
  function describeMemoryUpdates(updates) {
    if (!updates) return [];
    const notes = [];
    for (const { field, value } of updates.work ?? []) {
      notes.push(`work memory · ${labelForWorkField(field)}: ${shorten(value, 90)}`);
    }
    for (const update of updates.longTerm ?? []) {
      notes.push(update.category === 'solutions'
        ? `long-term solution · ${shorten(update.problem, 90)}`
        : `long-term knowledge · [${update.topic}] ${shorten(update.fact, 80)}`);
    }
    for (const { field, value } of updates.profile ?? []) {
      notes.push(`profile · ${field}: ${shorten(value, 90)}`);
    }
    return notes;
  }

  function labelForWorkField(field) {
    return state.memory?.fields?.work?.find((f) => f.id === field)?.label ?? field;
  }

  function atBottom() {
    return el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 80;
  }

  function scrollToBottom() {
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  /** Rebuild the whole chat from the server's conversation log. */
  function renderHistory(entries) {
    el.messages.replaceChildren();
    for (const entry of entries) el.messages.append(createBubble(entry));
    el.empty.hidden = entries.length > 0;
    scrollToBottom();
  }

  // --- Token statistics ------------------------------------------------------

  function renderTokens(tokens) {
    if (!tokens) return;
    state.tokens = tokens;

    for (const layer of ['shortTerm', 'work', 'longTerm', 'profile']) {
      $(`tokens-${layer}`).textContent = approx(tokens[layer]);
      $(`stat-${layer}`).classList.toggle('stat--empty', !tokens[layer]);
    }
    $('tokens-context').textContent = approx(tokens.currentContext);
    el.composerContext.textContent = approx(tokens.currentContext);
  }

  // --- Sending ---------------------------------------------------------------

  function setBusy(busy) {
    state.busy = busy;
    el.input.disabled = busy;
    updateAskButton();
  }

  function updateAskButton() {
    el.ask.disabled = state.busy || el.input.value.trim().length === 0;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = !message;
  }

  async function send(event) {
    event.preventDefault();
    const message = el.input.value.trim();
    if (!message || state.busy) return;
    if (message.length > MAX_CHARS) {
      showError(`The question is too long (limit ${numberFormat.format(MAX_CHARS)} characters).`);
      return;
    }

    showError('');
    setBusy(true);
    el.empty.hidden = true;

    // The question appears immediately; the server's own record replaces it
    // when the answer arrives, so ids and timestamps stay the server's.
    const optimistic = createBubble({
      type: 'user', tag: 'you asked', timestamp: new Date().toISOString(), content: message,
    });
    const pending = createPendingBubble();
    el.messages.append(optimistic, pending);
    scrollToBottom();

    try {
      const result = await api('/api/chat', { method: 'POST', body: { message } });

      optimistic.replaceWith(createBubble(result.request));
      pending.replaceWith(createBubble(result.reply, result.memoryUpdates));

      el.input.value = '';
      autosize();
      // Counts for memory as it stands after this exchange.
      renderTokens(result.memoryTokens);
      if (result.memoryUpdates?.profile?.length) await loadProfile();
      scrollToBottom();
    } catch (err) {
      pending.remove();
      optimistic.remove();
      showError(err.message);
      // The question is kept in the box so nothing typed is lost.
      el.input.value = message;
      autosize();
      // The server records failures in the log; reload it so the record and
      // the screen agree.
      await loadHistory().catch(() => {});
    } finally {
      setBusy(false);
      el.input.focus();
      schedulePreview();
    }
  }

  // --- Live context preview --------------------------------------------------

  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(runPreview, PREVIEW_DELAY_MS);
  }

  /**
   * Ask the server what the next request would cost with the current draft.
   * The server builds the real context for it, so the number in the UI and the
   * payload can never drift apart.
   */
  async function runPreview() {
    const seq = ++state.previewSeq;
    const message = el.input.value.slice(0, MAX_CHARS);
    try {
      const result = await api('/api/context/preview', { method: 'POST', body: { message } });
      if (seq === state.previewSeq) renderTokens(result.tokens);
    } catch {
      // A preview is a convenience; a failure must not interrupt the chat.
    }
  }

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
  }

  // --- Profile ---------------------------------------------------------------

  function profileStatus(message, kind = '') {
    el.profileStatus.textContent = message;
    el.profileStatus.className = `modal__status${kind ? ` modal__status--${kind}` : ''}`;
  }

  async function loadProfile() {
    const result = await api('/api/profile');
    applyProfile(result);
  }

  function applyProfile(result) {
    state.profile = result.profile;
    state.profileFields = result.fields;
    el.profileDot.hidden = result.empty;
    el.openProfile.title = result.empty
      ? 'No profile yet. It is attached to every request once you set it.'
      : 'Profile is set and attached to every request.';
    renderTokens(result.tokens);
    if (el.profileDialog.open) renderProfileFields();
    renderProfileMeta();
  }

  /** The profile form, built from the field definitions the server sent. */
  function renderProfileFields() {
    el.profileFields.replaceChildren();
    for (const field of state.profileFields) {
      const label = node('label', 'field');
      label.append(node('span', 'field__label', field.label));
      const control = field.id === 'name' ? node('input', 'field__control') : node('textarea', 'field__control');
      control.id = `profile-${field.id}`;
      control.name = field.id;
      control.maxLength = field.max;
      control.value = state.profile?.[field.id] ?? '';
      if (field.id === 'name') control.type = 'text';
      label.append(control, node('span', 'field__hint', field.hint));
      el.profileFields.append(label);
    }
  }

  function renderProfileMeta() {
    const { createdAt, updatedAt } = state.profile ?? {};
    const parts = [];
    if (createdAt) parts.push(`Created ${formatDateTime(createdAt)}`);
    if (updatedAt) parts.push(`last saved ${formatDateTime(updatedAt)}`);
    parts.push(`profile costs ${approx(state.tokens?.profile ?? 0)} tokens in every request`);
    el.profileMeta.textContent = `${parts.join(' · ')}.`;
  }

  function readProfileForm() {
    const values = {};
    for (const field of state.profileFields) {
      values[field.id] = $(`profile-${field.id}`)?.value ?? '';
    }
    return values;
  }

  function openProfileDialog() {
    renderProfileFields();
    renderProfileMeta();
    profileStatus('');
    el.profileConfirm.hidden = true;
    el.profileDialog.showModal();
  }

  async function saveProfile(event) {
    event.preventDefault();
    profileStatus('Saving…');
    try {
      const result = await api('/api/profile', { method: 'PUT', body: readProfileForm() });
      applyProfile(result);
      // In effect from the next request on: the preview already reflects it.
      profileStatus('Saved. It applies to your next question.', 'ok');
      schedulePreview();
    } catch (err) {
      profileStatus(err.message, 'error');
    }
  }

  async function clearProfileFields() {
    profileStatus('Clearing…');
    try {
      applyProfile(await api('/api/profile/clear', { method: 'POST' }));
      renderProfileFields();
      profileStatus('Every field is empty. The record is kept.', 'ok');
      schedulePreview();
    } catch (err) {
      profileStatus(err.message, 'error');
    }
  }

  async function deleteProfile() {
    profileStatus('Deleting…');
    try {
      applyProfile(await api('/api/profile', { method: 'DELETE' }));
      renderProfileFields();
      el.profileConfirm.hidden = true;
      profileStatus('Profile deleted.', 'ok');
      schedulePreview();
    } catch (err) {
      profileStatus(err.message, 'error');
    }
  }

  // --- Memory dialog ---------------------------------------------------------

  function memoryStatus(message, kind = '') {
    el.memoryStatus.textContent = message;
    el.memoryStatus.className = `modal__status${kind ? ` modal__status--${kind}` : ''}`;
  }

  async function openMemoryDialog() {
    memoryStatus('Loading…');
    el.memoryDialog.showModal();
    try {
      await loadMemory();
      memoryStatus('');
    } catch (err) {
      memoryStatus(err.message, 'error');
    }
    loadContextPreview();
  }

  async function loadMemory() {
    applyMemory(await api('/api/memory'));
  }

  function applyMemory(overview) {
    state.memory = overview;
    state.settingsDraft = {};
    renderTokens(overview.tokens);
    renderLayers();
    el.memorySave.disabled = true;
  }

  function renderLayers() {
    el.memoryLayers.replaceChildren();
    for (const layer of state.memory.layers) {
      el.memoryLayers.append(renderLayer(layer, state.memory.schema.find((s) => s.id === layer.id)));
    }
  }

  function renderLayer(layer, schema) {
    const card = el.layerTemplate.content.firstElementChild.cloneNode(true);
    const q = (selector) => card.querySelector(selector);

    q('.layer__title').textContent = layer.label;
    q('.layer__purpose').textContent = layer.purpose;
    const tokens = state.memory.tokens[layer.id];
    q('.layer__tokens').textContent = tokens === undefined
      ? 'not sent to DeepSeek'
      : `${approx(tokens)} tokens in context`;

    // Storage mode.
    const select = q('.layer__storage');
    for (const mode of schema.storageModes) {
      const option = node('option', null, `${mode.label} — ${mode.description}`);
      option.value = mode.mode;
      select.append(option);
    }
    select.value = layer.storage;
    select.addEventListener('change', () => stageSetting(layer.id, 'storage', select.value));

    // The one numeric setting a layer may have (short-term's "keep last N").
    if (schema.size) {
      const wrapper = q('.layer__size');
      wrapper.hidden = false;
      q('.layer__size-label').textContent = schema.size.label;
      const input = q('.layer__size-input');
      input.min = schema.size.min;
      input.max = schema.size.max;
      input.value = layer[schema.size.key];
      input.addEventListener('input', () => stageSetting(layer.id, schema.size.key, Number(input.value)));
    }

    q('.layer__note').textContent = layer.persistent
      ? `Stored in ${layer.location}/ — survives a restart.`
      : layer.enabled
        ? 'Kept in the server process only; lost on restart.'
        : 'Switched off: nothing is stored and nothing is sent to DeepSeek.';

    renderLayerContents(card, layer);

    // Long-term memory and the profile are meant to last, so those two ask first.
    const clear = q('.layer__clear');
    clear.textContent = layer.id === 'profile' ? 'Delete profile' : `Clear ${layer.label.toLowerCase()}`;
    const confirm = q('.layer__confirm');
    q('.confirm__text').textContent = layer.id === 'profile'
      ? 'Delete the profile? Style, format and limitations are lost.'
      : `Clear ${layer.label.toLowerCase()}? This cannot be undone.`;
    q('.confirm__yes').textContent = layer.id === 'profile' ? 'Yes, delete it' : 'Yes, clear it';

    clear.addEventListener('click', () => {
      if (layer.id === 'longTerm' || layer.id === 'profile') {
        confirm.hidden = false;
        clear.hidden = true;
      } else {
        clearLayer(layer.id);
      }
    });
    q('.confirm__yes').addEventListener('click', () => clearLayer(layer.id, true));
    q('.confirm__no').addEventListener('click', () => {
      confirm.hidden = true;
      clear.hidden = false;
    });

    return card;
  }

  /** Each layer shows its contents in the form that suits it. */
  function renderLayerContents(card, layer) {
    const host = card.querySelector('.layer__contents');
    const save = card.querySelector('.layer__save');

    switch (layer.id) {
      case 'work': {
        const editor = renderWorkEditor(layer.contents);
        host.append(editor.element);
        save.hidden = false;
        save.textContent = 'Save work memory';
        save.addEventListener('click', () => saveLayerContents('/api/memory/work', editor.read(), 'Work memory saved.'));
        break;
      }
      case 'longTerm': {
        const editor = renderLongTermEditor(layer.contents);
        host.append(editor.element);
        save.hidden = false;
        save.textContent = 'Save long-term memory';
        save.addEventListener('click', () => saveLayerContents('/api/memory/long-term', editor.read(), 'Long-term memory saved.'));
        break;
      }
      case 'profile': {
        const summary = node('pre', 'contents', formatProfileSummary(layer.contents));
        host.append(summary);
        const open = node('button', 'button button--ghost', 'Edit in the profile window');
        open.type = 'button';
        open.addEventListener('click', () => {
          el.memoryDialog.close();
          openProfileDialog();
        });
        host.append(open);
        break;
      }
      case 'shortTerm':
        host.append(renderMessageLog(layer.contents.map((m) => ({
          meta: `${m.role === 'user' ? 'you' : 'agent'} · ${formatDateTime(m.timestamp)}`,
          text: m.content,
        })), 'The window is empty. It fills up as you chat.'));
        break;
      case 'conversation':
        host.append(renderMessageLog(layer.contents.entries.map((entry) => ({
          meta: `${entry.tag} · ${entry.date} ${entry.time}`,
          text: entry.content,
        })), 'Nothing recorded yet.'));
        break;
      default:
        host.append(node('pre', 'contents', JSON.stringify(layer.contents, null, 2)));
    }
  }

  /** Work memory: one control per field, lists as one item per line. */
  function renderWorkEditor(task) {
    const element = node('div', 'editor');
    const controls = new Map();

    for (const field of state.memory.fields.work) {
      const label = node('label', 'field');
      label.append(node('span', 'field__label', field.label));
      const control = node('textarea', 'field__control');
      control.rows = field.kind === 'single' ? 2 : 3;
      control.value = field.kind === 'single'
        ? (task[field.id] ?? '')
        : (task[field.id] ?? []).join('\n');
      if (field.kind === 'list') label.append(node('span', 'field__hint', 'One entry per line.'));
      label.append(control);
      controls.set(field.id, { field, control });
      element.append(label);
    }

    return {
      element,
      read() {
        const values = {};
        for (const [id, { field, control }] of controls) {
          values[id] = field.kind === 'single'
            ? control.value.trim()
            : control.value.split('\n').map((line) => line.trim()).filter(Boolean);
        }
        return values;
      },
    };
  }

  /** Long-term memory: every solution and fact editable, each removable. */
  function renderLongTermEditor(contents) {
    const element = node('div', 'editor');
    const groups = {
      solutions: { title: 'Solutions', entries: [], host: node('div', 'editor') },
      knowledge: { title: 'Knowledge', entries: [], host: node('div', 'editor') },
    };

    for (const [category, group] of Object.entries(groups)) {
      element.append(node('h4', 'editor__group-title', group.title));
      element.append(group.host);

      const empty = node('p', 'editor__empty', category === 'solutions'
        ? 'No solutions kept yet.'
        : 'Nothing remembered yet.');
      group.host.append(empty);

      const addEntry = (entry) => {
        empty.hidden = true;
        const card = node('div', 'entry');
        const head = node('div', 'entry__head');
        head.append(node('span', 'entry__meta', entry.savedAt ? `saved ${formatDateTime(entry.savedAt)}` : 'new'));
        const remove = node('button', 'entry__remove', 'Remove');
        remove.type = 'button';
        head.append(remove);
        card.append(head);

        const fields = category === 'solutions'
          ? [['problem', 'Problem', 2], ['solution', 'Solution', 4]]
          : [['topic', 'Topic', 1], ['fact', 'Fact', 3]];
        const inputs = {};
        for (const [key, label, rows] of fields) {
          const wrapper = node('label', 'field');
          wrapper.append(node('span', 'field__label', label));
          const control = rows === 1 ? node('input', 'field__control') : node('textarea', 'field__control');
          if (rows > 1) control.rows = rows;
          control.value = entry[key] ?? '';
          wrapper.append(control);
          inputs[key] = control;
          card.append(wrapper);
        }

        const record = { id: entry.id, inputs, card, removed: false };
        remove.addEventListener('click', () => {
          record.removed = true;
          card.remove();
          if (!group.entries.some((e) => !e.removed)) empty.hidden = false;
        });
        group.entries.push(record);
        group.host.append(card);
      };

      for (const entry of contents[category] ?? []) addEntry(entry);

      const add = node('button', 'button button--ghost', `Add ${category === 'solutions' ? 'solution' : 'fact'}`);
      add.type = 'button';
      add.addEventListener('click', () => addEntry({}));
      element.append(add);
    }

    return {
      element,
      read() {
        const collect = (category) => groups[category].entries
          .filter((entry) => !entry.removed)
          .map((entry) => ({
            id: entry.id,
            ...Object.fromEntries(Object.entries(entry.inputs).map(([key, input]) => [key, input.value])),
          }));
        return { solutions: collect('solutions'), knowledge: collect('knowledge') };
      },
    };
  }

  function renderMessageLog(items, emptyText) {
    if (!items.length) return node('p', 'editor__empty', emptyText);
    const list = node('ul', 'log');
    for (const item of items) {
      const entry = node('li');
      entry.append(node('span', 'log__meta', item.meta));
      entry.append(node('span', 'log__text', shorten(item.text, 400)));
      list.append(entry);
    }
    return list;
  }

  function formatProfileSummary(profile) {
    // Field definitions come with the memory overview, so this does not depend
    // on /api/profile having answered first.
    const lines = state.memory.fields.profile
      .filter((field) => profile[field.id])
      .map((field) => `${field.label}: ${profile[field.id]}`);
    return lines.length ? lines.join('\n') : 'No profile set. Nothing is added to the request.';
  }

  /** Remember a changed control; nothing is sent until "Save storage settings". */
  function stageSetting(layerId, key, value) {
    state.settingsDraft[layerId] = { ...state.settingsDraft[layerId], [key]: value };
    el.memorySave.disabled = false;
    memoryStatus('Unsaved changes.');
  }

  async function saveSettings() {
    if (!Object.keys(state.settingsDraft).length) return;
    memoryStatus('Saving…');
    el.memorySave.disabled = true;
    try {
      const result = await api('/api/settings', { method: 'POST', body: { memory: state.settingsDraft } });
      applyMemory(result);
      memoryStatus('Settings saved.', 'ok');
      await loadHistory();
      loadContextPreview();
    } catch (err) {
      memoryStatus(err.message, 'error');
      el.memorySave.disabled = false;
    }
  }

  async function saveLayerContents(url, body, okMessage) {
    memoryStatus('Saving…');
    try {
      applyMemory(await api(url, { method: 'PUT', body }));
      memoryStatus(okMessage, 'ok');
      loadContextPreview();
    } catch (err) {
      memoryStatus(err.message, 'error');
    }
  }

  async function clearLayer(layerId, confirm = false) {
    memoryStatus('Clearing…');
    try {
      applyMemory(await api('/api/memory/clear', { method: 'POST', body: { layer: layerId, confirm } }));
      memoryStatus('Cleared.', 'ok');
      if (layerId === 'conversation') await loadHistory();
      if (layerId === 'profile') await loadProfile();
      loadContextPreview();
    } catch (err) {
      memoryStatus(err.message, 'error');
    }
  }

  async function loadContextPreview() {
    try {
      const result = await api('/api/context/preview', {
        method: 'POST',
        body: { message: el.input.value.slice(0, MAX_CHARS), includeMessages: true },
      });
      el.contextPreview.textContent = result.messages
        .map((m) => `[${m.role}]\n${m.content}`)
        .join('\n\n');
      renderTokens(result.tokens);
    } catch (err) {
      el.contextPreview.textContent = err.message;
    }
  }

  // --- Boot ------------------------------------------------------------------

  async function loadHistory() {
    const result = await api('/api/history');
    renderHistory(result.entries);
    renderTokens(result.tokens);
  }

  async function loadStatus() {
    const status = await api('/api/status');
    el.model.textContent = status.deepseek.model;
    if (!status.deepseek.configured) {
      el.banner.textContent = 'DEEPSEEK_API_KEY is not set on the server. '
        + 'The conversation and memory work, but questions will fail until the key is configured.';
      el.banner.hidden = false;
    }
  }

  function wire() {
    el.form.addEventListener('submit', send);
    el.input.addEventListener('input', () => {
      updateAskButton();
      autosize();
      schedulePreview();
    });
    el.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        el.form.requestSubmit();
      }
    });

    el.openProfile.addEventListener('click', openProfileDialog);
    el.profileForm.addEventListener('submit', saveProfile);
    el.profileClose.addEventListener('click', () => el.profileDialog.close());
    el.profileClear.addEventListener('click', clearProfileFields);
    el.profileDelete.addEventListener('click', () => {
      el.profileConfirm.hidden = false;
    });
    el.profileDeleteYes.addEventListener('click', deleteProfile);
    el.profileDeleteNo.addEventListener('click', () => {
      el.profileConfirm.hidden = true;
    });

    el.openMemory.addEventListener('click', openMemoryDialog);
    el.memoryClose.addEventListener('click', () => el.memoryDialog.close());
    el.memoryCancel.addEventListener('click', () => el.memoryDialog.close());
    el.memorySave.addEventListener('click', saveSettings);

    // Clicking the backdrop closes a dialog, as the rest of the web does.
    for (const dialog of [el.profileDialog, el.memoryDialog]) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    }

    // Keep the newest message in view when the window is resized.
    window.addEventListener('resize', () => {
      if (atBottom()) scrollToBottom();
    });
  }

  async function boot() {
    wire();
    autosize();
    updateAskButton();

    const results = await Promise.allSettled([loadStatus(), loadHistory(), loadProfile(), loadMemory()]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) showError(failure.reason?.message ?? 'Could not load the application state.');

    schedulePreview();
    el.input.focus();
  }

  boot();
})();
