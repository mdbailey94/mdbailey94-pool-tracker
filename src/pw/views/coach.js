// Coach: text the app. A chat with Claude that knows the plan, gear chart,
// groups, style, library, recent practices and debriefs, and answers with
// practices and blocks in the coach's notation that can go straight to the
// builder or the library. Without Claude: paste a set to save it as a block.

import { composePractice, sessionsOn, uid } from '../../practice.js';
import { coachContext, coachTurns, offlineReply, parseCoachReply, replyContent, slotOf } from '../../coach.js';
import { writeLines } from '../../setlang.js';
import { linesHTML, practiceHTML } from '../render.js';
import { replaceDraft } from '../guards.js';

const KEEP = 20; // turns kept in memory
const HIDE = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);
const OFF_NOTE = {
  not_granted: "Claude isn't allowed for this page, so texting the coach is off. Allow it from the page's permissions and reload.",
  sampling_disabled: "Claude isn't available for this account, so texting the coach is off.",
};

// What the page does about a failed call, by its code (the sample contract).
// Only a passing failure (upstream_error, or a code the contract doesn't
// list) and a rate limit (after a minute) offer "Try again" with the same
// message. Sent again unchanged, the others fail the same way: the message
// goes back in the box to change (refused, empty_completion,
// prompt_too_large, an unreadable answer, signed out), or the page itself
// is at fault (invalid_request, transform_error, queue_overflow).
const CODES = new Set(['invalid_request', 'prompt_too_large', 'images_unavailable', 'tools_unavailable', 'image_rejected', 'cancelled', 'not_granted',
  'session_expired', 'sampling_disabled', 'not_declared', 'rate_limited', 'refused', 'empty_completion', 'invalid_json', 'upstream_error',
  'capability_disabled', 'capability_removed', 'transform_error', 'queue_overflow']);
const BACK = 'Your message is back in the box.';
const ERRORS = {
  upstream_error: "Couldn't reach the coach. Try again.",
  rate_limited: 'Too many messages right now. Try again in a minute.',
  session_expired: `Sign in to Claude again, then send it again. ${BACK}`,
  prompt_too_large: `That was too much to send at once. Start a new chat or ask for less. ${BACK}`,
  refused: `The coach couldn't answer that one. Ask it differently. ${BACK}`,
  empty_completion: `The coach didn't write anything back. Ask for less at a time. ${BACK}`,
  invalid_json: `The coach's answer didn't come back in a form the app can read. Ask for less at a time. ${BACK}`,
};
const PAGE_ERROR = `Something went wrong on this page, so the coach wasn't asked. ${BACK}`;
const RATE_WAIT = 60 * 1000;

export function errorFor(code) {
  if (code === 'rate_limited') return { message: ERRORS.rate_limited, retry: true, wait: RATE_WAIT };
  if (code === 'upstream_error' || !CODES.has(code)) return { message: ERRORS.upstream_error, retry: true, wait: 0 };
  return { message: ERRORS[code] || PAGE_ERROR, retry: false, wait: 0 };
}

const coachOff = (ctx) => !ctx.claude.sample || !!ctx.state.ui.claudeOff;

export function render(ctx, el) {
  const { state } = ctx;
  const chat = state.chat;
  if (coachOff(ctx)) {
    chat.pending = null; // nothing to send it to here
    chat.pendingSlot = null;
    chat.pendingDate = null;
    renderOffline(ctx, el);
    return;
  }
  renderChat(ctx, el);
  if (chat.pending && !chat.busy) {
    const message = chat.pending;
    const slot = chat.pendingSlot || null;
    const date = chat.pendingDate || null;
    chat.pending = null;
    chat.pendingSlot = null;
    chat.pendingDate = null;
    setTimeout(() => send(ctx, message, { slot, date }), 0);
  }
}

// -------------------------------------------------------------------- chat

function quickChips(ctx) {
  const { state } = ctx;
  const day = sessionsOn(state.plan, state.today);
  const out = [];
  for (const s of day.sessions) out.push([`Write today's ${s.slot}`, s.slot]);
  if (!day.sessions.length) out.push(['Write the next practice', null]);
  out.push(['A 40 min aerobic IM block', null]);
  if (state.chat.history.some((t) => t.practice || t.blocks?.length)) out.push(['Make the main set shorter', null]);
  out.push(['What did the debriefs say about kick?', null]);
  return out;
}

