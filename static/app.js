/* H3 Studio — browser side. Builds ComfyUI API graphs for MiniMax H3 (Image Studio nodes for stills,
   native MiniMax H3 nodes for video), queues them through the /comfy proxy and tracks progress over the
   websocket. Form state, uploaded inputs and results persist in localStorage. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const CID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const LS = 'h3studio.';
const MB = 1024 * 1024;
const IMG_MODES = ['t2i', 'i2i', 'multi'];
const DEFAULTS = {
  img: { steps: 50, sampler: 'er_sde', scheduler: 'simple', prefix: 'h3studio/img' },
  video: { steps: 20, sampler: 'res_multistep', scheduler: 'simple', prefix: 'video/h3studio' },
};
const NODES = ['H3StudioModels', 'H3StudioEdit', 'H3StudioGenerate', 'H3StudioRender', 'UNETLoader', 'UnetLoaderGGUF',
  'CLIPLoader', 'VAELoader', 'KSamplerSelect', 'BasicScheduler', 'LoraLoaderModelOnly', 'MiniMaxH3ReferenceToVideo'];

const S = {
  mode: 't2i', info: {}, online: false, runs: [], byId: {}, ws: null, active: null,
  loras: [],
  lists: { i2i: [], multi: [], first: [], last: [], refImg: [], refVid: [], refAud: [] },
  guides: [],
};

/* ───────── storage ───────── */
const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* quota or private mode */ } };

