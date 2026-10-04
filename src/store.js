// Saved pool setup (corners, lanes, names) and finished sessions, on this
// device only.

import { defaultSetup } from './session.js';
import { defaultRaceSetup } from './finish.js';

const SETUP_KEY = 'pool-tracker-setup';
const SESSIONS_KEY = 'pool-tracker-sessions';
const MAX_SESSIONS = 100;

export function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSetup() {
  const saved = read(SETUP_KEY, null);
  return saved ? { ...defaultSetup(), ...saved, lane: { ...(saved.lane || {}) } } : defaultSetup();
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

// Single-lap heats (finish-line timing).
const RACE_SETUP_KEY = 'pool-tracker-race-setup';
const RACES_KEY = 'pool-tracker-races';
const MAX_RACES = 300;

export function loadRaceSetup() {
  const saved = read(RACE_SETUP_KEY, null);
  return saved ? { ...defaultRaceSetup(), ...saved, lane: { ...(saved.lane || {}) } } : defaultRaceSetup();
}

export const saveRaceSetup = (setup) => write(RACE_SETUP_KEY, setup);

export const loadRaces = () => read(RACES_KEY, []);

export function saveRace(record) {
  if (!record.results.some((r) => Number.isFinite(r.time))) return false;
  const all = loadRaces().filter((r) => r.id !== record.id);
  all.unshift(record);
  return write(RACES_KEY, all.slice(0, MAX_RACES));
}

export function deleteRace(id) {
  write(RACES_KEY, loadRaces().filter((r) => r.id !== id));
}