function blockMeta(b, unit) {
  return [b.minutes ? `${b.minutes} min` : `${b.distance}${unit}`, b.category, b.stroke !== 'choice' ? b.stroke : '', b.gears?.join(' '), b.session !== 'any' ? b.session : '', b.equipment?.join(', ')].filter(Boolean).join(' · ');
}

function assistantHTML(ctx, t, i) {
  const { state, esc } = ctx;
  const unit = state.plan.unit;
  const parts = [];
  if (t.reply) parts.push(`<div class="cc-text">${esc(t.reply)}</div>`);
  if (t.practice) {
    const p = t.practice;
    const composed = composePractice({ blocks: p.blocks, rounds: p.rounds, pattern: p.pattern, pace: state.plan.pace, unit });
    const allSaved = p.blocks.every((b) => t.saved?.[b.id]);
    parts.push(`<div class="cc-att">
      <div class="cc-att-head"><b>${esc(p.title || 'Practice')}</b><span class="muted small">${esc(p.slot || 'AM')}${p.blocks.some((b) => b.circuit) ? ` · ${p.rounds} round${p.rounds === 1 ? '' : 's'}` : ''}</span></div>
      ${practiceHTML(composed, ctx, { slot: p.slot || 'AM' })}
      <div class="actions">
        <button class="btn small-btn" data-open="${i}">Open in builder</button>
        <button class="btn secondary small-btn" data-savep="${i}" ${allSaved ? 'disabled' : ''}>${allSaved ? 'Saved to library' : 'Save blocks to library'}</button>
      </div>
    </div>`);
  }
  (t.blocks || []).forEach((b, j) => {
    const saved = !!t.saved?.[b.id];
    parts.push(`<div class="cc-att">
      <div class="cc-att-head"><b>${esc(b.name)}</b><span class="muted small">${esc(blockMeta(b, unit))}</span></div>
      ${linesHTML(writeLines(b.lines, ctx.learned.writing, { single: b.session === 'PM' }))}
      ${b.detail ? `<p class="muted small">${esc(b.detail)}</p>` : ''}
      <div class="actions"><button class="btn secondary small-btn" data-saveb="${i}:${j}" ${saved ? 'disabled' : ''}>${saved ? 'Saved' : 'Save'}</button></div>
    </div>`);
  });
  if (!parts.length) parts.push('<div class="cc-text muted">(no answer)</div>');
  return `<div class="bubble coach cc-bubble ${t.practice || t.blocks?.length ? 'wide' : ''}">${parts.join('')}</div>`;
}