/* ───────── small helpers ───────── */
const val = id => { const el = document.getElementById(id); return el.type === 'checkbox' ? el.checked : el.value; };
const setVal = (id, v) => { const el = document.getElementById(id); if (!el) return;
  if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
const radio = name => ($(`input[name="${name}"]:checked`) || {}).value;
const r32 = x => Math.max(32, Math.round(x / 32) * 32);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const group = m => (m === 'video' ? 'video' : 'img');
const viewUrl = a => `/comfy/view?filename=${encodeURIComponent(a.filename)}&subfolder=${encodeURIComponent(a.subfolder || '')}&type=${a.type || 'input'}`;
const loaderName = a => (a.type === 'output' || a.type === 'temp')
  ? `${a.subfolder ? a.subfolder + '/' : ''}${a.filename} [${a.type}]`
  : `${a.subfolder ? a.subfolder + '/' : ''}${a.filename}`;
const kindOf = name => /\.(mp4|webm|mkv|mov|avi|gif)$/i.test(name) ? 'video'
  : /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i.test(name) ? 'audio' : 'image';
const randSeed = () => Math.floor(Math.random() * 2 ** 32);

async function api(path, opts = {}) {
  const r = await fetch('/comfy/' + path, opts);
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) { const e = new Error(body.error?.message || body.error || r.statusText); e.body = body; e.status = r.status; throw e; }
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ───────── node info → option lists ───────── */
function opts(node, input) {
  const n = S.info[node]; if (!n) return [];
  const spec = n.input?.required?.[input] ?? n.input?.optional?.[input];
  if (!spec) return [];
  if (Array.isArray(spec[0])) return spec[0];
  return spec[1]?.options ?? [];
}
function fill(id, list, preferred) {
  const el = document.getElementById(id), cur = el.value;
  el.innerHTML = list.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  if (list.includes(cur)) el.value = cur;
  else if (preferred && list.includes(preferred)) el.value = preferred;
}
async function loadInfo() {
  const res = await Promise.all(NODES.map(n => api('object_info/' + n).catch(() => ({}))));
  res.forEach(r => Object.assign(S.info, r));
  fillModeOptions();
}
const loraFiles = () => ['None', ...opts('LoraLoaderModelOnly', 'lora_name')];
const turboLora = () => loraFiles().find(n => /minimax_h3_turbo_v4/i.test(n));

function fillModeOptions() {
  const m = S.mode;
  const samplers = opts('KSamplerSelect', 'sampler_name').length ? opts('KSamplerSelect', 'sampler_name') : opts('H3StudioRender', 'sampler_name');
  const schedulers = opts('BasicScheduler', 'scheduler').length ? opts('BasicScheduler', 'scheduler') : opts('H3StudioRender', 'scheduler');
  fill('sampler', samplers, DEFAULTS[group(m)].sampler);
  fill('scheduler', schedulers, 'simple');
  if (m === 'video') {
    const unet = opts('UNETLoader', 'unet_name').filter(n => /h3/i.test(n) && /minimax/i.test(n));
    const gguf = opts('UnetLoaderGGUF', 'unet_name').filter(n => /h3/i.test(n));
    fill('model', [...unet, ...gguf], 'minimax_h3_fl2va_pruned_int8_convrot.safetensors');
    fill('te', opts('CLIPLoader', 'clip_name').filter(n => /minimax|qwen3vl/i.test(n)));
    const vaes = opts('VAELoader', 'vae_name');
    fill('vae', vaes.filter(n => /minimax_h3_video_vae/i.test(n)), 'minimax_h3_video_vae_fp16.safetensors');
    fill('avae', vaes.filter(n => /minimax_h3_audio_vae/i.test(n)));
    fill('dtype', opts('UNETLoader', 'weight_dtype'), 'default');
  } else {
    fill('model', opts('H3StudioModels', 'diffusion_model'), 'minimax_h3_fl2va_pruned_int8_convrot.safetensors');
    fill('te', opts('H3StudioModels', 'text_encoder'));
    fill('vae', opts('H3StudioModels', 'video_vae'), 'minimax_h3_video_vae_fp16.safetensors');
    const aspects = m === 't2i' ? opts('H3StudioGenerate', 'aspect_ratio') : opts('H3StudioEdit', 'aspect_ratio');
    fill('aspect', aspects, m === 't2i' ? '1:1 square' : 'source image');
  }
  renderLoras();
}

/* ───────── form snapshots (per mode) ───────── */
function snap() {
  const v = {};
  $$('[data-persist]').forEach(el => {
    if (el.type === 'radio') { if (el.checked) v['radio:' + el.name] = el.value; }
    else v[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return { v, loras: S.loras.map(l => ({ ...l })) };
}
function applySnap(s) {
  if (!s) return;
  for (const [k, x] of Object.entries(s.v || {})) {
    if (k.startsWith('radio:')) { const r = $(`input[name="${k.slice(6)}"][value="${x}"]`); if (r) r.checked = true; }
    else { const el = document.getElementById(k); if (!el) continue;
      if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === x)) continue;
      setVal(k, x); }
  }
  if (s.loras) S.loras = s.loras.map(l => ({ ...l }));
}
const persistForm = () => save('form.' + S.mode, snap());
const persistAssets = () => save('assets', { lists: S.lists, guides: S.guides });

function setMode(m, { keepForm = false } = {}) {
  if (!keepForm) persistForm();
  S.mode = m;
  save('mode', m);
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  if (!keepForm) {
    const d = DEFAULTS[group(m)];
    S.loras = [];
    setVal('steps', d.steps); setVal('prefix', d.prefix);
    fillModeOptions();
    setVal('sampler', d.sampler); setVal('scheduler', d.scheduler);
    applySnap(load('form.' + m, null));
  }
  fillModeOptions();
  refresh();
}

/* ───────── visibility, labels, derived values ───────── */
function refresh() {
  const m = S.mode, vm = radio('vmode');
  $$('[data-show]').forEach(el => el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(m)));
  $$('[data-vshow]').forEach(el => { if (m === 'video') el.classList.toggle('hidden', !el.dataset.vshow.split(' ').includes(vm)); });
  $$('[data-custom]').forEach(el => el.classList.toggle('hidden', val('aspect') !== 'custom pixels'));
  $('#promptLabel').textContent = m === 't2i' || m === 'video' ? 'Prompt' : 'Instruction';
  $('#promptHint').textContent = {
    t2i: 'Used as-is: no hidden preservation wording.',
    i2i: 'Describe the change; say what must stay. "<Picture 1>." is prepended automatically if missing.',
    multi: 'Assign each picture a role, e.g. "Keep the room from <Picture 1>, use the light of <Picture 2>."',
    video: { t2v: 'Describe picture and sound. Timelines like "[0s-2s] …" work; H3 also generates audio.',
             first: 'The first frame is fixed; describe the motion, camera and sound that follow.',
             firstlast: 'Describe how the shot gets from the first frame to the last.',
             ref: 'Refer to references by tag: <Picture N>, <Video N>, <Audio N>.' }[vm],
  }[m];
  $('#prompt').placeholder = m === 't2i' ? 'Describe the image…' : m === 'video' ? 'Describe the shot, motion and sound…' : 'Describe the edit…';
  renderTags();
  updateCanvas();
  updateDuration();
  renderPresets();
  $('#promptCount').textContent = `${val('prompt').length} chars`;
}

function tagsForMode() {
  const m = S.mode;
  if (m === 'i2i') return ['<Picture 1>'];
  if (m === 'multi') return S.lists.multi.map((_, i) => `<Picture ${i + 1}>`);
  if (m === 'video' && radio('vmode') === 'ref') {
    const t = S.lists.refImg.map((_, i) => `<Picture ${i + 1}>`);
    let a = 0;
    S.lists.refVid.forEach((_, i) => { if (val('refVidAudio')) t.push(`<Audio ${++a}>`); t.push(`<Video ${i + 1}>`); });
    S.lists.refAud.forEach(() => t.push(`<Audio ${++a}>`));
    return t;
  }
  return [];
}
function renderTags() {
  $('#tagChips').innerHTML = tagsForMode().map(t => `<button type="button" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
}
function insertAtCursor(text) {
  const ta = $('#prompt'), s = ta.selectionStart, e = ta.selectionEnd;
  const pad = s > 0 && !/\s$/.test(ta.value.slice(0, s)) ? ' ' : '';
  ta.value = ta.value.slice(0, s) + pad + text + ' ' + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + pad.length + text.length + 1;
  ta.focus(); persistForm(); refresh();
}

function imgCanvas() {
  const a = val('aspect');
  if (a === 'custom pixels') return [r32(+val('width')), r32(+val('height'))];
  let ratio = 1;
  if (a === 'source image') {
    const p = (S.mode === 'i2i' ? S.lists.i2i : S.lists.multi)[0];
    if (!p?.w) return null;
    ratio = p.w / p.h;
  } else {
    const mm = a.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
    if (mm) ratio = mm[1] / mm[2];
  }
  const area = +val('mp') * MB;
  return [r32(Math.sqrt(area * ratio)), r32(Math.sqrt(area / ratio))];
}
function adaptCanvas(ratio) {     // mirrors comfy_extras/nodes_minimax_h3.adapt_canvas, before rounding
  let w, h;
  if (ratio >= 1) { w = 768 * ratio; h = 768; } else { w = 768; h = 768 / ratio; }
  const cap = 768 * 1344;
  if (w * h > cap) { const s = Math.sqrt(cap / (w * h)); w *= s; h *= s; }
  return [w, h];
}
function vidCanvasFromAspect() {
  const a = val('vAspect');
  if (a === 'custom') return null;
  let ratio = 16 / 9;
  if (a === 'first') { const f = S.lists.first[0]; if (f?.w) ratio = f.w / f.h; }
  else { const [x, y] = a.split(':').map(Number); ratio = x / y; }
  let [w, h] = adaptCanvas(ratio);
  const size = val('vSize');
  if (size !== 'native') { const t = +size * MB; if (t < w * h) { const s = Math.sqrt(t / (w * h)); w *= s; h *= s; } }
  return [r32(w), r32(h)];
}
function updateCanvas() {
  if (S.mode === 'video') {
    const c = vidCanvasFromAspect();
    if (c) { setVal('vWidth', c[0]); setVal('vHeight', c[1]); }
    return;
  }
  const c = imgCanvas();
  $('#canvasOut').textContent = c ? `≈ ${c[0]} × ${c[1]} px · ${(c[0] * c[1] / MB).toFixed(2)} MP (rounded to 32 px)`
    : 'Size follows Picture 1 once it is added.';
  $$('.presets [data-mp]').forEach(b => b.classList.toggle('on', +b.dataset.mp === +val('mp')));
}
function frameCount(sec) {
  let n = Math.max(5, Math.round(sec * 24));
  while (n % 17 !== 5) n++;
  return n;
}
function updateDuration() {
  const n = frameCount(+val('vSec'));
  $('#durOut').textContent = `${val('vSec')} s → ${n} frames · ${(n / 24).toFixed(2)} s at 24 fps` + (n > 362 ? ' · beyond trained range' : '');
  $$('#guides .fidx').forEach(updateGuideSec);
}

/* ───────── sampling presets ───────── */
function renderPresets() {
  const t = turboLora();
  const P = S.mode === 'video' ? [
    ['Template · 20 steps', () => { S.loras = []; setVal('steps', 20); setVal('sampler', 'res_multistep'); setVal('scheduler', 'simple'); setVal('shiftOn', false); }],
    t && ['Turbo LoRA @1.0 · 8 steps', () => { S.loras = [{ name: t, strength: 1 }]; setVal('steps', 8); }],
    ['Draft · 0.2 MP · 3 s', () => { setVal('vSize', '0.2'); setVal('vSec', 3); if (val('vAspect') === 'custom') setVal('vAspect', '16:9'); }],
    ['Final · native size', () => { setVal('vSize', 'native'); if (val('vAspect') === 'custom') setVal('vAspect', '16:9'); }],
  ] : [
    ['Quality · 50 steps, no LoRA', () => { S.loras = []; setVal('steps', 50); setVal('sampler', 'er_sde'); setVal('scheduler', 'simple'); }],
    t && ['Turbo · Larry v4 @0.38 · 20 steps', () => { S.loras = [{ name: t, strength: 0.38 }]; setVal('steps', 20); }],
    t && ['Preview · 1 MP turbo', () => { S.loras = [{ name: t, strength: 0.38 }]; setVal('steps', 20); setVal('mp', 1); }],
    ['Final · 3 MP', () => { setVal('mp', 3); }],
  ];
  $('#presetBtns').innerHTML = '';
  P.filter(Boolean).forEach(([label, fn]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.onclick = () => { fn(); renderLoras(); persistForm(); refresh(); };
    $('#presetBtns').append(b);
  });
}

/* ───────── LoRA stack ───────── */
function renderLoras() {
  const files = loraFiles(), host = $('#loras');
  host.innerHTML = '';
  S.loras.forEach((l, i) => {
    const row = document.createElement('div'); row.className = 'lrow';
    row.innerHTML = `<label>LoRA ${i + 1}<select>${files.map(f => `<option ${f === l.name ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
      <label>Strength<input type="number" step="0.01" min="-20" max="20" value="${l.strength}"></label>
      <button type="button" class="ghost" title="Remove">✕</button>`;
    const [sel, num] = [$('select', row), $('input', row)];
    sel.onchange = () => { l.name = sel.value; persistForm(); };
    num.oninput = () => { l.strength = +num.value; persistForm(); };
    $('button', row).onclick = () => { S.loras.splice(i, 1); renderLoras(); persistForm(); };
    host.append(row);
  });
}

/* ───────── asset slots ───────── */
async function upload(file) {
  const fd = new FormData();
  fd.append('image', file); fd.append('type', 'input'); fd.append('overwrite', 'false');
  const j = await api('upload/image', { method: 'POST', body: fd });
  const a = { filename: j.name, subfolder: j.subfolder || '', type: 'input', kind: kindOf(j.name) };
  return measure(a);
}
function measure(a) {
  return new Promise(res => {
    if (a.kind === 'image') { const im = new Image(); im.onload = () => res({ ...a, w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => res(a); im.src = viewUrl(a); }
    else if (a.kind === 'video') { const v = document.createElement('video'); v.preload = 'metadata';
      v.onloadedmetadata = () => res({ ...a, w: v.videoWidth, h: v.videoHeight, dur: v.duration }); v.onerror = () => res(a); v.src = viewUrl(a); }
    else res(a);
  });
}
function mediaEl(a) {
  if (a.kind === 'video') return `<video class="thumb" src="${viewUrl(a)}" muted loop onmouseenter="this.play()" onmouseleave="this.pause()"></video>`;
  if (a.kind === 'audio') return `<div class="audio"><span>${esc(a.filename)}</span><audio controls preload="none" src="${viewUrl(a)}"></audio></div>`;
  return `<img class="thumb" src="${viewUrl(a)}" alt="">`;
}
function slotEl(a, tag, onRemove) {
  const d = document.createElement('div'); d.className = 'slot';
  const dims = a.w ? `${a.w}×${a.h}` + (a.dur ? ` · ${a.dur.toFixed(1)}s` : '') : '';
  d.innerHTML = `${mediaEl(a)}<div class="cap"><code>${esc(tag || '')}</code><span class="muted">${dims}</span><button type="button" class="x" title="Remove">✕</button></div>`;
  d.title = a.filename;
  $('.x', d).onclick = onRemove;
  return d;
}
function dropEl(kind, multiple, onFiles) {
  const d = document.createElement('div'); d.className = 'drop';
  const accept = { image: 'image/*', video: 'video/*', audio: 'audio/*' }[kind];
  d.innerHTML = `<b>+</b>Drop or click to add ${kind}${multiple ? 's' : ''}`;
  d.onclick = () => { const fp = $('#filePick'); fp.accept = accept; fp.multiple = multiple;
    fp.onchange = () => { onFiles([...fp.files]); fp.value = ''; }; fp.click(); };
  d.ondragover = e => { e.preventDefault(); d.classList.add('over'); };
  d.ondragleave = () => d.classList.remove('over');
  d.ondrop = e => {
    e.preventDefault(); d.classList.remove('over');
    const ref = e.dataTransfer.getData('application/x-h3asset');
    if (ref) onFiles([], JSON.parse(ref)); else onFiles([...e.dataTransfer.files]);
  };
  return d;
}
async function addFiles(key, files, asset) {
  const host = $(`[data-list="${key}"]`), max = +host.dataset.max, list = S.lists[key];
  try {
    const items = asset ? [asset] : await Promise.all(files.slice(0, max - list.length).map(upload));
    if (max === 1) list.splice(0, list.length);
    list.push(...items.slice(0, max - list.length));
  } catch (e) { showErr('Upload failed: ' + e.message); }
  changed();
}
function renderList(key) {
  const host = $(`[data-list="${key}"]`), list = S.lists[key];
  const max = +host.dataset.max, kind = host.dataset.kind, tagName = host.dataset.tag;
  host.innerHTML = '';
  list.forEach((a, i) => {
    let tag = tagName ? `<${tagName} ${i + 1}>` : '';
    if (key === 'refAud') tag = `<Audio ${(val('refVidAudio') ? S.lists.refVid.length : 0) + i + 1}>`;
    const el = slotEl(a, tag, () => { list.splice(i, 1); changed(); });
    if (max > 1) {
      el.draggable = true;
      el.ondragstart = e => e.dataTransfer.setData('text/x-slot', `${key}:${i}`);
      el.ondragover = e => { if (e.dataTransfer.types.includes('text/x-slot')) { e.preventDefault(); el.classList.add('dragover'); } };
      el.ondragleave = () => el.classList.remove('dragover');
      el.ondrop = e => {
        e.preventDefault(); el.classList.remove('dragover');
        const [k, j] = e.dataTransfer.getData('text/x-slot').split(':');
        if (k !== key) return;
        const [moved] = list.splice(+j, 1); list.splice(i, 0, moved); changed();
      };
    }
    host.append(el);
  });
  if (list.length < max) host.append(dropEl(kind, max - list.length > 1, (files, asset) => addFiles(key, files, asset)));
}

/* keyframe guides */
function updateGuideSec(inp) {
  const n = frameCount(+val('vSec')), f = +inp.value, idx = f < 0 ? n + f : f;
  inp.closest('.grow').querySelector('.gsec').textContent = `= ${(idx / 24).toFixed(2)} s` + (idx >= n || idx < 0 ? ' (outside clip)' : '');
}
function renderGuides() {
  const host = $('#guides'); host.innerHTML = '';
  S.guides.forEach((g, i) => {
    const row = document.createElement('div'); row.className = 'grow';
    const left = g.asset ? slotEl(g.asset, g.kind === 'audio' ? 'audio guide' : 'image guide', () => { g.asset = null; changed(); })
      : dropEl(g.kind, false, async (files, asset) => {
        try { g.asset = asset || (files[0] && await upload(files[0])) || null; } catch (e) { showErr('Upload failed: ' + e.message); }
        changed(); });
    row.append(left);
    const mid = document.createElement('div'); mid.className = 'fi';
    mid.innerHTML = `<label>Frame index <small>(negative = from end)</small><input class="fidx" type="number" min="-9999" max="9999" value="${g.frame}"></label><span class="muted small gsec"></span>`;
    row.append(mid);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'ghost'; x.textContent = '✕';
    x.onclick = () => { S.guides.splice(i, 1); changed(); };
    row.append(x);
    const inp = $('.fidx', mid);
    inp.oninput = () => { g.frame = +inp.value; updateGuideSec(inp); persistAssets(); };
    host.append(row); updateGuideSec(inp);
  });
}
function changed() {
  Object.keys(S.lists).forEach(renderList);
  renderGuides();
  persistAssets();
  refresh();
}

/* ───────── graph builders ───────── */
function Graph() {
  let n = 0; const p = {};
  return { p, add(cls, inputs) { const k = String(++n); p[k] = { class_type: cls, inputs }; return k; } };
}
const L = (k, i = 0) => [k, i];

function buildImage(seed) {
  const m = S.mode, g = Graph();
  let models = g.add('H3StudioModels', { diffusion_model: val('model'), text_encoder: val('te'), video_vae: val('vae'), turbo_lora: 'None' });
  for (const l of S.loras) if (l.name !== 'None' && +l.strength !== 0)
    models = g.add('H3StudioLoRA', { models: L(models), lora_name: l.name, strength_model: +l.strength });
  const canvas = { aspect_ratio: val('aspect'), megapixels: +val('mp'), width: r32(+val('width')), height: r32(+val('height')) };
  let job;
  if (m === 't2i') job = g.add('H3StudioGenerate', { models: L(models), prompt: val('prompt'), ...canvas });
  else {
    const pics = m === 'i2i' ? S.lists.i2i : S.lists.multi;
    const inputs = { models: L(models), image: L(g.add('LoadImage', { image: loaderName(pics[0]) })), instruction: val('prompt'), ...canvas };
    pics.slice(1).forEach((a, i) => { inputs[`references.reference_image_${i + 2}`] = L(g.add('LoadImage', { image: loaderName(a) })); });
    job = g.add('H3StudioEdit', inputs);
  }
  const r = g.add('H3StudioRender', { image_job: L(job), steps: +val('steps'), seed, sampler_name: val('sampler'), scheduler: val('scheduler') });
  g.add('SaveImage', { images: L(r), filename_prefix: val('prefix') });
  g.add('PreviewAny', { source: L(r, 1) });
  return g.p;
}

function buildVideo(seed) {
  const g = Graph(), vm = radio('vmode'), name = val('model');
  const W = r32(+val('vWidth')), H = r32(+val('vHeight')), length = frameCount(+val('vSec'));
  let model = /\.gguf$/i.test(name) ? g.add('UnetLoaderGGUF', { unet_name: name })
    : g.add('UNETLoader', { unet_name: name, weight_dtype: val('dtype') || 'default' });
  for (const l of S.loras) if (l.name !== 'None' && +l.strength !== 0)
    model = g.add('LoraLoaderModelOnly', { model: L(model), lora_name: l.name, strength_model: +l.strength });
  if (val('shiftOn')) model = g.add('MiniMaxH3SigmaShift', { model: L(model), shift_video: +val('shiftV'), shift_audio: +val('shiftA') });
  const clip = g.add('CLIPLoader', { clip_name: val('te'), type: 'minimax', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: val('vae') });
  const avae = g.add('VAELoader', { vae_name: val('avae') });
  const img = a => L(g.add('LoadImage', { image: loaderName(a) }));
  let cond;
  if (vm === 'ref') {
    const inputs = { clip: L(clip), vae: L(vae), audio_vae: L(avae), prompt: val('prompt'), width: W, height: H, length, ref_image_size: val('refSize') };
    S.lists.refImg.forEach((a, i) => { inputs[`ref_images.ref_image_${i}`] = img(a); });
    S.lists.refVid.forEach((a, i) => {
      const comps = g.add('GetVideoComponents', { video: L(g.add('LoadVideo', { file: loaderName(a) })) });
      inputs[`ref_videos.ref_video_${i}`] = L(comps, 0);
      if (val('refVidAudio')) inputs[`ref_video_audios.ref_video_audio_${i}`] = L(comps, 1);
    });
    S.lists.refAud.forEach((a, i) => { inputs[`ref_audios.ref_audio_${i}`] = L(g.add('LoadAudio', { audio: loaderName(a) })); });
    cond = g.add('MiniMaxH3ReferenceToVideo', inputs);
  } else {
    const inputs = { clip: L(clip), vae: L(vae), prompt: val('prompt'), width: W, height: H, length };
    if ((vm === 'first' || vm === 'firstlast') && S.lists.first[0]) inputs.first_frame = img(S.lists.first[0]);
    if (vm === 'firstlast' && S.lists.last[0]) inputs.last_frame = img(S.lists.last[0]);
    cond = g.add('MiniMaxH3ImageToVideo', inputs);
  }
  let positive = L(cond, 0);
  const latent = L(cond, 1);
  for (const gd of S.guides) {
    if (!gd.asset) continue;
    const inputs = { positive, vae: L(vae), audio_vae: L(avae), latent, frame_idx: +gd.frame };
    if (gd.kind === 'audio') inputs.audio = L(g.add('LoadAudio', { audio: loaderName(gd.asset) }));
    else inputs.image = img(gd.asset);
    positive = L(g.add('MiniMaxH3AddGuide', inputs));
  }
  const sca = g.add('SamplerCustomAdvanced', {
    noise: L(g.add('RandomNoise', { noise_seed: seed })),
    guider: L(g.add('BasicGuider', { model: L(model), conditioning: positive })),
    sampler: L(g.add('KSamplerSelect', { sampler_name: val('sampler') })),
    sigmas: L(g.add('BasicScheduler', { model: L(model), scheduler: val('scheduler'), steps: +val('steps'), denoise: 1 })),
    latent_image: latent,
  });
  const frames = g.add('VAEDecode', { samples: L(sca), vae: L(vae) });
  const cv = { images: L(frames), fps: +val('vFps'), bit_depth: val('vBits') === 'auto' ? 'auto' : +val('vBits'), color_space: val('vColor') };
  if (val('vAudio')) cv.audio = L(g.add('VAEDecodeAudio', { samples: L(sca), vae: L(avae) }));
  const sv = { video: L(g.add('CreateVideo', cv)), filename_prefix: val('prefix'), format: val('vFormat'), 'format.codec': val('vCodec') };
  if (val('vCodec') === 'h264' && val('vCrf') !== '') {
    sv['format.codec.encoding'] = 're-encode';
    sv['format.codec.encoding.crf'] = +val('vCrf');
  }
  g.add('SaveVideo', sv);
  return g.p;
}
const build = seed => (S.mode === 'video' ? buildVideo(seed) : buildImage(seed));

function check() {
  const m = S.mode, vm = radio('vmode'), errs = [];
  if (!val('prompt').trim()) errs.push('Write a prompt.');
  if (!val('model')) errs.push('No MiniMax H3 diffusion model found in ComfyUI.');
  if (m === 'i2i' && !S.lists.i2i.length) errs.push('Add the source image.');
  if (m === 'multi' && !S.lists.multi.length) errs.push('Add at least Picture 1.');
  if (m === 'video') {
    if ((vm === 'first' || vm === 'firstlast') && !S.lists.first.length) errs.push('Add the first frame.');
    if (vm === 'firstlast' && !S.lists.last.length) errs.push('Add the last frame.');
    if (!val('avae')) errs.push('No MiniMax H3 audio VAE found.');
    if (S.guides.some(gd => !gd.asset)) errs.push('A keyframe guide has no file; add one or remove the guide.');
  }
  return errs;
}

/* ───────── queue & runs ───────── */
function showErr(msg) { const e = $('#err'); e.textContent = msg; e.classList.toggle('hidden', !msg); }
function formatNodeErrors(body, graph) {
  const lines = [body.error?.message || body.error || 'Prompt rejected'];
  for (const [id, ne] of Object.entries(body.node_errors || {}))
    for (const er of ne.errors || []) lines.push(`• ${graph?.[id]?.class_type || ne.class_type || id}: ${er.message}${er.details ? ' — ' + er.details : ''}`);
  return lines.join('\n');
}
function summary() {
  const m = S.mode;
  if (m === 'video') return `${radio('vmode')} · ${r32(+val('vWidth'))}×${r32(+val('vHeight'))} · ${frameCount(+val('vSec'))}f · ${val('steps')} steps · ${val('sampler')}/${val('scheduler')}`;
  const c = imgCanvas();
  return `${c ? c[0] + '×' + c[1] : 'source'} · ${val('steps')} steps · ${val('sampler')}/${val('scheduler')}`;
}
async function generate() {
  showErr('');
  const errs = check();
  if (errs.length) return showErr(errs.join('\n'));
  persistForm();
  const n = Math.max(1, +val('batch') || 1), base = +val('seed') || 0, btn = $('#go');
  btn.disabled = true;
  try {
    for (let i = 0; i < n; i++) {
      const seed = val('seedMode') === 'random' && i > 0 ? randSeed() : base + i;
      const graph = build(seed);
      let res;
      try { res = await post('prompt', { prompt: graph, client_id: CID }); }
      catch (e) { showErr(e.body ? formatNodeErrors(e.body, graph) : e.message); break; }
      const run = {
        id: res.prompt_id, mode: S.mode, vmode: S.mode === 'video' ? radio('vmode') : null, seed, prompt: val('prompt'),
        summary: summary(), loras: S.loras.filter(l => l.name !== 'None' && +l.strength).map(l => `${l.name} @${l.strength}`),
        model: val('model'), status: 'queued', outputs: [], info: '', t0: Date.now(), graph,
        restore: { mode: S.mode, form: snap(), lists: JSON.parse(JSON.stringify(S.lists)), guides: JSON.parse(JSON.stringify(S.guides)) },
      };
      S.runs.unshift(run); S.byId[run.id] = run;
    }
  } finally { btn.disabled = false; }
  const sm = val('seedMode');
  if (sm === 'increment') setVal('seed', base + n);
  else if (sm === 'random') setVal('seed', randSeed());
  persistForm(); saveRuns(); renderGallery();
}
function saveRuns() { save('runs', S.runs.slice(0, 200).map(r => ({ ...r, graph: undefined }))); }

function finish(run, status, error) {
  if (!run || run.status === 'done' || run.status === 'error') return;
  run.status = status; run.error = error || ''; run.t1 = Date.now();
  if (S.active === run.id) S.active = null;
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    prompt_id: run.id, status, error: run.error, mode: run.mode, video_mode: run.vmode, prompt: run.prompt, seed: run.seed,
    settings: run.summary, model: run.model, loras: run.loras, run_info: run.info,
    inputs: inputsOf(run.restore), outputs: run.outputs.map(o => loaderName(o).replace(/ \[output\]$/, '')),
    seconds: ((run.t1 - run.t0) / 1000).toFixed(1), graph: run.graph,
  }) }).catch(() => {});
  saveRuns(); renderGallery(); setRunbar();
}
function inputsOf(r) {
  if (!r) return [];
  const pick = { i2i: ['i2i'], multi: ['multi'], t2i: [] }[r.mode]
    ?? { t2v: [], first: ['first'], firstlast: ['first', 'last'], ref: ['refImg', 'refVid', 'refAud'] }[r.form.v['radio:vmode']] ?? [];
  const out = pick.flatMap(k => r.lists[k].map(a => `${k}:${loaderName(a)}`));
  if (r.mode === 'video') r.guides.forEach(g => g.asset && out.push(`guide@${g.frame}:${loaderName(g.asset)}`));
  return out;
}
function collect(run, output) {
  for (const it of output?.images || []) {
    if (!run.outputs.some(o => o.filename === it.filename && o.subfolder === it.subfolder))
      run.outputs.push({ ...it, kind: kindOf(it.filename) });
  }
  if (output?.text) run.info = [].concat(output.text).join('\n');
}

