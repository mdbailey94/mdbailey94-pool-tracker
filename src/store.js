// Saved pool setup (corners, lanes, names) and finished sessions, on this
// device only.

import { defaultSetup } from './session.js';

const SETUP_KEY = 'pool-tracker-setup';
const SESSIONS_KEY = 'pool-tracker-sessions';
const MAX_SESSIONS = 100;

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSetup() {
  const saved = read(SETUP_KEY, null);
  if (!saved) return defaultSetup();
  // Setups saved before the camera position choice were all end-on.
  return { ...defaultSetup(), view: 'end', ...saved, lane: { ...(saved.lane || {}) } };
}

export const saveSetup = (setup) => write(SETUP_KEY, setup);

export const loadSessions = () => read(SESSIONS_KEY, []);

export function saveSession(record) {
  if (!record.swimmers.length) return false;
  const all = loadSessions().filter((s) => s.id !== record.id);
  all.unshift(record);
  return write(SESSIONS_KEY, all.slice(0, MAX_SESSIONS));
}

export function deleteSession(id) {
  write(SESSIONS_KEY, loadSessions().filter((s) => s.id !== id));
}

export function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