function renderChat(ctx, el) {
  const { state, esc } = ctx;
  const chat = state.chat;
  const history = chat.history;
  const context = coachContext({ state, learned: ctx.learned });
  const kb = Math.max(1, Math.round(new TextEncoder().encode(context).length / 1024));
  el.innerHTML = `
    <section class="card cc-head">
      <div class="cc-head-row">
        <div><div class="eyebrow">Coach</div><h2>Text the coach</h2></div>
        ${history.length ? '<button class="btn secondary small-btn" id="cc-new">New chat</button>' : ''}
      </div>
      <p class="lead">Ask for a practice or a block in your notation, change one, or ask what the debriefs said. It reads your plan, gear chart, groups, style guide, library, recent practices and debriefs.</p>
      <details class="cc-sees"><summary>What the coach sees (${kb} KB)</summary><pre class="text">${esc(context)}</pre></details>
    </section>
    <section class="card cc-chat">
      <div class="chat" id="cc-log" aria-live="polite">
        ${history.length ? '' : `<div class="bubble coach"><div class="cc-text">Text me like you'd text an assistant coach: "Write today's AM", "a 30 min BR set for the slowest group", "the 50s were too tight last time". Answers come back in your notation with send-offs for each group.</div></div>`}
        ${history.map((t, i) => (t.role === 'user' ? `<div class="bubble me">${esc(t.content)}</div>` : assistantHTML(ctx, t, i))).join('')}
        ${chat.busy ? '<div class="bubble coach cc-thinking" id="cc-thinking">Thinking…</div>' : ''}
        ${chat.error ? `<div class="cc-error" role="alert"><span>${esc(chat.error.message)}</span>${chat.error.retry ? `<button class="btn secondary small-btn" id="cc-retry" ${retryWait(chat) > 0 ? 'disabled' : ''}>Try again</button>` : ''}</div>` : ''}
      </div>
      <div class="chips cc-quick">${quickChips(ctx).map(([label, slot], k) => `<button type="button" class="chip" data-quick="${k}" data-slot="${slot || ''}" ${chat.busy ? 'disabled' : ''}>${esc(label)}</button>`).join('')}</div>
    </section>
    <div class="composer cc-composer">
      <textarea id="cc-input" rows="1" placeholder="Text the coach…" aria-label="Message to the coach">${esc(state.ui.coachDraft || '')}</textarea>
      ${chat.busy ? '<button class="btn secondary danger" id="cc-stop">Stop</button>' : '<button class="btn" id="cc-send">Send</button>'}
    </div>`;
  bindChat(ctx, el);
  // A rate limit: "Try again" turns on after the wait.
  const wait = retryWait(chat);
  if (wait > 0) setTimeout(() => { const b = el.querySelector('#cc-retry'); if (b) b.disabled = false; }, wait);
  const seen = history.length * 2 + (chat.busy ? 1 : 0) + (chat.error ? 1 : 0);
  if (state.ui.coachSeen !== seen) {
    state.ui.coachSeen = seen;
    if (history.length || chat.busy) {
      const last = ctx.$('#cc-log', el)?.lastElementChild;
      last?.scrollIntoView({ block: 'nearest' });
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  }
}

const retryWait = (chat) => (chat.error?.retryAt ? chat.error.retryAt - Date.now() : 0);

function bindChat(ctx, el) {
  const { state, $, $$ } = ctx;
  const chat = state.chat;
  const input = $('#cc-input', el);
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; };
  grow();
  input.oninput = () => { state.ui.coachDraft = input.value; grow(); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!chat.busy) send(ctx, input.value);
    }
  };
  const sendBtn = $('#cc-send', el);
  if (sendBtn) sendBtn.onclick = () => send(ctx, input.value);
  const stop = $('#cc-stop', el);
  if (stop) stop.onclick = () => chat.controller?.abort();
  const retry = $('#cc-retry', el);
  if (retry) {
    retry.onclick = () => {
      if (retryWait(chat) > 0) return;
      const { retry: message, slot, date } = chat.error || {};
      chat.error = null;
      const last = chat.history.at(-1);
      if (last?.role === 'user' && last.content === message) chat.history.pop();
      send(ctx, message, { slot, date });
    };
  }
  const fresh = $('#cc-new', el);
  if (fresh) {
    fresh.onclick = async () => {
      if (!(await ctx.confirmAction('Start a new chat? This conversation is cleared.', 'New chat', { danger: false }))) return;
      chat.controller?.abort();
      chat.history = [];
      chat.error = null;
      ctx.rerender();
    };
  }
  const chips = quickChips(ctx);
  $$('[data-quick]', el).forEach((b) => {
    b.onclick = () => { const [label, slot] = chips[+b.dataset.quick]; send(ctx, label, { slot }); };
  });
  $$('[data-open]', el).forEach((b) => {
    b.onclick = async () => {
      const t = chat.history[+b.dataset.open];
      const p = t?.practice;
      if (!p || !(await replaceDraft(ctx, "the coach's practice"))) return;
      // The day and session the question was about (a session from the Week tab), else today.
      const date = t.date || state.today;
      const day = sessionsOn(state.plan, date);
      const slot = p.slot || t.slot || 'AM';
      state.draft = {
        date,
        slot,
        title: p.title || '',
        focus: day.sessions.find((s) => s.slot === slot)?.focus || null,
        blocks: p.blocks.map((x) => ({ ...x, key: uid('k') })),
        rounds: p.rounds || 1,
        pattern: p.pattern || 'even',
      };
      ctx.go('build');
    };
  });
  $$('[data-savep]', el).forEach((b) => {
    b.onclick = async () => {
      const t = chat.history[+b.dataset.savep];
      if (!t?.practice) return;
      b.disabled = true;
      const todo = t.practice.blocks.filter((x) => !t.saved?.[x.id]);
      await saveBlocks(ctx, t, todo);
    };
  });
  $$('[data-saveb]', el).forEach((b) => {
    b.onclick = async () => {
      const [i, j] = b.dataset.saveb.split(':').map(Number);
      const t = chat.history[i];
      const blk = t?.blocks?.[j];
      if (!blk) return;
      b.disabled = true;
      await saveBlocks(ctx, t, [blk]);
    };
  });
}

// A block that is not saved keeps its Save button (the app says Not saved
// and offers Try again); saving it again replaces it, by its id.
async function saveBlocks(ctx, turn, blocks) {
  const done = [];
  for (const b of blocks) {
    const { circuit, key, ...clean } = b;
    if (!(await ctx.save.block({ ...clean, source: clean.source || 'claude' }))) continue;
    turn.saved = { ...(turn.saved || {}), [b.id]: true };
    done.push(b);
  }
  if (done.length) {
    const style = await ctx.save.relearn();
    ctx.toast(`Saved ${done.length === 1 ? done[0].name : `${done.length} blocks`} to the library${done.length < blocks.length ? ` · ${blocks.length - done.length} not saved` : ''}${style ? ` · style from ${style.learnedFrom.blocks} sets` : ''}`);
  }
  ctx.rerender();
}

// One message to Claude and back. Errors by code: hide Claude for good on
// a refused grant, show a non-JSON answer as text, stay quiet when the coach
// pressed Stop, else say what happened (errorFor) and either offer "Try
// again" or put the message back in the box.
export async function send(ctx, text, { slot = null, date = null } = {}) {
  const { state } = ctx;
  const chat = state.chat;
  const message = String(text ?? '').trim();
  const sample = ctx.claude.sample;
  if (!message || chat.busy || !sample) return;
  const theSlot = slot || slotOf(message);
  const context = coachContext({ state, learned: ctx.learned, slot: theSlot, date });
  const turns = coachTurns(chat.history, message, context);
  chat.history.push({ role: 'user', content: message });
  chat.history = chat.history.slice(-KEEP);
  chat.busy = true;
  chat.error = null;
  const controller = new AbortController();
  chat.controller = controller;
  state.ui.coachDraft = '';
  ctx.rerender();
  let cancelled = false;
  try {
    const value = await sample.json(turns, {
      signal: controller.signal,
      modelTier: 'default',
      cache: false,
      onText: () => { const t = document.getElementById('cc-thinking'); if (t && t.textContent !== 'Writing…') t.textContent = 'Writing…'; },
    });
    const r = parseCoachReply(value);
    chat.history.push({ role: 'assistant', content: replyContent(r), reply: r.reply, practice: r.practice, blocks: r.blocks, saved: {}, date, slot: theSlot });
  } catch (e) {
    const code = e?.code || 'upstream_error';
    if (code === 'cancelled') cancelled = true;
    else if (HIDE.has(code)) state.ui.claudeOff = code;
    else if (code === 'invalid_json' && String(e.text || '').trim()) {
      const raw = String(e.text).trim();
      const r = parseCoachReply(raw);
      chat.history.push({ role: 'assistant', content: raw.slice(0, 20000), reply: r.reply || raw, practice: r.practice, blocks: r.blocks, saved: {}, date, slot: theSlot });
    } else {
      const { message: said, retry, wait } = errorFor(code);
      chat.error = { code, message: said, retry: retry ? message : null, retryAt: wait ? Date.now() + wait : 0, slot: theSlot, date };
      if (!retry) {
        // Not sent again as it is: off the chat and back in the box to change.
        const last = chat.history.at(-1);
        if (last?.role === 'user' && last.content === message) chat.history.pop();
        if (!String(state.ui.coachDraft || '').trim()) state.ui.coachDraft = message;
      }
    }
  } finally {
    if (chat.controller === controller) { chat.busy = false; chat.controller = null; }
    chat.history = chat.history.slice(-KEEP);
  }
  if (state.tab === 'coach') ctx.rerender();
  else if (!cancelled) ctx.toast(chat.error ? chat.error.message : 'The coach answered · see Coach');
}

// ----------------------------------------------------------------- offline

function renderOffline(ctx, el) {
  const { state, esc } = ctx;
  const off = state.ui.claudeOff;
  const q = state.ui.coachQuick;
  el.innerHTML = `
    <section class="card cc-off">
      <div class="eyebrow">Coach</div>
      <h2>${ctx.claude.connecting && !off ? 'Connecting to Claude…' : 'Texting the coach needs the Claude version of this page'}</h2>
      ${off ? `<p class="form-error small">${esc(OFF_NOTE[off] || "Claude isn't available in this view, so texting the coach is off.")}</p>` : ''}
      <p class="lead">Open Practice Writer on claude.ai (the Claude version) and this tab becomes a chat: "Write today's AM", "a 40 min aerobic IM block", "make the main set shorter", "what did the debriefs say about kick?". It answers in your notation with send-offs from your gear chart and groups.</p>
      ${ctx.isArtifact && !off ? '<p class="muted small">If you just opened the page, Claude can take a few seconds to connect.</p>' : ''}
    </section>
    <section class="card">
      <h3>Paste a set, save a block</h3>
      <p class="muted small">Your notation, one line per row; a "36 min …" heading first names the block. Saved to the library, and the app learns your style from it.</p>
      <label class="q"><span>Set</span>
        <textarea id="cc-quick" rows="7" spellcheck="false" placeholder="${esc('36 min FL/free switch\n3 x 300 free\n:15 REST\n3 rounds:\n6 x 50 FL, G2 → G5 by 25')}">${esc(state.ui.coachQuickText || '')}</textarea></label>
      <div class="actions"><button class="btn" id="cc-quick-save">Save as block</button></div>
      ${q ? `<div class="cc-result">
        <p class="${q.block ? '' : 'muted'}">${esc(q.reply)}</p>
        ${q.block ? `<div class="cc-att"><div class="cc-att-head"><b>${esc(q.block.name)}</b><span class="muted small">${esc(blockMeta(q.block, state.plan.unit))}</span></div>
          ${linesHTML(writeLines(q.block.lines, ctx.learned.writing, { single: q.block.session === 'PM' }))}
          <div class="actions"><button class="btn secondary small-btn" id="cc-quick-blocks">Open Blocks</button></div></div>` : ''}
      </div>` : ''}
    </section>`;
  const ta = ctx.$('#cc-quick', el);
  ta.oninput = () => { state.ui.coachQuickText = ta.value; };
  ctx.$('#cc-quick-save', el).onclick = async () => {
    const text = ta.value;
    if (!text.trim()) { ctx.toast('Paste a set first'); ta.focus(); return; }
    const r = offlineReply(text, ctx.learned.writing);
    const block = r.blocks[0] || null;
    let { reply } = r;
    if (block) {
      // Not saved: the app says so and offers Try again; the set stays in the
      // box, and saving the same set again replaces the block not saved.
      const failed = state.ui.coachQuickUnsaved;
      if (failed?.text === text) block.id = failed.id;
      if (await ctx.save.block(block)) {
        state.ui.coachQuickUnsaved = null;
        const style = await ctx.save.relearn();
        state.ui.coachQuickText = '';
        ctx.toast(`Saved ${block.name}${style ? ` · style from ${style.learnedFrom.blocks} sets` : ''}`);
      } else {
        state.ui.coachQuickUnsaved = { id: block.id, text };
        reply = `Not saved yet: ${block.name}. Press Save as block to try again.`;
      }
    }
    state.ui.coachQuick = { reply, block };
    ctx.rerender();
  };
  const open = ctx.$('#cc-quick-blocks', el);
  if (open) open.onclick = () => { state.ui.coachQuick = null; ctx.go('blocks'); };
}

