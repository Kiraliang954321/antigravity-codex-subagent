import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeCwdPath } from './codex-client.mjs';
import { atomicWriteJsonFile } from './disk-job-store.mjs';

export const AVATAR_PRESET_IDS = Object.freeze(['spark', 'terminal', 'bot', 'cube', 'bolt', 'orbit', 'cat', 'shield']);
export const SETTINGS_LIMITS = Object.freeze({
  maxNameLength: 40,
  maxModelLength: 128,
  maxEmojiLength: 16,
  maxEmojiBytes: 32,
  maxAvatarDataUrlChars: 65536,
});

const FACTORY_DEFAULTS = {
  version: 1,
  updatedAt: null,
  roles: {
    gemini: { name: null, avatar: null },
    codex: { name: null, avatar: null },
  },
  codex: { model: null, reasoningEffort: null },
};
const ROLE_IDS = Object.keys(FACTORY_DEFAULTS.roles);
export const MODEL_PATTERN = new RegExp(`^[^\\s\\p{Cc}\\p{Cf}]{1,${SETTINGS_LIMITS.maxModelLength}}$`, 'u');
export const REASONING_EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function resolveIsolatedSettingsPath(storePath) {
  const baseName = (path.basename(storePath, path.extname(storePath)) || 'sessions')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = createHash('sha256').update(normalizeCwdPath(storePath)).digest('hex').slice(0, 12);
  return path.join(path.dirname(storePath), 'settings', `${baseName}-${hash}.json`);
}

function validateKeys(value, allowed, field, required = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field} has unknown key "${String(key)}"`);
  }
  if (required) {
    for (const key of allowed) {
      if (!Object.hasOwn(value, key)) throw new Error(`${field}.${key} is required`);
    }
  }
}

function normalizeText(value, field, clean = (text) => text.trim()) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null`);
  return clean(value) || null;
}

function normalizeName(value, field) {
  const name = normalizeText(value, field, (text) => text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim());
  if (name !== null && [...name].length > SETTINGS_LIMITS.maxNameLength) {
    throw new Error(`${field} must be at most ${SETTINGS_LIMITS.maxNameLength} characters`);
  }
  return name;
}

function normalizeAvatar(avatar, field) {
  if (avatar === null) return null;
  validateKeys(avatar, ['type', 'value'], field, true);
  const { type, value } = avatar;
  if (typeof value !== 'string') throw new Error(`${field}.value must be a string`);
  if (type === 'preset') {
    if (!AVATAR_PRESET_IDS.includes(value)) throw new Error(`${field}.value must be a known avatar preset`);
  } else if (type === 'emoji') {
    const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === '\u200D' || char === '\uFE0F' ? char : '').trim();
    if (!cleaned || cleaned.length > SETTINGS_LIMITS.maxEmojiLength || Buffer.byteLength(cleaned, 'utf8') > SETTINGS_LIMITS.maxEmojiBytes) {
      throw new Error(`${field}.value must be non-empty and at most ${SETTINGS_LIMITS.maxEmojiLength} UTF-16 code units and ${SETTINGS_LIMITS.maxEmojiBytes} UTF-8 bytes`);
    }
    return { type, value: cleaned };
  } else if (type === 'image') {
    const match = value.length <= SETTINGS_LIMITS.maxAvatarDataUrlChars
      && /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    const encoded = match?.[1];
    const canonical = encoded && Buffer.from(encoded, 'base64').toString('base64');
    if (match?.[0] !== value || (encoded !== canonical && encoded !== canonical?.replace(/=+$/, ''))) {
      throw new Error(`${field}.value must be a base64 PNG, JPEG, WebP, or GIF data URL of at most ${SETTINGS_LIMITS.maxAvatarDataUrlChars} characters`);
    }
  } else {
    throw new Error(`${field}.type must be preset, emoji, or image`);
  }
  return { type, value };
}

function applySettings(next, settings, reasoningEfforts, required = false) {
  if (settings.roles !== undefined) {
    validateKeys(settings.roles, ROLE_IDS, 'roles', required);
    for (const roleId of ROLE_IDS) {
      if (!Object.hasOwn(settings.roles, roleId)) continue;
      const role = settings.roles[roleId];
      const field = `roles.${roleId}`;
      validateKeys(role, ['name', 'avatar'], field, required);
      if (role.name !== undefined) next.roles[roleId].name = normalizeName(role.name, `${field}.name`);
      if (role.avatar !== undefined) next.roles[roleId].avatar = normalizeAvatar(role.avatar, `${field}.avatar`);
    }
  }
  if (settings.codex !== undefined) {
    validateKeys(settings.codex, ['model', 'reasoningEffort'], 'codex', required);
    const { model, reasoningEffort } = settings.codex;
    if (model !== undefined) {
      const cleaned = normalizeText(model, 'codex.model');
      if (cleaned !== null && !MODEL_PATTERN.test(cleaned)) {
        throw new Error(`codex.model must be at most ${SETTINGS_LIMITS.maxModelLength} characters without whitespace or control/format characters`);
      }
      next.codex.model = cleaned;
    }
    if (reasoningEffort !== undefined) {
      const cleaned = normalizeText(reasoningEffort, 'codex.reasoningEffort');
      if (cleaned !== null && !reasoningEfforts.includes(cleaned)) {
        throw new Error(`codex.reasoningEffort must be one of ${reasoningEfforts.join(', ')}`);
      }
      next.codex.reasoningEffort = cleaned;
    }
  }
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.exec(value);
  if (match?.[0] !== value) return false;
  const midnight = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().split('T')[0] === match[1];
}

function applySettingsPatch(next, patch, reasoningEfforts) {
  validateKeys(patch, ['reset', 'roles', 'codex'], 'settings patch');
  if (patch.reset !== undefined && typeof patch.reset !== 'boolean') throw new Error('reset must be a boolean');
  applySettings(next, patch, reasoningEfforts);
}

export function validateSettingsPatch(patch, reasoningEfforts) {
  applySettingsPatch(structuredClone(FACTORY_DEFAULTS), patch, [...reasoningEfforts]);
}

export function createSettingsStore(settingsPath, { reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], logError = () => {} } = {}) {
  let current = structuredClone(FACTORY_DEFAULTS);
  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    validateKeys(stored, ['version', 'updatedAt', 'roles', 'codex'], 'stored settings', true);
    if (stored.version !== FACTORY_DEFAULTS.version || (stored.updatedAt !== null && !isIsoDate(stored.updatedAt))) {
      throw new Error('Invalid stored settings version or updatedAt');
    }
    const next = structuredClone(FACTORY_DEFAULTS);
    applySettings(next, stored, reasoningEfforts, true);
    next.updatedAt = stored.updatedAt;
    current = next;
  } catch (error) {
    if (error.code !== 'ENOENT') logError('Could not load Monitor settings; using factory defaults.');
  }

  return {
    settingsPath,
    get: () => structuredClone(current),
    update(patch) {
      const next = structuredClone(patch?.reset === true ? FACTORY_DEFAULTS : current);
      applySettingsPatch(next, patch, reasoningEfforts);
      next.updatedAt = new Date().toISOString();
      atomicWriteJsonFile(settingsPath, next);
      current = next;
      return structuredClone(current);
    },
  };
}
