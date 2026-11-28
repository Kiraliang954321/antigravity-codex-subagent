import {
  App,
  McpUiOpenLinkResultSchema,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/app-with-deps';
import { tFor } from './i18n.js';
import {
  escapeHtml,
  lookupFileUri,
  parseDiffByFile,
  renderDiff,
  renderMarkdown,
  stripCodexFooter,
} from './markdown.js';

const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INITIAL_SNAPSHOT_WAIT_MS = 120;
const SAFE_AVATAR_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

const SVG_DEFS = `
  <svg class="svg-defs" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="gemini-sparkle-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#3b82f6" />
        <stop offset="100%" stop-color="#7c5cff" />
      </linearGradient>
    </defs>
  </svg>
`;

const ICON_GEMINI_SVG = `
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path fill="url(#gemini-sparkle-grad)" d="M12 2.2C12.4 7.7 16.3 11.6 21.8 12C16.3 12.4 12.4 16.3 12 21.8C11.6 16.3 7.7 12.4 2.2 12C7.7 11.6 11.6 7.7 12 2.2Z" />
  </svg>
`;

const ICON_CODEX_SVG = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="4" />
    <path d="M8.5 9.5l3 2.5-3 2.5" />
    <path d="M13 14.5h3" />
  </svg>
`;

const ICON_GEAR_SVG = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
`;

const AVATAR_PRESET_SVGS = Object.freeze({
  spark: `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="url(#gemini-sparkle-grad)" d="M12 2.2C12.4 7.7 16.3 11.6 21.8 12C16.3 12.4 12.4 16.3 12 21.8C11.6 16.3 7.7 12.4 2.2 12C7.7 11.6 11.6 7.7 12 2.2Z" /></svg>`,
  terminal: ICON_CODEX_SVG,
  bot: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3" /><circle cx="12" cy="2.5" r="0.8" fill="currentColor" /><rect x="4" y="6.5" width="16" height="13" rx="4" /><circle cx="9.2" cy="12.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="14.8" cy="12.5" r="1.1" fill="currentColor" stroke="none" /><path d="M9.5 16h5" /></svg>`,
  cube: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4.5 7.3v9.4L12 21l7.5-4.3V7.3L12 3Z" /><path d="M4.5 7.3 12 11.6l7.5-4.3" /><path d="M12 11.6V21" /></svg>`,
  bolt: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2.5 5 13.5h6.5L10.5 21.5 19 10.5h-6.5L13 2.5Z" /></svg>`,
  orbit: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-28 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(28 12 12)" /></svg>`,
  cat: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 10V4.5L9.5 7.5a7.5 7.5 0 0 1 5 0L19 4.5V10a6.8 6.8 0 0 1 1 3.6c0 3.7-3.4 6.4-8 6.4s-8-2.7-8-6.4A6.8 6.8 0 0 1 5 10Z" /><circle cx="9.2" cy="12.6" r="0.9" fill="currentColor" stroke="none" /><circle cx="14.8" cy="12.6" r="0.9" fill="currentColor" stroke="none" /><path d="M10.7 15.5c.8.6 1.8.6 2.6 0" /></svg>`,
  shield: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5.5c0 4.6 3 8.4 7 9.5 4-1.1 7-4.9 7-9.5V6l-7-3Z" /><path d="m9.2 12.2 2 2 3.8-4" /></svg>`,
});

const ICON_TRACE_OK_SVG = `
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 8.2l1.8 1.8 3.4-3.6" />
  </svg>
`;

const ICON_TRACE_ERR_SVG = `
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5.2v3.3" />
    <circle cx="8" cy="11.1" r="0.6" fill="currentColor" stroke="none" />
  </svg>
`;

const ICON_NOTE_SVG = `
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
    <path d="M8 2.2a4.3 4.3 0 0 0-2.6 7.72c.45.34.72.84.72 1.38v.45h3.76v-.45c0-.54.27-1.04.72-1.38A4.3 4.3 0 0 0 8 2.2Z" />
    <path d="M6.4 13.8h3.2" stroke-linecap="round" />
  </svg>
`;

const app = new App({ name: 'codex-subagent-monitor', version: '0.5.0' }, {}, { autoResize: false });

const state = {
  connected: false,
  hydrated: false,
  initialSnapshotApplied: false,
  cursorEpoch: null,
  capabilities: {},
  locale: 'en-US',
  conversations: [],
  search: '',
  selectedId: null,
  preferredInitialId: null,
  convCache: new Map(), // conversationId -> { conversation, eventsById, order, nextSeq, truncated, liveJob, fileLinksByPath, needsFullHydration }
  expandedPanels: new Set(),
  collapsedPanels: new Set(),
  busyAction: false,
  confirmStep: null, // null | 'close' | 'clear_history'
  forkOpen: false,
  toast: null, // { kind: 'info'|'success'|'error', text }
  nearBottom: true,
  pollTimer: null,
  pollInFlight: false,
  lastDockSignature: '',
  lastRenderedConvKey: '',
  renderNonce: 0,
  settings: {
    roles: {
      gemini: { name: null, avatar: null },
      codex: { name: null, avatar: null },
    },
    codex: { model: null, reasoningEffort: null },
    updatedAt: null,
  },
  settingsMeta: {
    codexConfig: {
      synced: false,
      model: null,
      reasoningEffort: null,
      catalogDefaultModel: null,
      catalogDefaultReasoningEffort: null,
      catalogAvailable: false,
      overridden: false,
      overriddenMessage: null,
      error: null,
    },
    defaults: {
      model: null,
      reasoningEffort: null,
      envModel: null,
      envReasoningEffort: null,
    },
    effective: { model: null, reasoningEffort: null },
    options: {
      models: [],
      reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      avatarPresets: ['spark', 'terminal', 'bot', 'cube', 'bolt', 'orbit', 'cat', 'shield'],
    },
    limits: {
      maxNameLength: 40,
      maxModelLength: 128,
      maxEmojiLength: 16,
      maxEmojiBytes: 32,
      maxAvatarDataUrlChars: 65536,
    },
  },
  settingsLoaded: false,
  settingsSyncing: false,
  settingsVersion: 0,
  settingsOpen: false,
  settingsDraft: null,
  settingsDraftDirty: false,
  codexDraftDirty: false,
  modelMenuOpen: false,
  customModelMode: false,
  settingsBusy: false,
};

let shellRefs = null;
let toastTimer = null;
let snapshotWaitResolve = null;

function strings() {
  return tFor(state.locale);
}

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme === 'dark' || ctx.theme === 'light') {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  if (typeof ctx.locale === 'string' && ctx.locale) {
    state.locale = ctx.locale;
  }
}

function showToast(kind, text, ttlMs = 3500) {
  state.toast = { kind, text };
  clearTimeout(toastTimer);
  renderToast();
  if (ttlMs > 0) {
    toastTimer = setTimeout(() => {
      state.toast = null;
      renderToast();
    }, ttlMs);
  }
}

function parseToolPayload(result) {
  if (!result) return null;
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = (result.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function extractErrorText(result, fallback = 'Operation failed') {
  const payload = parseToolPayload(result);
  const text = (result?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return payload?.error || text || fallback;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function formatClockTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function formatChatTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatFullTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function formatHumanDuration(ms, { subSecond = false } = {}) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const s = strings();
  if (subSecond && ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec === 0 && ms > 0) {
    return subSecond ? '0.1s' : `1${s.durationSecUnit}`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins > 0) {
    return s.durationMinUnit === 'm'
      ? `${mins}m ${secs}s`
      : `${mins}${s.durationMinUnit}${secs}${s.durationSecUnit}`;
  }
  return `${totalSec}${s.durationSecUnit}`;
}

function formatCommandLabel(rawCmd) {
  const raw = String(rawCmd ?? '').trim();
  if (!raw) return 'Command';
  let inner = raw;
  const pwshMatch = /^(?:"[^"]*[/\\](?:pwsh|powershell)(?:\.exe)?"|(?:pwsh|powershell)(?:\.exe)?)\s+(?:-[A-Za-z]+\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(inner);
  if (pwshMatch) {
    inner = pwshMatch[1].trim();
  } else {
    const shMatch = /^(?:cmd(?:\.exe)?\s+\/c|\/bin\/(?:ba|z)?sh\s+-[a-z]*c)\s+([\s\S]+)$/i.exec(inner);
    if (shMatch) {
      inner = shMatch[1].trim();
    }
  }
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
    inner = inner.slice(1, -1);
  }
  return inner.replace(/\s+/g, ' ').trim() || raw;
}

function shortId(value) {
  if (typeof value !== 'string') return '';
  return value.length > 14 ? `${value.slice(0, 8)}…` : value;
}

function getSelectedEntry() {
  if (!state.selectedId) return null;
  const fromCache = state.convCache.get(state.selectedId);
  const fromList = state.conversations.find((item) => item.conversationId === state.selectedId) ?? null;
  return {
    meta: fromCache?.conversation ?? fromList,
    cache: fromCache ?? null,
  };
}

function bumpRenderNonce() {
  state.renderNonce += 1;
  state.lastRenderedConvKey = '';
}

function buildShell() {
  const root = document.getElementById('app');
  const s = strings();
  root.innerHTML = `
    ${SVG_DEFS}
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-copy">
            <span id="brand-title" class="brand-title">${escapeHtml(s.appTitle)}</span>
            <span id="brand-subtitle" class="brand-subtitle">${escapeHtml(s.brandSubtitle)}</span>
          </div>
        </div>
        <div class="picker-wrap">
          <select id="conv-picker" class="picker" aria-label="Conversations"></select>
        </div>
        <div class="topbar-spacer"></div>
        <div class="topbar-controls">
          <button id="settings-btn" type="button" class="icon-btn icon-btn-gear" title="${escapeHtml(s.settings)}" aria-label="${escapeHtml(s.settings)}" aria-haspopup="dialog" aria-expanded="false">${ICON_GEAR_SVG}</button>
          <button id="refresh-btn" type="button" class="icon-btn" title="${escapeHtml(s.refresh)}">↻ <span id="refresh-label">${escapeHtml(s.refresh)}</span></button>
        </div>
      </header>
      <div class="workspace">
        <aside class="sidebar">
          <div class="sidebar-search">
            <input id="sidebar-search" class="search-input" type="search" placeholder="${escapeHtml(s.searchPlaceholder)}" />
          </div>
          <div id="sidebar-list" class="sidebar-list"></div>
        </aside>
        <section class="main-pane">
          <div id="status-strip" class="status-strip" hidden></div>
          <div id="timeline" class="timeline"></div>
          <button id="jump-latest" type="button" class="jump-pill" hidden>${escapeHtml(s.jumpLatest)}</button>
          <div id="toast" class="toast" hidden></div>
          <div id="dock" class="dock" hidden></div>
        </section>
      </div>
    </div>
    <div id="settings-modal-root" class="settings-modal-root" hidden></div>
  `;

  shellRefs = {
    brandTitle: document.getElementById('brand-title'),
    brandSubtitle: document.getElementById('brand-subtitle'),
    picker: document.getElementById('conv-picker'),
    settingsBtn: document.getElementById('settings-btn'),
    refreshBtn: document.getElementById('refresh-btn'),
    refreshLabel: document.getElementById('refresh-label'),
    searchInput: document.getElementById('sidebar-search'),
    sidebarList: document.getElementById('sidebar-list'),
    statusStrip: document.getElementById('status-strip'),
    timeline: document.getElementById('timeline'),
    jumpLatest: document.getElementById('jump-latest'),
    toast: document.getElementById('toast'),
    dock: document.getElementById('dock'),
    settingsModalRoot: document.getElementById('settings-modal-root'),
  };

  shellRefs.picker.addEventListener('change', (ev) => {
    selectConversation(ev.target.value);
  });

  shellRefs.settingsBtn.addEventListener('click', () => {
    if (state.settingsOpen) closeSettingsModal();
    else openSettingsModal();
  });

  shellRefs.refreshBtn.addEventListener('click', () => {
    void pollOnce({ forceFull: false });
  });

  bindSettingsModalEvents();

  shellRefs.searchInput.addEventListener('input', (ev) => {
    state.search = ev.target.value;
    renderSidebar();
  });

  shellRefs.sidebarList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-conv-id]');
    if (btn) selectConversation(btn.dataset.convId);
  });

  shellRefs.timeline.addEventListener('scroll', () => {
    const el = shellRefs.timeline;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    state.nearBottom = distance < 64;
    shellRefs.jumpLatest.hidden = state.nearBottom;
  });

  shellRefs.jumpLatest.addEventListener('click', () => {
    state.nearBottom = true;
    shellRefs.timeline.scrollTop = shellRefs.timeline.scrollHeight;
    shellRefs.jumpLatest.hidden = true;
  });

  shellRefs.timeline.addEventListener('toggle', (ev) => {
    const details = ev.target.closest('details[data-panel-key]');
    if (!details || !shellRefs.timeline.contains(details)) return;
    const key = details.dataset.panelKey;
    if (details.open) {
      state.expandedPanels.add(key);
      state.collapsedPanels.delete(key);
    } else {
      state.expandedPanels.delete(key);
      state.collapsedPanels.add(key);
    }
  }, true);

  shellRefs.timeline.addEventListener('click', (ev) => {
    const fileBtn = ev.target.closest('[data-file-uri]');
    if (fileBtn) {
      void openFileInPane(fileBtn.dataset.fileUri);
      return;
    }
    const extLink = ev.target.closest('[data-ext-link]');
    if (extLink) {
      ev.preventDefault();
      if (state.capabilities?.openLinks) {
        void app.openLink({ url: extLink.dataset.extLink }).catch(() => {});
      }
      return;
    }
    const copyCodeBtn = ev.target.closest('.copy-code-btn');
    if (copyCodeBtn) {
      const code = copyCodeBtn.closest('.code-wrap')?.querySelector('code')?.textContent ?? '';
      void copyText(code).then((ok) => {
        if (ok) {
          copyCodeBtn.textContent = strings().copied;
          setTimeout(() => { copyCodeBtn.textContent = strings().copy; }, 1500);
        }
      });
      return;
    }
    const copyAnsBtn = ev.target.closest('[data-copy-event]');
    if (copyAnsBtn) {
      const text = getEventAnswerBody(copyAnsBtn.dataset.copyEvent);
      if (text) {
        void copyText(text).then((ok) => {
          if (ok) showToast('success', strings().copied, 1800);
        });
      }
      return;
    }
    const attachBtn = ev.target.closest('[data-attach-event]');
    if (attachBtn) {
      void handleHandoffToGemini(attachBtn.dataset.attachEvent, false);
      return;
    }
    const sendBtn = ev.target.closest('[data-send-event]');
    if (sendBtn) {
      void handleHandoffToGemini(sendBtn.dataset.sendEvent, true);
      return;
    }
    const toggleBtn = ev.target.closest('[data-toggle-panel]');
    if (toggleBtn) {
      const key = toggleBtn.dataset.togglePanel;
      const defaultOpen = toggleBtn.dataset.defaultOpen === '1';
      const isOpen = defaultOpen ? !state.collapsedPanels.has(key) : state.expandedPanels.has(key);
      if (isOpen) {
        state.expandedPanels.delete(key);
        state.collapsedPanels.add(key);
      } else {
        state.expandedPanels.add(key);
        state.collapsedPanels.delete(key);
      }
      bumpRenderNonce();
      renderTimeline(true);
    }
  });

  shellRefs.statusStrip.addEventListener('click', (ev) => {
    const compactBtn = ev.target.closest('[data-quick-compact]');
    if (compactBtn) {
      void runLifecycleAction('compact');
    }
  });

  shellRefs.dock.addEventListener('click', (ev) => {
    const actionBtn = ev.target.closest('[data-dock-action]');
    if (!actionBtn) return;
    const act = actionBtn.dataset.dockAction;
    if (act === 'submit-steer') {
      const input = shellRefs.dock.querySelector('#steer-input');
      if (input) void submitSteer(input.value, input);
    } else if (act === 'submit-fork') {
      const input = shellRefs.dock.querySelector('#fork-target-input');
      if (input) void submitFork(input.value.trim());
    } else if (act === 'cancel') void runLifecycleAction('cancel');
    else if (act === 'compact') void runLifecycleAction('compact');
    else if (act === 'open-fork') {
      state.forkOpen = !state.forkOpen;
      state.confirmStep = null;
      renderDock(true);
    } else if (act === 'cancel-fork') {
      state.forkOpen = false;
      renderDock(true);
    } else if (act === 'close') {
      if (state.confirmStep === 'close') {
        state.confirmStep = null;
        void runLifecycleAction('close');
      } else {
        state.confirmStep = 'close';
        renderDock(true);
      }
    } else if (act === 'clear_history') {
      if (state.confirmStep === 'clear_history') {
        state.confirmStep = null;
        void runLifecycleAction('clear_history');
      } else {
        state.confirmStep = 'clear_history';
        renderDock(true);
      }
    }
  });

  shellRefs.dock.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'steer-input' && ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void submitSteer(ev.target.value, ev.target);
    } else if (ev.target.id === 'fork-target-input' && ev.key === 'Enter') {
      ev.preventDefault();
      void submitFork(ev.target.value.trim());
    }
  });
}

