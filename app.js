'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =========================================================
   Stockage local
   ========================================================= */
const KEY = 'sportapp.v1';
const DEFAULTS = {
  settings: { sound: true, voice: true, prep: 5, goal: 100 },
  quick: { work: 30, rest: 15, rounds: 8 },
  pushup: { series: 4, sub: 3, work: 40, subRest: 20, rest: 90 },
  exercises: [
    { id: 'gainage', name: 'Gainage', work: 45, rest: 15, rounds: 4 },
    { id: 'squats', name: 'Squats', work: 40, rest: 20, rounds: 5 },
    { id: 'burpees', name: 'Burpees', work: 30, rest: 30, rounds: 6 },
  ],
  pushupLog: [], // { id, ts, day, manual?, sets: [{ series, sub, reps, work, ts }] }
  history: [],   // { ts, name, kind, rounds, duration }
  lastReps: 10,
};

function load() {
  const base = structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') {
      return {
        ...base, ...raw,
        settings: { ...base.settings, ...raw.settings },
        quick: { ...base.quick, ...raw.quick },
        pushup: { ...base.pushup, ...raw.pushup },
      };
    }
  } catch (e) { /* données corrompues : on repart des valeurs par défaut */ }
  return base;
}
let db = load();
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Impossible d\'enregistrer'); } };
  if (now) write(); else saveTimer = setTimeout(write, 250);
}

