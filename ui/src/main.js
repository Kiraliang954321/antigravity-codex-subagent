import {
  App,
  McpUiOpenLinkResultSchema,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { tFor } from './i18n.js';
import { escapeHtml, renderDiff, renderMarkdown } from './markdown.js';

const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const app = new App({ name: 'codex-subagent-monitor', version: '0.5.0' }, {});

const state = {
  connected: false,
  capabilities: {},
  locale: 'en-US',
  conversations: [],
  search: '',
  selectedId: null,
  preferredInitialId: null,
  convCache: new Map(), // conversationId -> { conversation, eventsById, order, nextSeq, truncated, liveJob, fileLinksByPath, dirtyVersion }
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
};

let shellRefs = null;
let toastTimer = null;

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
  const text = (result?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const payload = parseToolPayload(result);
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

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
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

function buildShell() {
  const root = document.getElementById('app');
  const s = strings();
  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="brand-dot"></span><span id="brand-title">${escapeHtml(s.appTitle)}</span></div>
        <div class="picker-wrap">
          <select id="conv-picker" class="picker" aria-label="Conversations"></select>
        </div>
        <button id="refresh-btn" type="button" class="icon-btn">${escapeHtml(s.refresh)}</button>
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
  `;

  shellRefs = {
    brandTitle: document.getElementById('brand-title'),
    picker: document.getElementById('conv-picker'),
    refreshBtn: document.getElementById('refresh-btn'),
    searchInput: document.getElementById('sidebar-search'),
    sidebarList: document.getElementById('sidebar-list'),
    statusStrip: document.getElementById('status-strip'),
    timeline: document.getElementById('timeline'),
    jumpLatest: document.getElementById('jump-latest'),
    toast: document.getElementById('toast'),
    dock: document.getElementById('dock'),
  };

  shellRefs.picker.addEventListener('change', (ev) => {
    selectConversation(ev.target.value);
  });

  shellRefs.refreshBtn.addEventListener('click', () => {
    void pollOnce({ forceFull: false });
  });

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
    if (!details) return;
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
      const text = getEventAnswerText(copyAnsBtn.dataset.copyEvent);
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
    const expandPromptBtn = ev.target.closest('[data-toggle-prompt]');
    if (expandPromptBtn) {
      const key = expandPromptBtn.dataset.togglePrompt;
      if (state.expandedPanels.has(key)) state.expandedPanels.delete(key);
      else state.expandedPanels.add(key);
      state.lastRenderedConvKey = '';
      renderTimeline();
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

function getEventAnswerText(eventId) {
  const entry = getSelectedEntry();
  const ev = entry?.cache?.eventsById.get(eventId);
  if (!ev) return '';
  return ev.text || '';
}

function buildHandoffText(meta, ev) {
  const header = meta?.sessionKey
    ? `Codex session \`${meta.sessionKey}\` (${meta.threadId ?? ''})`
    : `Codex thread ${meta?.threadId ?? meta?.conversationId ?? ''}`;
  return `From ${header}:\n\n${ev.text ?? ''}`;
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
  state.lastRenderedConvKey = '';
  renderChrome();
  renderAllPanels(true);
  void refreshConversation(conversationId, { forceFull: true });
}

function renderChrome() {
  if (!shellRefs) return;
  const s = strings();
  shellRefs.brandTitle.textContent = s.appTitle;
  shellRefs.refreshBtn.textContent = s.refresh;
  shellRefs.searchInput.placeholder = s.searchPlaceholder;
  shellRefs.jumpLatest.textContent = s.jumpLatest;
}

function renderPicker() {
  if (!shellRefs) return;
  const s = strings();
  const picker = shellRefs.picker;
  picker.innerHTML = '';
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
          return `
            <button type="button" class="conv-item${active}" data-conv-id="${escapeHtml(conv.conversationId)}">
              <div class="conv-row">
                <span class="conv-title">${escapeHtml(conv.sessionKey || conv.title || conv.conversationId)}</span>
                <span class="pill pill-${escapeHtml(conv.status)}">${conv.status === 'running' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(statusLabel)}</span>
              </div>
              <div class="conv-row">
                <span class="conv-meta">${escapeHtml(conv.model || conv.kind)}${pct ? ` · ${escapeHtml(pct)}` : ''}</span>
                <span class="conv-meta">${escapeHtml(formatClockTime(conv.updatedAt))}</span>
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

  const metricParts = [];
  if (meta.model) metricParts.push(`<span class="badge">${escapeHtml(meta.model)}</span>`);
  if (meta.threadId) metricParts.push(`<span class="badge" title="${escapeHtml(meta.threadId)}">${escapeHtml(shortId(meta.threadId))}</span>`);
  if (liveJob?.elapsedMs != null) metricParts.push(`<span>${escapeHtml(s.elapsedPrefix)}: ${escapeHtml(formatDuration(liveJob.elapsedMs))}</span>`);
  if (telemetry?.idleMs != null && liveJob?.status === 'running') metricParts.push(`<span>${escapeHtml(s.idlePrefix)}: ${escapeHtml(formatDuration(telemetry.idleMs))}</span>`);

  shellRefs.statusStrip.innerHTML = `
    <div class="status-top">
      <div class="status-left">
        <span class="conv-heading">${escapeHtml(meta.sessionKey || meta.title || meta.conversationId)}</span>
        <span class="pill pill-${escapeHtml(status)}">${status === 'running' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(statusLabel)}</span>
        ${phaseLabel && status === 'running' ? `<span class="pill">${escapeHtml(phaseLabel)}</span>` : ''}
      </div>
      <div class="status-metrics">${metricParts.join('')}</div>
    </div>
    ${tokenText ? `
      <div class="ctx-bar-wrap">
        <span class="ctx-text">${escapeHtml(s.contextLabel)}: ${escapeHtml(tokenText)}</span>
        ${usage.modelContextWindow ? `<div class="ctx-track"><div class="ctx-fill ${pctClass}" style="width:${Math.min(100, Math.max(2, pct ?? 0))}%"></div></div>` : ''}
        ${pct >= 80 ? `<span class="pill pill-warning">${escapeHtml(s.highUsageWarning)}</span>` : ''}
        ${showQuickCompact ? `<button type="button" class="mini-btn btn-warning" data-quick-compact="1">${escapeHtml(s.compactNow)}</button>` : ''}
      </div>
    ` : ''}
  `;
}

function renderFilesHtml(files, linksMap) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const s = strings();
  return `
    <div class="files-strip">
      ${files
        .map((filePath) => {
          const uri = linksMap?.get(filePath);
          if (uri) {
            return `<button type="button" class="file-chip" data-file-uri="${escapeHtml(uri)}" title="${escapeHtml(`${filePath} — ${s.openInPaneHint}`)}">${escapeHtml(filePath)}</button>`;
          }
          return `<span class="file-chip static" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>`;
        })
        .join('')}
    </div>
  `;
}

function renderPlanHtml(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return '';
  const s = strings();
  const rows = plan.steps
    .map((step) => {
      const mark = step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '●' : '○';
      return `<li class="plan-step step-${escapeHtml(step.status)}"><span class="step-mark">${mark}</span><span>${escapeHtml(step.step)}</span></li>`;
    })
    .join('');
  return `
    <div class="plan-card">
      <div class="plan-title">${escapeHtml(s.planTitle)}${plan.explanation ? ` — ${escapeHtml(plan.explanation)}` : ''}</div>
      <ul class="plan-steps">${rows}</ul>
    </div>
  `;
}

function formatActivityText(ev) {
  const sum = ev.summary ?? {};
  if (ev.kind === 'commandExecution') {
    const exitStr = typeof sum.exitCode === 'number' ? ` (exit ${sum.exitCode})` : '';
    return `[cmd:${ev.phase}] ${sum.command || ''}${exitStr}`;
  }
  if (ev.kind === 'fileChange') {
    const fileList = Array.isArray(sum.files) && sum.files.length > 0 ? ` ${sum.files.join(', ')}` : '';
    return `[file:${ev.phase}]${fileList}`;
  }
  if (ev.kind === 'mcpToolCall') {
    return `[mcp:${ev.phase}] ${sum.server ?? ''}/${sum.tool ?? ''}`;
  }
  if (ev.kind === 'commentary' && sum.text) {
    return `[note] ${sum.text}`;
  }
  return `[${ev.kind}:${ev.phase}]`;
}

function renderTimeline(force = false) {
  if (!shellRefs) return;
  const s = strings();
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
  const convKey = `${meta.conversationId}:${cache?.nextSeq ?? 0}:${ordered.length}:${state.locale}:${entry.cache?.truncated ? 1 : 0}:${entry.cache?.liveJob?.status ?? ''}`;
  if (!force && state.lastRenderedConvKey === convKey) return;
  state.lastRenderedConvKey = convKey;

  const wasNearBottom = state.nearBottom;

  if (ordered.length === 0) {
    const fallbackPlan = meta.latestPlan ? renderPlanHtml(meta.latestPlan) : '';
    shellRefs.timeline.innerHTML = `${fallbackPlan}<div class="empty-state">${escapeHtml(s.noEventsYet)}</div>`;
    return;
  }

  // Group contiguous activity/plan events neatly; render stream, diff, delegation, steer, answer clearly.
  const cards = [];
  if (cache?.truncated) {
    cards.push(`<div class="banner-warn">${escapeHtml(s.truncatedWarning)}</div>`);
  }

  let idx = 0;
  while (idx < ordered.length) {
    const ev = ordered[idx];

    if (ev.type === 'delegation') {
      const promptKey = `prompt:${ev.eventId}`;
      const isLong = (ev.prompt ?? '').length > 260 || (ev.prompt ?? '').split('\n').length > 4;
      const expanded = state.expandedPanels.has(promptKey);
      const badges = [];
      if (ev.sandbox) badges.push(ev.sandbox);
      if (ev.permissionMode) badges.push(ev.permissionMode);
      if (ev.model) badges.push(ev.model);
      if (ev.reasoningEffort) badges.push(ev.reasoningEffort);
      if (ev.imageCount) badges.push(`${ev.imageCount} ${s.badgeImages}`);
      if (ev.hasOutputSchema) badges.push(s.badgeSchema);

      cards.push(`
        <article class="card card-delegation">
          <div class="card-head">
            <div class="card-role">
              <span>${escapeHtml(s.roleGemini)} → ${escapeHtml(s.roleCodex)}</span>
              ${ev.description ? `<span class="badge">${escapeHtml(ev.description)}</span>` : ''}
            </div>
            <span class="card-time">${escapeHtml(formatClockTime(ev.at))}</span>
          </div>
          ${badges.length ? `<div class="badges">${badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join('')}</div>` : ''}
          ${ev.prompt ? `
            <div class="${isLong && !expanded ? 'collapsed-text' : ''}">${renderMarkdown(ev.prompt, s.copy)}</div>
            ${isLong ? `<div class="card-actions"><button type="button" class="mini-btn" data-toggle-prompt="${escapeHtml(promptKey)}">${expanded ? '▲' : '▼'}</button></div>` : ''}
          ` : ''}
        </article>
      `);
      idx += 1;
      continue;
    }

    if (ev.type === 'plan') {
      // Only show the latest consecutive plan snapshot if several arrived back-to-back
      let latest = ev;
      while (idx + 1 < ordered.length && ordered[idx + 1].type === 'plan') {
        idx += 1;
        latest = ordered[idx];
      }
      cards.push(renderPlanHtml(latest));
      idx += 1;
      continue;
    }

    if (ev.type === 'activity') {
      const group = [];
      while (idx < ordered.length && ordered[idx].type === 'activity') {
        group.push(ordered[idx]);
        idx += 1;
      }
      const panelKey = `act:${group[0].eventId}`;
      const isOpen = state.expandedPanels.has(panelKey);
      cards.push(`
        <details class="stream-box" data-panel-key="${escapeHtml(panelKey)}"${isOpen ? ' open' : ''}>
          <summary>${escapeHtml(s.activityTitle)} (${group.length})</summary>
          <ul class="activity-list">
            ${group.map((item) => `<li class="activity-row"><span>${escapeHtml(formatActivityText(item))}</span></li>`).join('')}
          </ul>
        </details>
      `);
      continue;
    }

    if (ev.type === 'stream') {
      if (ev.channel === 'agentMessage') {
        cards.push(`
          <article class="card">
            <div class="card-head">
              <div class="card-role"><span>${escapeHtml(s.roleCodex)}</span><span class="pill pill-running"><span class="pulse-dot"></span>${escapeHtml(s.phase.streaming)}</span></div>
              <span class="card-time">${escapeHtml(formatClockTime(ev.at))}</span>
            </div>
            ${renderMarkdown(ev.text, s.copy)}
          </article>
        `);
      } else {
        const panelKey = `stream:${ev.eventId}`;
        const defaultOpen = ev.channel === 'commandOutput';
        const isOpen = state.expandedPanels.has(panelKey) || (defaultOpen && !state.collapsedPanels.has(panelKey));
        const title = ev.channel === 'reasoning'
          ? s.thinkingTitle
          : ev.channel === 'commandOutput'
            ? s.commandTitle
            : s.planTitle;
        cards.push(`
          <details class="stream-box" data-panel-key="${escapeHtml(panelKey)}"${isOpen ? ' open' : ''}>
            <summary>${escapeHtml(title)}</summary>
            <pre class="stream-pre">${escapeHtml(ev.text)}</pre>
          </details>
        `);
      }
      idx += 1;
      continue;
    }

    if (ev.type === 'diff') {
      const panelKey = `diff:${ev.eventId}`;
      const isOpen = state.expandedPanels.has(panelKey);
      cards.push(`
        <article class="card">
          <div class="card-head">
            <div class="card-role"><span>${escapeHtml(s.diffTitle)}</span><span class="badge">${ev.filesChangedCount ?? (ev.files?.length ?? 0)} files</span></div>
            <span class="card-time">${escapeHtml(formatClockTime(ev.at))}</span>
          </div>
          ${renderFilesHtml(ev.files, cache?.fileLinksByPath)}
          ${ev.diff ? `
            <details class="stream-box" style="margin-top:8px" data-panel-key="${escapeHtml(panelKey)}"${isOpen ? ' open' : ''}>
              <summary>Unified Diff${ev.truncated ? ` (${escapeHtml(s.diffTruncated)})` : ''}</summary>
              ${renderDiff(ev.diff)}
            </details>
          ` : ''}
        </article>
      `);
      idx += 1;
      continue;
    }

    if (ev.type === 'steer') {
      const roleTitle = ev.source === 'user_ui' ? s.roleUiSteer : s.roleGeminiSteer;
      cards.push(`
        <article class="card card-steer">
          <div class="card-head">
            <div class="card-role"><span>${escapeHtml(roleTitle)}</span></div>
            <span class="card-time">${escapeHtml(formatClockTime(ev.at))}</span>
          </div>
          ${renderMarkdown(ev.text, s.copy)}
        </article>
      `);
      idx += 1;
      continue;
    }

    if (ev.type === 'answer') {
      const canAttach = Boolean(state.capabilities?.updateModelContext);
      const canSend = Boolean(state.capabilities?.message);
      const ansActions = [];
      if (ev.text) {
        ansActions.push(`<button type="button" class="mini-btn" data-copy-event="${escapeHtml(ev.eventId)}">${escapeHtml(s.copy)}</button>`);
        if (canAttach) {
          ansActions.push(`<button type="button" class="mini-btn" data-attach-event="${escapeHtml(ev.eventId)}">${escapeHtml(s.attachGemini)}</button>`);
        }
        if (canSend) {
          ansActions.push(`<button type="button" class="mini-btn" data-send-event="${escapeHtml(ev.eventId)}">${escapeHtml(s.sendGemini)}</button>`);
        }
      }
      cards.push(`
        <article class="card card-answer${ev.isError ? ' error' : ''}">
          <div class="card-head">
            <div class="card-role">
              <span>${escapeHtml(s.roleCodex)}</span>
              ${ev.isError ? `<span class="pill pill-danger">${escapeHtml(s.errorLabel)}</span>` : ''}
            </div>
            <span class="card-time">${escapeHtml(formatClockTime(ev.at))}</span>
          </div>
          ${renderMarkdown(ev.text || '', s.copy)}
          ${ansActions.length ? `<div class="card-actions">${ansActions.join('')}</div>` : ''}
        </article>
      `);
      idx += 1;
      continue;
    }

    // Lifecycle cards: compact / fork / cancel / closed
    const summaryText = ev.type === 'compact'
      ? `${s.actionCompact}: ${ev.text || s.compactCompleted}`
      : ev.type === 'fork'
        ? `${s.actionFork} (${shortId(ev.sourceThreadId)} → ${shortId(ev.threadId)})`
        : ev.type === 'cancel'
          ? `${ev.source === 'user_ui' ? s.roleUiSteer : s.roleGemini}: ${s.runCancelled}`
          : ev.type === 'closed'
            ? s.sessionClosed
            : ev.type;
    cards.push(`
      <article class="card card-lifecycle">
        <div class="card-head" style="margin-bottom:0">
          <span>${escapeHtml(summaryText)}</span>
          <span class="card-time">${escapeHtml(formatClockTime(ev.at))}</span>
        </div>
      </article>
    `);
    idx += 1;
  }

  shellRefs.timeline.innerHTML = cards.join('');

  if (wasNearBottom) {
    shellRefs.timeline.scrollTop = shellRefs.timeline.scrollHeight;
    shellRefs.jumpLatest.hidden = true;
  } else {
    shellRefs.jumpLatest.hidden = false;
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
  let cache = state.convCache.get(conversationId);
  if (!cache || reset) {
    cache = {
      conversation: payload.conversation,
      eventsById: new Map(),
      order: [],
      nextSeq: 0,
      truncated: false,
      liveJob: null,
      fileLinksByPath: new Map(),
    };
    state.convCache.set(conversationId, cache);
  }
  cache.conversation = payload.conversation;
  cache.liveJob = payload.liveJob ?? null;
  cache.truncated = Boolean(payload.truncated);
  if (Array.isArray(payload.fileLinks)) {
    for (const link of payload.fileLinks) {
      if (link?.path && link?.uri) cache.fileLinksByPath.set(link.path, link.uri);
    }
  }
  const incoming = Array.isArray(payload.events) ? payload.events : [];
  for (const ev of incoming) {
    const existed = cache.eventsById.has(ev.eventId);
    cache.eventsById.set(ev.eventId, ev);
    if (!existed) cache.order.push(ev.eventId);
  }
  if (typeof payload.nextSeq === 'number' && payload.nextSeq > cache.nextSeq) {
    cache.nextSeq = payload.nextSeq;
  }
}

async function refreshList() {
  const res = await app.callServerTool({ name: 'codex_ui_list_conversations', arguments: {} });
  if (res.isError) return;
  const payload = parseToolPayload(res);
  if (!payload || !Array.isArray(payload.conversations)) return;
  state.conversations = payload.conversations;

  const ids = new Set(state.conversations.map((item) => item.conversationId));
  if (state.preferredInitialId && ids.has(state.preferredInitialId)) {
    state.selectedId = state.preferredInitialId;
    state.preferredInitialId = null;
  } else if (!state.selectedId || !ids.has(state.selectedId)) {
    state.selectedId = state.conversations[0]?.conversationId ?? null;
  }
}

async function refreshConversation(conversationId, { forceFull = false } = {}) {
  if (!conversationId) return;
  const cached = state.convCache.get(conversationId);
  const afterSeq = forceFull || !cached ? 0 : cached.nextSeq;
  const res = await app.callServerTool({
    name: 'codex_ui_get_conversation',
    arguments: { conversationId, afterSeq, limit: 200 },
  });
  if (res.isError) {
    if (forceFull) {
      await refreshList();
      renderAllPanels(true);
    }
    return;
  }
  const payload = parseToolPayload(res);
  if (!payload?.conversation) return;
  applyConversationPage(conversationId, payload, forceFull || !cached);

  // Follow pagination cleanly without exceeding host tool concurrency limits
  let safety = 0;
  while (payload.hasMore && safety < 5) {
    safety += 1;
    const nextAfter = state.convCache.get(conversationId)?.nextSeq ?? 0;
    const nextRes = await app.callServerTool({
      name: 'codex_ui_get_conversation',
      arguments: { conversationId, afterSeq: nextAfter, limit: 200 },
    });
    if (nextRes.isError) break;
    const nextPayload = parseToolPayload(nextRes);
    if (!nextPayload?.events?.length) break;
    applyConversationPage(conversationId, nextPayload, false);
    if (!nextPayload.hasMore) break;
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
  if (document.hidden) return;
  const anyRunning = state.conversations.some((c) => c.status === 'running')
    || getSelectedEntry()?.cache?.liveJob?.status === 'running';
  const delayMs = anyRunning ? 650 : 2500;
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
    state.lastRenderedConvKey = '';
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
  const targetId = payload?.initialConversationId ?? payload?.conversationId;
  if (typeof targetId === 'string' && targetId) {
    state.preferredInitialId = targetId;
    if (state.connected) {
      state.selectedId = targetId;
      state.lastRenderedConvKey = '';
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
    renderAllPanels(true);
  }
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.connected) {
    void pollOnce().then(() => scheduleNextPoll());
  } else {
    clearTimeout(state.pollTimer);
  }
});

async function bootstrap() {
  buildShell();
  await app.connect();
  state.connected = true;
  state.capabilities = app.getHostCapabilities() ?? {};
  applyHostContext(app.getHostContext());
  renderChrome();
  await pollOnce({ forceFull: true });
  scheduleNextPoll();
}

void bootstrap();