/* websocket */
function connectWS() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comfy/ws?clientId=${CID}`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  ws.onmessage = e => {
    if (typeof e.data !== 'string') return livePreview(e.data);
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    const d = msg.data || {}, run = S.byId[d.prompt_id];
    switch (msg.type) {
      case 'status': $('#queueInfo').textContent = `queue: ${d.status?.exec_info?.queue_remaining ?? 0}`; break;
      case 'execution_start': if (run) { run.status = 'running'; run.tStart = Date.now(); S.active = run.id; renderGallery(); } setRunbar(); break;
      case 'executing': if (run && d.node) { S.node = run.graph?.[d.node]?.class_type || d.node; S.prog = null; setRunbar(); } break;
      case 'progress': if (run) { S.prog = [d.value, d.max]; setRunbar(); } break;
      case 'executed': if (run) { collect(run, d.output); renderGallery(); } break;
      case 'execution_success': finish(run, 'done'); break;
      case 'execution_error': finish(run, 'error', `${d.node_type || ''}: ${d.exception_message || 'error'}`.trim()); break;
      case 'execution_interrupted': finish(run, 'error', 'Interrupted'); break;
    }
  };
  ws.onclose = () => { S.ws = null; setTimeout(connectWS, 2000); };
}
function livePreview(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== 1) return;
  const type = dv.getUint32(4) === 2 ? 'image/png' : 'image/jpeg';
  const url = URL.createObjectURL(new Blob([buf.slice(8)], { type }));
  let im = $('#livePrev');
  if (!im) { im = document.createElement('img'); im.id = 'livePrev'; im.style.cssText = 'width:100%;border-radius:8px;margin-top:8px'; $('.runbar').append(im); }
  if (im.dataset.url) URL.revokeObjectURL(im.dataset.url);
  im.src = url; im.dataset.url = url;
}
async function pollPending() {      // backstop when websocket messages were missed
  for (const run of S.runs.filter(r => r.status === 'queued' || r.status === 'running')) {
    try {
      const h = (await api('history/' + run.id))[run.id];
      if (!h) continue;
      Object.values(h.outputs || {}).forEach(o => collect(run, o));
      if (h.status?.completed || h.status?.status_str === 'success') finish(run, 'done');
      else if (h.status?.status_str === 'error') {
        const m = (h.status.messages || []).find(x => x[0] === 'execution_error');
        finish(run, 'error', m ? `${m[1].node_type}: ${m[1].exception_message}` : 'error');
      }
    } catch { /* offline */ }
  }
}
function setRunbar() {
  const run = S.byId[S.active];
  const pending = S.runs.filter(r => r.status === 'queued').length;
  $('#runTitle').textContent = run ? `Running ${run.mode === 'video' ? 'video' : 'image'} · seed ${run.seed}` : pending ? `${pending} waiting` : 'Idle';
  const pct = run && S.prog ? (100 * S.prog[0] / S.prog[1]) : 0;
  $('#barFill').style.width = pct + '%';
  $('#runNode').textContent = run ? `${S.node || ''}${S.prog ? ` · ${S.prog[0]}/${S.prog[1]}` : ''} · ${((Date.now() - (run.tStart || run.t0)) / 1000).toFixed(0)} s` : '';
  $('#conn').className = 'dot ' + (S.online ? (run ? 'busy' : 'on') : 'off');
  if (!run) $('#livePrev')?.remove();
}

/* ───────── gallery ───────── */
function renderGallery() {
  const host = $('#gallery'); host.innerHTML = '';
  for (const run of S.runs.slice(0, 60)) {
    const c = document.createElement('div');
    const head = `<b>${{ t2i: 'Text → Image', i2i: 'Image → Image', multi: 'Multi-image', video: 'Video' }[run.mode]}</b>${run.vmode ? ` · ${run.vmode}` : ''} · seed ${run.seed}`;
    if (run.status === 'queued' || run.status === 'running') {
      c.className = 'card pending'; c.innerHTML = `${head}<br>${run.status}… <span class="muted">${esc(run.summary)}</span>`;
      host.append(c); continue;
    }
    c.className = 'card' + (run.status === 'error' ? ' failed' : '');
    const media = run.outputs.map((o, i) => o.kind === 'video'
      ? `<video src="${viewUrl(o)}" controls loop playsinline data-i="${i}"></video>`
      : `<img src="${viewUrl(o)}" loading="lazy" data-i="${i}" alt="">`).join('');
    const secs = run.t1 ? ` · ${((run.t1 - (run.tStart || run.t0)) / 1000).toFixed(0)} s` : '';
    c.innerHTML = `${media}${run.status === 'error' ? `<div class="errtxt">${esc(run.error)}</div>` : ''}
      <div class="meta">${head}${secs}<p class="muted" title="${esc(run.prompt)}">${esc(run.prompt)}</p>
      <div class="muted">${esc(run.summary)}${run.loras?.length ? ' · ' + esc(run.loras.join(', ')) : ''}</div></div>
      <div class="acts"></div>`;
    const acts = $('.acts', c);
    const act = (label, fn, title) => { const b = document.createElement('button'); b.textContent = label; if (title) b.title = title; b.onclick = fn; acts.append(b); };
    const o = run.outputs[0];
    if (o?.kind === 'image') {
      const asset = { filename: o.filename, subfolder: o.subfolder, type: o.type, kind: 'image' };
      act('→ Edit', () => sendTo('i2i', asset), 'Use as Picture 1 in Image → Image');
      act('+ Ref', () => sendTo('multi', asset), 'Add to Multi-image pictures');
      act('→ First frame', () => sendTo('first', asset));
      act('→ Last frame', () => sendTo('last', asset));
      $$('img', c).forEach(im => { im.draggable = true; im.ondragstart = e => e.dataTransfer.setData('application/x-h3asset', JSON.stringify(asset)); });
    }
    if (run.restore) act('↺ Settings', () => restore(run), 'Restore every setting of this run');
    act('Seed', () => { setVal('seed', run.seed); persistForm(); });
    if (run.info) act('Info', () => modal(`<pre>${esc(run.info)}</pre>`));
    if (o) { const a = document.createElement('a'); a.href = viewUrl(o); a.download = o.filename; a.textContent = 'Download'; acts.append(a); }
    act('✕', () => { S.runs = S.runs.filter(r => r !== run); saveRuns(); renderGallery(); }, 'Remove from list (file stays on disk)');
    $$('img', c).forEach(im => im.onclick = () => modal(`<img src="${im.src}"><p class="muted small">${esc(run.prompt)}</p>`));
    host.append(c);
  }
  if (!S.runs.length) host.innerHTML = '<p class="muted">Results appear here. Ctrl+Enter generates.</p>';
}
function sendTo(key, asset) {
  measure(asset).then(a => {
    if (key === 'multi') S.lists.multi.length < 9 && S.lists.multi.push(a); else S.lists[key] = [a];
    const target = { i2i: 'i2i', multi: 'multi', first: 'video', last: 'video' }[key];
    if (S.mode !== target) setMode(target);
    if (key === 'first' && radio('vmode') !== 'firstlast') $('input[name=vmode][value=first]').checked = true;
    if (key === 'last') $('input[name=vmode][value=firstlast]').checked = true;
    changed(); persistForm();
  });
}
function restore(run) {
  const r = run.restore;
  persistForm();
  S.mode = r.mode; save('mode', r.mode);
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === r.mode));
  fillModeOptions();
  applySnap(r.form);
  S.lists = JSON.parse(JSON.stringify(r.lists)); S.guides = JSON.parse(JSON.stringify(r.guides || []));
  setVal('seed', run.seed);
  renderLoras(); changed(); persistForm();
}
function modal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }

/* ───────── connection ───────── */
async function heartbeat() {
  try {
    const st = await api('system_stats');
    const was = S.online; S.online = true;
    const d = st.devices?.[0];
    $('#vram').textContent = d ? `${d.name.replace(/^cuda:\d+\s*/, '').split(':')[0]} · VRAM ${(d.vram_free / 2 ** 30).toFixed(1)}/${(d.vram_total / 2 ** 30).toFixed(1)} GB free` : '';
    $('#connText').textContent = 'ComfyUI ' + (st.system?.comfyui_version || 'online');
    $('#startComfy').classList.add('hidden');
    if (!was) { await loadInfo(); applySnap(load('form.' + S.mode, null)); renderLoras(); refresh(); pollPending(); }
  } catch {
    S.online = false;
    $('#connText').textContent = 'ComfyUI offline'; $('#vram').textContent = '';
    $('#startComfy').classList.remove('hidden');
  }
  setRunbar();
}

/* ───────── wiring ───────── */
function init() {
  S.runs = load('runs', []).map(r => (r.status === 'queued' || r.status === 'running') ? r : r);
  S.runs.forEach(r => { S.byId[r.id] = r; });
  const as = load('assets', null);
  if (as) { Object.assign(S.lists, as.lists); S.guides = as.guides || []; }
  S.mode = load('mode', 't2i');
  $$('#tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  const d = DEFAULTS[group(S.mode)];
  setVal('steps', d.steps); setVal('prefix', d.prefix);
  applySnap(load('form.' + S.mode, null));

  $('#form').addEventListener('input', e => {
    if (e.target.id === 'vWidth' || e.target.id === 'vHeight') setVal('vAspect', 'custom');
    if (e.target.matches('[data-persist]')) persistForm();
    if (e.target.name === 'vmode' || e.target.id === 'refVidAudio') changed(); else refresh();
  });
  $('#form').addEventListener('change', e => { if (e.target.matches('select[data-persist]')) { persistForm(); refresh(); } });
  $('#tagChips').onclick = e => { const t = e.target.dataset.tag; if (t) insertAtCursor(t); };
  $$('.presets [data-mp]').forEach(b => b.onclick = () => { setVal('mp', b.dataset.mp); persistForm(); refresh(); });
  $('#dice').onclick = () => { setVal('seed', randSeed()); persistForm(); };
  $('#addLora').onclick = () => { S.loras.push({ name: turboLora() || 'None', strength: S.mode === 'video' ? 1 : 0.38 }); renderLoras(); persistForm(); };
  $('#addGuideImg').onclick = () => { S.guides.push({ kind: 'image', asset: null, frame: 0 }); changed(); };
  $('#addGuideAud').onclick = () => { S.guides.push({ kind: 'audio', asset: null, frame: 0 }); changed(); };
  $('#go').onclick = generate;
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
  document.addEventListener('paste', async e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    const key = { i2i: 'i2i', multi: 'multi' }[S.mode] || (S.mode === 'video' && radio('vmode') === 'ref' ? 'refImg' : S.mode === 'video' && radio('vmode') !== 't2v' ? 'first' : null);
    if (key) { e.preventDefault(); addFiles(key, files); }
  });
  $('#showApi').onclick = () => {
    const errs = check().filter(x => !/prompt/i.test(x));
    if (errs.length) return showErr(errs.join('\n'));
    const json = JSON.stringify(build(+val('seed') || 0), null, 2);
    modal(`<div class="row between"><b>ComfyUI API prompt</b><span class="row"><button class="ghost" id="cpy">Copy</button>
      <a class="ghost" download="h3_${S.mode}_api.json" href="data:application/json,${encodeURIComponent(json)}">Download</a></span></div>
      <textarea readonly>${esc(json)}</textarea>`);
    $('#cpy').onclick = () => navigator.clipboard.writeText(json);
  };
  $('#interrupt').onclick = () => post('interrupt', {}).catch(e => showErr(e.message));
  $('#clearQueue').onclick = async () => {
    await post('queue', { clear: true }).catch(e => showErr(e.message));
    S.runs.filter(r => r.status === 'queued').forEach(r => finish(r, 'error', 'Removed from queue'));
  };
  $('#freeMem').onclick = () => post('free', { unload_models: true, free_memory: true }).then(heartbeat).catch(e => showErr(e.message));
  $('#startComfy').onclick = async () => {
    $('#startComfy').textContent = 'Starting…';
    await fetch('/api/start-comfy', { method: 'POST' });
    const t = setInterval(async () => { await heartbeat(); if (S.online) { clearInterval(t); $('#startComfy').textContent = 'Start ComfyUI'; } }, 3000);
  };
  $('#clearGallery').onclick = () => { S.runs = S.runs.filter(r => r.status === 'queued' || r.status === 'running'); saveRuns(); renderGallery(); };
  $('#modalClose').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };

  renderLoras(); changed(); renderGallery();
  connectWS(); heartbeat();
  setInterval(heartbeat, 5000);
  setInterval(() => { if (!S.ws || S.ws.readyState !== 1) pollPending(); setRunbar(); }, 3000);
}
init();
