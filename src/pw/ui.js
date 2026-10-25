// Small DOM helpers shared by the Practice Writer views.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// A short message at the bottom. An error ({ error: true }) stays longer, and
// a plain toast that comes right after it (a view's "Saved") doesn't cover it;
// `force` shows one anyway (the save that fixed the error).
let toastTimer;
let errorUntil = 0;
export function toast(msg, { error = false, force = false } = {}) {
  const el = $('#toast');
  if (!el) return;
  const now = Date.now();
  if (!error && !force && now < errorUntil) return;
  errorUntil = error ? now + 4500 : 0;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 4500 : 2400);
}

// In-page confirmation (artifact hosts block window.confirm). Resolves true
// when the person presses the action button.
export function confirmAction(message, label = 'Delete', { danger = true } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-msg">
      <p id="sheet-msg">${esc(message)}</p>
      <div class="actions"><button class="btn secondary" data-no>Cancel</button><button class="btn ${danger ? 'danger-fill' : ''}" data-yes>${esc(label)}</button></div>
    </div>`;
    const done = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    wrap.querySelector('[data-no]').onclick = () => done(false);
    wrap.querySelector('[data-yes]').onclick = () => done(true);
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    wrap.querySelector('[data-yes]').focus();
  });
}

// Copy text: clipboard inside the click, else select a hidden textarea.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* nothing else to try */ }
    ta.remove();
  }
  toast('Copied');
}

// Offer a file: the Artifact downloads capability when present; else a link
// (`link`: false inside the Artifact, whose sandbox ignores <a download>);
// else, or when the save can't run here, the text in a sheet to copy.
export async function saveFile(downloads, filename, text, { link = true } = {}) {
  if (downloads) {
    try { await downloads.save({ filename, data: text }); toast('Saved'); return; } catch (e) {
      if (e?.code === 'declined') return;
      if (e?.code === 'rate_limited') { toast('A save is already waiting for you to confirm'); return; }
    }
  } else if (link) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  showText(filename, text);
}

// The file's text in a sheet, to copy when a file can't be saved here.
function showText(filename, text) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-file">
    <p id="sheet-file">${esc(filename)}</p>
    <div class="muted small">Saving a file isn't available here. Copy the text and paste it into a file named ${esc(filename)} to keep it; Import takes that file back.</div>
    <div class="field"><textarea readonly rows="8" aria-label="${esc(filename)}" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${esc(text)}</textarea></div>
    <div class="actions"><button class="btn secondary" data-close>Close</button><button class="btn" data-copy>Copy</button></div>
  </div>`;
  const ta = wrap.querySelector('textarea');
  const done = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') done(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) done(); });
  wrap.querySelector('[data-close]').onclick = done;
  wrap.querySelector('[data-copy]').onclick = () => copyText(text);
  ta.onfocus = () => ta.select();
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  wrap.querySelector('[data-copy]').focus();
}

// A row of single-choice chips. options: [[value, label], …]; null value = none.
export function chips(name, options, current, { allowNone = true } = {}) {
  return `<div class="chips" role="group" data-chips="${esc(name)}">${options.map(([v, l]) => `<button type="button" class="chip ${current === v ? 'on' : ''}" data-chip="${esc(name)}" data-value="${esc(v)}" data-none="${allowNone ? 1 : 0}" aria-pressed="${current === v}">${esc(l)}</button>`).join('')}</div>`;
}

// Wire chip rows: onPick(name, value|null) after toggling.
export function bindChips(root, onPick) {
  $$('[data-chip]', root).forEach((b) => {
    b.onclick = () => {
      const on = b.classList.contains('on');
      const value = on && b.dataset.none === '1' ? null : b.dataset.value;
      onPick(b.dataset.chip, value);
    };
  });
}