/* =========================================================
   Dates & formats
   ========================================================= */
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const weekStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtLong(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${pad(m)}` : `${m} min`;
}
const fmtDay = k => {
  const today = dayKey(), yest = dayKey(addDays(new Date(), -1));
  if (k === today) return 'Aujourd\'hui';
  if (k === yest) return 'Hier';
  return parseDay(k).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
};
const fmtTime = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/* =========================================================
   Sons, voix, écran allumé
   ========================================================= */
let actx = null;
function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!actx) actx = new AC();
  if (actx.state === 'suspended') actx.resume();
}
function tone(freq, dur = 0.15, when = 0, vol = 0.4) {
  if (!db.settings.sound || !actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}
const sfx = {
  count: () => tone(880, 0.12),
  work: () => tone(1320, 0.5),
  rest: () => { tone(660, 0.18); tone(520, 0.25, 0.2); },
  done: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, i * 0.15)),
};
function say(text) {
  if (!db.settings.voice || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch (e) { }
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { }
}
function releaseAwake() { try { wakeLock?.release(); } catch (e) { } wakeLock = null; }

/* =========================================================
   Champs « stepper » (− valeur +) avec appui long
   ========================================================= */
const LIMITS = {
  'quick.work': [5, 3600], 'quick.rest': [0, 3600], 'quick.rounds': [1, 99],
  'draft.work': [5, 3600], 'draft.rest': [0, 3600], 'draft.rounds': [1, 99],
  'pushup.series': [1, 20], 'pushup.sub': [1, 10], 'pushup.work': [5, 600],
  'pushup.subRest': [0, 600], 'pushup.rest': [0, 900],
  'settings.prep': [0, 30], 'settings.goal': [10, 5000],
};
let draft = null; // exercice en cours d'édition

function resolve(path) {
  const [root, key] = path.split('.');
  return [root === 'draft' ? draft : db[root], key];
}
const getPath = p => { const [o, k] = resolve(p); return o[k]; };
function setPath(p, v) { const [o, k] = resolve(p); o[k] = v; }

function timeStep(v, dir) {
  if (dir > 0) return v < 60 ? 5 : v < 300 ? 15 : 30;
  return v <= 60 ? 5 : v <= 300 ? 15 : 30;
}
function stepValue(path, kind, dir) {
  const v = getPath(path);
  const [min, max] = LIMITS[path] || [0, 9999];
  let step = 1;
  if (kind === 'time') step = timeStep(v, dir);
  else if (path === 'settings.goal') step = v < 200 ? 10 : 50;
  let n = v + dir * step;
  if (kind === 'time') n = Math.round(n / step) * step; // reste aligné sur le pas
  n = clamp(n, min, max);
  if (n === v) return false;
  setPath(path, n);
  return true;
}
function stepper(path, label, kind = 'int', hint = '', cls = '') {
  const v = getPath(path);
  return `<div class="field ${cls}" data-field="${path}">
    <span class="field-label">${label}${hint ? `<small>${hint}</small>` : ''}</span>
    <div class="stepper" data-path="${path}" data-kind="${kind}">
      <button class="step" data-dir="-1" aria-label="Moins">−</button>
      <output>${kind === 'time' ? fmt(v) : v}</output>
      <button class="step" data-dir="1" aria-label="Plus">+</button>
    </div></div>`;
}

let holdTimer = null, holdInterval = null;
function stopHold() { clearTimeout(holdTimer); clearInterval(holdInterval); holdTimer = holdInterval = null; }
document.addEventListener('pointerdown', e => {
  const btn = e.target.closest('.step');
  if (!btn) return;
  e.preventDefault();
  const st = btn.closest('.stepper');
  const { path, kind } = st.dataset;
  const dir = Number(btn.dataset.dir);
  const apply = () => {
    if (!stepValue(path, kind, dir)) return;
    const v = getPath(path);
    st.querySelector('output').textContent = kind === 'time' ? fmt(v) : v;
    if (!path.startsWith('draft')) save();
    refreshSummaries();
  };
  apply();
  stopHold();
  holdTimer = setTimeout(() => {
    let n = 0;
    holdInterval = setInterval(() => { apply(); if (++n === 12) { clearInterval(holdInterval); holdInterval = setInterval(apply, 45); } }, 110);
  }, 380);
});
['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(ev => document.addEventListener(ev, stopHold, true));

/* =========================================================
   Plans de séance
   ========================================================= */
function planDuration({ work, rest, rounds }) {
  return db.settings.prep + rounds * work + Math.max(0, rounds - 1) * rest;
}
function pushupDuration(c) {
  const n = c.series * c.sub;
  return db.settings.prep + n * c.work + c.series * (c.sub - 1) * c.subRest + (c.series - 1) * c.rest;
}
function buildPlan({ work, rest, rounds }) {
  const phases = [];
  if (db.settings.prep > 0) phases.push({ type: 'prep', dur: db.settings.prep, label: 'Prêt' });
  for (let r = 1; r <= rounds; r++) {
    phases.push({ type: 'work', dur: work, label: 'Effort', round: `${r} / ${rounds}`, speak: rounds > 1 ? (r === rounds ? 'Dernière' : `Série ${r}`) : 'Go' });
    if (r < rounds && rest > 0) phases.push({ type: 'rest', dur: rest, label: 'Repos', round: `${r} / ${rounds}` });
  }
  return phases;
}
function buildPushupPlan(c) {
  const phases = [];
  if (db.settings.prep > 0) phases.push({ type: 'prep', dur: db.settings.prep, label: 'Prêt' });
  for (let s = 1; s <= c.series; s++) {
    for (let k = 1; k <= c.sub; k++) {
      const last = s === c.series && k === c.sub;
      const round = c.sub > 1 ? `Série ${s}/${c.series} · ${k}/${c.sub}` : `Série ${s} / ${c.series}`;
      phases.push({ type: 'work', dur: c.work, label: 'Pompes', round, series: s, sub: k, speak: last ? 'Dernière' : (k === 1 ? `Série ${s}` : 'Go') });
      if (last) continue;
      const long = k === c.sub;
      const dur = long ? c.rest : c.subRest;
      if (dur > 0) phases.push({ type: 'rest', dur, label: long ? 'Repos' : 'Récup', round });
    }
  }
  return phases;
}

/* =========================================================
   Moteur du chrono
   ========================================================= */
let run = null;
const RING = 2 * Math.PI * 92;

function startRun(opts) {
  unlockAudio();
  run = { ...opts, i: -1, paused: false, startedAt: Date.now(), pausedMs: 0, finished: false, worksDone: 0 };
  const el = $('#run');
  el.hidden = false;
  el.classList.remove('paused');
  $('#run-done').hidden = true;
  $('#reps-panel').hidden = true;
  $('#run-title').textContent = opts.title;
  keepAwake();
  nextPhase(Date.now(), true);
  run.timer = setInterval(tick, 100);
}

function nextPhase(at, live) {
  const prev = run.phases[run.i];
  if (prev && prev.type === 'work') {
    run.worksDone++;
    run.onWorkEnd?.(prev, (at - run.phaseStart) / 1000);
  }
  run.i++;
  if (run.i >= run.phases.length) return finishRun(true);
  const p = run.phases[run.i];
  run.phaseStart = at;
  run.phaseEnd = at + p.dur * 1000;
  run.lastBeep = null;
  if (live) {
    if (p.type === 'work') { sfx.work(); say(p.speak || 'Go'); }
    else if (p.type === 'rest') { sfx.rest(); say(p.label === 'Récup' ? 'Récup' : 'Repos'); }
    else say('Prêt');
  }
  renderRunStatic();
  renderRunTime(Date.now());
}

function tick() {
  if (!run || run.paused || run.finished) return;
  const now = Date.now();
  // rattrape le temps si l'app était en arrière-plan
  while (run && !run.finished && now >= run.phaseEnd) nextPhase(run.phaseEnd, now - run.phaseEnd < 1000);
  if (!run || run.finished) return;
  const rem = Math.ceil((run.phaseEnd - now) / 1000);
  if (rem <= 3 && rem >= 1 && rem !== run.lastBeep) { run.lastBeep = rem; sfx.count(); }
  renderRunTime(now);
}

function remainingTotal(now) {
  let t = Math.max(0, (run.phaseEnd - now) / 1000);
  for (let j = run.i + 1; j < run.phases.length; j++) t += run.phases[j].dur;
  return t;
}

function renderRunStatic() {
  const p = run.phases[run.i];
  const el = $('#run');
  el.dataset.phase = p.type;
  $('#run-phase').textContent = run.paused ? 'Pause' : p.label;
  $('#run-round').textContent = p.round || '';
  const n = run.phases[run.i + 1];
  $('#run-next').textContent = n ? `Ensuite : ${n.label} ${fmt(n.dur)}` : 'Dernière ligne droite !';
}

function renderRunTime(now) {
  const p = run.phases[run.i];
  const left = run.paused ? run.pausedLeft : Math.max(0, run.phaseEnd - now);
  $('#run-time').textContent = fmt(Math.ceil(left / 1000));
  const frac = p.dur ? left / (p.dur * 1000) : 0;
  $('#ring').style.strokeDashoffset = RING * (1 - frac);
  const totalLeft = run.paused ? run.pausedLeft / 1000 + run.phases.slice(run.i + 1).reduce((a, x) => a + x.dur, 0) : remainingTotal(now);
  $('#run-total').textContent = `Reste ${fmt(totalLeft)}`;
}

function togglePause() {
  if (!run || run.finished) return;
  const now = Date.now();
  if (run.paused) {
    run.paused = false;
    run.pausedMs += now - run.pauseAt;
    run.phaseEnd = now + run.pausedLeft;
    run.phaseStart += now - run.pauseAt;
  } else {
    run.paused = true;
    run.pauseAt = now;
    run.pausedLeft = Math.max(0, run.phaseEnd - now);
  }
  $('#run').classList.toggle('paused', run.paused);
  renderRunStatic();
  renderRunTime(now);
}

function finishRun(completed) {
  if (!run) return;
  clearInterval(run.timer);
  run.finished = true;
  releaseAwake();
  const now = Date.now();
  const pausedNow = run.paused ? now - run.pauseAt : 0;
  const elapsed = (now - run.startedAt - run.pausedMs - pausedNow) / 1000;
  run.elapsed = elapsed;
  // arrêt en plein effort : la série entamée compte quand même
  const cur = run.phases[run.i];
  if (!completed && cur?.type === 'work') {
    const w = (now - run.phaseStart - pausedNow) / 1000;
    if (w >= 3) { run.worksDone++; run.onWorkEnd?.(cur, w); }
  }
  if (completed) { sfx.done(); say('Terminé, bravo'); }
  if (run.kind !== 'pushups' && run.worksDone > 0) {
    db.history.unshift({ ts: run.startedAt, name: run.title, kind: run.kind, rounds: run.worksDone, duration: Math.round(elapsed) });
    db.history = db.history.slice(0, 300);
    save(true);
  }
  run.completed = completed;
  renderDone();
}

function closeRun() {
  if (run) clearInterval(run.timer);
  releaseAwake();
  if (run?.session && run.session.sets.length === 0) removeSession(run.session.id);
  run = null;
  repsQueue = [];
  $('#run').hidden = true;
  render();
}

function renderDone() {
  if (repsQueue.length) return; // on attend la saisie des dernières séries
  const d = $('#run-done');
  let body = '';
  if (run.kind === 'pushups') {
    const sets = run.session.sets;
    const total = sets.reduce((a, x) => a + x.reps, 0);
    const best = Math.max(0, ...sets.map(x => x.reps));
    const today = dayTotals()[dayKey()] || 0;
    body = `
      <p class="lead">${run.completed ? 'Séance terminée' : 'Séance arrêtée'} · ${fmt(run.elapsed)}</p>
      <div class="hero"><div class="big-num">${total}</div><div class="sub">pompes cette séance</div></div>
      <div class="grid">
        <div class="stat"><div class="k">Aujourd'hui</div><div class="v">${today}</div></div>
        <div class="stat"><div class="k">Meilleure série</div><div class="v">${best}</div></div>
        <div class="stat"><div class="k">Séries</div><div class="v">${sets.length}</div></div>
        <div class="stat"><div class="k">Moyenne</div><div class="v">${sets.length ? (total / sets.length).toFixed(1) : 0}</div></div>
      </div>
      ${sets.length ? `<div class="card">${barChart(sets.map((x, i) => ({ key: i, value: x.reps, label: String(i + 1) })), { h: 140 })}</div>` : ''}`;
  } else {
    body = `
      <p class="lead">${esc(run.title)}</p>
      <div class="grid">
        <div class="stat"><div class="k">Durée</div><div class="v">${fmt(run.elapsed)}</div></div>
        <div class="stat"><div class="k">Séries faites</div><div class="v">${run.worksDone}</div></div>
      </div>`;
  }
  d.innerHTML = `<h2>${run.completed ? 'Bravo 💪' : 'Séance arrêtée'}</h2>${body}<div class="spacer"></div>
    <button class="btn primary big" data-action="run-close">Terminer</button>`;
  d.hidden = false;
}

/* ---------- Saisie des pompes pendant la séance ---------- */
let repsQueue = []; // séries d'effort terminées en attente de saisie
let repsVal = 10;

function queueReps(phase, workSec) {
  repsQueue.push({ series: phase.series, sub: phase.sub, work: Math.round(workSec), round: phase.round });
  if (repsQueue.length === 1) showRepsPanel();
}
function showRepsPanel() {
  const item = repsQueue[0];
  if (!item) { $('#reps-panel').hidden = true; if (run?.finished) renderDone(); return; }
  repsVal = db.lastReps;
  $('#reps-q').innerHTML = `Combien de pompes ?<small>${esc(item.round)}${repsQueue.length > 1 ? ` · ${repsQueue.length} en attente` : ''}</small>`;
  $('#reps-val').textContent = repsVal;
  $('#reps-panel').hidden = false;
}
function validateReps() {
  const item = repsQueue.shift();
  if (!item || !run) return;
  const s = run.session;
  if (!db.pushupLog.includes(s)) db.pushupLog.push(s);
  s.sets.push({ series: item.series, sub: item.sub, reps: repsVal, work: item.work, ts: Date.now() });
  db.lastReps = repsVal;
  save(true);
  showRepsPanel();
}

/* =========================================================
   Données pompes : agrégats
   ========================================================= */
function dayTotals() {
  const m = {};
  for (const s of db.pushupLog) for (const x of s.sets) m[s.day] = (m[s.day] || 0) + x.reps;
  return m;
}
function removeSession(id) {
  db.pushupLog = db.pushupLog.filter(s => s.id !== id);
  save(true);
}
function computeStats() {
  const totals = dayTotals();
  const sets = db.pushupLog.flatMap(s => s.sets.map(x => ({ ...x, day: s.day })));
  const today = dayKey();
  const ws = weekStart(new Date());
  const lastWs = addDays(ws, -7);
  let week = 0, lastWeekSameTime = 0, month = 0;
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  for (const [k, v] of Object.entries(totals)) {
    const d = parseDay(k);
    if (d >= ws) week += v;
    if (d >= lastWs && d < ws && (d.getDay() + 6) % 7 <= dow) lastWeekSameTime += v;
    if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) month += v;
  }
  let bestDay = null;
  for (const [k, v] of Object.entries(totals)) if (!bestDay || v > bestDay.v) bestDay = { k, v };
  let bestSet = null;
  for (const x of sets) if (!bestSet || x.reps > bestSet.reps) bestSet = x;
  const total = sets.reduce((a, x) => a + x.reps, 0);
  const timed = sets.filter(x => x.work > 0);
  const timedReps = timed.reduce((a, x) => a + x.reps, 0);
  const workSec = timed.reduce((a, x) => a + x.work, 0);
  // jours consécutifs (la série reste valable si aujourd'hui n'est pas encore fait)
  let streak = 0;
  let d = new Date();
  if (!totals[dayKey(d)]) d = addDays(d, -1);
  while (totals[dayKey(d)]) { streak++; d = addDays(d, -1); }
  const activeDays = Object.values(totals).filter(v => v > 0).length;
  return {
    totals, today: totals[today] || 0, week, lastWeekSameTime, month, total, bestDay, bestSet,
    avgSet: sets.length ? total / sets.length : 0, setsCount: sets.length,
    rate: workSec ? timedReps / (workSec / 60) : 0, workSec, streak, activeDays,
    avgDay: activeDays ? total / activeDays : 0,
  };
}

/* =========================================================
   Graphique en barres (SVG)
   ========================================================= */
function barChart(items, { goal = 0, selected = null, h = 160, action = null, labelEvery = 1 } = {}) {
  const W = 320, H = h, padT = 16, padB = 18;
  const n = items.length || 1;
  const max = Math.max(goal, 1, ...items.map(i => i.value));
  const gap = n > 20 ? 2 : n > 10 ? 4 : 8;
  const bw = (W - gap * (n - 1)) / n;
  const y = v => padT + (H - padT - padB) * (1 - v / max);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  if (goal) s += `<line class="goal" x1="0" x2="${W}" y1="${y(goal)}" y2="${y(goal)}"/>`;
  items.forEach((it, i) => {
    const x = i * (bw + gap);
    const top = y(it.value);
    const bh = it.value ? Math.max(2, H - padB - top) : 0;
    const cls = ['bar', goal && it.value >= goal ? 'hit' : '', selected !== null && it.key === selected ? 'sel' : ''].join(' ');
    s += `<g${action ? ` data-action="${action}" data-key="${it.key}"` : ''}>`;
    if (action) s += `<rect x="${x}" y="0" width="${bw + gap}" height="${H}" fill="transparent"/>`;
    s += `<rect class="${cls}" x="${x}" y="${H - padB - bh}" width="${bw}" height="${bh}" rx="${Math.min(4, bw / 3)}"/>`;
    if (n <= 14 && it.value > 0) s += `<text class="vl" x="${x + bw / 2}" y="${H - padB - bh - 4}">${it.value}</text>`;
    if (i % labelEvery === 0 || it.key === selected) s += `<text x="${x + bw / 2}" y="${H - 4}">${it.label}</text>`;
    s += `</g>`;
  });
  return s + `</svg>`;
}

function daySeries(days) {
  const totals = dayTotals();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    const k = dayKey(d);
    out.push({ key: k, value: totals[k] || 0, label: days <= 7 ? d.toLocaleDateString('fr-FR', { weekday: 'narrow' }) : String(d.getDate()) });
  }
  return out;
}
function weekSeries(weeks) {
  const totals = dayTotals();
  const cur = weekStart(new Date());
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = addDays(cur, -7 * i);
    let v = 0;
    for (let j = 0; j < 7; j++) v += totals[dayKey(addDays(ws, j))] || 0;
    out.push({ key: dayKey(ws), value: v, label: `${ws.getDate()}/${ws.getMonth() + 1}` });
  }
  return out;
}

/* =========================================================
   Vues
   ========================================================= */
const TITLES = { timer: 'Chrono', exercises: 'Exercices', pushups: 'Pompes', stats: 'Stats' };
let current = 'timer';
let statsRange = '7';
let selectedDay = dayKey();

const PRESETS = [
  { w: 20, r: 10, n: 8, label: 'Tabata 20/10 ×8' },
  { w: 30, r: 15, n: 8, label: '30/15 ×8' },
  { w: 40, r: 20, n: 6, label: '40/20 ×6' },
  { w: 45, r: 15, n: 5, label: '45/15 ×5' },
  { w: 60, r: 30, n: 5, label: '1:00/0:30 ×5' },
];

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>`;
const ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

const views = {
  timer() {
    const q = db.quick;
    return `
      <section class="card">
        ${stepper('quick.work', 'Effort', 'time')}
        ${stepper('quick.rest', 'Repos', 'time')}
        ${stepper('quick.rounds', 'Répétitions')}
        <div class="summary"><span>Durée totale</span><b data-summary="quick">${fmt(planDuration(q))}</b></div>
      </section>
      <div class="chips">${PRESETS.map(p => `<button class="chip ${p.w === q.work && p.r === q.rest && p.n === q.rounds ? 'active' : ''}" data-action="preset" data-w="${p.w}" data-r="${p.r}" data-n="${p.n}">${p.label}</button>`).join('')}</div>
      <button class="btn primary big" data-action="start-quick">${ICON_PLAY.replace('<svg', '<svg width="22" height="22"')} Démarrer</button>
      <button class="btn ghost" data-action="save-quick">Enregistrer comme exercice</button>`;
  },

  exercises() {
    const today = dayTotals()[dayKey()] || 0;
    const list = db.exercises.map(x => `
      <div class="ex-card">
        <div class="ex-main" data-action="edit-ex" data-id="${x.id}">
          <div class="ex-name">${esc(x.name)}</div>
          <div class="ex-meta">${x.rounds} × ${fmt(x.work)}${x.rest ? ` / ${fmt(x.rest)}` : ''} · ${fmtLong(planDuration(x))}</div>
        </div>
        <button class="play" data-action="start-ex" data-id="${x.id}" aria-label="Démarrer ${esc(x.name)}">${ICON_PLAY}</button>
      </div>`).join('');
    return `
      <div class="ex-card special">
        <div class="ex-main" data-action="tab" data-view="pushups">
          <div class="ex-name">Pompes</div>
          <div class="ex-meta">Compteur · ${today} aujourd'hui</div>
        </div>
        <button class="play" data-action="start-pushups" aria-label="Démarrer les pompes">${ICON_PLAY}</button>
      </div>
      ${list || '<div class="empty">Aucun exercice pour l\'instant.</div>'}
      <button class="btn ghost" data-action="new-ex">+ Nouvel exercice</button>
      <p class="note">Touchez un exercice pour le modifier ou le supprimer.</p>`;
  },

  pushups() {
    const st = computeStats();
    const goal = db.settings.goal;
    const pct = Math.min(100, (st.today / goal) * 100);
    const c = db.pushup;
    const todaySets = db.pushupLog.filter(s => s.day === dayKey());
    return `
      <section class="card hero">
        <h2>Aujourd'hui</h2>
        <div class="big-num">${st.today}</div>
        <div class="sub">sur ${goal} · ${st.streak} jour${st.streak > 1 ? 's' : ''} d'affilée</div>
        <div class="progress ${st.today >= goal ? 'done' : ''}"><i style="width:${pct}%"></i></div>
        ${barChart(daySeries(7), { goal, h: 110, selected: dayKey() })}
      </section>
      <section class="card">
        <h2>Séance</h2>
        ${stepper('pushup.series', 'Séries')}
        ${stepper('pushup.sub', 'Sous-séries', 'int', 'par série')}
        ${stepper('pushup.work', 'Temps', 'time', 'par sous-série')}
        ${stepper('pushup.subRest', 'Récup', 'time', 'entre sous-séries', c.sub > 1 ? '' : 'disabled')}
        ${stepper('pushup.rest', 'Repos', 'time', 'après chaque série')}
        <div class="summary"><span data-summary="pushup-count">${c.series * c.sub} efforts</span><b data-summary="pushup">≈ ${fmtLong(pushupDuration(c))}</b></div>
      </section>
      <button class="btn primary big" data-action="start-pushups">${ICON_PLAY.replace('<svg', '<svg width="22" height="22"')} Démarrer</button>
      <button class="btn ghost" data-action="add-manual">+ Ajouter des pompes à la main</button>
      ${todaySets.length ? `<div class="section-title">Séries du jour</div><section class="card">${setList(todaySets)}</section>` : ''}`;
  },

  stats() {
    const st = computeStats();
    const goal = db.settings.goal;
    let series, labelEvery = 1, chartGoal = goal, action = 'select-day';
    if (statsRange === '7') series = daySeries(7);
    else if (statsRange === '30') { series = daySeries(30); labelEvery = 5; }
    else { series = weekSeries(12); labelEvery = 3; chartGoal = 0; action = null; }
    const periodTotal = series.reduce((a, x) => a + x.value, 0);
    const trend = st.lastWeekSameTime ? Math.round(((st.week - st.lastWeekSameTime) / st.lastWeekSameTime) * 100) : null;
    const daySessions = db.pushupLog.filter(s => s.day === selectedDay);
    const dayTotal = st.totals[selectedDay] || 0;
    const timerHist = db.history.slice(0, 15);
    return `
      <div class="seg">
        ${[['7', '7 jours'], ['30', '30 jours'], ['w', '12 semaines']].map(([k, l]) => `<button class="${statsRange === k ? 'active' : ''}" data-action="range" data-r="${k}">${l}</button>`).join('')}
      </div>
      <section class="card">
        ${barChart(series, { goal: chartGoal, selected: action ? selectedDay : null, action, labelEvery, h: 170 })}
        <div class="chart-legend"><span>Total période</span><b>${periodTotal} pompes</b></div>
      </section>
      <div class="grid">
        <div class="stat"><div class="k">Aujourd'hui</div><div class="v">${st.today}</div><div class="d">objectif ${goal}</div></div>
        <div class="stat"><div class="k">Cette semaine</div><div class="v">${st.week}</div><div class="d ${trend === null ? '' : trend >= 0 ? 'up' : 'down'}">${trend === null ? '—' : `${trend >= 0 ? '+' : ''}${trend}% vs sem. passée`}</div></div>
        <div class="stat"><div class="k">Ce mois</div><div class="v">${st.month}</div></div>
        <div class="stat"><div class="k">Total</div><div class="v">${st.total}</div><div class="d">${st.activeDays} jour${st.activeDays > 1 ? 's' : ''} actif${st.activeDays > 1 ? 's' : ''}</div></div>
        <div class="stat"><div class="k">Record jour</div><div class="v">${st.bestDay ? st.bestDay.v : 0}</div><div class="d">${st.bestDay ? fmtDay(st.bestDay.k) : '—'}</div></div>
        <div class="stat"><div class="k">Meilleure série</div><div class="v">${st.bestSet ? st.bestSet.reps : 0}</div><div class="d">${st.bestSet ? fmtDay(st.bestSet.day) : '—'}</div></div>
        <div class="stat"><div class="k">Moy. / série</div><div class="v">${st.avgSet.toFixed(1)}</div><div class="d">${st.setsCount} séries</div></div>
        <div class="stat"><div class="k">Moy. / jour actif</div><div class="v">${Math.round(st.avgDay)}</div></div>
        <div class="stat"><div class="k">Cadence</div><div class="v">${st.rate.toFixed(1)}<small> /min</small></div><div class="d">pendant l'effort</div></div>
        <div class="stat"><div class="k">Temps d'effort</div><div class="v">${fmtLong(st.workSec)}</div><div class="d">série : ${st.streak} j</div></div>
      </div>
      <div class="section-title">${fmtDay(selectedDay)} · ${dayTotal} pompes</div>
      <section class="card">${daySessions.length ? setList(daySessions, true) : '<div class="empty">Rien ce jour-là.</div>'}</section>
      <div class="section-title">Séances chrono</div>
      <section class="card">${timerHist.length ? `<ul class="hist">${timerHist.map(h => `
        <li><div class="h-main"><div class="h-name">${esc(h.name)}</div><div class="h-meta">${fmtDay(dayKey(h.ts))} · ${fmtTime(h.ts)} · ${h.rounds} série${h.rounds > 1 ? 's' : ''}</div></div><div class="h-val">${fmt(h.duration)}</div></li>`).join('')}</ul>` : '<div class="empty">Aucune séance enregistrée.</div>'}</section>`;
  },
};

function setList(sessions, showSessionHeader = false) {
  return sessions.map(s => {
    const total = s.sets.reduce((a, x) => a + x.reps, 0);
    const rows = s.sets.map((x, i) => `
      <li><span class="lbl">${s.manual ? 'Ajout manuel' : `Série ${x.series}${x.sub ? `.${x.sub}` : ''}`} · ${fmtTime(x.ts)}${x.work ? ` · ${fmt(x.work)}` : ''}</span>
      <span class="val">${x.reps}</span>
      <button class="del" data-action="del-set" data-sid="${s.id}" data-idx="${i}" aria-label="Supprimer">${ICON_X}</button></li>`).join('');
    const head = showSessionHeader && !s.manual ? `<div class="hist"><div class="h-meta" style="padding:4px 0">Séance de ${fmtTime(s.ts)} · ${total} pompes</div></div>` : '';
    return `${head}<ul class="set-list">${rows}</ul>`;
  }).join('<div style="height:10px"></div>');
}

function render() {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === current));
  $('#title').textContent = TITLES[current];
  $('#view').innerHTML = views[current]();
}

