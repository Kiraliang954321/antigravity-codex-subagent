import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/app-with-deps';
import { tFor } from './i18n.js';

const DEFAULT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const PRO_PLANS_WITHOUT_FIVE_HOUR = new Set(['pro', 'prolite', 'promax', 'edu_pro']);
const QUOTA_GRADIENT_STOPS = [
  { at: 0, start: [220, 38, 38], end: [248, 113, 113] },
  { at: 20, start: [234, 88, 12], end: [251, 146, 60] },
  { at: 45, start: [217, 119, 6], end: [250, 204, 21] },
  { at: 75, start: [22, 163, 74], end: [74, 222, 128] },
  { at: 100, start: [5, 150, 105], end: [52, 211, 153] },
];

const app = new App({ name: 'codex-subagent-settings', version: '0.5.0' }, {}, { autoResize: false });

const emptyRateLimits = () => ({
  available: false,
  planType: null,
  ordinaryUsageAllowed: null,
  windows: [],
  credits: null,
  spendControlReached: null,
  rateLimitReachedType: null,
  updatedAt: null,
  error: null,
});

const state = {
  connected: false,
  loaded: false,
  syncedOnce: false,
  syncing: false,
  busy: false,
  dirty: false,
  locale: 'en-US',
  modelMenuOpen: false,
  customModelMode: false,
  toast: null,
  draft: { model: null, reasoningEffort: null },
  meta: {
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
      reasoningEfforts: [...DEFAULT_EFFORTS],
    },
    limits: { maxModelLength: 128 },
    rateLimits: emptyRateLimits(),
  },
};

let toastTimer = null;