function getEventAnswerBody(eventId) {
  const entry = getSelectedEntry();
  const ev = entry?.cache?.eventsById.get(eventId);
  if (!ev?.text) return '';
  return stripCodexFooter(ev.text).body || ev.text;
}

function buildHandoffText(meta, ev) {
  const header = meta?.sessionKey
    ? `Codex session \`${meta.sessionKey}\` (${meta.threadId ?? ''})`
    : `Codex thread ${meta?.threadId ?? meta?.conversationId ?? ''}`;
  const cleanBody = stripCodexFooter(ev.text ?? '').body || (ev.text ?? '');
  return `From ${header}:\n\n${cleanBody}`;
}

async function handleHandoffToGemini(eventId, sendImmediately) {
  const s = strings();
  const entry = getSelectedEntry();
  const ev = entry?.cache?.eventsById.get(eventId);
  if (!ev || !ev.text) return;
  const text = buildHandoffText(entry.meta, ev);
  try {
    if (sendImmediately) {
      if (!state.capabilities?.message) return;
      const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
      if (res?.isError) {
        showToast('error', s.errorLabel);
      } else {
        showToast('success', s.sentGemini);
      }
    } else {
      if (!state.capabilities?.updateModelContext) return;
      await app.updateModelContext({ content: [{ type: 'text', text }] });
      showToast('success', s.attachedGemini);
    }
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  }
}

async function openFileInPane(uri) {
  if (!uri) return;
  try {
    const res = await app.request(
      { method: 'com.google.antigravity/toggle-aux-pane', params: { tabType: 'fileView', uri } },
      McpUiOpenLinkResultSchema,
    );
    if (res?.isError) {
      showToast('info', strings().filePaneUnsupported);
    }
  } catch {
    showToast('info', strings().filePaneUnsupported);
  }
}

function selectConversation(conversationId) {
  if (!conversationId || conversationId === state.selectedId) return;
  state.selectedId = conversationId;
  state.confirmStep = null;
  state.forkOpen = false;
  state.nearBottom = true;
  bumpRenderNonce();
  renderChrome();
  renderAllPanels(true);
  const cached = state.convCache.get(conversationId);
  const forceFull = !cached || cached.needsFullHydration;
  void refreshConversation(conversationId, { forceFull }).then(() => {
    renderAllPanels(false);
    scheduleNextPoll();
  });
}

function getRoleDefaultName(role) {
  const s = strings();
  return role === 'gemini' ? s.roleGemini : s.roleCodex;
}

function getRoleName(role) {
  const custom = state.settings?.roles?.[role]?.name;
  return typeof custom === 'string' && custom.trim() ? custom.trim() : getRoleDefaultName(role);
}

function renderRoleAvatarHtml(role, avatarOverride, extraClass = '') {
  const avatar = avatarOverride !== undefined ? avatarOverride : state.settings?.roles?.[role]?.avatar;
  const cls = `avatar-badge avatar-${role}${extraClass ? ` ${extraClass}` : ''}`;
  if (avatar?.type === 'image' && typeof avatar.value === 'string' && SAFE_AVATAR_IMAGE_RE.test(avatar.value)) {
    return `<span class="${cls} has-img" aria-hidden="true"><img class="avatar-img" src="${escapeHtml(avatar.value)}" alt="" /></span>`;
  }
  if (avatar?.type === 'emoji' && typeof avatar.value === 'string' && avatar.value) {
    return `<span class="${cls}" aria-hidden="true"><span class="avatar-emoji">${escapeHtml(avatar.value)}</span></span>`;
  }
  if (avatar?.type === 'preset' && typeof avatar.value === 'string' && Object.hasOwn(AVATAR_PRESET_SVGS, avatar.value)) {
    return `<span class="${cls}" aria-hidden="true">${AVATAR_PRESET_SVGS[avatar.value]}</span>`;
  }
  const fallbackSvg = role === 'gemini' ? ICON_GEMINI_SVG : ICON_CODEX_SVG;
  return `<span class="${cls}" aria-hidden="true">${fallbackSvg}</span>`;
}

function getSelectedModelEntry(modelId) {
  const target = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (!target) return null;
  const models = state.settingsMeta?.options?.models ?? [];
  return models.find((entry) => entry.model.toLowerCase() === target || String(entry.id || '').toLowerCase() === target) ?? null;
}

function getEffortOptionsForModel(modelId) {
  const entry = getSelectedModelEntry(modelId);
  if (entry?.supportedReasoningEfforts?.length) {
    return entry.supportedReasoningEfforts;
  }
  const fallback = state.settingsMeta?.options?.reasoningEfforts?.length
    ? state.settingsMeta.options.reasoningEfforts
    : ['low', 'medium', 'high', 'xhigh'];
  return fallback.map((reasoningEffort) => ({ reasoningEffort, description: '' }));
}

function resolvedCodexDraftDefaults() {
  const cfg = state.settingsMeta?.codexConfig ?? {};
  const model = cfg.model ?? state.settings?.codex?.model ?? cfg.catalogDefaultModel ?? state.settingsMeta?.effective?.model ?? null;
  const entry = getSelectedModelEntry(model);
  const rawEffort = cfg.reasoningEffort
    ?? state.settings?.codex?.reasoningEffort
    ?? entry?.defaultReasoningEffort
    ?? cfg.catalogDefaultReasoningEffort
    ?? state.settingsMeta?.effective?.reasoningEffort
    ?? null;
  const effortOptions = getEffortOptionsForModel(model);
  const matchedEffort = rawEffort
    ? (effortOptions.find((opt) => opt.reasoningEffort.toLowerCase() === String(rawEffort).toLowerCase())?.reasoningEffort ?? rawEffort)
    : (entry?.defaultReasoningEffort ?? effortOptions[0]?.reasoningEffort ?? null);
  return {
    model: model || null,
    reasoningEffort: matchedEffort || null,
  };
}

function getEffortLabel(effortKey) {
  const s = strings();
  const key = effortKey || 'default';
  return s.effortOptions?.[key] ?? key;
}

function syncSettingsButtonState() {
  if (!shellRefs?.settingsBtn) return;
  shellRefs.settingsBtn.classList.toggle('active', state.settingsOpen);
  shellRefs.settingsBtn.setAttribute('aria-expanded', state.settingsOpen ? 'true' : 'false');
}

function applySettingsPayload(payload) {
  if (!payload?.settings || typeof payload.settings !== 'object') return false;
  const incomingRoles = payload.settings.roles ?? {};
  const incomingCodex = payload.settings.codex ?? {};
  const cfg = payload.codexConfig ?? {};
  state.settings = {
    version: payload.settings.version ?? 1,
    updatedAt: payload.settings.updatedAt ?? null,
    roles: {
      gemini: {
        name: incomingRoles.gemini?.name ?? null,
        avatar: incomingRoles.gemini?.avatar ? { ...incomingRoles.gemini.avatar } : null,
      },
      codex: {
        name: incomingRoles.codex?.name ?? null,
        avatar: incomingRoles.codex?.avatar ? { ...incomingRoles.codex.avatar } : null,
      },
    },
    codex: {
      model: incomingCodex.model ?? null,
      reasoningEffort: incomingCodex.reasoningEffort ?? null,
    },
  };
  state.settingsMeta = {
    codexConfig: {
      synced: Boolean(cfg.synced),
      model: cfg.model ?? null,
      reasoningEffort: cfg.reasoningEffort ?? null,
      catalogDefaultModel: cfg.catalogDefaultModel ?? null,
      catalogDefaultReasoningEffort: cfg.catalogDefaultReasoningEffort ?? null,
      catalogAvailable: Boolean(cfg.catalogAvailable),
      overridden: Boolean(cfg.overridden),
      overriddenMessage: cfg.overriddenMessage ?? null,
      error: cfg.error ?? null,
    },
    defaults: {
      model: payload.defaults?.model ?? null,
      reasoningEffort: payload.defaults?.reasoningEffort ?? null,
      envModel: payload.defaults?.envModel ?? null,
      envReasoningEffort: payload.defaults?.envReasoningEffort ?? null,
    },
    effective: {
      model: payload.effective?.model ?? null,
      reasoningEffort: payload.effective?.reasoningEffort ?? null,
    },
    options: {
      models: Array.isArray(payload.options?.models)
        ? payload.options.models.map((entry) => ({
            ...entry,
            supportedReasoningEfforts: Array.isArray(entry.supportedReasoningEfforts)
              ? entry.supportedReasoningEfforts.map((opt) => ({ ...opt }))
              : [],
          }))
        : [],
      reasoningEfforts: Array.isArray(payload.options?.reasoningEfforts)
        ? [...payload.options.reasoningEfforts]
        : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      avatarPresets: Array.isArray(payload.options?.avatarPresets)
        ? [...payload.options.avatarPresets]
        : ['spark', 'terminal', 'bot', 'cube', 'bolt', 'orbit', 'cat', 'shield'],
    },
    limits: {
      maxNameLength: payload.limits?.maxNameLength ?? 40,
      maxModelLength: payload.limits?.maxModelLength ?? 128,
      maxEmojiLength: payload.limits?.maxEmojiLength ?? 16,
      maxEmojiBytes: payload.limits?.maxEmojiBytes ?? 32,
      maxAvatarDataUrlChars: payload.limits?.maxAvatarDataUrlChars ?? 65536,
    },
  };
  state.settingsLoaded = true;
  state.settingsVersion += 1;
  return true;
}

async function loadSettings({ silent = true, syncCodex = true } = {}) {
  if (!state.connected) return false;
  if (syncCodex) {
    state.settingsSyncing = true;
    if (state.settingsOpen) renderCodexConfigSection();
  }
  try {
    const res = await app.callServerTool({
      name: 'codex_ui_get_settings',
      arguments: syncCodex ? { syncCodex: true } : { syncCodex: false },
    });
    if (res?.isError) {
      if (!silent) showToast('error', extractErrorText(res));
      return false;
    }
    const payload = parseToolPayload(res);
    if (!applySettingsPayload(payload)) return false;
    if (state.settingsOpen && state.settingsDraft) {
      if (!state.settingsDraftDirty) {
        state.settingsDraft.roles = structuredClone(state.settings.roles);
      }
      if (!state.codexDraftDirty) {
        const resolved = resolvedCodexDraftDefaults();
        state.settingsDraft.codex = { ...resolved };
        state.customModelMode = Boolean(
          resolved.model
          && state.settingsMeta.options.models.length > 0
          && !getSelectedModelEntry(resolved.model),
        );
      }
      if (!state.settingsDraftDirty && !state.codexDraftDirty && !shellRefs?.settingsModalRoot?.contains(document.activeElement)) {
        renderSettingsModal();
      } else {
        renderCodexConfigSection();
      }
    }
    bumpRenderNonce();
    renderStatusStrip();
    renderTimeline(true);
    return true;
  } catch (err) {
    if (!silent) showToast('error', err?.message || strings().errorLabel);
    return false;
  } finally {
    if (syncCodex) {
      state.settingsSyncing = false;
      if (state.settingsOpen) renderCodexConfigSection();
    }
  }
}

function openSettingsModal() {
  const resolved = resolvedCodexDraftDefaults();
  state.settingsOpen = true;
  state.settingsDraftDirty = false;
  state.codexDraftDirty = false;
  state.modelMenuOpen = false;
  state.customModelMode = Boolean(
    resolved.model
    && (state.settingsMeta?.options?.models?.length ?? 0) > 0
    && !getSelectedModelEntry(resolved.model),
  );
  state.settingsDraft = structuredClone(state.settings);
  state.settingsDraft.codex = { ...resolved };
  syncSettingsButtonState();
  renderSettingsModal();
  const focusTarget = shellRefs?.settingsModalRoot?.querySelector('[data-role-name="gemini"]');
  focusTarget?.focus();
  if (state.connected) {
    void loadSettings({ silent: false, syncCodex: true });
  }
}

function closeSettingsModal() {
  if (state.settingsBusy) return;
  state.settingsOpen = false;
  state.settingsDraft = null;
  state.settingsDraftDirty = false;
  state.codexDraftDirty = false;
  state.modelMenuOpen = false;
  state.customModelMode = false;
  syncSettingsButtonState();
  renderSettingsModal();
}