function refreshSummaries() {
  $$('[data-summary]').forEach(el => {
    const k = el.dataset.summary;
    if (k === 'quick') el.textContent = fmt(planDuration(db.quick));
    else if (k === 'pushup') el.textContent = `≈ ${fmtLong(pushupDuration(db.pushup))}`;
    else if (k === 'pushup-count') el.textContent = `${db.pushup.series * db.pushup.sub} efforts`;
    else if (k === 'draft' && draft) el.textContent = fmt(planDuration(draft));
  });
  const sr = $('[data-field="pushup.subRest"]');
  if (sr) sr.classList.toggle('disabled', db.pushup.sub <= 1);
  if (current === 'timer') {
    const q = db.quick;
    $$('.chip').forEach(c => c.classList.toggle('active', +c.dataset.w === q.work && +c.dataset.r === q.rest && +c.dataset.n === q.rounds));
  }
}

/* =========================================================
   Panneaux modaux
   ========================================================= */
let sheetResolve = null;
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
}
function closeSheet(result) {
  $('#sheet').hidden = true;
  $('#sheet-body').innerHTML = '';
  draft = null;
  if (!run) render();
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(result); }
}
function ask(message, okLabel = 'Confirmer', danger = true) {
  return new Promise(res => {
    openSheet(`<h3>${esc(message)}</h3>
      <button class="btn ${danger ? 'danger' : 'primary'}" style="${danger ? 'background:var(--surface-2)' : ''}" data-action="ask-ok">${esc(okLabel)}</button>
      <button class="btn" data-action="sheet-close">Annuler</button>`);
    sheetResolve = res;
  });
}
function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);transform:translateX(-50%);background:#2a2f37;color:#fff;padding:10px 16px;border-radius:12px;z-index:50;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.4)';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

