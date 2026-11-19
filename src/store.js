// Finished jump sessions and the chosen unit, on this device only.
// Session record: { id, startedAt, jumps: [{ at, heightM, flightTime, confidence }] }

const SESSIONS_KEY = 'jump-height-sessions';
const UNIT_KEY = 'jump-height-unit';
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

export const newSessionId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const loadUnit = () => (read(UNIT_KEY, 'cm') === 'in' ? 'in' : 'cm');
export const saveUnit = (unit) => write(UNIT_KEY, unit);

export const loadSessions = () => {
  const all = read(SESSIONS_KEY, []);
  return Array.isArray(all) ? all : [];
};

// Saves (or replaces) a session. A session with no jumps is removed instead.
export function saveSession(record) {
  const all = loadSessions().filter((s) => s.id !== record.id);
  if (!record.jumps.length) return write(SESSIONS_KEY, all);
  all.unshift(record);
  return write(SESSIONS_KEY, all.slice(0, MAX_SESSIONS));
}

export function deleteSession(id) {
  write(SESSIONS_KEY, loadSessions().filter((s) => s.id !== id));
}

const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function sessionCSV(rec) {
  const rows = [['session_started', 'jump', 'time', 'height_cm', 'height_in', 'flight_time_ms', 'confidence']];
  rec.jumps.forEach((j, i) => rows.push([
    rec.startedAt, i + 1, new Date(j.at).toISOString(),
    (j.heightM * 100).toFixed(1), (j.heightM * 39.3701).toFixed(1),
    Math.round(j.flightTime * 1000), j.confidence,
  ]));
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

export function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