function syncRoleAvatarSelection(role) {
  const root = shellRefs?.settingsModalRoot;
  if (!root || !state.settingsDraft) return;
  const card = root.querySelector(`[data-role-card="${role}"]`);
  if (!card) return;
  const av = state.settingsDraft.roles?.[role]?.avatar ?? null;
  const previewWrap = card.querySelector(`[data-role-preview-avatar="${role}"]`);
  if (previewWrap) {
    previewWrap.innerHTML = renderRoleAvatarHtml(role, av);
  }
  const defBtn = card.querySelector(`[data-role-avatar-default="${role}"]`);
  if (defBtn) defBtn.classList.toggle('selected', !av);
  for (const tile of card.querySelectorAll('[data-role-preset]')) {
    tile.classList.toggle('selected', av?.type === 'preset' && av.value === tile.dataset.rolePreset);
  }
}

function renderCodexEffortFieldHtml() {
  const s = strings();
  const draft = state.settingsDraft ?? state.settings;
  const currentModel = (draft?.codex?.model ?? '').trim();
  const currentEffort = (draft?.codex?.reasoningEffort ?? '').trim().toLowerCase();
  const effortOptions = getEffortOptionsForModel(currentModel);
  const disabledAttr = state.settingsBusy ? ' disabled' : '';

  const effortButtons = effortOptions.map((opt) => {
    const sel = currentEffort && opt.reasoningEffort.toLowerCase() === currentEffort ? ' selected' : '';
    return `<button type="button" class="seg-btn${sel}" data-codex-effort="${escapeHtml(opt.reasoningEffort)}"${opt.description ? ` title="${escapeHtml(opt.description)}"` : ''}${disabledAttr}>${escapeHtml(getEffortLabel(opt.reasoningEffort))}</button>`;
  }).join('');

  const selectedOpt = effortOptions.find((opt) => currentEffort && opt.reasoningEffort.toLowerCase() === currentEffort);
  return `
    <span class="settings-field-label">${escapeHtml(s.settingsEffortLabel)}</span>
    <div class="effort-segment">${effortButtons}</div>
    ${selectedOpt?.description ? `<div class="effort-desc">${escapeHtml(selectedOpt.description)}</div>` : ''}
  `;
}

function renderCodexEffortField() {
  const field = shellRefs?.settingsModalRoot?.querySelector('[data-codex-effort-field="1"]');
  if (field) {
    field.innerHTML = renderCodexEffortFieldHtml();
  }
}

function renderCodexConfigSectionHtml() {
  const s = strings();
  const draft = state.settingsDraft ?? state.settings;
  const limits = state.settingsMeta?.limits ?? {};
  const codexConfig = state.settingsMeta?.codexConfig ?? {};
  const defaults = state.settingsMeta?.defaults ?? {};
  const models = state.settingsMeta?.options?.models ?? [];
  const trimmedModel = String(draft?.codex?.model ?? '').trim();
  const selectedEntry = getSelectedModelEntry(trimmedModel);
  const showDropdown = models.length > 0 && !state.customModelMode;
  const disabledAttr = state.settingsBusy ? ' disabled' : '';
  const syncDisabledAttr = (state.settingsBusy || state.settingsSyncing) ? ' disabled' : '';

  let syncStatusHtml = '';
  if (state.settingsSyncing) {
    syncStatusHtml = `<span class="codex-sync-status">${escapeHtml(s.settingsSyncing)}</span>`;
  } else if (codexConfig.synced && codexConfig.catalogAvailable) {
    syncStatusHtml = `<span class="codex-sync-status ok">${escapeHtml(s.settingsSynced)}</span>`;
  } else if (codexConfig.error || state.settingsLoaded) {
    syncStatusHtml = `<span class="codex-sync-status warn">${escapeHtml(s.settingsSyncFailed)}</span>`;
  }

  let modelControlHtml = '';
  if (showDropdown) {
    const triggerTitle = selectedEntry?.displayName || trimmedModel || s.settingsModelSelectPlaceholder;
    const triggerSlug = selectedEntry && selectedEntry.displayName.toLowerCase() !== selectedEntry.model.toLowerCase()
      ? selectedEntry.model
      : '';
    const menuHtml = state.modelMenuOpen ? `
      <div class="codex-model-menu" role="listbox" aria-label="${escapeHtml(s.settingsModelLabel)}">
        <div class="codex-model-menu-head">${escapeHtml(s.settingsModelRecommended)}</div>
        <div class="codex-model-menu-list">
          ${models.map((entry) => {
            const isSel = selectedEntry
              ? entry.model.toLowerCase() === selectedEntry.model.toLowerCase()
              : trimmedModel.toLowerCase() === entry.model.toLowerCase();
            return `
              <button type="button" class="codex-model-option${isSel ? ' selected' : ''}" role="option" aria-selected="${isSel ? 'true' : 'false'}" data-codex-model-pick="${escapeHtml(entry.model)}"${disabledAttr}>
                <span class="codex-model-option-main">
                  <span class="codex-model-option-top">
                    <span class="codex-model-option-title">${escapeHtml(entry.displayName)}</span>
                    ${entry.isDefault ? `<span class="codex-model-default-tag">${escapeHtml(s.settingsModelBadgeDefault)}</span>` : ''}
                  </span>
                  ${entry.description ? `<span class="codex-model-option-desc" title="${escapeHtml(entry.description)}">${escapeHtml(entry.description)}</span>` : ''}
                </span>
                ${isSel ? '<span class="codex-model-check" aria-hidden="true">✓</span>' : ''}
              </button>
            `;
          }).join('')}
        </div>
        <div class="codex-model-menu-foot">
          <button type="button" class="link-toggle-btn" data-codex-custom-toggle="1"${disabledAttr}>${escapeHtml(s.settingsModelUseCustom)}</button>
        </div>
      </div>
    ` : '';

    modelControlHtml = `
      <div class="settings-field">
        <span class="settings-field-label">${escapeHtml(s.settingsModelLabel)}</span>
        <div class="codex-model-picker" data-codex-model-picker="1">
          <button type="button" class="codex-model-trigger" data-codex-model-toggle="1" aria-expanded="${state.modelMenuOpen ? 'true' : 'false'}"${disabledAttr}>
            <span class="codex-model-trigger-main">
              <span class="codex-model-name">${escapeHtml(triggerTitle)}</span>
              ${triggerSlug ? `<span class="codex-model-slug">${escapeHtml(triggerSlug)}</span>` : ''}
            </span>
            <span class="codex-model-caret" aria-hidden="true">▾</span>
          </button>
          ${menuHtml}
        </div>
      </div>
    `;
  } else {
    modelControlHtml = `
      <label class="settings-field">
        <span class="settings-field-label">${escapeHtml(s.settingsModelLabel)}</span>
        <div class="codex-model-custom-row">
          <input id="codex-model-input" type="text" class="settings-input mono" data-codex-model="1" maxlength="${limits.maxModelLength ?? 128}" value="${escapeHtml(draft?.codex?.model ?? '')}" placeholder="${escapeHtml(s.settingsModelPlaceholderCustom)}"${disabledAttr} />
          ${models.length > 0 ? `<button type="button" class="btn" data-codex-custom-toggle="0"${disabledAttr}>${escapeHtml(s.settingsModelBackToList)}</button>` : ''}
        </div>
      </label>
    `;
  }

  const envVars = [];
  if (defaults.envModel) envVars.push('CODEX_MODEL');
  if (defaults.envReasoningEffort) envVars.push('CODEX_REASONING_EFFORT');
  const envWarnHtml = envVars.length > 0
    ? `<div class="settings-env-warn">${escapeHtml(`${s.settingsEnvOverridePrefix}${envVars.join(', ')}${s.settingsEnvOverrideSuffix}`)}</div>`
    : '';
  const layerWarnHtml = codexConfig.overridden
    ? `<div class="settings-env-warn">${escapeHtml(`${s.settingsModelOverridden}${codexConfig.overriddenMessage ? ` ${codexConfig.overriddenMessage}` : ''}`)}</div>`
    : '';

  return `
    <div class="settings-section-head">
      <div class="settings-section-title">${escapeHtml(s.settingsCodexSection)}</div>
      <div class="codex-sync-controls">
        ${syncStatusHtml}
        <button type="button" class="mini-btn codex-sync-btn" data-codex-sync="1"${syncDisabledAttr}>↻ ${escapeHtml(s.settingsSync)}</button>
      </div>
    </div>
    <div class="codex-config-card">
      ${modelControlHtml}
      <div class="settings-field" data-codex-effort-field="1">
        ${renderCodexEffortFieldHtml()}
      </div>
      ${envWarnHtml}
      ${layerWarnHtml}
      <div class="settings-hint">${escapeHtml(s.settingsModelHint)}</div>
    </div>
  `;
}

function renderCodexConfigSection() {
  const sec = shellRefs?.settingsModalRoot?.querySelector('[data-codex-section="1"]');
  if (sec) {
    sec.innerHTML = renderCodexConfigSectionHtml();
  }
}

async function processAvatarFile(file) {
  if (!(file instanceof File)) throw new Error('Invalid file');
  const mimeType = String(file.type || '').toLowerCase();
  if (mimeType.includes('svg')) throw new Error('SVG not supported');

  const rawDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Read failed'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Image decode failed'));
    el.src = rawDataUrl;
  });

  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) throw new Error('Empty image');
  const side = Math.min(sw, sh);
  const sx = Math.floor((sw - side) / 2);
  const sy = Math.floor((sh - side) / 2);

  const encodeAt = (size, mime, quality) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return quality !== undefined ? canvas.toDataURL(mime, quality) : canvas.toDataURL(mime);
  };

  const maxChars = state.settingsMeta?.limits?.maxAvatarDataUrlChars ?? 65536;
  const attempts = [
    () => encodeAt(128, 'image/webp', 0.86),
    () => encodeAt(96, 'image/jpeg', 0.82),
    () => encodeAt(64, 'image/png'),
  ];
  for (const attempt of attempts) {
    const out = attempt();
    if (SAFE_AVATAR_IMAGE_RE.test(out) && out.length <= maxChars) {
      return out;
    }
  }
  throw new Error('Encoded avatar exceeds limit');
}

async function handleAvatarFileSelect(role, fileInput) {
  const file = fileInput?.files?.[0];
  if (fileInput) fileInput.value = '';
  if (!file || !state.settingsDraft || state.settingsBusy) return;
  try {
    const dataUrl = await processAvatarFile(file);
    state.settingsDraftDirty = true;
    state.settingsDraft.roles[role].avatar = { type: 'image', value: dataUrl };
    renderSettingsModal();
  } catch {
    showToast('error', strings().settingsAvatarError, 3200);
  }
}

async function saveSettings() {
  if (!state.settingsDraft || state.settingsBusy || !state.connected) return;
  const s = strings();
  const roles = {};
  for (const role of ['gemini', 'codex']) {
    const draftRole = state.settingsDraft.roles?.[role] ?? {};
    const cleanName = typeof draftRole.name === 'string' ? (draftRole.name.trim() || null) : null;
    let cleanAvatar = draftRole.avatar ? { ...draftRole.avatar } : null;
    if (cleanAvatar?.type === 'emoji') {
      const em = String(cleanAvatar.value ?? '').trim();
      cleanAvatar = em ? { type: 'emoji', value: em } : null;
    }
    roles[role] = { name: cleanName, avatar: cleanAvatar };
  }
  const args = { roles };
  if (state.codexDraftDirty) {
    const cleanModel = typeof state.settingsDraft.codex?.model === 'string'
      ? (state.settingsDraft.codex.model.trim() || null)
      : null;
    const cleanEffort = typeof state.settingsDraft.codex?.reasoningEffort === 'string'
      ? (state.settingsDraft.codex.reasoningEffort.trim() || null)
      : null;
    args.codex = { model: cleanModel, reasoningEffort: cleanEffort };
  }

  state.settingsBusy = true;
  renderSettingsModal();
  try {
    const res = await app.callServerTool({
      name: 'codex_ui_update_settings',
      arguments: args,
    });
    if (res?.isError) {
      showToast('error', extractErrorText(res));
      return;
    }
    const payload = parseToolPayload(res);
    applySettingsPayload(payload);
    state.settingsOpen = false;
    state.settingsDraft = null;
    state.settingsDraftDirty = false;
    state.codexDraftDirty = false;
    state.modelMenuOpen = false;
    state.customModelMode = false;
    syncSettingsButtonState();
    showToast('success', s.settingsSaved, 2400);
    bumpRenderNonce();
    renderAllPanels(true);
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  } finally {
    state.settingsBusy = false;
    renderSettingsModal();
  }
}

async function resetAllSettings() {
  if (state.settingsBusy || !state.connected) return;
  const s = strings();
  state.settingsBusy = true;
  renderSettingsModal();
  try {
    const res = await app.callServerTool({
      name: 'codex_ui_update_settings',
      arguments: { reset: true },
    });
    if (res?.isError) {
      showToast('error', extractErrorText(res));
      return;
    }
    const payload = parseToolPayload(res);
    applySettingsPayload(payload);
    const resolved = resolvedCodexDraftDefaults();
    state.settingsDraft = structuredClone(state.settings);
    state.settingsDraft.codex = { ...resolved };
    state.settingsDraftDirty = false;
    state.codexDraftDirty = false;
    state.modelMenuOpen = false;
    state.customModelMode = Boolean(
      resolved.model
      && (state.settingsMeta?.options?.models?.length ?? 0) > 0
      && !getSelectedModelEntry(resolved.model),
    );
    showToast('info', s.settingsResetDone, 2400);
    bumpRenderNonce();
    renderAllPanels(true);
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  } finally {
    state.settingsBusy = false;
    renderSettingsModal();
  }
}