function openEditor(ex) {
  draft = ex ? { ...ex } : { id: null, name: '', work: db.quick.work, rest: db.quick.rest, rounds: db.quick.rounds };
  openSheet(`
    <h3>${draft.id ? 'Modifier l\'exercice' : 'Nouvel exercice'}</h3>
    <input class="text-input" id="ex-name" placeholder="Nom (ex. Abdos, Corde à sauter…)" value="${esc(draft.name)}" maxlength="40" autocomplete="off">
    ${stepper('draft.work', 'Effort', 'time')}
    ${stepper('draft.rest', 'Repos', 'time')}
    ${stepper('draft.rounds', 'Répétitions')}
    <div class="summary"><span>Durée totale</span><b data-summary="draft">${fmt(planDuration(draft))}</b></div>
    <button class="btn primary" data-action="editor-save">Enregistrer</button>
    ${draft.id ? '<button class="btn danger" data-action="editor-delete">Supprimer</button>' : '<button class="btn" data-action="sheet-close">Annuler</button>'}`);
  if (!draft.id) setTimeout(() => $('#ex-name')?.focus(), 250);
}

let manualVal = 10;
function openManual() {
  manualVal = db.lastReps;
  openSheet(`
    <h3>Ajouter des pompes</h3>
    <p class="note">Pour une série faite sans le chrono. Comptée aujourd'hui.</p>
    <div class="picker">
      <button class="pk" data-action="manual-adj" data-d="-5">−5</button>
      <button class="pk" data-action="manual-adj" data-d="-1">−1</button>
      <output id="manual-val">${manualVal}</output>
      <button class="pk" data-action="manual-adj" data-d="1">+1</button>
      <button class="pk" data-action="manual-adj" data-d="5">+5</button>
    </div>
    <button class="btn primary" data-action="manual-ok">Ajouter</button>
    <button class="btn" data-action="sheet-close">Annuler</button>`);
}