function strings() {
  return tFor(state.locale);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function showToast(kind, text, ttlMs = 3200) {
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

function getSelectedModelEntry(modelId) {
  const target = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (!target) return null;
  const models = state.meta.options.models ?? [];
  return models.find((entry) => entry.model.toLowerCase() === target || String(entry.id || '').toLowerCase() === target) ?? null;
}

function getEffortOptionsForModel(modelId) {
  const entry = getSelectedModelEntry(modelId);
  if (entry?.supportedReasoningEfforts?.length) {
    return entry.supportedReasoningEfforts;
  }
  const fallback = state.meta.options.reasoningEfforts?.length
    ? state.meta.options.reasoningEfforts
    : DEFAULT_EFFORTS;
  return fallback.map((reasoningEffort) => ({ reasoningEffort, description: '' }));
}

function resolvedDraftDefaults() {
  const cfg = state.meta.codexConfig;
  const defs = state.meta.defaults;
  const eff = state.meta.effective;
  const model = cfg.model ?? defs.model ?? cfg.catalogDefaultModel ?? eff.model ?? null;
  const entry = getSelectedModelEntry(model);
  const rawEffort = cfg.reasoningEffort
    ?? defs.reasoningEffort
    ?? entry?.defaultReasoningEffort
    ?? cfg.catalogDefaultReasoningEffort
    ?? eff.reasoningEffort
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

function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return emptyRateLimits();
  return {
    available: Boolean(raw.available),
    planType: typeof raw.planType === 'string' && raw.planType.trim() ? raw.planType.trim().toLowerCase() : null,
    ordinaryUsageAllowed: typeof raw.ordinaryUsageAllowed === 'boolean' ? raw.ordinaryUsageAllowed : null,
    windows: Array.isArray(raw.windows)
      ? raw.windows
          .filter((win) => win && typeof win === 'object')
          .map((win) => {
            const used = clampPercent(Number.isFinite(win.usedPercent) ? win.usedPercent : 0);
            const remaining = clampPercent(
              Number.isFinite(win.remainingPercent) ? win.remainingPercent : (100 - used),
            );
            return {
              kind: typeof win.kind === 'string' ? win.kind : 'window',
              usedPercent: used,
              remainingPercent: remaining,
              windowDurationMins: Number.isInteger(win.windowDurationMins) && win.windowDurationMins > 0
                ? win.windowDurationMins
                : null,
              resetsAt: Number.isFinite(win.resetsAt) && win.resetsAt > 0 ? win.resetsAt : null,
            };
          })
      : [],
    credits: raw.credits && typeof raw.credits === 'object'
      ? {
          hasCredits: Boolean(raw.credits.hasCredits),
          unlimited: Boolean(raw.credits.unlimited),
          balance: raw.credits.balance ?? null,
        }
      : null,
    spendControlReached: typeof raw.spendControlReached === 'boolean' ? raw.spendControlReached : null,
    rateLimitReachedType: typeof raw.rateLimitReachedType === 'string' ? raw.rateLimitReachedType : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function lerpRgb(rgbA, rgbB, t) {
  const r = Math.round(rgbA[0] + (rgbB[0] - rgbA[0]) * t);
  const g = Math.round(rgbA[1] + (rgbB[1] - rgbA[1]) * t);
  const b = Math.round(rgbA[2] + (rgbB[2] - rgbA[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function quotaGradientForRemaining(remainingPercent) {
  const pct = clampPercent(remainingPercent);
  let upperIdx = QUOTA_GRADIENT_STOPS.findIndex((stop) => stop.at >= pct);
  if (upperIdx <= 0) {
    const first = QUOTA_GRADIENT_STOPS[0];
    return {
      fillBackground: `linear-gradient(90deg, rgb(${first.start.join(',')}), rgb(${first.end.join(',')}))`,
      levelClass: 'crit',
    };
  }
  const lowStop = QUOTA_GRADIENT_STOPS[upperIdx - 1];
  const highStop = QUOTA_GRADIENT_STOPS[upperIdx];
  const span = Math.max(1, highStop.at - lowStop.at);
  const t = Math.max(0, Math.min(1, (pct - lowStop.at) / span));
  const startRgb = lerpRgb(lowStop.start, highStop.start, t);
  const endRgb = lerpRgb(lowStop.end, highStop.end, t);
  let levelClass = 'crit';
  if (pct >= 60) levelClass = 'high';
  else if (pct >= 30) levelClass = 'mid';
  else if (pct >= 15) levelClass = 'low';
  return {
    fillBackground: `linear-gradient(90deg, ${startRgb}, ${endRgb})`,
    levelClass,
  };
}

function formatPercentValue(value) {
  const pct = clampPercent(value);
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

function formatPlanLabel(planType, s) {
  if (!planType) return '';
  if (s.planLabels?.[planType]) return s.planLabels[planType];
  return planType.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function visibleQuotaWindows(rateLimits) {
  const windows = Array.isArray(rateLimits?.windows) ? [...rateLimits.windows] : [];
  if (rateLimits?.planType && PRO_PLANS_WITHOUT_FIVE_HOUR.has(rateLimits.planType)) {
    const nonFiveHour = windows.filter((win) => win.kind !== 'five_hour' && win.windowDurationMins !== 300);
    if (nonFiveHour.length > 0) return nonFiveHour;
  }
  return windows;
}

function formatWindowLabel(win, s) {
  const isZh = String(state.locale).toLowerCase().startsWith('zh');
  if (win.kind === 'five_hour') return s.quotaFiveHour;
  if (win.kind === 'weekly') return s.quotaWeekly;
  if (win.kind === 'daily') return s.quotaDaily;
  const mins = win.windowDurationMins;
  if (Number.isInteger(mins) && mins > 0) {
    if (mins % 1440 === 0) {
      const days = mins / 1440;
      return isZh ? `${days} 天限额` : `${days}-day limit`;
    }
    if (mins % 60 === 0) {
      const hours = mins / 60;
      return isZh ? `${hours} 小时用量上限` : `${hours}-hour usage limit`;
    }
    return isZh ? `${mins} 分钟用量上限` : `${mins}-minute usage limit`;
  }
  return s.quotaGeneric;
}

function formatResetText(resetsAtSec, s) {
  if (!Number.isFinite(resetsAtSec) || resetsAtSec <= 0) return '';
  const targetMs = resetsAtSec * 1000;
  const diffMs = targetMs - Date.now();
  const isZh = String(state.locale).toLowerCase().startsWith('zh');
  const dateObj = new Date(targetMs);
  let clockStr = '';
  try {
    clockStr = new Intl.DateTimeFormat(state.locale || (isZh ? 'zh-CN' : 'en-US'), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(dateObj);
  } catch {
    clockStr = '';
  }

  if (diffMs <= 60_000) {
    return clockStr ? `${s.quotaResetsSoon} (${clockStr})` : s.quotaResetsSoon;
  }

  const totalMins = Math.round(diffMs / 60_000);
  if (totalMins < 1440) {
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (isZh) {
      const dur = hours > 0 ? (mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`) : `${mins} 分钟`;
      return clockStr ? `${dur}后重置（${clockStr}）` : `${dur}后重置`;
    }
    const dur = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
    return clockStr ? `Resets in ${dur} (${clockStr})` : `Resets in ${dur}`;
  }

  const days = Math.floor(totalMins / 1440);
  const remHours = Math.floor((totalMins % 1440) / 60);
  let dayStr = '';
  try {
    dayStr = new Intl.DateTimeFormat(state.locale || (isZh ? 'zh-CN' : 'en-US'), {
      month: isZh ? 'numeric' : 'short',
      day: 'numeric',
    }).format(dateObj);
  } catch {
    dayStr = '';
  }
  const timeStamp = [dayStr, clockStr].filter(Boolean).join(isZh ? ' ' : ', ');
  if (isZh) {
    const dur = remHours > 0 ? `${days} 天 ${remHours} 小时` : `${days} 天`;
    return timeStamp ? `${dur}后重置（${timeStamp}）` : `${dur}后重置`;
  }
  const dur = remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  return timeStamp ? `Resets in ${dur} (${timeStamp})` : `Resets in ${dur}`;
}

function applySettingsPayload(payload, { forceDraft = false } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.codexConfig) return false;
  const cfg = payload.codexConfig ?? {};
  state.meta = {
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
        : [...DEFAULT_EFFORTS],
    },
    limits: {
      maxModelLength: payload.limits?.maxModelLength ?? 128,
    },
    rateLimits: normalizeRateLimits(payload.rateLimits),
  };
  state.loaded = true;
  if (state.meta.codexConfig.synced) {
    state.syncedOnce = true;
  }
  if (forceDraft || !state.dirty) {
    const resolved = resolvedDraftDefaults();
    state.draft = { ...resolved };
    state.dirty = false;
    state.customModelMode = Boolean(
      resolved.model
      && state.meta.options.models.length > 0
      && !getSelectedModelEntry(resolved.model),
    );
  }
  return true;
}

async function loadSettings({ silent = false, syncCodex = true, forceDraft = false } = {}) {
  if (!state.connected) return false;
  if (syncCodex) {
    state.syncing = true;
    renderAll();
  }
  try {
    const res = await app.callServerTool({
      name: 'codex_ui_get_settings',
      arguments: syncCodex ? { syncCodex: true } : { syncCodex: false },
    });
    if (res?.isError) {
      if (!silent) showToast('error', extractErrorText(res, strings().errorLabel));
      return false;
    }
    const payload = parseToolPayload(res);
    if (!applySettingsPayload(payload, { forceDraft })) return false;
    renderAll();
    return true;
  } catch (err) {
    if (!silent) showToast('error', err?.message || strings().errorLabel);
    return false;
  } finally {
    if (syncCodex) {
      state.syncing = false;
      renderAll();
    }
  }
}

async function saveSettings() {
  if (!state.connected || state.busy) return;
  const s = strings();
  const cleanModel = typeof state.draft.model === 'string' ? (state.draft.model.trim() || null) : null;
  const cleanEffort = typeof state.draft.reasoningEffort === 'string'
    ? (state.draft.reasoningEffort.trim() || null)
    : null;

  state.busy = true;
  renderAll();
  try {
    const res = await app.callServerTool({
      name: 'codex_ui_update_settings',
      arguments: {
        codex: {
          model: cleanModel,
          reasoningEffort: cleanEffort,
        },
      },
    });
    if (res?.isError) {
      showToast('error', extractErrorText(res, s.errorLabel));
      return;
    }
    const payload = parseToolPayload(res);
    applySettingsPayload(payload, { forceDraft: true });
    state.dirty = false;
    state.modelMenuOpen = false;
    showToast('success', s.savedToast, 2600);
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  } finally {
    state.busy = false;
    renderAll();
  }
}

async function resetSettings() {
  if (!state.connected || state.busy) return;
  const s = strings();
  state.busy = true;
  renderAll();
  try {
    const res = await app.callServerTool({
      name: 'codex_ui_update_settings',
      arguments: { reset: true },
    });
    if (res?.isError) {
      showToast('error', extractErrorText(res, s.errorLabel));
      return;
    }
    const payload = parseToolPayload(res);
    applySettingsPayload(payload, { forceDraft: true });
    state.dirty = false;
    state.modelMenuOpen = false;
    showToast('info', s.resetToast, 2600);
  } catch (err) {
    showToast('error', err?.message || s.errorLabel);
  } finally {
    state.busy = false;
    renderAll();
  }
}

function renderEffortFieldHtml() {
  const s = strings();
  const currentModel = String(state.draft.model ?? '').trim();
  const currentEffort = String(state.draft.reasoningEffort ?? '').trim().toLowerCase();
  const effortOptions = getEffortOptionsForModel(currentModel);
  const disabledAttr = state.busy ? ' disabled' : '';

  const buttonsHtml = effortOptions.map((opt) => {
    const sel = currentEffort && opt.reasoningEffort.toLowerCase() === currentEffort ? ' selected' : '';
    return `<button type="button" class="seg-btn${sel}" data-effort="${escapeHtml(opt.reasoningEffort)}"${opt.description ? ` title="${escapeHtml(opt.description)}"` : ''}${disabledAttr}>${escapeHtml(getEffortLabel(opt.reasoningEffort))}</button>`;
  }).join('');

  const selectedOpt = effortOptions.find((opt) => currentEffort && opt.reasoningEffort.toLowerCase() === currentEffort);
  return `
    <span class="field-label">${escapeHtml(s.effortLabel)}</span>
    <div class="effort-segment">${buttonsHtml}</div>
    ${selectedOpt?.description ? `<div class="effort-desc">${escapeHtml(selectedOpt.description)}</div>` : ''}
  `;
}

function renderEffortField() {
  const field = document.querySelector('[data-effort-field="1"]');
  if (field) field.innerHTML = renderEffortFieldHtml();
  renderDirtyState();
}

function renderDirtyState() {
  const s = strings();
  const badge = document.getElementById('dirty-pill');
  if (badge) {
    badge.hidden = !state.dirty;
    badge.textContent = s.unsavedBadge;
  }
}

function renderToast() {
  const el = document.getElementById('settings-toast');
  if (!el) return;
  if (!state.toast) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.className = `toast ${state.toast.kind}`;
  el.innerHTML = `<span>${escapeHtml(state.toast.text)}</span><button type="button" class="mini-btn" data-dismiss-toast="1">×</button>`;
}

function renderQuotaCardHtml() {
  const s = strings();
  const rl = state.meta.rateLimits ?? emptyRateLimits();
  const disabledAttr = (state.busy || state.syncing) ? ' disabled' : '';
  const planLabel = formatPlanLabel(rl.planType, s);
  const isPro = Boolean(rl.planType && PRO_PLANS_WITHOUT_FIVE_HOUR.has(rl.planType));
  const planBadgeHtml = planLabel
    ? `<span class="plan-badge ${isPro ? 'plan-pro' : 'plan-plus'}">${escapeHtml(planLabel)}</span>`
    : '';

  let bodyHtml = '';
  if (state.syncing && !rl.available) {
    bodyHtml = `
      <div class="quota-loading" aria-busy="true">
        <div class="quota-skeleton-bar"></div>
        <div class="quota-skeleton-bar"></div>
        <div class="hint-text">${escapeHtml(s.quotaLoading)}</div>
      </div>
    `;
  } else if (!rl.available) {
    bodyHtml = `<div class="quota-empty">${escapeHtml(s.quotaUnavailable)}</div>`;
  } else {
    const windows = visibleQuotaWindows(rl);
    const windowsHtml = windows.length > 0
      ? `<div class="quota-list">${windows.map((win) => {
          const label = formatWindowLabel(win, s);
          const remPct = clampPercent(win.remainingPercent);
          const usedPct = clampPercent(win.usedPercent);
          const remText = `${s.quotaRemainingPrefix}${formatPercentValue(remPct)}%`;
          const usedText = `${s.quotaUsedPrefix}${formatPercentValue(usedPct)}%`;
          const resetText = formatResetText(win.resetsAt, s);
          const { fillBackground, levelClass } = quotaGradientForRemaining(remPct);
          const fillStyle = remPct <= 0
            ? `width:0%;background:${fillBackground}`
            : remPct < 3
              ? `width:${remPct}%;min-width:6px;background:${fillBackground}`
              : `width:${remPct}%;background:${fillBackground}`;
          return `
            <div class="quota-item" data-quota-kind="${escapeHtml(win.kind)}">
              <div class="quota-item-head">
                <span class="quota-item-label">${escapeHtml(label)}</span>
                <span class="quota-item-pct quota-level-${levelClass}">${escapeHtml(remText)}</span>
              </div>
              <div class="quota-bar-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(formatPercentValue(remPct))}">
                <div class="quota-bar-fill" style="${escapeHtml(fillStyle)}"></div>
              </div>
              <div class="quota-item-meta">
                <span>${escapeHtml(usedText)}</span>
                ${resetText ? `<span class="quota-reset-text">${escapeHtml(resetText)}</span>` : ''}
              </div>
            </div>
          `;
        }).join('')}</div>`
      : `<div class="quota-empty">${escapeHtml(s.quotaEmptyWindows)}</div>`;

    const blockedWarnHtml = (rl.ordinaryUsageAllowed === false || rl.spendControlReached === true)
      ? `<div class="warn-banner">${escapeHtml(s.quotaBlockedWarn)}</div>`
      : '';

    let creditsHtml = '';
    if (rl.credits) {
      const creditsValue = rl.credits.unlimited
        ? s.quotaUnlimited
        : (rl.credits.balance ?? (rl.credits.hasCredits ? '✓' : '0'));
      creditsHtml = `
        <div class="quota-credits-row">
          <span class="quota-credits-label">${escapeHtml(s.quotaCreditsLabel)}</span>
          <span class="quota-credits-val">${escapeHtml(creditsValue)}</span>
        </div>
      `;
    }

    bodyHtml = `${windowsHtml}${blockedWarnHtml}${creditsHtml}`;
  }

  return `
    <div class="quota-head">
      <div class="quota-head-copy">
        <div class="quota-title-row">
          <h2 class="quota-title">${escapeHtml(s.quotaTitle)}</h2>
          ${planBadgeHtml}
        </div>
        <p class="quota-subtitle">${escapeHtml(s.quotaSubtitle)}</p>
      </div>
      <button type="button" class="mini-btn" data-action="refresh-quota"${disabledAttr}>↻ ${escapeHtml(s.quotaRefresh)}</button>
    </div>
    ${bodyHtml}
  `;
}

function renderAll() {
  const root = document.getElementById('app');
  if (!root) return;

  const s = strings();
  const { codexConfig, defaults, effective, options, limits } = state.meta;
  const models = options.models ?? [];
  const trimmedModel = String(state.draft.model ?? '').trim();
  const selectedEntry = getSelectedModelEntry(trimmedModel);
  const showDropdown = models.length > 0 && !state.customModelMode;
  const disabledAttr = state.busy ? ' disabled' : '';
  const syncDisabledAttr = (state.busy || state.syncing) ? ' disabled' : '';

  let syncStatusHtml = '';
  if (state.syncing) {
    syncStatusHtml = `<span class="sync-status">${escapeHtml(s.syncing)}</span>`;
  } else if (codexConfig.synced && codexConfig.catalogAvailable) {
    syncStatusHtml = `<span class="sync-status ok">${escapeHtml(s.synced)}</span>`;
  } else if (codexConfig.error || state.loaded) {
    syncStatusHtml = `<span class="sync-status warn">${escapeHtml(s.syncFailed)}</span>`;
  }

  let modelControlHtml = '';
  if (showDropdown) {
    const triggerTitle = selectedEntry?.displayName || trimmedModel || s.modelSelectPlaceholder;
    const triggerSlug = selectedEntry && selectedEntry.displayName.toLowerCase() !== selectedEntry.model.toLowerCase()
      ? selectedEntry.model
      : '';
    const menuHtml = state.modelMenuOpen ? `
      <div class="codex-model-menu" role="listbox" aria-label="${escapeHtml(s.modelLabel)}">
        <div class="codex-model-menu-head">${escapeHtml(s.modelRecommended)}</div>
        <div class="codex-model-menu-list">
          ${models.map((entry) => {
            const isSel = selectedEntry
              ? entry.model.toLowerCase() === selectedEntry.model.toLowerCase()
              : trimmedModel.toLowerCase() === entry.model.toLowerCase();
            return `
              <button type="button" class="codex-model-option${isSel ? ' selected' : ''}" role="option" aria-selected="${isSel ? 'true' : 'false'}" data-model-pick="${escapeHtml(entry.model)}"${disabledAttr}>
                <span class="codex-model-option-main">
                  <span class="codex-model-option-top">
                    <span class="codex-model-option-title">${escapeHtml(entry.displayName)}</span>
                    ${entry.isDefault ? `<span class="codex-model-default-tag">${escapeHtml(s.modelBadgeDefault)}</span>` : ''}
                  </span>
                  ${entry.description ? `<span class="codex-model-option-desc" title="${escapeHtml(entry.description)}">${escapeHtml(entry.description)}</span>` : ''}
                </span>
                ${isSel ? '<span class="codex-model-check" aria-hidden="true">✓</span>' : ''}
              </button>
            `;
          }).join('')}
        </div>
        <div class="codex-model-menu-foot">
          <button type="button" class="link-toggle-btn" data-custom-toggle="1"${disabledAttr}>${escapeHtml(s.modelUseCustom)}</button>
        </div>
      </div>
    ` : '';

    modelControlHtml = `
      <div class="field-block">
        <span class="field-label">${escapeHtml(s.modelLabel)}</span>
        <div class="codex-model-picker" data-model-picker="1">
          <button type="button" class="codex-model-trigger" data-model-toggle="1" aria-expanded="${state.modelMenuOpen ? 'true' : 'false'}"${disabledAttr}>
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
      <label class="field-block">
        <span class="field-label">${escapeHtml(s.modelLabel)}</span>
        <div class="codex-model-custom-row">
          <input id="codex-model-input" type="text" class="text-input mono" data-codex-model="1" maxlength="${limits.maxModelLength ?? 128}" value="${escapeHtml(state.draft.model ?? '')}" placeholder="${escapeHtml(s.modelPlaceholderCustom)}"${disabledAttr} />
          ${models.length > 0 ? `<button type="button" class="btn" data-custom-toggle="0"${disabledAttr}>${escapeHtml(s.modelBackToList)}</button>` : ''}
        </div>
      </label>
    `;
  }

  const envVars = [];
  if (defaults.envModel) envVars.push('CODEX_MODEL');
  if (defaults.envReasoningEffort) envVars.push('CODEX_REASONING_EFFORT');
  const envWarnHtml = envVars.length > 0
    ? `<div class="warn-banner">${escapeHtml(`${s.envOverridePrefix}${envVars.join(', ')}${s.envOverrideSuffix}`)}</div>`
    : '';
  const layerWarnHtml = codexConfig.overridden
    ? `<div class="warn-banner">${escapeHtml(`${s.modelOverridden}${codexConfig.overriddenMessage ? ` ${codexConfig.overriddenMessage}` : ''}`)}</div>`
    : '';

  const effParts = [];
  if (effective.model) {
    const effEntry = getSelectedModelEntry(effective.model);
    effParts.push(effEntry?.displayName || effective.model);
  }
  if (effective.reasoningEffort) {
    effParts.push(getEffortLabel(effective.reasoningEffort));
  }
  const effectiveSummaryHtml = effParts.length > 0
    ? `<div class="effective-row"><span class="effective-label">${escapeHtml(s.effectiveLabel)}:</span>${effParts.map((part) => `<span class="effective-chip">${escapeHtml(part)}</span>`).join('')}</div>`
    : '';

  root.innerHTML = `
    <main class="page-shell">
      <div class="settings-panel">
        <header class="panel-head">
          <div class="panel-head-copy">
            <div class="panel-title-row">
              <h1 class="panel-title">${escapeHtml(s.pageTitle)}</h1>
              <span id="dirty-pill" class="dirty-pill"${state.dirty ? '' : ' hidden'}>${escapeHtml(s.unsavedBadge)}</span>
            </div>
            <p class="panel-subtitle">${escapeHtml(s.pageSubtitle)}</p>
          </div>
          <div class="sync-controls">
            ${syncStatusHtml}
            <button type="button" class="mini-btn sync-btn" data-action="sync"${syncDisabledAttr}>↻ ${escapeHtml(s.sync)}</button>
          </div>
        </header>

        <section class="panel-card">
          ${modelControlHtml}
          <div class="field-block" data-effort-field="1">
            ${renderEffortFieldHtml()}
          </div>
          ${envWarnHtml}
          ${layerWarnHtml}
          ${effectiveSummaryHtml}
          <div class="hint-text">${escapeHtml(s.modelHint)}</div>
          <footer class="card-foot">
            <button type="button" class="btn btn-danger" data-action="reset"${disabledAttr}>${escapeHtml(s.resetDefaults)}</button>
            <button type="button" class="btn btn-primary" data-action="save"${disabledAttr}>${escapeHtml(state.busy ? s.saving : s.save)}</button>
          </footer>
        </section>

        <div id="settings-toast" class="toast" hidden></div>

        <section class="panel-card quota-card" data-quota-card="1">
          ${renderQuotaCardHtml()}
        </section>
      </div>
    </main>
  `;

  renderToast();
}

function bindEvents() {
  const root = document.getElementById('app');
  if (!root) return;

  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-dismiss-toast]')) {
      state.toast = null;
      renderToast();
      return;
    }

    if (state.modelMenuOpen && !ev.target.closest('[data-model-picker]')) {
      state.modelMenuOpen = false;
      renderAll();
    }

    const syncBtn = ev.target.closest('[data-action="sync"]');
    if (syncBtn && !state.syncing && !state.busy) {
      state.dirty = false;
      void loadSettings({ silent: false, syncCodex: true, forceDraft: true });
      return;
    }

    const refreshQuotaBtn = ev.target.closest('[data-action="refresh-quota"]');
    if (refreshQuotaBtn && !state.syncing && !state.busy) {
      void loadSettings({ silent: false, syncCodex: true, forceDraft: false });
      return;
    }

    const toggleBtn = ev.target.closest('[data-model-toggle]');
    if (toggleBtn && !state.busy) {
      state.modelMenuOpen = !state.modelMenuOpen;
      renderAll();
      return;
    }

    const pickBtn = ev.target.closest('[data-model-pick]');
    if (pickBtn && !state.busy) {
      const pickedModel = pickBtn.dataset.modelPick || '';
      state.dirty = true;
      state.modelMenuOpen = false;
      state.customModelMode = false;
      state.draft.model = pickedModel || null;
      const entry = getSelectedModelEntry(pickedModel);
      if (entry?.supportedReasoningEfforts?.length) {
        const curEff = String(state.draft.reasoningEffort ?? '').trim().toLowerCase();
        const supported = entry.supportedReasoningEfforts.some((opt) => opt.reasoningEffort.toLowerCase() === curEff);
        if (!supported) {
          state.draft.reasoningEffort = entry.defaultReasoningEffort || entry.supportedReasoningEfforts[0].reasoningEffort;
        }
      }
      renderAll();
      return;
    }

    const customToggle = ev.target.closest('[data-custom-toggle]');
    if (customToggle && !state.busy) {
      const enableCustom = customToggle.dataset.customToggle === '1';
      state.customModelMode = enableCustom;
      state.modelMenuOpen = false;
      renderAll();
      if (enableCustom) {
        document.getElementById('codex-model-input')?.focus();
      }
      return;
    }

    const effortBtn = ev.target.closest('[data-effort]');
    if (effortBtn && !state.busy) {
      const eff = effortBtn.dataset.effort || '';
      state.dirty = true;
      state.draft.reasoningEffort = eff || null;
      renderEffortField();
      return;
    }

    const saveBtn = ev.target.closest('[data-action="save"]');
    if (saveBtn) {
      void saveSettings();
      return;
    }

    const resetBtn = ev.target.closest('[data-action="reset"]');
    if (resetBtn) {
      void resetSettings();
    }
  });

  root.addEventListener('input', (ev) => {
    if (ev.target?.dataset?.codexModel !== undefined) {
      state.dirty = true;
      state.draft.model = ev.target.value;
      renderEffortField();
    }
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.modelMenuOpen) {
      state.modelMenuOpen = false;
      renderAll();
    }
  });
}

async function bootstrap() {
  renderAll();
  bindEvents();

  app.onhostcontextchanged = (ctx) => {
    applyHostContext(ctx);
    renderAll();
  };

  app.ontoolresult = (result) => {
    const payload = parseToolPayload(result);
    if (!state.syncedOnce && !state.dirty && payload?.codexConfig) {
      applySettingsPayload(payload);
      renderAll();
    }
  };

  try {
    await app.connect();
    state.connected = true;
    applyHostContext(app.getHostContext?.());
    renderAll();
    await loadSettings({ silent: false, syncCodex: true });
  } catch (err) {
    showToast('error', err?.message || strings().errorLabel, 0);
  }
}

void bootstrap();