function renderRoleConfigCardHtml(role) {
  const s = strings();
  const draftRole = state.settingsDraft?.roles?.[role] ?? { name: null, avatar: null };
  const limits = state.settingsMeta?.limits ?? {};
  const presets = state.settingsMeta?.options?.avatarPresets ?? [];
  const defaultName = getRoleDefaultName(role);
  const previewName = typeof draftRole.name === 'string' && draftRole.name.trim() ? draftRole.name.trim() : defaultName;
  const badgeTitle = role === 'gemini' ? s.settingsRoleGemini : s.settingsRoleCodex;
  const av = draftRole.avatar ?? null;
  const emojiValue = av?.type === 'emoji' ? av.value : '';
  const disabledAttr = state.settingsBusy ? ' disabled' : '';

  const presetTilesHtml = presets.map((presetId) => {
    const sel = av?.type === 'preset' && av.value === presetId ? ' selected' : '';
    const iconSvg = AVATAR_PRESET_SVGS[presetId] ?? '';
    return `<button type="button" class="preset-tile${sel}" data-role-target="${role}" data-role-preset="${escapeHtml(presetId)}" title="${escapeHtml(presetId)}"${disabledAttr}>${iconSvg}</button>`;
  }).join('');

  return `
    <div class="role-config-card" data-role-card="${role}">
      <div class="role-card-head">
        <span class="role-card-badge">${escapeHtml(badgeTitle)}</span>
      </div>
      <div class="role-preview-row">
        <span data-role-preview-avatar="${role}">${renderRoleAvatarHtml(role, av)}</span>
        <span class="role-preview-name" data-role-preview-name="${role}">${escapeHtml(previewName)}</span>
      </div>
      <label class="settings-field">
        <span class="settings-field-label">${escapeHtml(s.settingsNameLabel)}</span>
        <input type="text" class="settings-input" data-role-name="${role}" maxlength="${limits.maxNameLength ?? 40}" value="${escapeHtml(draftRole.name ?? '')}" placeholder="${escapeHtml(`${s.settingsNamePlaceholderPrefix} ${defaultName}`)}"${disabledAttr} />
      </label>
      <div class="settings-field">
        <span class="settings-field-label">${escapeHtml(s.settingsAvatarLabel)}</span>
        <div class="avatar-presets-grid">
          <button type="button" class="preset-tile${!av ? ' selected' : ''}" data-role-avatar-default="${role}"${disabledAttr}>${escapeHtml(s.settingsAvatarDefault)}</button>
          ${presetTilesHtml}
        </div>
        <div class="avatar-custom-row">
          <input type="text" class="settings-input emoji-input" data-role-emoji="${role}" maxlength="${limits.maxEmojiLength ?? 16}" value="${escapeHtml(emojiValue)}" placeholder="${escapeHtml(s.settingsAvatarEmojiPlaceholder)}"${disabledAttr} />
          <button type="button" class="btn" data-role-upload-trigger="${role}"${disabledAttr}>${escapeHtml(s.settingsAvatarUpload)}</button>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="file-input-hidden" data-role-file-input="${role}"${disabledAttr} />
        </div>
      </div>
    </div>
  `;
}