function openSettings() {
  const t = (path, label, hint = '') => `<div class="field"><span class="field-label">${label}${hint ? `<small>${hint}</small>` : ''}</span><button class="toggle ${getPath(path) ? 'on' : ''}" data-action="toggle" data-path="${path}" aria-label="${label}"></button></div>`;
  openSheet(`
    <h3>Réglages</h3>
    ${t('settings.sound', 'Bips', 'Décompte 3-2-1 et changements de phase')}
    ${t('settings.voice', 'Voix', 'Annonce « Repos », « Série 2 »…')}
    ${stepper('settings.prep', 'Préparation', 'time', 'avant le premier effort', 'small')}
    ${stepper('settings.goal', 'Objectif pompes', 'int', 'par jour', 'small')}
    <div class="section-title">Sauvegarde</div>
    <p class="note">Vos données restent sur ce téléphone. Exportez-les de temps en temps pour ne rien perdre.</p>
    <div class="btn-row">
      <button class="btn" data-action="export">Exporter</button>
      <button class="btn" data-action="import">Importer</button>
    </div>
    <button class="btn danger" data-action="reset">Tout effacer</button>
    <button class="btn primary" data-action="sheet-close">OK</button>`);
}

async function exportData() {
  const json = JSON.stringify(db, null, 1);
  const name = `seances-${dayKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.pushupLog) || !Array.isArray(data.exercises)) throw new Error('format');
    if (!(await ask('Remplacer toutes les données actuelles par ce fichier ?', 'Remplacer'))) return;
    localStorage.setItem(KEY, JSON.stringify(data));
    db = load();
    render();
    toast('Données importées');
  } catch (err) { toast('Fichier invalide'); }
});

/* =========================================================
   Actions (délégation des clics)
   ========================================================= */
function startExercise(ex) {
  startRun({ title: ex.name, kind: 'timer', phases: buildPlan(ex) });
}
function startPushups() {
  const c = db.pushup;
  const session = { id: uid(), ts: Date.now(), day: dayKey(), sets: [] };
  startRun({ title: 'Pompes', kind: 'pushups', phases: buildPushupPlan(c), session, onWorkEnd: queueReps });
}

const actions = {
  tab: el => { current = el.dataset.view; if (current === 'stats') selectedDay = dayKey(); render(); window.scrollTo(0, 0); },
  preset: el => { Object.assign(db.quick, { work: +el.dataset.w, rest: +el.dataset.r, rounds: +el.dataset.n }); save(); render(); },
  'start-quick': () => startExercise({ ...db.quick, name: 'Chrono' }),
  'save-quick': () => openEditor(null),
  'new-ex': () => openEditor(null),
  'edit-ex': el => openEditor(db.exercises.find(x => x.id === el.dataset.id)),
  'start-ex': el => { const ex = db.exercises.find(x => x.id === el.dataset.id); if (ex) startExercise(ex); },
  'start-pushups': startPushups,
  'add-manual': openManual,
  'open-settings': openSettings,
  range: el => { statsRange = el.dataset.r; render(); },
  'select-day': el => { selectedDay = el.dataset.key; render(); },
  'del-set': async el => {
    const s = db.pushupLog.find(x => x.id === el.dataset.sid);
    if (!s) return;
    const set = s.sets[+el.dataset.idx];
    if (!(await ask(`Supprimer cette série de ${set.reps} pompes ?`, 'Supprimer'))) return;
    s.sets.splice(+el.dataset.idx, 1);
    if (!s.sets.length) removeSession(s.id); else save(true);
    render();
  },

  'run-pause': () => togglePause(),
  'run-plus': () => {
    if (!run || run.finished) return;
    if (run.paused) run.pausedLeft += 10000; else run.phaseEnd += 10000;
    run.phases[run.i] = { ...run.phases[run.i], dur: run.phases[run.i].dur + 10 };
    renderRunTime(Date.now());
  },
  'run-skip': () => {
    if (!run || run.finished) return;
    if (run.paused) togglePause();
    nextPhase(Date.now(), true);
  },
  'run-stop': async () => {
    if (!run) return;
    if (run.finished) return closeRun();
    const wasPaused = run.paused;
    if (!wasPaused) togglePause();
    const ok = await ask('Arrêter la séance ?', 'Arrêter');
    if (!run) return;
    if (ok) finishRun(false);
    else if (!wasPaused) togglePause();
  },
  'run-close': closeRun,
  'reps-adj': el => { repsVal = clamp(repsVal + Number(el.dataset.d), 0, 999); $('#reps-val').textContent = repsVal; },
  'reps-ok': validateReps,
  'reps-skip': () => { repsQueue.shift(); showRepsPanel(); },

  'sheet-backdrop': (el, e) => { if (e.target === el) closeSheet(false); },
  'sheet-close': () => closeSheet(false),
  'ask-ok': () => closeSheet(true),
  'editor-save': () => {
    const name = ($('#ex-name').value || '').trim() || 'Exercice';
    const data = { name, work: draft.work, rest: draft.rest, rounds: draft.rounds };
    if (draft.id) Object.assign(db.exercises.find(x => x.id === draft.id), data);
    else db.exercises.push({ id: uid(), ...data });
    save(true);
    closeSheet(true);
    if (current !== 'exercises') { current = 'exercises'; toast('Exercice enregistré'); }
    render();
  },
  'editor-delete': async () => {
    const id = draft.id, name = draft.name;
    closeSheet(false);
    if (!(await ask(`Supprimer « ${name} » ?`, 'Supprimer'))) return;
    db.exercises = db.exercises.filter(x => x.id !== id);
    save(true);
    render();
  },
  'manual-adj': el => { manualVal = clamp(manualVal + Number(el.dataset.d), 1, 999); $('#manual-val').textContent = manualVal; },
  'manual-ok': () => {
    db.pushupLog.push({ id: uid(), ts: Date.now(), day: dayKey(), manual: true, sets: [{ series: 0, sub: 0, reps: manualVal, work: 0, ts: Date.now() }] });
    db.lastReps = manualVal;
    save(true);
    closeSheet(true);
    render();
    toast(`+${manualVal} pompes`);
  },
  toggle: el => { const p = el.dataset.path; setPath(p, !getPath(p)); el.classList.toggle('on', getPath(p)); save(); },
  export: exportData,
  import: () => $('#import-file').click(),
  reset: async () => {
    closeSheet(false);
    if (!(await ask('Effacer toutes les données (exercices, pompes, historique) ?', 'Tout effacer'))) return;
    db = structuredClone(DEFAULTS);
    save(true);
    render();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  actions[el.dataset.action]?.(el, e);
});

/* Écran allumé : la demande saute quand l'app passe en arrière-plan */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (run && !run.finished) { keepAwake(); tick(); }
    else if (!run) render(); // la date a pu changer
  }
});

/* Hors ligne */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

render();