function renderSettingsModal() {
  const root = shellRefs?.settingsModalRoot;
  if (!root) return;
  if (!state.settingsOpen) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;
  const s = strings();
  const disabledAttr = state.settingsBusy ? ' disabled' : '';

  root.innerHTML = `
    <div class="settings-backdrop" data-settings-backdrop="1">
      <div class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
        <div class="settings-head">
          <h2 id="settings-modal-title" class="settings-title">${escapeHtml(s.settingsTitle)}</h2>
          <button type="button" class="icon-btn settings-close-btn" data-settings-close="1" aria-label="${escapeHtml(s.settingsClose)}" title="${escapeHtml(s.settingsClose)}"${disabledAttr}>×</button>
        </div>
        <div class="settings-body">
          <section class="settings-section">
            <div class="settings-section-title">${escapeHtml(s.settingsRolesSection)}</div>
            <div class="role-cards-grid">
              ${renderRoleConfigCardHtml('gemini')}
              ${renderRoleConfigCardHtml('codex')}
            </div>
          </section>
          <section class="settings-section" data-codex-section="1">
            ${renderCodexConfigSectionHtml()}
          </section>
        </div>
        <div class="settings-foot">
          <button type="button" class="btn btn-danger" data-settings-action="reset-all"${disabledAttr}>${escapeHtml(s.settingsResetAll)}</button>
          <div class="settings-foot-right">
            <button type="button" class="btn" data-settings-close="1"${disabledAttr}>${escapeHtml(s.settingsCancel)}</button>
            <button type="button" class="btn btn-primary" data-settings-action="save"${disabledAttr}>${escapeHtml(state.settingsBusy ? s.settingsSaving : s.settingsSave)}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindSettingsModalEvents() {
  const root = shellRefs?.settingsModalRoot;
  if (!root) return;

  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-settings-close]')) {
      closeSettingsModal();
      return;
    }
    if (ev.target.dataset?.settingsBackdrop === '1') {
      closeSettingsModal();
      return;
    }
    if (state.modelMenuOpen && !ev.target.closest('[data-codex-model-picker]')) {
      state.modelMenuOpen = false;
      renderCodexConfigSection();
    }
    const defBtn = ev.target.closest('[data-role-avatar-default]');
    if (defBtn && state.settingsDraft) {
      const role = defBtn.dataset.roleAvatarDefault;
      state.settingsDraftDirty = true;
      state.settingsDraft.roles[role].avatar = null;
      const emojiInput = root.querySelector(`[data-role-emoji="${role}"]`);
      if (emojiInput) emojiInput.value = '';
      syncRoleAvatarSelection(role);
      return;
    }
    const presetBtn = ev.target.closest('[data-role-preset]');
    if (presetBtn && state.settingsDraft) {
      const role = presetBtn.dataset.roleTarget;
      const presetId = presetBtn.dataset.rolePreset;
      state.settingsDraftDirty = true;
      state.settingsDraft.roles[role].avatar = { type: 'preset', value: presetId };
      const emojiInput = root.querySelector(`[data-role-emoji="${role}"]`);
      if (emojiInput) emojiInput.value = '';
      syncRoleAvatarSelection(role);
      return;
    }
    const uploadBtn = ev.target.closest('[data-role-upload-trigger]');
    if (uploadBtn) {
      const role = uploadBtn.dataset.roleUploadTrigger;
      root.querySelector(`[data-role-file-input="${role}"]`)?.click();
      return;
    }
    const syncBtn = ev.target.closest('[data-codex-sync]');
    if (syncBtn && !state.settingsSyncing && !state.settingsBusy) {
      state.codexDraftDirty = false;
      void loadSettings({ silent: false, syncCodex: true });
      return;
    }
    const toggleBtn = ev.target.closest('[data-codex-model-toggle]');
    if (toggleBtn && state.settingsDraft) {
      state.modelMenuOpen = !state.modelMenuOpen;
      renderCodexConfigSection();
      return;
    }
    const pickBtn = ev.target.closest('[data-codex-model-pick]');
    if (pickBtn && state.settingsDraft) {
      const pickedModel = pickBtn.dataset.codexModelPick || '';
      state.codexDraftDirty = true;
      state.modelMenuOpen = false;
      state.customModelMode = false;
      state.settingsDraft.codex.model = pickedModel || null;
      const entry = getSelectedModelEntry(pickedModel);
      if (entry?.supportedReasoningEfforts?.length) {
        const curEff = String(state.settingsDraft.codex.reasoningEffort ?? '').trim().toLowerCase();
        const supported = entry.supportedReasoningEfforts.some((opt) => opt.reasoningEffort.toLowerCase() === curEff);
        if (!supported) {
          state.settingsDraft.codex.reasoningEffort = entry.defaultReasoningEffort || entry.supportedReasoningEfforts[0].reasoningEffort;
        }
      }
      renderCodexConfigSection();
      return;
    }
    const customToggle = ev.target.closest('[data-codex-custom-toggle]');
    if (customToggle && state.settingsDraft) {
      const enableCustom = customToggle.dataset.codexCustomToggle === '1';
      state.customModelMode = enableCustom;
      state.modelMenuOpen = false;
      renderCodexConfigSection();
      if (enableCustom) {
        root.querySelector('#codex-model-input')?.focus();
      }
      return;
    }
    const effortBtn = ev.target.closest('[data-codex-effort]');
    if (effortBtn && state.settingsDraft) {
      const eff = effortBtn.dataset.codexEffort || '';
      state.codexDraftDirty = true;
      state.settingsDraft.codex.reasoningEffort = eff || null;
      renderCodexEffortField();
      return;
    }
    const actionBtn = ev.target.closest('[data-settings-action]');
    if (actionBtn) {
      if (actionBtn.dataset.settingsAction === 'save') void saveSettings();
      else if (actionBtn.dataset.settingsAction === 'reset-all') void resetAllSettings();
    }
  });

  root.addEventListener('input', (ev) => {
    if (!state.settingsDraft) return;
    if (ev.target.dataset?.roleName) {
      const role = ev.target.dataset.roleName;
      state.settingsDraftDirty = true;
      state.settingsDraft.roles[role].name = ev.target.value;
      const previewEl = root.querySelector(`[data-role-preview-name="${role}"]`);
      if (previewEl) {
        previewEl.textContent = ev.target.value.trim() || getRoleDefaultName(role);
      }
      return;
    }
    if (ev.target.dataset?.roleEmoji) {
      const role = ev.target.dataset.roleEmoji;
      state.settingsDraftDirty = true;
      const cleaned = ev.target.value.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\u200D' || c === '\uFE0F' ? c : '')).trim();
      if (cleaned) {
        state.settingsDraft.roles[role].avatar = { type: 'emoji', value: cleaned };
      } else if (state.settingsDraft.roles[role].avatar?.type === 'emoji') {
        state.settingsDraft.roles[role].avatar = null;
      }
      syncRoleAvatarSelection(role);
      return;
    }
    if (ev.target.dataset?.codexModel) {
      state.codexDraftDirty = true;
      state.settingsDraft.codex.model = ev.target.value;
      renderCodexEffortField();
    }
  });

  root.addEventListener('change', (ev) => {
    if (ev.target.dataset?.roleFileInput) {
      void handleAvatarFileSelect(ev.target.dataset.roleFileInput, ev.target);
    }
  });
}

function renderChrome() {
  if (!shellRefs) return;
  const s = strings();
  shellRefs.brandTitle.textContent = s.appTitle;
  shellRefs.brandSubtitle.textContent = s.brandSubtitle;
  shellRefs.settingsBtn.title = s.settings;
  shellRefs.settingsBtn.setAttribute('aria-label', s.settings);
  shellRefs.refreshLabel.textContent = s.refresh;
  shellRefs.refreshBtn.title = s.refresh;
  shellRefs.searchInput.placeholder = s.searchPlaceholder;
  shellRefs.jumpLatest.textContent = s.jumpLatest;
  if (state.settingsOpen) renderSettingsModal();
}

function renderPicker() {
  if (!shellRefs) return;
  const s = strings();
  const picker = shellRefs.picker;
  picker.innerHTML = '';
  if (!state.hydrated && state.conversations.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = s.loadingMonitor;
    picker.appendChild(opt);
    picker.disabled = true;
    return;
  }
  if (state.conversations.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = s.noConversations;
    picker.appendChild(opt);
    picker.disabled = true;
    return;
  }
  picker.disabled = false;
  for (const conv of state.conversations) {
    const opt = document.createElement('option');
    opt.value = conv.conversationId;
    const labelStatus = s.status[conv.status] ?? conv.status;
    const pct = conv.tokenUsage?.utilizationPct != null ? ` · ${conv.tokenUsage.utilizationPct}%` : '';
    opt.textContent = `[${labelStatus}] ${conv.sessionKey || conv.title || conv.conversationId}${pct}`;
    if (conv.conversationId === state.selectedId) opt.selected = true;
    picker.appendChild(opt);
  }
}

function renderSidebar() {
  if (!shellRefs) return;
  const s = strings();
  if (!state.hydrated && state.conversations.length === 0) {
    shellRefs.sidebarList.innerHTML = `<div class="empty-state"><div class="empty-title">${escapeHtml(s.loadingMonitor)}</div></div>`;
    return;
  }
  const q = state.search.trim().toLowerCase();
  const filtered = state.conversations.filter((conv) => {
    if (!q) return true;
    return [conv.title, conv.sessionKey, conv.threadId, conv.conversationId, conv.lastPreview]
      .filter(Boolean)
      .some((val) => String(val).toLowerCase().includes(q));
  });

  if (filtered.length === 0) {
    shellRefs.sidebarList.innerHTML = `<div class="empty-state"><div class="empty-title">${escapeHtml(s.noConversations)}</div><div>${escapeHtml(s.noConversationsHint)}</div></div>`;
    return;
  }

  const groups = {
    running: [],
    sessions: [],
    history: [],
  };

  for (const conv of filtered) {
    if (conv.status === 'running') {
      groups.running.push(conv);
    } else if (conv.kind === 'session' && conv.status !== 'closed') {
      groups.sessions.push(conv);
    } else {
      groups.history.push(conv);
    }
  }

  const sections = [
    [s.groupRunning, groups.running],
    [s.groupSessions, groups.sessions],
    [s.groupHistory, groups.history],
  ].filter(([, items]) => items.length > 0);

  shellRefs.sidebarList.innerHTML = sections
    .map(([title, items]) => {
      const rows = items
        .map((conv) => {
          const active = conv.conversationId === state.selectedId ? ' active' : '';
          const statusLabel = s.status[conv.status] ?? conv.status;
          const pct = conv.tokenUsage?.utilizationPct != null ? `${conv.tokenUsage.utilizationPct}%` : '';
          const turnStr = conv.turnCount ? `${conv.turnCount}${s.turnCountUnit}` : '';
          const metaLeft = [turnStr, pct].filter(Boolean).join(' · ') || conv.kind;
          return `
            <button type="button" class="conv-item${active}" data-conv-id="${escapeHtml(conv.conversationId)}">
              <div class="conv-row">
                <span class="conv-title">${escapeHtml(conv.sessionKey || conv.title || conv.conversationId)}</span>
                <span class="pill pill-${escapeHtml(conv.status)}">${conv.status === 'running' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(statusLabel)}</span>
              </div>
              <div class="conv-row">
                <span class="conv-meta">${escapeHtml(metaLeft)}</span>
                <span class="conv-meta" title="${escapeHtml(formatFullTime(conv.updatedAt))}">${escapeHtml(formatChatTime(conv.updatedAt))}</span>
              </div>
            </button>
          `;
        })
        .join('');
      return `<div class="group-label">${escapeHtml(title)}</div>${rows}`;
    })
    .join('');
}

function renderStatusStrip() {
  if (!shellRefs) return;
  const entry = getSelectedEntry();
  const meta = entry?.meta;
  if (!meta) {
    shellRefs.statusStrip.hidden = true;
    return;
  }
  shellRefs.statusStrip.hidden = false;
  const s = strings();
  const liveJob = entry.cache?.liveJob;
  const telemetry = liveJob?.telemetry;
  const phase = telemetry?.phase;
  const phaseLabel = phase ? (s.phase[phase] ?? phase) : '';
  const status = liveJob?.status ?? meta.status;
  const statusLabel = s.status[status] ?? status;
  const usage = telemetry?.tokenUsage ?? meta.tokenUsage;
  const pct = usage?.utilizationPct;
  const pctClass = pct >= 80 ? 'high' : pct >= 65 ? 'warn' : '';
  const isSessionOpen = meta.kind === 'session' && meta.status !== 'closed';
  const showQuickCompact = pct >= 80 && isSessionOpen && status !== 'running';

  const tokenText = usage
    ? usage.modelContextWindow
      ? `${usage.totalTokens.toLocaleString()} / ${usage.modelContextWindow.toLocaleString()} (${pct ?? 0}%)`
      : `${usage.totalTokens.toLocaleString()} ${s.contextUnknown}`
    : '';

  const subtitleParts = [`${getRoleName('gemini')} → ${getRoleName('codex')}`];
  if (meta.turnCount) subtitleParts.push(`${meta.turnCount}${s.turnCountUnit}`);
  if (tokenText) subtitleParts.push(tokenText);

  const metricParts = [];
  if (meta.threadId) metricParts.push(`<span class="badge" title="${escapeHtml(meta.threadId)}">${escapeHtml(shortId(meta.threadId))}</span>`);
  if (liveJob?.elapsedMs != null) metricParts.push(`<span>${escapeHtml(s.elapsedPrefix)}: ${escapeHtml(formatHumanDuration(liveJob.elapsedMs))}</span>`);
  if (telemetry?.idleMs != null && liveJob?.status === 'running') metricParts.push(`<span>${escapeHtml(s.idlePrefix)}: ${escapeHtml(formatHumanDuration(telemetry.idleMs))}</span>`);

  shellRefs.statusStrip.innerHTML = `
    <div class="status-top">
      <div class="status-title-group">
        <div class="status-left">
          <span class="conv-heading">${escapeHtml(meta.sessionKey || meta.title || meta.conversationId)}</span>
          <span class="pill pill-${escapeHtml(status)}">${status === 'running' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(statusLabel)}</span>
          ${phaseLabel && status === 'running' ? `<span class="pill">${escapeHtml(phaseLabel)}</span>` : ''}
        </div>
        <div class="status-subtitle">${escapeHtml(subtitleParts.join(' · '))}</div>
      </div>
      <div class="status-metrics">${metricParts.join('')}</div>
    </div>
    ${usage?.modelContextWindow || pct >= 80 ? `
      <div class="ctx-bar-wrap">
        ${usage?.modelContextWindow ? `<div class="ctx-track"><div class="ctx-fill ${pctClass}" style="width:${Math.min(100, Math.max(2, pct ?? 0))}%"></div></div>` : ''}
        ${pct >= 80 ? `<span class="pill pill-warning">${escapeHtml(s.highUsageWarning)}</span>` : ''}
        ${showQuickCompact ? `<button type="button" class="mini-btn btn-warning" data-quick-compact="1">${escapeHtml(s.compactNow)}</button>` : ''}
      </div>
    ` : ''}
  `;
}

function renderPlanHtml(plan, compact = false) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return '';
  const s = strings();
  const rows = plan.steps
    .map((step) => {
      const mark = step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '●' : '○';
      return `<li class="plan-step step-${escapeHtml(step.status)}"><span class="step-mark">${mark}</span><span>${escapeHtml(step.step)}</span></li>`;
    })
    .join('');
  return `
    <div class="plan-card${compact ? ' plan-card-nested' : ''}">
      <div class="plan-title">${escapeHtml(s.planTitle)}${plan.explanation ? ` — ${escapeHtml(plan.explanation)}` : ''}</div>
      <ul class="plan-steps">${rows}</ul>
    </div>
  `;
}

function groupTimelineItems(ordered, meta, liveJob) {
  const blocks = [];
  const turnsByJob = new Map();
  let anonymousCount = 0;
  let delegationCount = 0;

  const ensureTurn = (jobId, anchorAt) => {
    let turn = turnsByJob.get(jobId);
    if (!turn) {
      turn = {
        kind: 'turn',
        jobId,
        turnKey: jobId,
        turnIndex: null,
        model: null,
        reasoningEffort: null,
        delegationAt: null,
        delegations: [],
        steers: [],
        activities: [],
        streams: [],
        latestPlan: null,
        diffs: [],
        terminals: [],
        hasTerminalEvent: false,
        inserted: false,
        startedAt: anchorAt,
        updatedAt: anchorAt,
      };
      turnsByJob.set(jobId, turn);
    }
    return turn;
  };

  for (const ev of ordered) {
    if (!ev.jobId) {
      blocks.push({ kind: 'standalone', event: ev, key: `solo:${ev.eventId ?? ++anonymousCount}` });
      continue;
    }

    const turn = ensureTurn(ev.jobId, ev.at);
    turn.updatedAt = ev.at;

    if (ev.type === 'delegation') {
      delegationCount += 1;
      turn.turnIndex = delegationCount;
      if (ev.model) turn.model = ev.model;
      if (ev.reasoningEffort) turn.reasoningEffort = ev.reasoningEffort;
      if (!turn.delegationAt) turn.delegationAt = ev.at;
      turn.delegations.push(ev);
      blocks.push({ kind: 'delegation', event: ev, turnIndex: delegationCount, key: `del:${ev.eventId}` });
      if (liveJob?.jobId === ev.jobId && liveJob?.status === 'running' && meta.status === 'running' && !turn.inserted) {
        turn.inserted = true;
        blocks.push(turn);
      }
      continue;
    }

    if (!turn.inserted) {
      turn.inserted = true;
      blocks.push(turn);
    }

    if (ev.type === 'steer') {
      turn.steers.push(ev);
    } else if (ev.type === 'plan') {
      turn.latestPlan = ev;
    } else if (ev.type === 'diff') {
      turn.diffs.push(ev);
    } else if (ev.type === 'activity') {
      turn.activities.push(ev);
    } else if (ev.type === 'stream') {
      if (ev.superseded !== true) {
        turn.streams.push(ev);
      }
    } else if (ev.type === 'answer' || ev.type === 'compact' || ev.type === 'cancel') {
      turn.terminals.push(ev);
      turn.hasTerminalEvent = true;
    }
  }

  return blocks;
}

function summarizeTurnWork(turn, meta, liveJob) {
  const effectiveStatus = liveJob?.status ?? meta.status;
  const isTurnActive = Boolean(
    effectiveStatus === 'running'
    && liveJob?.status === 'running'
    && turn.jobId === liveJob.jobId
    && !turn.hasTerminalEvent,
  );

  // Build commentary notes (prefer completed activity text, deduped by itemId)
  const notesById = new Map();
  const completedCommentaryIds = new Set();
  for (const act of turn.activities) {
    if (act.kind !== 'commentary') continue;
    const key = act.itemId || act.eventId;
    const text = typeof act.summary?.text === 'string' ? act.summary.text.trim() : '';
    if (act.phase === 'completed' && act.itemId && text) {
      completedCommentaryIds.add(act.itemId);
    }
    const existing = notesById.get(key) ?? { id: key, text: '', phase: act.phase, at: act.at };
    if (text) existing.text = text;
    if (act.phase === 'completed') existing.phase = 'completed';
    existing.at = act.at;
    notesById.set(key, existing);
  }
  const commentaryNotes = [...notesById.values()].filter((n) => n.text);

  // Pair commands cleanly by itemId + attach commandOutput stream
  const cmdStreamsByItem = new Map();
  for (const st of turn.streams) {
    if (st.channel === 'commandOutput') {
      cmdStreamsByItem.set(st.itemId || st.eventId, st);
    }
  }
  const cmdsById = new Map();
  for (const act of turn.activities) {
    if (act.kind !== 'commandExecution') continue;
    const key = act.itemId || act.eventId;
    const rec = cmdsById.get(key) ?? {
      id: key,
      command: '',
      exitCode: null,
      startedAt: null,
      completedAt: null,
      completed: false,
      stream: cmdStreamsByItem.get(key) ?? null,
    };
    if (act.summary?.command) rec.command = act.summary.command;
    if (typeof act.summary?.exitCode === 'number') rec.exitCode = act.summary.exitCode;
    if (act.phase === 'started' && !rec.startedAt) rec.startedAt = act.at;
    if (act.phase === 'completed') {
      rec.completed = true;
      rec.completedAt = act.at;
    }
    cmdsById.set(key, rec);
  }
  for (const [key, st] of cmdStreamsByItem.entries()) {
    if (!cmdsById.has(key)) {
      cmdsById.set(key, {
        id: key,
        command: st.itemId || 'Command',
        exitCode: null,
        startedAt: st.startedAt ?? st.at,
        completedAt: st.at,
        completed: Boolean(st.done),
        stream: st,
      });
    }
  }
  const commands = [...cmdsById.values()];

  // Collect per-file diff sections across all turn diffs
  const fileEntriesByPath = new Map();
  const unmatchedDiffs = [];
  for (const d of turn.diffs) {
    if (d.diff) {
      const parsed = parseDiffByFile(d.diff);
      for (const [filePath, info] of parsed.byFile.entries()) {
        const prev = fileEntriesByPath.get(filePath);
        if (prev) {
          prev.diff = prev.diff ? `${prev.diff}\n${info.diff}` : info.diff;
          prev.truncated = prev.truncated || Boolean(d.truncated);
        } else {
          fileEntriesByPath.set(filePath, {
            path: filePath,
            kind: info.kind,
            diff: info.diff,
            truncated: Boolean(d.truncated),
          });
        }
      }
      if (parsed.unmatchedChunks.length > 0) {
        unmatchedDiffs.push({
          eventId: d.eventId,
          diff: parsed.unmatchedChunks.join('\n\n'),
          truncated: Boolean(d.truncated),
          filesCount: d.filesChangedCount ?? (d.files?.length ?? 0),
        });
      }
    }
    for (const f of d.files ?? []) {
      if (!fileEntriesByPath.has(f)) {
        fileEntriesByPath.set(f, { path: f, kind: 'mod', diff: null, truncated: Boolean(d.truncated) });
      }
    }
  }

  // Pair remaining non-commentary / non-command tools (and pick up fileChange file paths)
  const toolsById = new Map();
  for (const act of turn.activities) {
    if (act.kind === 'commentary' || act.kind === 'commandExecution') continue;
    if (act.kind === 'reasoning' && !act.summary?.text?.trim()) continue;
    if (act.kind === 'fileChange') {
      for (const f of act.summary?.files ?? []) {
        if (!fileEntriesByPath.has(f)) {
          fileEntriesByPath.set(f, { path: f, kind: 'mod', diff: null, truncated: false });
        }
      }
      continue;
    }
    const key = act.itemId || act.eventId;
    const rec = toolsById.get(key) ?? { id: key, kind: act.kind, phase: act.phase, summary: act.summary ?? {}, at: act.at };
    rec.phase = act.phase;
    rec.summary = { ...rec.summary, ...(act.summary ?? {}) };
    rec.at = act.at;
    toolsById.set(key, rec);
  }
  const tools = [...toolsById.values()];
  const changedFilesDetailed = [...fileEntriesByPath.values()];

  const reasoningStreams = turn.streams.filter((st) => st.channel === 'reasoning' && st.text?.trim());
  const planStreams = turn.streams.filter((st) => st.channel === 'plan' && st.text?.trim());

  const answerEvent = [...turn.terminals].reverse().find((t) => t.type === 'answer') ?? null;
  const compactEvent = [...turn.terminals].reverse().find((t) => t.type === 'compact') ?? null;
  const cancelEvent = [...turn.terminals].reverse().find((t) => t.type === 'cancel') ?? null;
  const answerBodySet = new Set(
    turn.terminals
      .filter((t) => t.type === 'answer' && typeof t.text === 'string')
      .map((t) => stripCodexFooter(t.text).body.trim())
      .filter(Boolean),
  );

  const visibleAgentStreams = turn.streams.filter((st) => {
    if (st.channel !== 'agentMessage' || st.superseded === true) return false;
    if (st.itemId && completedCommentaryIds.has(st.itemId)) return false;
    if (answerEvent) {
      const stTrimmed = (st.text ?? '').trim();
      if (answerBodySet.has(stTrimmed)) return false;
      if (st.done === true && stTrimmed.length > 0 && answerBodySet.size > 0) {
        for (const body of answerBodySet) {
          if (body === stTrimmed || body.startsWith(stTrimmed)) return false;
        }
      }
    }
    return Boolean((st.text ?? '').trim());
  });

  // Calculate turn elapsed duration
  let turnDurationMs = null;
  if (isTurnActive && liveJob?.elapsedMs != null) {
    turnDurationMs = liveJob.elapsedMs;
  } else {
    const startAnchor = turn.delegationAt ?? turn.startedAt;
    const endAnchor = answerEvent?.at ?? compactEvent?.at ?? cancelEvent?.at ?? turn.updatedAt;
    if (startAnchor && endAnchor) {
      const diffMs = Date.parse(endAnchor) - Date.parse(startAnchor);
      if (Number.isFinite(diffMs) && diffMs >= 0) turnDurationMs = diffMs;
    }
  }

  // Live ticker text if turn is currently active
  let liveTicker = '';
  if (isTurnActive) {
    const activeCmd = [...commands].reverse().find((c) => !c.completed && c.command);
    if (activeCmd) {
      liveTicker = formatCommandLabel(activeCmd.command);
    } else if (commentaryNotes.length > 0) {
      liveTicker = commentaryNotes.at(-1).text;
    } else if (liveJob?.telemetry?.phase) {
      const s = strings();
      liveTicker = s.phase[liveJob.telemetry.phase] ?? liveJob.telemetry.phase;
    }
  }

  return {
    isTurnActive,
    commentaryNotes,
    commands,
    tools,
    reasoningStreams,
    planStreams,
    changedFilesDetailed,
    unmatchedDiffs,
    answerEvent,
    compactEvent,
    cancelEvent,
    visibleAgentStreams,
    liveTicker,
    turnDurationMs,
  };
}

function formatToolRow(act) {
  const sum = act.summary ?? {};
  if (act.kind === 'mcpToolCall') {
    return `[mcp:${act.phase}] ${sum.server ?? ''}${sum.tool ? `/${sum.tool}` : ''}`;
  }
  if (act.kind === 'webSearch') {
    return `[search:${act.phase}]`;
  }
  return `[${act.kind}:${act.phase}]`;
}

function renderDelegationCard(ev, turnIndex) {
  const s = strings();
  const promptKey = `prompt:${ev.eventId}`;
  const rawPrompt = (ev.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  const lineCount = rawPrompt ? rawPrompt.split('\n').length : 0;
  const isLong = lineCount > 5 || rawPrompt.length > 260;
  const expanded = state.expandedPanels.has(promptKey);

  const hintBadges = [];
  if (ev.sandbox === 'read-only') hintBadges.push('read-only');
  if (ev.imageCount) hintBadges.push(`${ev.imageCount} ${s.badgeImages}`);
  if (ev.hasOutputSchema) hintBadges.push(s.badgeSchema);

  const showDesc = Boolean(
    ev.description
    && rawPrompt
    && !rawPrompt.toLowerCase().startsWith(ev.description.trim().toLowerCase()),
  );

  const turnBadge = turnIndex != null ? `${s.turnPrefix}${turnIndex}${s.turnSuffix}` : '';
  const expandLabel = `${s.expandPromptLines} · ${s.totalUnit}${lineCount}${s.linesUnit} ▾`;
  const collapseLabel = `${s.collapsePrompt} ▴`;

  return `
    <article class="msg-row msg-gemini">
      <div class="msg-meta msg-meta-right">
        <span class="role-name">${escapeHtml(getRoleName('gemini'))}</span>
        ${renderRoleAvatarHtml('gemini')}
      </div>
      <div class="bubble bubble-gemini">
        ${showDesc ? `<div class="prompt-kicker">${escapeHtml(ev.description)}</div>` : ''}
        ${rawPrompt ? `
          <div class="prompt-body${isLong && !expanded ? ' collapsed-prompt' : ''}">${renderMarkdown(rawPrompt, { copyLabel: s.copy })}</div>
          ${isLong ? `
            <div class="prompt-toggle-row">
              <button type="button" class="link-toggle-btn" data-toggle-panel="${escapeHtml(promptKey)}">
                ${escapeHtml(expanded ? collapseLabel : expandLabel)}
              </button>
            </div>
          ` : ''}
        ` : `<div class="muted-note">${escapeHtml(ev.description || ev.action || '')}</div>`}
      </div>
      <div class="msg-foot msg-foot-right">
        ${hintBadges.map((b) => `<span class="meta-chip">${escapeHtml(b)}</span>`).join('')}
        ${turnBadge ? `<span class="turn-pill">${escapeHtml(turnBadge)}</span>` : ''}
        <span class="msg-time" title="${escapeHtml(formatFullTime(ev.at))}">${escapeHtml(formatChatTime(ev.at))}</span>
      </div>
    </article>
  `;
}

function renderTurnWorkDrawer(turn, summary, fileLinksByPath, { hasBodyBelow = false } = {}) {
  const s = strings();
  const hasAnyWork = Boolean(
    turn.latestPlan
    || summary.commentaryNotes.length
    || summary.commands.length
    || summary.tools.length
    || summary.reasoningStreams.length
    || summary.planStreams.length
    || summary.changedFilesDetailed.length
    || summary.unmatchedDiffs.length,
  );
  if (!hasAnyWork) return '';

  let stateIcon = `<span class="trace-icon-ok">${ICON_TRACE_OK_SVG}</span>`;
  let statePhrase = s.traceDone;
  if (summary.isTurnActive) {
    stateIcon = '<span class="pulse-dot trace-pulse"></span>';
    statePhrase = s.traceRunning;
  } else if (summary.answerEvent?.isError || summary.compactEvent?.isError) {
    stateIcon = `<span class="trace-icon-err">${ICON_TRACE_ERR_SVG}</span>`;
    statePhrase = s.traceFailed;
  } else if (summary.cancelEvent) {
    stateIcon = `<span class="trace-icon-err">${ICON_TRACE_ERR_SVG}</span>`;
    statePhrase = s.traceCancelled;
  } else if (summary.compactEvent) {
    statePhrase = s.traceCompacted;
  }

  const chips = [];
  if (summary.commands.length) chips.push(`${summary.commands.length} ${s.summaryCmds}`);
  if (summary.tools.length) chips.push(`${summary.tools.length} ${s.summaryTools}`);
  if (summary.changedFilesDetailed.length) chips.push(`${summary.changedFilesDetailed.length} ${s.summaryFiles}`);
  if (summary.commentaryNotes.length && !summary.commands.length && !summary.changedFilesDetailed.length) {
    chips.push(`${summary.commentaryNotes.length} ${s.summaryNotes}`);
  }
  if (summary.reasoningStreams.length) chips.push(`${summary.reasoningStreams.length} ${s.summaryThoughts}`);
  if (turn.latestPlan?.steps?.length) {
    const doneSteps = turn.latestPlan.steps.filter((st) => st.status === 'completed').length;
    chips.push(`${s.summaryPlan} ${doneSteps}/${turn.latestPlan.steps.length}`);
  }
  if (summary.turnDurationMs != null && !summary.isTurnActive) {
    chips.push(formatHumanDuration(summary.turnDurationMs));
  }

  const sections = [];

  if (turn.latestPlan) {
    sections.push(renderPlanHtml(turn.latestPlan, true));
  }
  for (const ps of summary.planStreams) {
    const pk = `planstr:${turn.turnKey}:${ps.eventId}`;
    const open = state.expandedPanels.has(pk);
    sections.push(`
      <details class="sub-drawer" data-panel-key="${escapeHtml(pk)}"${open ? ' open' : ''}>
        <summary><span>${escapeHtml(s.planTitle)}</span><span class="trace-chevron">▾</span></summary>
        <pre class="stream-pre">${escapeHtml(ps.text)}</pre>
      </details>
    `);
  }

  if (summary.commentaryNotes.length) {
    sections.push(`
      <div class="trace-group">
        ${summary.commentaryNotes
          .map((n) => `
            <div class="trace-note-item">
              <span class="trace-note-icon" aria-hidden="true">${ICON_NOTE_SVG}</span>
              <span class="trace-note-text">${escapeHtml(n.text)}</span>
            </div>
          `)
          .join('')}
      </div>
    `);
  }

  if (summary.reasoningStreams.length) {
    for (const [idx, rs] of summary.reasoningStreams.entries()) {
      const rk = `reason:${turn.turnKey}:${rs.eventId}`;
      const open = state.expandedPanels.has(rk);
      const label = summary.reasoningStreams.length > 1 ? `${s.thinkingTitle} #${idx + 1}` : s.thinkingTitle;
      sections.push(`
        <details class="sub-drawer" data-panel-key="${escapeHtml(rk)}"${open ? ' open' : ''}>
          <summary><span>${escapeHtml(label)}</span><span class="badge">${rs.text.length} chars</span></summary>
          <pre class="stream-pre">${escapeHtml(rs.text)}</pre>
        </details>
      `);
    }
  }

  if (summary.changedFilesDetailed.length) {
    const fileCards = summary.changedFilesDetailed.map((f) => {
      const kindLabel = f.kind === 'add' ? s.fileAdd : f.kind === 'del' ? s.fileDel : s.fileMod;
      const uri = lookupFileUri(f.path, fileLinksByPath);
      const pathHtml = uri
        ? `<button type="button" class="trace-file-path clickable" data-file-uri="${escapeHtml(uri)}" title="${escapeHtml(`${f.path} — ${s.openInPaneHint}`)}">${escapeHtml(f.path)}</button>`
        : `<span class="trace-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>`;
      const fdiffKey = `fdiff:${turn.turnKey}:${f.path}`;
      const diffOpen = Boolean(f.diff) && state.expandedPanels.has(fdiffKey);
      const toggleDiffBtn = f.diff
        ? `<button type="button" class="trace-diff-toggle" data-toggle-panel="${escapeHtml(fdiffKey)}">${escapeHtml(diffOpen ? s.hideDiff : s.viewDiff)} ${diffOpen ? '▴' : '▾'}</button>`
        : '';
      return `
        <div class="trace-file-card">
          <div class="trace-file-row">
            <span class="trace-file-main">
              <span class="file-kind-pill kind-${escapeHtml(f.kind)}">${escapeHtml(kindLabel)}</span>
              ${pathHtml}
            </span>
            ${toggleDiffBtn}
          </div>
          ${diffOpen ? `<div class="trace-file-diff-body">${f.truncated ? `<div class="muted-note">${escapeHtml(s.diffTruncated)}</div>` : ''}${renderDiff(f.diff)}</div>` : ''}
        </div>
      `;
    }).join('');
    sections.push(`<div class="trace-group">${fileCards}</div>`);
  }

  if (summary.commands.length) {
    const cmdRows = summary.commands.map((cmd) => {
      const ck = `cmd:${turn.turnKey}:${cmd.id}`;
      const open = state.expandedPanels.has(ck);
      const cleanCmd = formatCommandLabel(cmd.command || 'Command');
      const durMs = cmd.startedAt && cmd.completedAt ? Date.parse(cmd.completedAt) - Date.parse(cmd.startedAt) : null;
      const durStr = durMs != null && Number.isFinite(durMs) && durMs >= 0 ? formatHumanDuration(durMs, { subSecond: true }) : '';
      let statusBadge = '';
      if (typeof cmd.exitCode === 'number') {
        if (cmd.exitCode === 0) {
          const passText = durStr ? `${s.cmdPass} · ${durStr}` : s.cmdPass;
          statusBadge = `<span class="pill pill-ready">${escapeHtml(passText)}</span>`;
        } else {
          const failText = `${s.cmdFail} ${cmd.exitCode}${durStr ? ` · ${durStr}` : ''}`;
          statusBadge = `<span class="pill pill-danger">${escapeHtml(failText)}</span>`;
        }
      } else if (!cmd.completed && summary.isTurnActive) {
        statusBadge = `<span class="pill pill-running">${escapeHtml(s.runningCmd)}</span>`;
      } else if (durStr) {
        statusBadge = `<span class="badge">${escapeHtml(durStr)}</span>`;
      }
      const truncBadge = cmd.stream?.truncated ? `<span class="badge">${escapeHtml(s.outputTruncated)}</span>` : '';
      const outText = cmd.stream?.text ?? '';
      const rawLine = cmd.command && cleanCmd !== cmd.command
        ? `<div class="trace-cmd-raw" title="${escapeHtml(cmd.command)}">$ ${escapeHtml(cmd.command)}</div>`
        : '';
      return `
        <details class="sub-drawer trace-cmd-drawer" data-panel-key="${escapeHtml(ck)}"${open ? ' open' : ''}>
          <summary title="${escapeHtml(cmd.command || ck)}">
            <span class="cmd-title"><span class="cmd-dollar">$</span> ${escapeHtml(cleanCmd)}</span>
            <span class="cmd-badges">${truncBadge}${statusBadge}</span>
          </summary>
          ${rawLine}
          ${outText
            ? `<pre class="stream-pre">${escapeHtml(outText)}</pre>`
            : `<div class="muted-note">${escapeHtml(s.noCommandOutput)}</div>`}
        </details>
      `;
    }).join('');
    sections.push(`<div class="trace-group">${cmdRows}</div>`);
  }

  if (summary.tools.length) {
    sections.push(`
      <div class="sub-block">
        <div class="sub-title">${escapeHtml(s.toolsTitle)} (${summary.tools.length})</div>
        <ul class="activity-list">
          ${summary.tools.map((t) => `<li class="activity-row"><span>${escapeHtml(formatToolRow(t))}</span></li>`).join('')}
        </ul>
      </div>
    `);
  }

  for (const d of summary.unmatchedDiffs) {
    const dk = `diff:${turn.turnKey}:${d.eventId}`;
    const open = state.expandedPanels.has(dk);
    sections.push(`
      <details class="sub-drawer" data-panel-key="${escapeHtml(dk)}"${open ? ' open' : ''}>
        <summary>
          <span>${escapeHtml(s.diffTitle)}${d.truncated ? ` (${escapeHtml(s.diffTruncated)})` : ''}</span>
          <span class="badge">${d.filesCount} ${escapeHtml(s.diffFilesBadge)}</span>
        </summary>
        ${renderDiff(d.diff)}
      </details>
    `);
  }

  const drawerKey = `work:${turn.turnKey}`;
  const isOpen = state.expandedPanels.has(drawerKey);

  return `
    <details class="trace-drawer${summary.isTurnActive ? ' active' : ''}${hasBodyBelow ? '' : ' trace-only'}" data-panel-key="${escapeHtml(drawerKey)}"${isOpen ? ' open' : ''}>
      <summary>
        <span class="trace-summary-left">
          ${stateIcon}
          <span class="trace-title">${escapeHtml(statePhrase)}</span>
          ${chips.length ? `<span class="trace-chips">${chips.map((c) => `<span class="trace-chip">${escapeHtml(c)}</span>`).join('')}</span>` : ''}
        </span>
        <span class="trace-chevron-pill" aria-hidden="true"><span class="trace-chevron">▾</span></span>
      </summary>
      <div class="trace-body">
        <div class="trace-rail">${sections.join('')}</div>
      </div>
    </details>
  `;
}

function renderBubbleFilesHtml(changedFilesDetailed, linksMap) {
  if (!Array.isArray(changedFilesDetailed) || changedFilesDetailed.length === 0) return '';
  const s = strings();
  return `
    <div class="bubble-files">
      ${changedFilesDetailed
        .map((f) => {
          const uri = lookupFileUri(f.path, linksMap);
          const dot = `<span class="file-chip-dot kind-${escapeHtml(f.kind)}" aria-hidden="true"></span>`;
          if (uri) {
            return `<button type="button" class="file-chip" data-file-uri="${escapeHtml(uri)}" title="${escapeHtml(`${f.path} — ${s.openInPaneHint}`)}">${dot}<span>${escapeHtml(f.path)}</span></button>`;
          }
          return `<span class="file-chip static" title="${escapeHtml(f.path)}">${dot}<span>${escapeHtml(f.path)}</span></span>`;
        })
        .join('')}
    </div>
  `;
}

function renderCodexTurnCard(turn, { meta, liveJob, fileLinksByPath, isLastTurn }) {
  const s = strings();
  const summary = summarizeTurnWork(turn, meta, liveJob);
  const { isTurnActive, answerEvent, compactEvent, cancelEvent, visibleAgentStreams } = summary;

  let statusPill = '';
  if (isTurnActive) {
    const phase = liveJob?.telemetry?.phase;
    const phaseLabel = phase ? (s.phase[phase] ?? phase) : s.phase.streaming;
    statusPill = `<span class="pill pill-running"><span class="pulse-dot"></span>${escapeHtml(phaseLabel)}</span>`;
  } else if (answerEvent?.isError) {
    statusPill = `<span class="pill pill-danger">${escapeHtml(s.errorLabel)}</span>`;
  } else if (cancelEvent) {
    statusPill = `<span class="pill pill-danger">${escapeHtml(s.turnCancelled)}</span>`;
  } else if (compactEvent) {
    statusPill = compactEvent.isError
      ? `<span class="pill pill-danger">${escapeHtml(s.errorLabel)}</span>`
      : `<span class="pill pill-ready">${escapeHtml(s.turnCompacted)}</span>`;
  } else if (meta.status === 'interrupted' && isLastTurn && !answerEvent) {
    statusPill = `<span class="pill pill-danger">${escapeHtml(s.turnInterrupted)}</span>`;
  }

  const liveTickerHtml = isTurnActive && summary.liveTicker
    ? `<div class="live-ticker" title="${escapeHtml(summary.liveTicker)}"><span class="pulse-dot"></span><span class="live-ticker-text">${escapeHtml(s.liveActivityPrefix)} ${escapeHtml(summary.liveTicker)}</span></div>`
    : '';

  const steersHtml = turn.steers.map((st) => {
    const roleTitle = st.source === 'user_ui' ? s.roleUiSteer : s.roleGeminiSteer;
    return `
      <div class="msg-row msg-steer-inline">
        <div class="msg-meta msg-meta-right">
          <span class="turn-pill steer-pill">${escapeHtml(roleTitle)}</span>
        </div>
        <div class="bubble bubble-steer">${renderMarkdown(st.text, { copyLabel: s.copy, fileLinksByPath })}</div>
        <div class="msg-foot msg-foot-right">
          <span class="msg-time" title="${escapeHtml(formatFullTime(st.at))}">${escapeHtml(formatChatTime(st.at))}</span>
        </div>
      </div>
    `;
  }).join('');

  const filesHtml = renderBubbleFilesHtml(summary.changedFilesDetailed, fileLinksByPath);

  let bodyHtml = '';
  let actionsHtml = '';
  let contextWarningHtml = '';

  if (answerEvent) {
    const { body, contextWarning } = stripCodexFooter(answerEvent.text || '');
    if (contextWarning) {
      contextWarningHtml = `<div class="banner-warn">${escapeHtml(contextWarning)}</div>`;
    }
    const lineCount = body.split('\n').length;
    const isLong = body.length > 900 || lineCount > 16;
    const replyKey = `reply:${turn.turnKey}`;
    const defaultOpen = isLastTurn || !isLong;
    const isExpanded = defaultOpen ? !state.collapsedPanels.has(replyKey) : state.expandedPanels.has(replyKey);
    const rendered = renderMarkdown(body || answerEvent.text || '', { copyLabel: s.copy, fileLinksByPath });
    bodyHtml = `
      <div class="answer-body${isLong && !isExpanded ? ' collapsed-answer' : ''}">${rendered}</div>
      ${isLong ? `<div class="reply-toggle-row"><button type="button" class="link-toggle-btn" data-toggle-panel="${escapeHtml(replyKey)}" data-default-open="${defaultOpen ? '1' : '0'}">${escapeHtml(isExpanded ? s.collapseReply : s.expandReply)}</button></div>` : ''}
    `;

    const canAttach = Boolean(state.capabilities?.updateModelContext);
    const canSend = Boolean(state.capabilities?.message);
    const btns = [];
    if (body) {
      btns.push(`<button type="button" class="mini-btn" data-copy-event="${escapeHtml(answerEvent.eventId)}">${escapeHtml(s.copy)}</button>`);
      if (canAttach) {
        btns.push(`<button type="button" class="mini-btn" data-attach-event="${escapeHtml(answerEvent.eventId)}">${escapeHtml(s.attachGemini)}</button>`);
      }
      if (canSend) {
        btns.push(`<button type="button" class="mini-btn" data-send-event="${escapeHtml(answerEvent.eventId)}">${escapeHtml(s.sendGemini)}</button>`);
      }
    }
    if (btns.length) actionsHtml = `<div class="card-actions">${btns.join('')}</div>`;
  } else if (compactEvent) {
    const { body } = stripCodexFooter(compactEvent.text || '');
    bodyHtml = `<div class="answer-body">${renderMarkdown(body || s.compactCompleted, { copyLabel: s.copy, fileLinksByPath })}</div>`;
  } else if (cancelEvent && visibleAgentStreams.length === 0) {
    const who = cancelEvent.source === 'user_ui' ? s.roleUiSteer : getRoleName('gemini');
    bodyHtml = `<div class="muted-note">${escapeHtml(`${who}: ${s.runCancelled}`)}</div>`;
  } else if (visibleAgentStreams.length > 0) {
    bodyHtml = visibleAgentStreams
      .map((st) => `<div class="answer-body">${renderMarkdown(stripCodexFooter(st.text).body, { copyLabel: s.copy, fileLinksByPath })}</div>`)
      .join('');
  }

  const hasAnswerBody = Boolean(contextWarningHtml || bodyHtml || filesHtml || actionsHtml);
  const workDrawerHtml = renderTurnWorkDrawer(turn, summary, fileLinksByPath, {
    hasBodyBelow: Boolean(liveTickerHtml || hasAnswerBody),
  });
  const hasUnifiedBubble = Boolean(workDrawerHtml || liveTickerHtml || hasAnswerBody);
  const bubbleErrClass = (answerEvent?.isError || cancelEvent || compactEvent?.isError) ? ' error' : '';
  const codexTime = formatChatTime(turn.updatedAt);
  const codexFootParts = [];
  if (turn.reasoningEffort) codexFootParts.push(`<span class="meta-subtle">${escapeHtml(turn.reasoningEffort)}</span>`);
  if (statusPill) codexFootParts.push(statusPill);
  if (codexTime) codexFootParts.push(`<span class="msg-time" title="${escapeHtml(formatFullTime(turn.updatedAt))}">${escapeHtml(codexTime)}</span>`);

  return `
    <article class="msg-row msg-codex">
      <div class="msg-meta msg-meta-left">
        ${renderRoleAvatarHtml('codex')}
        <span class="role-name">${escapeHtml(getRoleName('codex'))}</span>
      </div>
      <div class="codex-stack">
        ${steersHtml}
        ${hasUnifiedBubble ? `
          <div class="bubble bubble-codex${bubbleErrClass}">
            ${workDrawerHtml}
            ${liveTickerHtml}
            ${hasAnswerBody ? `
              <div class="codex-bubble-body">
                ${contextWarningHtml}
                ${bodyHtml}
                ${filesHtml}
                ${actionsHtml}
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
      ${codexFootParts.length ? `<div class="msg-foot msg-foot-left">${codexFootParts.join('')}</div>` : ''}
    </article>
  `;
}

function renderStandaloneCard(ev) {
  const s = strings();
  const summaryText = ev.type === 'compact'
    ? `${s.actionCompact}: ${ev.text || s.compactCompleted}`
    : ev.type === 'fork'
      ? `${s.actionFork} (${shortId(ev.sourceThreadId)} → ${shortId(ev.threadId)})`
      : ev.type === 'cancel'
        ? `${ev.source === 'user_ui' ? s.roleUiSteer : getRoleName('gemini')}: ${s.runCancelled}`
        : ev.type === 'closed'
          ? s.sessionClosed
          : ev.type;
  const timeText = formatClockTime(ev.at);
  return `
    <div class="msg-system" title="${escapeHtml(formatFullTime(ev.at))}">
      <span class="system-pill">${escapeHtml(summaryText)}${timeText ? ` · ${escapeHtml(timeText)}` : ''}</span>
    </div>
  `;
}

function renderTimeline(force = false) {
  if (!shellRefs) return;
  const s = strings();

  if (!state.hydrated && state.conversations.length === 0) {
    const loadKey = `loading:${state.locale}`;
    if (!force && state.lastRenderedConvKey === loadKey) return;
    state.lastRenderedConvKey = loadKey;
    shellRefs.timeline.innerHTML = `<div class="empty-state"><div class="empty-title">${escapeHtml(s.loadingMonitor)}</div></div>`;
    return;
  }

  const entry = getSelectedEntry();
  const meta = entry?.meta;

  if (!meta) {
    const emptyText = state.conversations.length === 0 ? s.noConversationsHint : s.selectConversation;
    const emptyKey = `empty:${emptyText}`;
    if (!force && state.lastRenderedConvKey === emptyKey) return;
    state.lastRenderedConvKey = emptyKey;
    shellRefs.timeline.innerHTML = `<div class="empty-state"><div class="empty-title">${escapeHtml(s.noConversations)}</div><div>${escapeHtml(emptyText)}</div></div>`;
    return;
  }

  const cache = entry.cache;
  const ordered = cache ? cache.order.map((id) => cache.eventsById.get(id)).filter(Boolean) : [];
  const liveJob = cache?.liveJob ?? null;
  const convKey = [
    meta.conversationId,
    meta.status,
    cache?.nextSeq ?? 0,
    ordered.length,
    ordered.at(-1)?.seq ?? 0,
    state.locale,
    state.settingsVersion,
    cache?.truncated ? 1 : 0,
    liveJob?.status ?? '',
    liveJob?.telemetry?.phase ?? '',
    cache?.fileLinksByPath?.size ?? 0,
    state.renderNonce,
  ].join(':');
  if (!force && state.lastRenderedConvKey === convKey) return;
  state.lastRenderedConvKey = convKey;

  const wasNearBottom = state.nearBottom;
  const prevScrollTop = shellRefs.timeline.scrollTop;

  if (ordered.length === 0) {
    const fallbackPlan = meta.latestPlan ? renderPlanHtml(meta.latestPlan) : '';
    shellRefs.timeline.innerHTML = `<div class="timeline-inner">${fallbackPlan}<div class="empty-state">${escapeHtml(s.noEventsYet)}</div></div>`;
    return;
  }

  const blocks = groupTimelineItems(ordered, meta, liveJob);
  const turnBlocks = blocks.filter((b) => b.kind === 'turn');
  const lastTurn = turnBlocks.at(-1) ?? null;

  const cards = [];
  if (cache?.truncated) {
    cards.push(`<div class="banner-warn">${escapeHtml(s.truncatedWarning)}</div>`);
  }

  for (const block of blocks) {
    if (block.kind === 'delegation') {
      cards.push(renderDelegationCard(block.event, block.turnIndex));
    } else if (block.kind === 'turn') {
      cards.push(renderCodexTurnCard(block, {
        meta,
        liveJob,
        fileLinksByPath: cache?.fileLinksByPath ?? null,
        isLastTurn: block === lastTurn,
      }));
    } else {
      cards.push(renderStandaloneCard(block.event));
    }
  }

  shellRefs.timeline.innerHTML = `<div class="timeline-inner">${cards.join('')}</div>`;

  if (wasNearBottom) {
    shellRefs.timeline.scrollTop = shellRefs.timeline.scrollHeight;
    shellRefs.jumpLatest.hidden = true;
  } else {
    shellRefs.timeline.scrollTop = prevScrollTop;
    const distance = shellRefs.timeline.scrollHeight - shellRefs.timeline.scrollTop - shellRefs.timeline.clientHeight;
    shellRefs.jumpLatest.hidden = distance < 64;
  }
}

function renderToast() {
  if (!shellRefs) return;
  if (!state.toast) {
    shellRefs.toast.hidden = true;
    shellRefs.toast.innerHTML = '';
    return;
  }
  shellRefs.toast.hidden = false;
  shellRefs.toast.className = `toast ${state.toast.kind}`;
  shellRefs.toast.innerHTML = `<span>${escapeHtml(state.toast.text)}</span><button type="button" class="mini-btn" id="toast-dismiss">×</button>`;
  const dismiss = document.getElementById('toast-dismiss');
  if (dismiss) dismiss.onclick = () => { state.toast = null; renderToast(); };
}

function renderDock(force = false) {
  if (!shellRefs) return;
  const entry = getSelectedEntry();
  const meta = entry?.meta;
  if (!meta) {
    shellRefs.dock.hidden = true;
    state.lastDockSignature = '';
    return;
  }
  shellRefs.dock.hidden = false;
  const s = strings();
  const liveJob = entry.cache?.liveJob;
  const isRunning = liveJob?.status === 'running';
  const steerable = Boolean(liveJob?.steerable && isRunning);
  const canManageSession = meta.kind === 'session' && meta.status !== 'closed' && meta.status !== 'running';
  const canClearHistory = !liveJob && (meta.status === 'closed' || meta.kind === 'ephemeral');

  const sig = [
    meta.conversationId,
    meta.status,
    meta.kind,
    liveJob?.jobId ?? '',
    liveJob?.status ?? '',
    steerable ? 1 : 0,
    canManageSession ? 1 : 0,
    canClearHistory ? 1 : 0,
    state.busyAction ? 1 : 0,
    state.confirmStep ?? '',
    state.forkOpen ? 1 : 0,
    state.locale,
  ].join('|');

  if (!force && sig === state.lastDockSignature) return;
  state.lastDockSignature = sig;

  if (isRunning) {
    shellRefs.dock.innerHTML = `
      <div id="steer-form" class="steer-form">
        <textarea id="steer-input" class="steer-input" rows="2" placeholder="${escapeHtml(steerable ? s.steerPlaceholder : s.noSteerIdle)}" ${!steerable || state.busyAction ? 'disabled' : ''}></textarea>
        <div class="dock-row">
          <div class="dock-actions">
            <button type="button" data-dock-action="submit-steer" class="btn btn-primary" ${!steerable || state.busyAction ? 'disabled' : ''}>${escapeHtml(s.steerSend)}</button>
            <button type="button" class="btn btn-danger" data-dock-action="cancel" ${state.busyAction ? 'disabled' : ''}>${escapeHtml(s.actionCancel)}</button>
          </div>
          <span class="dock-note">${escapeHtml(steerable ? '' : s.noSteerIdle)}</span>
        </div>
      </div>
    `;
    return;
  }

  const buttons = [];
  if (canManageSession) {
    buttons.push(`<button type="button" class="btn" data-dock-action="compact" ${state.busyAction ? 'disabled' : ''}>${escapeHtml(s.actionCompact)}</button>`);
    buttons.push(`<button type="button" class="btn" data-dock-action="open-fork" ${state.busyAction ? 'disabled' : ''}>${escapeHtml(s.actionFork)}</button>`);
    const closeLabel = state.confirmStep === 'close' ? s.confirmClose : s.actionClose;
    buttons.push(`<button type="button" class="btn btn-danger" data-dock-action="close" ${state.busyAction ? 'disabled' : ''}>${escapeHtml(closeLabel)}</button>`);
  }
  if (canClearHistory) {
    const clearLabel = state.confirmStep === 'clear_history' ? s.confirmClearHistory : s.actionClearHistory;
    buttons.push(`<button type="button" class="btn btn-danger" data-dock-action="clear_history" ${state.busyAction ? 'disabled' : ''}>${escapeHtml(clearLabel)}</button>`);
  }

  const note = liveJob?.status === 'completed_unclaimed'
    ? s.unclaimedNotice
    : meta.status === 'closed'
      ? s.closedNotice
      : meta.kind === 'ephemeral'
        ? s.ephemeralNotice
        : s.sessionIdleNotice;

  const forkForm = state.forkOpen && canManageSession ? `
    <div id="fork-form" class="fork-row">
      <input id="fork-target-input" class="fork-input" type="text" placeholder="${escapeHtml(s.forkPlaceholder)}" value="${escapeHtml(`${meta.sessionKey || 'branch'}-fork`)}" />
      <button type="button" data-dock-action="submit-fork" class="btn btn-primary" ${state.busyAction ? 'disabled' : ''}>${escapeHtml(s.forkSubmit)}</button>
      <button type="button" class="btn" data-dock-action="cancel-fork">${escapeHtml(s.forkCancel)}</button>
    </div>
  ` : '';

  shellRefs.dock.innerHTML = `
    ${forkForm}
    <div class="dock-row">
      <div class="dock-actions">${buttons.join('')}</div>
      <span class="dock-note">${escapeHtml(note)}</span>
    </div>
  `;
}

function renderAllPanels(force = false) {
  renderPicker();
  renderSidebar();
  renderStatusStrip();
  renderTimeline(force);
  renderToast();
  renderDock(force);
}

function applyConversationPage(conversationId, payload, reset = false) {
  if (typeof payload.cursorEpoch === 'string' && payload.cursorEpoch) {
    state.cursorEpoch = payload.cursorEpoch;
  }
  const shouldReset = reset || Boolean(payload.reset) || !state.convCache.has(conversationId);
  let cache = state.convCache.get(conversationId);
  if (shouldReset) {
    cache = {
      conversation: payload.conversation,
      eventsById: new Map(),
      order: [],
      nextSeq: 0,
      truncated: false,
      liveJob: null,
      fileLinksByPath: new Map(),
      needsFullHydration: false,
    };
    state.convCache.set(conversationId, cache);
  }
  cache.conversation = payload.conversation;
  cache.liveJob = payload.liveJob ?? null;
  cache.truncated = Boolean(payload.truncated);
  if (Array.isArray(payload.fileLinks)) {
    cache.needsFullHydration = false;
    for (const link of payload.fileLinks) {
      if (link?.path && link?.uri) cache.fileLinksByPath.set(link.path, link.uri);
    }
  } else {
    cache.needsFullHydration = true;
  }
  const incoming = Array.isArray(payload.events) ? payload.events : [];
  for (const ev of incoming) {
    const existed = cache.eventsById.has(ev.eventId);
    cache.eventsById.set(ev.eventId, ev);
    if (!existed) cache.order.push(ev.eventId);
  }
  cache.order.sort((leftId, rightId) => (cache.eventsById.get(leftId)?.seq ?? 0) - (cache.eventsById.get(rightId)?.seq ?? 0));
  if (typeof payload.nextSeq === 'number' && (shouldReset || payload.nextSeq > cache.nextSeq)) {
    cache.nextSeq = payload.nextSeq;
  }
}

function chooseSelectedId(conversations, explicitInitialId = null) {
  const ids = new Set(conversations.map((item) => item.conversationId));
  if (state.preferredInitialId && ids.has(state.preferredInitialId)) {
    const chosen = state.preferredInitialId;
    state.preferredInitialId = null;
    return chosen;
  }
  if (explicitInitialId && ids.has(explicitInitialId)) return explicitInitialId;
  if (state.selectedId && ids.has(state.selectedId)) return state.selectedId;
  return conversations[0]?.conversationId ?? null;
}

function applySnapshotPayload(payload, { isInitialToolResult = false } = {}) {
  const snapshot = isInitialToolResult ? payload?.initialSnapshot : payload;
  if (!snapshot || !Array.isArray(snapshot.conversations)) return false;

  if (typeof payload.cursorEpoch === 'string' && payload.cursorEpoch) {
    state.cursorEpoch = payload.cursorEpoch;
  }
  state.conversations = snapshot.conversations;
  const page = snapshot.initialConversation;
  const pageId = page?.conversation?.conversationId ?? null;
  state.selectedId = chooseSelectedId(snapshot.conversations, payload.initialConversationId ?? pageId);

  if (page?.conversation) {
    applyConversationPage(page.conversation.conversationId, page, true);
  }
  state.hydrated = true;
  state.initialSnapshotApplied = true;
  if (snapshotWaitResolve) {
    snapshotWaitResolve();
    snapshotWaitResolve = null;
  }

  bumpRenderNonce();
  renderAllPanels(true);

  const selectedCache = state.selectedId ? state.convCache.get(state.selectedId) : null;
  const needsPageTail = Boolean(page?.hasMore || selectedCache?.needsFullHydration || !selectedCache || state.selectedId !== pageId);
  const needsMoreList = Boolean(snapshot.hasMoreConversations);
  if (state.connected && (needsPageTail || needsMoreList)) {
    void backgroundFinishInitialHydration({ needsPageTail, needsMoreList, selectedId: state.selectedId });
  }
  return true;
}

async function backgroundFinishInitialHydration({ needsPageTail, needsMoreList, selectedId }) {
  if (!state.connected || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    if (needsMoreList) {
      await refreshList();
    }
    const targetId = selectedId ?? state.selectedId;
    if (targetId && needsPageTail) {
      const cache = state.convCache.get(targetId);
      const forceFull = !cache || cache.needsFullHydration;
      await refreshConversation(targetId, { forceFull });
    }
    renderAllPanels(false);
  } catch {
    // Background hydration errors will recover cleanly on next poll
  } finally {
    state.pollInFlight = false;
    scheduleNextPoll();
  }
}

async function refreshList() {
  const res = await app.callServerTool({ name: 'codex_ui_list_conversations', arguments: {} });
  if (res.isError) return;
  const payload = parseToolPayload(res);
  if (!payload || !Array.isArray(payload.conversations)) return;
  if (typeof payload.cursorEpoch === 'string' && payload.cursorEpoch) {
    if (state.cursorEpoch && payload.cursorEpoch !== state.cursorEpoch) {
      for (const entry of state.convCache.values()) {
        entry.needsFullHydration = true;
      }
    }
    state.cursorEpoch = payload.cursorEpoch;
  }
  state.conversations = payload.conversations;
  state.hydrated = true;
  state.selectedId = chooseSelectedId(state.conversations);
}

async function refreshConversation(conversationId, { forceFull = false } = {}) {
  if (!conversationId) return;
  const cached = state.convCache.get(conversationId);
  const effectiveForce = forceFull || !cached || Boolean(cached.needsFullHydration);
  const afterSeq = effectiveForce ? 0 : cached.nextSeq;
  const args = {
    conversationId,
    afterSeq,
    limit: 200,
    ...(state.cursorEpoch ? { cursorEpoch: state.cursorEpoch } : {}),
  };
  const res = await app.callServerTool({ name: 'codex_ui_get_conversation', arguments: args });
  if (res.isError) {
    if (effectiveForce) {
      await refreshList();
      renderAllPanels(true);
    }
    return;
  }
  const payload = parseToolPayload(res);
  if (!payload?.conversation) return;
  applyConversationPage(conversationId, payload, effectiveForce);

  let more = Boolean(payload.hasMore);
  let safety = 0;
  while (more && safety < 5) {
    safety += 1;
    const nextAfter = state.convCache.get(conversationId)?.nextSeq ?? 0;
    const nextRes = await app.callServerTool({
      name: 'codex_ui_get_conversation',
      arguments: {
        conversationId,
        afterSeq: nextAfter,
        limit: 200,
        ...(state.cursorEpoch ? { cursorEpoch: state.cursorEpoch } : {}),
      },
    });
    if (nextRes.isError) break;
    const nextPayload = parseToolPayload(nextRes);
    if (!nextPayload?.events?.length) break;
    applyConversationPage(conversationId, nextPayload, false);
    more = Boolean(nextPayload.hasMore);
  }
}

async function pollOnce({ forceFull = false } = {}) {
  if (!state.connected || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    await refreshList();
    if (state.selectedId) {
      await refreshConversation(state.selectedId, { forceFull });
    }
    renderAllPanels(false);
  } catch {
    // Transient polling failure; retry next tick cleanly
  } finally {
    state.pollInFlight = false;
  }
}

function scheduleNextPoll() {
  clearTimeout(state.pollTimer);
  if (document.hidden || !state.connected) return;
  const anyRunning = state.conversations.some((c) => c.status === 'running')
    || getSelectedEntry()?.cache?.liveJob?.status === 'running';
  const delayMs = anyRunning ? 650 : 3000;
  state.pollTimer = setTimeout(async () => {
    await pollOnce();
    scheduleNextPoll();
  }, delayMs);
}

async function submitSteer(rawText, inputEl) {
  const s = strings();
  const text = rawText.trim();
  const entry = getSelectedEntry();
  const job = entry?.cache?.liveJob;
  if (!text) {
    showToast('info', s.emptySteer, 2000);
    return;
  }
  if (!job?.jobId || job.status !== 'running' || !job.steerable) {
    showToast('error', s.noSteerIdle);
    return;
  }
  state.busyAction = true;
  renderDock(true);
  try {
    const res = await app.callServerTool({
      name: 'codex_ui_steer',
      arguments: { jobId: job.jobId, steer: text },
    });
    if (res.isError) {
      showToast('error', extractErrorText(res));
      return;
    }
    if (inputEl) inputEl.value = '';
    showToast('success', s.steerSent, 2200);
    await pollOnce();
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  } finally {
    state.busyAction = false;
    renderDock(true);
    scheduleNextPoll();
  }
}

async function submitFork(targetSessionKey) {
  const s = strings();
  const meta = getSelectedEntry()?.meta;
  if (!meta) return;
  if (!SESSION_KEY_RE.test(targetSessionKey)) {
    showToast('error', s.invalidSessionKey);
    return;
  }
  state.busyAction = true;
  renderDock(true);
  try {
    const args = {
      action: 'fork',
      targetSessionKey,
      ...(meta.sessionKey ? { sessionKey: meta.sessionKey } : { threadId: meta.threadId }),
    };
    const res = await app.callServerTool({ name: 'codex_ui_action', arguments: args });
    if (res.isError) {
      showToast('error', extractErrorText(res));
      return;
    }
    state.forkOpen = false;
    const newConvId = `session:${targetSessionKey}`;
    state.selectedId = newConvId;
    bumpRenderNonce();
    showToast('success', `${s.forkCreated} ${targetSessionKey}`);
    await pollOnce({ forceFull: true });
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  } finally {
    state.busyAction = false;
    renderDock(true);
    scheduleNextPoll();
  }
}

async function runLifecycleAction(action) {
  const s = strings();
  const entry = getSelectedEntry();
  const meta = entry?.meta;
  const liveJob = entry?.cache?.liveJob;
  if (!meta) return;

  let args;
  if (action === 'cancel') {
    if (!liveJob?.jobId) return;
    args = { action: 'cancel', jobId: liveJob.jobId };
  } else if (action === 'clear_history') {
    args = { action: 'clear_history', conversationId: meta.conversationId };
  } else {
    args = {
      action,
      ...(meta.sessionKey ? { sessionKey: meta.sessionKey } : { threadId: meta.threadId }),
    };
  }

  state.busyAction = true;
  renderDock(true);
  try {
    const res = await app.callServerTool({ name: 'codex_ui_action', arguments: args });
    if (res.isError) {
      showToast('error', extractErrorText(res));
      return;
    }
    const payload = parseToolPayload(res);
    if (action === 'cancel') {
      showToast('info', s.runCancelled);
    } else if (action === 'compact') {
      showToast(payload?.status === 'completed' ? 'success' : 'info', payload?.status === 'completed' ? s.compactCompleted : s.compactStarted);
    } else if (action === 'close') {
      showToast('success', s.sessionClosed);
    } else if (action === 'clear_history') {
      state.convCache.delete(meta.conversationId);
      if (state.selectedId === meta.conversationId) state.selectedId = null;
      showToast('success', s.historyCleared);
    }
    await pollOnce({ forceFull: true });
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  } finally {
    state.busyAction = false;
    renderDock(true);
    scheduleNextPoll();
  }
}

function handleMonitorToolHint(resultOrArgs) {
  const payload = resultOrArgs?.structuredContent ?? resultOrArgs;
  if (payload?.initialSnapshot && Array.isArray(payload.initialSnapshot.conversations)) {
    applySnapshotPayload(payload, { isInitialToolResult: true });
    return;
  }
  const targetId = payload?.initialConversationId ?? payload?.conversationId;
  if (typeof targetId === 'string' && targetId) {
    state.preferredInitialId = targetId;
    if (state.connected) {
      state.selectedId = targetId;
      bumpRenderNonce();
      void pollOnce({ forceFull: true });
    }
  }
}

app.ontoolinput = ({ arguments: args }) => {
  handleMonitorToolHint(args);
};

app.ontoolresult = (result) => {
  handleMonitorToolHint(result);
};

app.ontoolcancelled = () => {
  showToast('info', strings().runCancelled);
};

app.onhostcontextchanged = (ctx) => {
  const prevLocale = state.locale;
  applyHostContext(ctx);
  if (prevLocale !== state.locale) {
    renderChrome();
    bumpRenderNonce();
    renderAllPanels(true);
  }
};

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.settingsOpen && !state.settingsBusy) {
    if (state.modelMenuOpen) {
      state.modelMenuOpen = false;
      renderCodexConfigSection();
    } else {
      closeSettingsModal();
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.connected) {
    void pollOnce().then(() => scheduleNextPoll());
  } else {
    clearTimeout(state.pollTimer);
  }
});

async function bootstrap() {
  buildShell();
  renderAllPanels(true);
  await app.connect();
  state.connected = true;
  state.capabilities = app.getHostCapabilities() ?? {};
  applyHostContext(app.getHostContext());
  renderChrome();
  void loadSettings({ silent: true, syncCodex: false });

  if (!state.initialSnapshotApplied) {
    await new Promise((resolve) => {
      snapshotWaitResolve = resolve;
      setTimeout(resolve, INITIAL_SNAPSHOT_WAIT_MS);
    });
    snapshotWaitResolve = null;
  }

  if (!state.initialSnapshotApplied) {
    const args = {
      include: 'initialConversation',
      ...(state.preferredInitialId ? { conversationId: state.preferredInitialId } : {}),
    };
    const res = await app.callServerTool({ name: 'codex_ui_list_conversations', arguments: args });
    if (!res.isError) {
      const payload = parseToolPayload(res);
      if (payload && applySnapshotPayload(payload, { isInitialToolResult: false })) {
        scheduleNextPoll();
        return;
      }
    }
    await pollOnce({ forceFull: true });
  }
  scheduleNextPoll();
}

void bootstrap();
