/* H3 Studio: browser side. Builds ComfyUI API graphs for MiniMax H3 (Image Studio nodes for stills,
   native MiniMax H3 nodes for video), queues them through the /comfy proxy and tracks progress over the
   websocket. Form state, uploaded inputs and results persist in localStorage. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const CID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const LS = 'h3studio.';  // localStorage prefix
const MB = 1024 * 1024;
const IMG_MODES = ['t2i', 'i2i', 'multi'];
const DEFAULTS = {
  img: { steps: 50, sampler: 'er_sde', scheduler: 'simple', prefix: 'h3studio/img' },
  video: { steps: 20, sampler: 'res_multistep', scheduler: 'simple', prefix: 'video/h3studio' },
};
const NODES = ['H3StudioModels', 'H3StudioEdit', 'H3StudioGenerate', 'H3StudioRender', 'UNETLoader', 'UnetLoaderGGUF',
  'CLIPLoader', 'VAELoader', 'KSamplerSelect', 'BasicScheduler', 'LoraLoaderModelOnly', 'MiniMaxH3ReferenceToVideo', 'KSampler'];
const IMG_CKPT = 'minimax_h3_image_pruned_int8_convrot.safetensors';
const officialImage = () => /h3_image/i.test(val('model'));

const S = {
  mode: 't2i', info: {}, online: false, runs: [], byId: {}, ws: null, active: null,
  loras: [], bld: null, promptSource: 'raw',
  lists: { i2i: [], multi: [], first: [], last: [], refImg: [], refVid: [], refAud: [] },
  guides: [],
  sel: new Set(), gFilter: 'all', gQ: '', gShown: [],
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
const icon = (n, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const fmtS = s => !isFinite(s) || s < 0 ? '—' : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`;
const short = (name, n = 28) => { const s = String(name || '').replace(/\.(safetensors|gguf)$/i, '').replace(/^minimax_h3_/i, ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

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
    const unet = opts('UNETLoader', 'unet_name').filter(n => /h3|fl2va|minimax/i.test(n));
    const gguf = opts('UnetLoaderGGUF', 'unet_name').filter(n => /h3/i.test(n));
    fill('model', [...unet, ...gguf], unet.includes(IMG_CKPT) ? IMG_CKPT : 'minimax_h3_fl2va_pruned_int8_convrot.safetensors');
    fill('te', opts('CLIPLoader', 'clip_name').filter(n => /minimax|qwen3vl/i.test(n)));
    const vaes = opts('VAELoader', 'vae_name');
    const off = unet.includes(val('model')) && /h3_image/i.test(val('model'));
    fill('vae', off ? vaes.filter(n => /minimax_h3_image_vae/i.test(n)) : vaes.filter(n => /minimax_h3_video_vae/i.test(n)),
      off ? 'minimax_h3_image_vae_fp16.safetensors' : 'minimax_h3_video_vae_fp16.safetensors');
    fill('avae', vaes.filter(n => /minimax_h3_audio_vae/i.test(n)));
    if (off && +val('steps') === 50 && val('sampler') === 'er_sde') { setVal('steps', 6); setVal('sampler', 'euler'); setVal('scheduler', 'simple'); }
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
  $$('#tabs button').forEach(b => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
  S.sel.clear(); updateBulk();
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
  renderBuilder();
  syncBandSummaries();
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

/* ───────── prompt builder ─────────
   Assembles the fields above into one detailed English paragraph following the official
   h3-image-prompt-writing guides (docs/prompt-guide-*.md): T2I writes purpose → subject →
   layout → quoted lettering → light/material → exclusions; editing follows the reference protocol
   <Picture N> definitions → "The target image …" → per-subject relationships → changed details. */
const BLD_TYPES = [
  ['photo', 'Photo', 'A naturalistic photograph of '], ['cinematic', 'Cinematic', 'A cinematic still of '],
  ['illustration', 'Illustration', 'An illustration of '], ['painting', 'Painting', 'A painting of '],
  ['poster', 'Poster', 'A poster design: '], ['infographic', 'Infographic', 'An infographic: '],
  ['ui', 'UI screen', 'A UI screen showing '], ['product', 'Product shot', 'A product shot of '],
  ['logo', 'Logo / mark', 'A logo mark: '], ['grid', 'Grid / storyboard', 'A grid of panels: '], ['free', 'Free text', ''],
];
const BLD_RATIOS = ['1:1', '5:4', '4:3', '3:2', '16:9', '21:9', '4:5', '3:4', '2:3', '9:16'];
const BLD_RELS = { full: 'fully preserved', partial: 'partially preserved', transfer: 'exact property transfer', weak: 'weak reference' };
const BLD_REL_HINT = {
  full: '', partial: 'its shape, position and scale remain while its colour changes',
  transfer: 'body colour transferred to <Subject 1>', weak: 'style reference for the new background, with freely adapted forms',
};
const BLD_REL_TIP = {
  full: 'Nothing about it changes.',
  partial: 'Part of it stays. Describe what changes in Detail.',
  transfer: 'Borrows one exact property (colour, material) from this reference.',
  weak: 'Loose inspiration; the target may adapt freely.',
};
const BLD_QUICK = [   // appended to a partial-preservation detail; edits to lock a person's identity
  'face, facial features, hairstyle and skin tone remain exactly as in the source',
  'body proportions and apparent age remain',
  'clothing changes', 'pose, gaze and expression change', 'the background remains unchanged',
];
const BLD_TEXT_FIELDS = { 'b-subject': 'subject', 'b-layout': 'layout', 'b-light': 'light', 'b-exclude': 'exclude', 'b-target': 'target', 'b-changes': 'changes' };
const BLD_EXAMPLES = {
  t2i: [
    { label: 'Potter · photograph', type: 'photo', ratio: '', noText: true, texts: [], exclude: 'lettering or additional people',
      subject: 'a woman potter seated at a pottery wheel in a sunlit workshop, viewed from her left side at approximately hand level; she leans slightly forward with relaxed shoulders and looks down at the clay, her left hand supporting the bowl’s outer wall while the fingertips of her right hand shape the inner surface near the rim',
      layout: 'a medium composition includes her profile, shoulders, forearms, hands and the complete bowl on the wheel, with enough of the wheel and stool visible to make her working posture clear; a worn wooden workbench and quiet shelves recede out of focus, keeping attention on the hands',
      light: 'soft sunlight enters from a side window, catching the moisture on the clay and casting gentle shadows beneath her wrists; wet slip coats her fingertips and gathers in fine concentric ridges on the rounded bowl; warm earth tones, believable skin texture and subtle workshop wear give the scene a tactile, unposed quality' },
    { label: 'Sales dashboard · infographic', type: 'infographic', ratio: '16:9', noText: false, texts: [], exclude: 'invented dates, forecasts, percentage changes or additional data series',
      subject: 'a clean sales dashboard on a warm white background in a restrained charcoal-and-teal palette with crisp sans-serif typography and a consistent alignment grid, titled “Quarterly sales”, summarizing products A, B and C with 12, 18 and 9 units',
      layout: 'the title “Quarterly sales” sits at the upper left; two compact summary cards occupy the top row beneath it — “Total units” with the value “39” and “Best-performing product” with “B — 18 units”; the lower left contains a large vertical bar chart whose horizontal axis is labeled “Product” with categories “A”, “B” and “C” in that order and whose vertical axis is labeled “Units” with evenly spaced ticks at 0, 5, 10, 15 and 20, all bars sharing one zero baseline and equal widths, heights corresponding exactly to 12, 18 and 9 with each value printed above its bar, product B teal while A and C share a muted gray, thin horizontal gridlines aiding the scale; the lower right holds a compact table with column headings “Product” and “Units” and rows “A | 12”, “B | 18” and “C | 9”, its B row carrying a subtle teal accent matching the highlighted bar; balanced spacing separates cards, chart and table',
      light: '' },
  ],
  edit: [
    { label: 'Blue cup · local colour edit', target: 'shows <Subject 1> with a blue finish',
      subs: [{ what: 'red cup on the left', rel: 'partial', detail: 'its shape, material, position and scale remain while its surface colour changes' },
             { what: 'lemon on the right', rel: 'full', detail: '' }],
      changes: 'the blue finish follows the existing surface shading and highlights of <Subject 1>, with the rest of the source image unchanged', texts: [] },
    { label: 'Fashion poster · property transfer', target: 'is a portrait fashion poster featuring <Subject 1> beneath a short headline',
      subs: [{ what: 'front-facing beige coat', rel: 'partial', detail: 'its cut, fabric texture, folds and front-facing presentation remain while its colour, scale and placement change' },
             { what: 'body colour of the vase', rel: 'transfer', detail: 'body colour transferred to <Subject 1>' }],
      changes: '<Subject 1> is centred in the lower two-thirds of the poster with its full hem and sleeves visible; a new warm off-white background extends evenly to the edges, leaving generous space around the garment',
      texts: [{ text: 'A quieter kind\nof bold.', where: 'above the coat in large charcoal serif lettering, on two centered lines' }] },
    { label: 'Café portrait · identity locked', target: 'shows the same woman seated at the café table, turning her head slightly toward the window with a calm, faint smile',
      subs: [{ what: 'woman in the denim jacket at the centre', rel: 'partial',
        detail: 'her face, facial features, hairstyle, skin tone and apparent age remain exactly as in <Picture 1>, while her clothing, pose and expression change' }],
      changes: 'she now wears a rust-coloured chunky knit sweater with visible stitching and sleeves pushed to the wrists, hands loosely wrapped around a white ceramic cup; her shoulders angle three-quarters toward the window with her weight settled into the chair and forearms resting on the table; the corners of her lips lift slightly and her eyes soften toward the light; the blurred café interior and warm side lighting of <Picture 1> continue unchanged',
      texts: [] },
  ],
};
const bldBlank = kind => kind === 't2i'
  ? { type: 'photo', subject: '', layout: '', light: '', exclude: '', noText: false, texts: [], ratio: '' }
  : { subs: [], target: '', changes: '', texts: [] };
const bldVariant = () => S.mode === 't2i' ? 't2i' : IMG_MODES.includes(S.mode) ? 'edit' : null;
const bldState = () => S.bld[S.mode] || (S.bld[S.mode] = bldBlank(bldVariant()));
const saveBld = () => save('builder', S.bld);
const bq = s => `"${String(s).trim()}"`;
const bLower = s => /^A[n]? |^The /.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
const bDot = s => /[.!?]$/.test(s.trim()) ? s.trim() : s.trim() + '.';
const bSent = s => { s = bDot(s); return s.charAt(0).toUpperCase() + s.slice(1); };

function bldTextSentences(list) {
  const out = [];
  for (const t of list || []) {
    const lines = String(t.text || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    const where = String(t.where || '').trim() || 'in the image';
    out.push(lines.length === 1 ? `The text ${bq(lines[0])} appears ${where}.`
      : `The text appears ${where}, arranged on ${lines.length} lines: ${lines.map(bq).join(', then ')}.`);
  }
  return out;
}
function assemblePrompt() {
  const b = bldState(), parts = [];
  if (bldVariant() === 't2i') {
    const t = BLD_TYPES.find(x => x[0] === b.type) || BLD_TYPES[0], subj = (b.subject || '').trim();
    if (subj) parts.push(bSent(b.type === 'free' ? subj : t[2] + bLower(subj)));
    if ((b.layout || '').trim()) parts.push(bSent(b.layout));
    parts.push(...bldTextSentences(b.texts));
    if (b.noText) parts.push('No lettering or text appears.');
    if ((b.light || '').trim()) parts.push(bSent(b.light));
    const ex = (b.exclude || '').trim().replace(/^no\s+/i, '');
    if (ex) parts.push(`No ${ex} appear.`);
  } else {
    const pics = S.lists[S.mode] || [];
    const subs = (b.subs || []).map((s, i) => ({ ...s, i }))
      .filter(s => (s.what || '').trim() && (!pics.length || s.i < pics.length));
    subs.forEach(s => {
      const w = (s.what || '').trim();
      parts.push(/<Picture/i.test(w) ? bDot(`${w.charAt(0).toUpperCase() + w.slice(1)} is <Subject ${s.i + 1}>`)   // free text citing pictures itself
        : `The ${w.replace(/^(the|a|an)\s+/i, '')} in <Picture ${s.i + 1}> is <Subject ${s.i + 1}>.`);
    });
    const tg = (b.target || '').trim();
    if (tg) parts.push(bSent(/^the target image\b/i.test(tg) ? tg : 'The target image ' + bLower(tg)));
    subs.forEach(s => {
      const d = (s.detail || '').trim(), n = `<Subject ${s.i + 1}>`;
      if (s.rel === 'full') parts.push(`${n} is fully preserved.`);
      else if (s.rel === 'partial') parts.push(`${n} is partially preserved; ${bDot(d || 'the requested changes are applied')}`);
      else if (s.rel === 'transfer') parts.push(`${n} supplies the exact ${bDot(d || 'property the target asks for')}`);
      else parts.push(`${n} serves as a weak ${bDot(d || 'reference for the target, with freely adapted forms')}`);
    });
    if ((b.changes || '').trim()) parts.push(bSent(b.changes));
    parts.push(...bldTextSentences(b.texts));
  }
  return parts.join(' ');
}

function renderBuilder() {
  const host = $('#builder'), v = bldVariant();
  if (!host) return;
  if (!v) { host.classList.add('hidden'); return; }
  $$('#bldBody [data-bld]').forEach(el => el.classList.toggle('hidden', el.dataset.bld !== v));
  const b = bldState();
  for (const [id, key] of Object.entries(BLD_TEXT_FIELDS)) {
    const el = document.getElementById(id), v = b[key] ?? '';
    if (el && el.value !== v) el.value = v;   // don't reset the caret when re-rendering mid-typing
  }
  setVal('b-noText', !!b.noText); setVal('b-syncRatio', S.bld.syncRatio !== false);
  if (S.bld.open !== undefined && host.open !== S.bld.open) host.open = S.bld.open;
  if (v === 't2i') {
    renderBChips('bType', BLD_TYPES.map(t => [t[0], t[1]]), b.type, x => { b.type = x; saveBld(); renderBuilder(); });
    renderBChips('bRatio', BLD_RATIOS.map(r => [r, r]), b.ratio || '',
      x => { b.ratio = b.ratio === x ? '' : x; saveBld(); renderBuilder(); });
    const t = BLD_TYPES.find(x => x[0] === b.type) || BLD_TYPES[0];
    $('#bOpenPreview').textContent = t[2] ? `Opening line: “${t[2]}…”` : 'Free text. The Subject field is used exactly as written.';
  } else renderBSubs(b);
  renderBTexts(b);
  renderBExample();
  updateBldOut();
}
function renderBChips(hostId, pairs, cur, onPick) {
  const host = document.getElementById(hostId);
  host.innerHTML = '';
  pairs.forEach(([value, label]) => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label;
    btn.classList.toggle('on', value === cur);
    btn.onclick = () => onPick(value);
    host.append(btn);
  });
}
function renderBExample() {
  const sel = $('#bExample'), list = BLD_EXAMPLES[bldVariant()] || [];
  sel.innerHTML = '<option value="">Load example…</option>'
    + list.map((x, i) => `<option value="${i}">${esc(x.label || 'Example ' + (i + 1))}</option>`).join('');
}
function renderBSubs(b) {
  const host = $('#bSubjects'), pics = S.lists[S.mode] || [];
  while (b.subs.length < pics.length) b.subs.push({ what: '', rel: 'full', detail: '' });
  host.innerHTML = '';
  if (!pics.length) { host.innerHTML = '<p class="muted small">Add Pictures above. Each slot gets a definition sentence once you name what it contributes.</p>'; return; }
  pics.forEach((pic, i) => {
    const s = b.subs[i] || (b.subs[i] = { what: '', rel: 'full', detail: '' });
    const card = document.createElement('div'); card.className = 'bcard';
    card.innerHTML = `<div class="bcardhead">
        ${pic.kind === 'image' ? `<img class="bthumb" src="${viewUrl(pic)}" alt="">` : ''}
        <span class="tag">&lt;Picture ${i + 1}&gt;</span>
        <span class="muted small bpicname" title="${esc(pic.filename)}">${esc(pic.filename)}</span></div>
      <label>What it is <small class="muted">free text may cite pictures, e.g. “The woman in &lt;Picture 1&gt; and the close-up in &lt;Picture 2&gt;”</small>
        <input class="bwhat" type="text" placeholder="the red cup on the left" value="${esc(s.what)}"></label>
      <div class="seg brel">${Object.entries(BLD_RELS).map(([k, l]) =>
        `<label title="${esc(BLD_REL_TIP[k])}"><input type="radio" name="brel${i}" value="${k}" ${s.rel === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <label class="bdet">Detail <small class="muted">what stays and what changes</small>
        <input type="text" placeholder="${esc(BLD_REL_HINT[s.rel])}" value="${esc(s.detail)}"></label>
      <div class="presets bquick"></div>`;
    const what = $('.bwhat', card), det = $('.bdet input', card), quick = $('.bquick', card);
    const syncDetail = () => { card.querySelector('.bdet').classList.toggle('hidden', s.rel === 'full'); quick.classList.toggle('hidden', s.rel !== 'partial'); };
    syncDetail();
    BLD_QUICK.forEach(snip => {
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = snip;
      btn.onclick = () => { s.detail = s.detail.trim() ? `${s.detail.replace(/[,\s]*$/, '')}, ${snip}` : snip; det.value = s.detail; saveBld(); updateBldOut(); };
      quick.append(btn);
    });
    what.oninput = () => { s.what = what.value; saveBld(); updateBldOut(); };
    det.oninput = () => { s.detail = det.value; saveBld(); updateBldOut(); };
    $$('input[type=radio]', card).forEach(r => r.onchange = () => {
      s.rel = r.value; det.placeholder = BLD_REL_HINT[s.rel]; syncDetail(); saveBld(); updateBldOut();
    });
    host.append(card);
  });
}
function renderBTexts(b) {
  const t2i = $('#bTextsT2i'), edit = $('#bTextsEdit');
  t2i.innerHTML = ''; edit.innerHTML = '';
  const host = bldVariant() === 't2i' ? t2i : edit;
  (b.texts || []).forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'brow';
    row.innerHTML = `<label>Text <small class="muted">one line per visual line</small><textarea rows="2" placeholder="MONEY TALKS">${esc(t.text)}</textarea></label>
      <label>Placement<input type="text" placeholder="above the sign, in large serif capitals" value="${esc(t.where)}"></label>
      <button type="button" class="ghost" title="Remove" aria-label="Remove">${icon('x')}</button>`;
    const [ta, where] = [$('textarea', row), $('input[type=text]', row)];
    ta.oninput = () => { t.text = ta.value; saveBld(); updateBldOut(); };
    where.oninput = () => { t.where = where.value; saveBld(); updateBldOut(); };
    $('button', row).onclick = () => { b.texts.splice(i, 1); saveBld(); renderBuilder(); };
    host.append(row);
  });
}
function updateBldOut() {
  if (!bldVariant()) return;
  const b = bldState(), txt = assemblePrompt();
  $('#bOut').textContent = txt || 'Fill the steps. The assembled paragraph appears here, in the official order.';
  $('#bOut').classList.toggle('muted', !txt);
  const est = Math.round(txt.length / 4);
  $('#bCount').textContent = txt ? `≈ ${est} of 4096 tokens` : '';
  $('#bCount').classList.toggle('warn', est > 3500);
  const bud = $('#bBudget');
  if (bud) {
    $('#bBudgetFill').style.width = Math.min(100, est / 4096 * 100) + '%';
    bud.classList.toggle('warn', est > 3500 && est <= 4096);
    bud.classList.toggle('over', est > 4096);
  }
  markBSteps(b);
  renderBTokChips();
  const filled = bldVariant() === 't2i'
    ? [b.subject, b.layout, b.light, b.exclude, b.noText || (b.texts || []).some(t => (t.text || '').trim()), b.ratio].filter(Boolean).length
    : [b.target, b.changes, (b.texts || []).some(t => (t.text || '').trim()), (b.subs || []).some(s => (s.what || '').trim())].filter(Boolean).length;
  $('#bldSummary').textContent = txt ? `${filled} step${filled === 1 ? '' : 's'} filled · ≈${est} tokens` : 'step by step · official H3-Image guide';
}
/* per-step completion: number chip turns into a green check as each step gets filled */
function markBSteps(b) {
  const v = bldVariant();
  const any = xs => xs.some(x => (x || '').trim());
  const filled = v === 't2i'
    ? [b.type, any([b.subject]), any([b.layout]), (b.texts || []).some(t => (t.text || '').trim()), any([b.light]),
       any([b.exclude]) || b.ratio || !!b.noText]
    : [(b.subs || []).some(s => (s.what || '').trim()), any([b.target]), any([b.changes]), (b.texts || []).some(t => (t.text || '').trim())];
  $$('#bldBody [data-step]').forEach(el =>
    el.classList.toggle('done', !el.classList.contains('hidden') && !!filled[+el.dataset.step - 1]));
}
/* one-click reference tags for the edit steps: inserts at the caret of the last focused field */
let bLastField = null;
document.addEventListener('focusin', e => { if (e.target.matches('#bldBody textarea, #bldBody input[type=text]')) bLastField = e.target; });
function renderBTokChips() {
  const row = $('#bTokRow'); if (!row) return;
  const v = bldVariant();
  const tags = v === 'edit'
    ? [...(S.lists[S.mode] || []).map((_, i) => `<Picture ${i + 1}>`),
       ...(bldState().subs || []).map((s, i) => `<Subject ${i + 1}>`), '<Video 1>', '<Audio 1>']
    : [];
  row.classList.toggle('hidden', !tags.length);
  if (row.dataset.tags === tags.join(',')) return;   // no rebuild while typing: keeps focus safe
  row.dataset.tags = tags.join(',');
  row.innerHTML = '';
  tags.forEach(t => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = t;
    btn.onclick = () => insertTag(t);
    row.append(btn);
  });
}
function insertTag(t) {
  const el = bLastField && document.contains(bLastField) ? bLastField : $('#b-target');
  if (!el) return;
  const i0 = el.selectionStart ?? el.value.length, i1 = el.selectionEnd ?? i0;
  el.value = el.value.slice(0, i0) + t + el.value.slice(i1);
  el.focus();
  el.selectionStart = el.selectionEnd = i0 + t.length;
  syncBldField(el);
}
/* shared input pipeline for builder fields: state → save → live output */
function syncBldField(el) {
  const b = bldState();
  if (el.id && BLD_TEXT_FIELDS[el.id]) b[BLD_TEXT_FIELDS[el.id]] = el.value;
  else if (el.classList.contains('bwhat')) {
    const s = $$('#bSubjects .bcard').indexOf(el.closest('.bcard')); if (s >= 0) b.subs[s].what = el.value;
  } else if (el.closest('.brow')) {
    const row = el.closest('.brow'), i = [...$('#bTextsT2i').children, ...$('#bTextsEdit').children].indexOf(row);
    const t = bldState().texts[i]; if (t) { if (el.tagName === 'TEXTAREA') t.text = el.value; else t.where = el.value; }
  } else if (el.closest('.bdet')) {
    const s = $$('#bSubjects .bcard').indexOf(el.closest('.bcard')); if (s >= 0) b.subs[s].detail = el.value;
  }
  saveBld(); updateBldOut();
}
function applyBld(append) {
  const txt = assemblePrompt();
  if (!txt.trim()) return showErr('The builder has nothing to assemble yet: fill at least step 2 (Subject) or step 1 (References).');
  const ta = $('#prompt');
  ta.value = append && ta.value.trim() ? `${ta.value.trimEnd()} ${txt}` : txt;
  S.promptSource = 'builder';
  const b = bldState();
  if (!append && bldVariant() === 't2i' && b.ratio && val('b-syncRatio')) {
    const opt = [...$('#aspect').options].find(o => o.value.startsWith(b.ratio));
    if (opt) setVal('aspect', opt.value);
  }
  persistForm(); refresh();
  ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
  ta.classList.remove('flash'); void ta.offsetWidth; ta.classList.add('flash');
  setTimeout(() => ta.classList.remove('flash'), 1100);
  toast('ok', append ? 'Builder draft appended' : 'Prompt replaced', `${txt.length} characters · from the builder steps`);
}
function bldExample(idx) {
  const set = BLD_EXAMPLES[bldVariant()] || [], ex = set[+idx];
  $('#bExample').value = '';
  if (!ex) return;
  S.bld[S.mode] = Object.assign(bldBlank(bldVariant()), JSON.parse(JSON.stringify(ex)));
  saveBld(); renderBuilder();
  toast('info', `Example loaded: ${ex.label || 'Example'}`, 'Nothing was overwritten. Press Replace prompt to use it.');
}
async function bldGuide() {
  const kind = bldVariant() === 't2i' ? 't2i' : 'edit';
  try {
    const r = await fetch(`/docs/prompt-guide-${kind}.md`);
    if (!r.ok) throw new Error();
    modal(`<b>Official MiniMax H3-Image ${kind === 't2i' ? 'text-to-image' : 'image-edit'} prompt writing guide</b><pre>${esc(await r.text())}</pre>`);
  } catch { showErr('Guide file missing: docs/prompt-guide-' + kind + '.md'); }
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
    officialImage() && ['H3-Image official · 6 steps CFG1', () => { S.loras = []; setVal('steps', 6); setVal('sampler', 'euler'); setVal('scheduler', 'simple'); }],
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
      <button type="button" class="ghost" title="Remove" aria-label="Remove">${icon('x')}</button>`;
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
  d.innerHTML = `<div class="thumb-wrap">${mediaEl(a)}<button type="button" class="x" title="Remove" aria-label="Remove" draggable="false">${icon('x')}</button></div><div class="cap"><code>${esc(tag || '')}</code><span class="muted">${dims}</span></div>`;
  d.title = a.filename;
  $('.x', d).onclick = e => { e.stopPropagation(); onRemove(); };
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
    const x = document.createElement('button'); x.type = 'button'; x.className = 'ghost'; x.innerHTML = icon('x');
    x.title = 'Remove guide'; x.setAttribute('aria-label', 'Remove guide');
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
  if (officialImage()) return buildOfficialImage(g, seed);
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

/* Official standalone MiniMax-H3-Image checkpoint: core nodes, CFG 1, no video VAE. */
function buildOfficialImage(g, seed) {
  const m = S.mode;
  let model = g.add('UNETLoader', { unet_name: val('model'), weight_dtype: 'default' });
  for (const l of S.loras) if (l.name !== 'None' && +l.strength !== 0)
    model = g.add('LoraLoaderModelOnly', { model: L(model), lora_name: l.name, strength_model: +l.strength });
  const clip = g.add('CLIPLoader', { clip_name: val('te'), type: 'minimax', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: val('vae') });
  const c = imgCanvas() || [r32(Math.sqrt(+val('mp') * MB)), r32(Math.sqrt(+val('mp') * MB))];
  const inputs = { clip: L(clip), vae: L(vae), prompt: val('prompt'), width: c[0], height: c[1] };
  if (m !== 't2i') {
    const pics = m === 'i2i' ? S.lists.i2i : S.lists.multi;
    pics.forEach((a, i) => { inputs[`images.image_${i + 1}`] = L(g.add('LoadImage', { image: loaderName(a) })); });
  }
  const cond = g.add('MiniMaxH3ImageConditioning', inputs);
  const neg = g.add('ConditioningZeroOut', { conditioning: L(cond, 0) });
  const ksam = opts('KSampler', 'sampler_name');
  const ks = g.add('KSampler', {
    model: L(model), positive: L(cond, 0), negative: L(neg), latent_image: L(cond, 1),
    seed, steps: +val('steps'), cfg: 1,
    sampler_name: ksam.includes(val('sampler')) ? val('sampler') : 'euler',
    scheduler: 'simple', denoise: 1,
  });
  const dec = g.add('VAEDecodeTiled', { samples: L(ks), vae: L(vae), tile_size: 1024, overlap: 64, temporal_size: 64, temporal_overlap: 8 });
  g.add('SaveImage', { images: L(dec), filename_prefix: val('prefix') });
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
  if (m !== 'video' && officialImage() && !val('vae')) errs.push('No MiniMax H3 image VAE found.');
  if (m === 'video') {
    if ((vm === 'first' || vm === 'firstlast') && !S.lists.first.length) errs.push('Add the first frame.');
    if (vm === 'firstlast' && !S.lists.last.length) errs.push('Add the last frame.');
    if (!val('avae')) errs.push('No MiniMax H3 audio VAE found.');
    if (S.guides.some(gd => !gd.asset)) errs.push('A keyframe guide has no file; add one or remove the guide.');
  }
  return errs;
}

/* ───────── toasts & dialogs ───────── */
const T_IC = { info: 'info', ok: 'check', warn: 'warn', error: 'warn' };
function toast(kind, title, detail) {
  const host = $('#toasts'); if (!host) return;
  while (host.children.length >= 4) host.firstChild.remove();
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<span class="t-ic">${icon(T_IC[kind] || 'info')}</span><b class="t-title">${esc(title)}</b>`
    + `<button type="button" class="t-x" aria-label="Dismiss">${icon('x')}</button>`
    + (detail ? `<span class="t-msg">${esc(detail)}</span>` : '');
  const ms = kind === 'error' || kind === 'warn' ? 10000 : 5000;
  let timer = setTimeout(kill, ms);
  function kill() { t.classList.remove('in'); t.classList.add('out'); setTimeout(() => t.remove(), 220); }
  t.onmouseenter = () => clearTimeout(timer);
  t.onmouseleave = () => { timer = setTimeout(kill, 900); };
  $('.t-x', t).onclick = () => { clearTimeout(timer); kill(); };
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
}
let confirmResolve = null;
function confirmDialog(title, detail, { okLabel = 'OK', danger = true } = {}) {
  return new Promise(res => {
    confirmResolve = res;
    modal(`<div class="dlg"><b>${esc(title)}</b><p class="muted">${esc(detail || '')}</p>
      <div class="dlg-acts"><button type="button" class="ghost" id="cfNo">Cancel</button>
      <button type="button" class="${danger ? 'dang' : 'primary'}" id="cfYes">${esc(okLabel)}</button></div></div>`);
    $('#cfNo').onclick = () => closeConfirm(false);
    $('#cfYes').onclick = () => closeConfirm(true);
    $('#cfYes').focus();
  });
}
function closeConfirm(v) { const r = confirmResolve; confirmResolve = null; hideModal(); if (r) r(v); }
function hideModal() { if (LB) return lbClose(); $('#modal').classList.add('hidden'); }

/* ───────── theme (system → light → dark) ───────── */
const THEME_IC = { system: 'monitor', light: 'sun', dark: 'moon' };
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = $('#themeBtn');
  if (btn) { btn.innerHTML = icon(THEME_IC[t]); btn.title = `Theme: ${t} (click to switch)`; }
}
function cycleTheme() {
  const next = { system: 'light', light: 'dark', dark: 'system' }[load('theme', 'system')];
  save('theme', next); applyTheme(next);
}

/* ───────── collapsible bands ───────── */
function initBands() {
  const saved = load('bands', {});
  $$('details[data-band]').forEach(d => {
    d.open = !!saved[d.dataset.band];
    d.addEventListener('toggle', () => { const b = load('bands', {}); b[d.dataset.band] = d.open; save('bands', b); });
  });
}
const BAND_SUM = {
  sampling: () => {
    const parts = [`${val('steps')} steps`, `${val('sampler') || '—'}/${val('scheduler') || '—'}`,
      `seed ${val('seed')}`, `×${val('batch') || 1}`];
    if (S.mode !== 'video' && val('aspect') !== 'custom pixels') parts.splice(1, 0, `${val('mp')} MP`);
    return parts.join(' · ');
  },
  models: () => {
    const l = S.loras.filter(x => x.name !== 'None' && +x.strength).length;
    return [short(val('model')), val('te') ? 'TE ' + short(val('te'), 14) : '', l ? `${l} LoRA` : ''].filter(Boolean).join(' · ') || 'no model loaded';
  },
  output: () => S.mode === 'video'
    ? `${val('prefix')} · ${val('vFormat')}/${val('vCodec')}${val('vAudio') ? '' : ' · silent'}`
    : val('prefix'),
};
function syncBandSummaries() {
  $$('details[data-band] .sum').forEach(el => {
    const fn = BAND_SUM[el.closest('details').dataset.band];
    if (fn) { try { el.textContent = fn(); } catch { el.textContent = ''; } }
  });
}

/* ───────── queue & runs ───────── */
function showErr(msg) {
  const e = $('#err');
  if (!msg) { e.classList.add('hidden'); e.innerHTML = ''; return; }
  const m = String(msg), first = m.split('\n')[0];
  e.innerHTML = `<div class="err-h">${icon('warn')}<span>${esc(first)}</span>`
    + `<button type="button" class="err-x" aria-label="Dismiss error">${icon('x')}</button></div>`
    + (m.includes('\n') || m.length > first.length ? `<pre>${esc(m)}</pre>` : '');
  e.classList.remove('hidden');
  toast('error', first.length > 60 ? first.slice(0, 57) + '…' : first, m.includes('\n') ? m.split('\n').slice(1).join('\n') : '');
}
function formatNodeErrors(body, graph) {
  const lines = [body.error?.message || body.error || 'Prompt rejected'];
  for (const [id, ne] of Object.entries(body.node_errors || {}))
    for (const er of ne.errors || []) lines.push(`• ${graph?.[id]?.class_type || ne.class_type || id}: ${er.message}${er.details ? ', ' + er.details : ''}`);
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
        promptSource: S.promptSource || 'raw',
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
  if (status === 'error') toast('error', `${run.mode === 'video' ? 'Video' : 'Image'} run failed (seed ${run.seed})`, run.error);
  else toast('ok', `${run.mode === 'video' ? 'Video' : 'Image'} ready`, `seed ${run.seed} · ${run.summary}`);
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    prompt_id: run.id, status, error: run.error, mode: run.mode, video_mode: run.vmode, prompt: run.prompt, seed: run.seed,
    prompt_source: run.promptSource || 'raw',
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
  if (!im) { im = document.createElement('img'); im.id = 'livePrev'; im.alt = 'live preview'; document.body.append(im); }
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
function runStatus() {
  const run = S.byId[S.active];
  if (!run || run.status !== 'running') return null;
  const el = (Date.now() - (run.tStart || run.t0)) / 1000;
  const pct = S.prog && S.prog[1] ? Math.min(100, 100 * S.prog[0] / S.prog[1]) : 0;
  let eta = '';
  if (S.prog && S.prog[0] > 0) {
    const r = S.prog[0] / S.prog[1];
    eta = `~${fmtS(el * (1 - r) / r)}`;
  }
  return { run, el, pct, eta };
}
function setRunbar() {
  const st = runStatus();
  const pending = S.runs.filter(r => r.status === 'queued').length;
  $('#runTitle').textContent = st ? `RUNNING ${st.run.mode === 'video' ? 'VIDEO' : 'IMAGE'} · seed ${st.run.seed}`
    : pending ? `${pending} WAITING` : 'IDLE';
  $('#barFill').style.width = (st ? st.pct : 0) + '%';
  $('#runPct').textContent = st && st.pct ? `${Math.round(st.pct)}%` : '';
  $('#runNode').textContent = st ? (S.node || 'starting…') : '';
  $('#runTime').textContent = st ? fmtS(st.el) : '';
  $('#runEta').textContent = st ? (st.eta || 'eta —') : '';
  $('#conn').className = 'dot ' + (S.online ? (st ? 'busy' : 'on') : 'off');
  if (!st) $('#livePrev')?.remove();
}

/* ───────── gallery: contact sheet + filter + multi-select ───────── */
const MODE_LBL = { t2i: 'Text → Image', i2i: 'Image → Image', multi: 'Multi-image', video: 'Video' };
function runMatches(r) {
  const outs = r.outputs || [];
  if (S.gFilter === 'images' && !outs.some(o => o.kind === 'image')) return false;
  if (S.gFilter === 'videos' && !outs.some(o => o.kind === 'video')) return false;
  if (S.gFilter === 'failed' && r.status !== 'error') return false;
  if (S.gQ) {
    const q = S.gQ.toLowerCase();
    if (!(String(r.seed).includes(q) || (r.prompt || '').toLowerCase().includes(q) || String(r.id).toLowerCase().includes(q))) return false;
  }
  return true;
}
const saveGFilter = () => save('galleryFilter', { f: S.gFilter, q: S.gQ });
function setGalleryFilter(f) {
  S.gFilter = f;
  $$('.gfilter .fbtn').forEach(b => b.classList.toggle('on', b.dataset.filter === f));
  saveGFilter(); renderGallery();
}
function updateBulk() {
  const bar = $('#bulkBar'); if (!bar) return;
  bar.classList.toggle('hidden', !S.sel.size);
  $('#bulkN').textContent = S.sel.size;
}
function renderGallery() {
  const host = $('#gallery'); host.innerHTML = '';
  const total = { all: S.runs.length, images: 0, videos: 0, failed: 0 };
  for (const r of S.runs) {
    if ((r.outputs || []).some(o => o.kind === 'image')) total.images++;
    if ((r.outputs || []).some(o => o.kind === 'video')) total.videos++;
    if (r.status === 'error') total.failed++;
  }
  for (const k of Object.keys(total)) { const el = document.getElementById('fc-' + k); if (el) el.textContent = total[k]; }
  const shown = S.runs.filter(runMatches).slice(0, 60);
  S.gShown = shown;
  if (!shown.length) {
    const box = document.createElement('div'); box.className = 'gempty';
    if (!S.runs.length) box.innerHTML = `${icon('inbox', 'i')}<span>Results appear here. <kbd>Ctrl</kbd><kbd>Enter</kbd> generates.</span>`;
    else box.innerHTML = `${icon('inbox', 'i')}<span>Nothing matches filter “${esc(S.gFilter)}”${S.gQ ? ` or search “${esc(S.gQ)}”` : ''}.</span><br>
      <button type="button" id="gClearFilter">Clear filters</button>`;
    host.append(box);
    $('#gClearFilter')?.addEventListener('click', () => {
      S.gQ = ''; $('#gSearch').value = ''; setGalleryFilter('all');
    });
    updateBulk();
    return;
  }
  for (const run of shown) host.append(cardEl(run, shown));
  updateBulk();
}
function cardEl(run, shown) {
  const c = document.createElement('div');
  const head = `<b>${MODE_LBL[run.mode]}</b>${run.vmode ? ` · ${run.vmode}` : ''}`
    + `${run.promptSource === 'builder' ? ` <span title="Prompt assembled with the Prompt builder">${icon('blocks')}builder</span>` : ''} · seed ${run.seed}`;
  if (run.status === 'queued' || run.status === 'running') {
    c.className = `card ${run.status === 'running' ? 'run' : 'queue'}`;
    c.innerHTML = `<div class="thumb">${icon('clock', 'i play')}<div class="spin"></div></div><div class="meta">${head}<br>${run.status}… <span class="muted">${esc(run.summary)}</span></div>`;
    return c;
  }
  const outs = run.outputs || [];
  const first = outs[0];
  const media = first
    ? (first.kind === 'video'
        ? `<video src="${viewUrl(first)}" preload="metadata" muted loop playsinline></video>`
        : `<img src="${viewUrl(first)}" loading="lazy" decoding="async" alt="${esc((run.prompt || 'result').slice(0, 80))}">`)
    : '';
  const secs = run.t1 ? ` · ${((run.t1 - (run.tStart || run.t0)) / 1000).toFixed(0)}s` : '';
  c.className = 'card ' + (run.status === 'error' ? 'error' : 'done') + (S.sel.has(run.id) ? ' sel' : '');
  c.innerHTML = `<div class="thumb">${media}
      <span class="tag">${run.status === 'error' ? 'FAILED' : first?.kind === 'video' ? 'VIDEO' : 'IMAGE'}${outs.length > 1 ? ` +${outs.length - 1}` : ''}</span>
      <label class="sel-box"><input type="checkbox" ${S.sel.has(run.id) ? 'checked' : ''} aria-label="Select run ${esc(run.id)}"></label>
    </div>
    <div class="meta">${head}${secs}</div>
    <div class="prompts"><p title="${esc(run.prompt)}">${esc(run.prompt)}</p></div>
    ${run.status === 'error' ? `<div class="errtxt">${esc(run.error)}</div>` : ''}
    <div class="meta"><span>${esc(run.summary)}${run.loras?.length ? ' · ' + esc(run.loras.join(', ')) : ''}</span></div>
    <div class="acts"></div>`;
  const acts = $('.acts', c);
  const act = (ic, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.innerHTML = icon(ic); b.title = title; b.setAttribute('aria-label', title);
    b.onclick = e => { e.stopPropagation(); fn(); };
    acts.append(b);
  };
  if (first?.kind === 'image') {
    const asset = { filename: first.filename, subfolder: first.subfolder, type: first.type, kind: 'image' };
    act('send', 'Use as Picture 1 in Image → Image', () => sendTo('i2i', asset));
    act('plus', 'Add to Multi-image pictures', () => sendTo('multi', asset));
    act('film', 'Use as first frame', () => sendTo('first', asset));
    act('film', 'Use as last frame', () => sendTo('last', asset));
    c.querySelectorAll('img').forEach(im => {
      im.draggable = true;
      im.ondragstart = e => e.dataTransfer.setData('application/x-h3asset', JSON.stringify(asset));
    });
  }
  if (run.restore) act('refresh', 'Restore every setting of this run', () => restore(run));
  act('dice', 'Copy seed into the form', () => { setVal('seed', run.seed); persistForm(); toast('info', 'Seed copied', String(run.seed)); });
  if (run.info) act('info', 'Run info', () => modal(`<pre>${esc(run.info)}</pre>`));
  if (first) { const a = document.createElement('a'); a.href = viewUrl(first); a.download = first.filename; a.title = 'Download'; a.setAttribute('aria-label', 'Download'); a.innerHTML = icon('dl'); acts.append(a); }
  act('trash', 'Remove from list (file stays on disk)', () => { S.runs = S.runs.filter(r => r !== run); delete S.byId[run.id]; S.sel.delete(run.id); saveRuns(); renderGallery(); });
  const cb = $('.sel-box input', c);
  cb.onclick = e => e.stopPropagation();
  cb.onchange = () => {
    cb.checked ? S.sel.add(run.id) : S.sel.delete(run.id);
    c.classList.toggle('sel', cb.checked);
    updateBulk();
  };
  $('.thumb', c).onclick = () => lbOpen(shown, shown.indexOf(run), c);
  return c;
}

/* lightbox over the filtered list */
let LB = null;
function lbOpen(items, i, trigger) { LB = { items, i, trigger }; lbRender(); }
function lbRender() {
  const run = LB.items[LB.i];
  if (!run) { lbClose(); return; }
  const nav = `<div class="lbbar"><button type="button" class="icon-btn" id="lbPrev" aria-label="Previous run">${icon('arrow-l')}</button>`
    + `<span class="muted small">${LB.i + 1} / ${LB.items.length} · ${MODE_LBL[run.mode]} · seed ${run.seed}</span>`
    + `<button type="button" class="icon-btn" id="lbNext" aria-label="Next run">${icon('arrow-r')}</button></div>`;
  const media = (run.outputs || []).map(o => o.kind === 'video'
    ? `<video src="${viewUrl(o)}" controls autoplay loop playsinline></video>`
    : `<img src="${viewUrl(o)}" alt="">`).join('')
    || `<p class="muted" style="padding:12px">No outputs (still ${run.status}).</p>`;
  LB.html = nav + media + `<p class="muted small" style="margin:0 14px 12px">${esc(run.prompt)}</p>`;
  $('#modalBody').innerHTML = LB.html;
  $('#modal').classList.remove('hidden');
  $('#lbPrev').onclick = () => lbStep(-1);
  $('#lbNext').onclick = () => lbStep(1);
}
function lbStep(d) {
  if (!LB) return;
  LB.i = (LB.i + d + LB.items.length) % LB.items.length;
  lbRender();
}
function lbClose() {
  const t = LB && LB.trigger; LB = null;
  $('#modal').classList.add('hidden');
  if (t && document.contains(t)) t.focus();
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
  $$('#tabs button').forEach(b => { const on = b.dataset.mode === r.mode; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
  S.sel.clear(); updateBulk();
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
    $('#stopComfy').classList.remove('hidden');
    if (!was) { await loadInfo(); applySnap(load('form.' + S.mode, null)); renderLoras(); refresh(); pollPending(); }
  } catch {
    S.online = false;
    $('#connText').textContent = 'ComfyUI offline'; $('#vram').textContent = '';
    $('#startComfy').classList.remove('hidden');
    $('#stopComfy').classList.add('hidden');
  }
  setRunbar();
}

/* ───────── wiring ───────── */
function init() {
  S.runs = load('runs', []).map(r => (r.status === 'queued' || r.status === 'running') ? r : r);
  S.runs.forEach(r => { S.byId[r.id] = r; });
  const as = load('assets', null);
  if (as) { Object.assign(S.lists, as.lists); S.guides = as.guides || []; }
  S.bld = load('builder', {});
  S.bld.t2i = Object.assign(bldBlank('t2i'), S.bld.t2i);
  for (const m of ['i2i', 'multi']) S.bld[m] = Object.assign(bldBlank('edit'), S.bld[m]);
  S.mode = load('mode', 't2i');
  applyTheme(load('theme', 'system'));
  initBands();
  const gf = load('galleryFilter', { f: 'all', q: '' });
  S.gFilter = ['all', 'images', 'videos', 'failed'].includes(gf.f) ? gf.f : 'all';
  S.gQ = gf.q || '';
  $$('#tabs button').forEach(b => {
    b.onclick = () => setMode(b.dataset.mode);
    const on = b.dataset.mode === S.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
  });
  $('#tabs').addEventListener('keydown', e => {
    const tabs = $$('#tabs button');
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n === null) return;
    e.preventDefault();
    setMode(tabs[n].dataset.mode);
    tabs[n].focus();
  });
  $('#gSearch').value = S.gQ;
  $$('.gfilter .fbtn').forEach(b => b.classList.toggle('on', b.dataset.filter === S.gFilter));
  const d = DEFAULTS[group(S.mode)];
  setVal('steps', d.steps); setVal('prefix', d.prefix);
  applySnap(load('form.' + S.mode, null));

  $('#form').addEventListener('input', e => {
    if (e.target.id === 'prompt') S.promptSource = 'raw';
    if (e.target.closest('#builder')) {   // builder fields write straight to state; only the preview refreshes
      const key = BLD_TEXT_FIELDS[e.target.id];
      if (key) { bldState()[key] = e.target.value; saveBld(); }
      if (e.target.id === 'b-noText') { bldState().noText = e.target.checked; saveBld(); }
      if (e.target.id === 'b-syncRatio') { S.bld.syncRatio = e.target.checked; saveBld(); }
      updateBldOut(); return;
    }
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
  $$('[data-addtext]').forEach(btn => btn.onclick = () => { bldState().texts.push({ text: '', where: '' }); saveBld(); renderBuilder(); });
  $('#bUse').onclick = () => applyBld(false);
  $('#bAppend').onclick = () => applyBld(true);
  $('#bCopy').onclick = async () => {
    const txt = assemblePrompt();
    if (!txt.trim()) return toast('warn', 'Nothing to copy', 'Fill at least one step first.');
    try { await navigator.clipboard.writeText(txt); toast('ok', 'Prompt copied', `${txt.length} characters`); }
    catch { showErr('Clipboard blocked by the browser. Select the text in the preview and copy manually.'); }
  };
  $('#bClear').onclick = async () => {
    if (assemblePrompt().trim()
      && !await confirmDialog('Clear the builder steps?', 'Your draft for this mode is erased. The prompt box is not touched.', { okLabel: 'Clear steps' })) return;
    S.bld[S.mode] = bldBlank(bldVariant()); saveBld(); renderBuilder();
  };
  $('#bExample').onchange = () => bldExample($('#bExample').value);
  $('#bGuide').onclick = bldGuide;
  $('#builder').ontoggle = () => { S.bld.open = $('#builder').open; saveBld(); };
  $('#go').onclick = generate;
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      // while writing in the builder, the same shortcut applies the draft instead of generating
      const inBld = $('#builder')?.open && !$('#builder').classList.contains('hidden') && e.target.closest('#bldBody');
      if (inBld) applyBld(false); else generate();
      return;
    }
    if (e.key === 'Escape') {
      if (confirmResolve) closeConfirm(false);
      else if (LB) lbClose();
      else if (!$('#modal').classList.contains('hidden')) $('#modal').classList.add('hidden');
      return;
    }
    if (LB && !$('#modal').classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); lbStep(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); lbStep(1); }
    }
  });
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
  $('#stopComfy').onclick = async () => {
    if (!await confirmDialog('Stop ComfyUI', 'Any running generation will be cancelled.', { okLabel: 'Stop ComfyUI' })) return;
    const btn = $('#stopComfy');
    const done = () => { btn.textContent = 'Stop ComfyUI'; btn.disabled = false; };
    btn.textContent = 'Stopping…'; btn.disabled = true;
    try {
      const r = await fetch('/api/stop-comfy', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText);
      let tries = 0;
      const t = setInterval(async () => {
        await heartbeat();
        if (!S.online || ++tries > 20) {
          clearInterval(t); done();
          if (S.online) showErr('ComfyUI is still running.');
        }
      }, 1000);
    } catch (e) { showErr('Could not stop ComfyUI: ' + e.message); done(); }
  };
  $('#clearGallery').onclick = async () => {
    if (S.runs.every(r => r.status === 'queued' || r.status === 'running')) return;
    if (!await confirmDialog('Clear the results list?', 'Finished runs disappear from the panel; the files stay on disk in ComfyUI.', { okLabel: 'Clear list' })) return;
    S.runs = S.runs.filter(r => r.status === 'queued' || r.status === 'running');
    S.sel.clear();
    saveRuns(); renderGallery();
  };

  /* gallery filter, search, bulk actions, theme */
  $('#gSearch').oninput = e => { S.gQ = e.target.value.trim(); saveGFilter(); renderGallery(); };
  $$('.gfilter .fbtn').forEach(b => b.onclick = () => setGalleryFilter(b.dataset.filter));
  $('#bulkClear').onclick = () => { S.sel.clear(); renderGallery(); };
  $('#bulkDel').onclick = async () => {
    const n = S.sel.size; if (!n) return;
    if (!await confirmDialog(`Remove ${n} run${n > 1 ? 's' : ''} from the list?`, 'The files stay on disk in ComfyUI.', { okLabel: 'Remove', danger: true })) return;
    S.runs = S.runs.filter(r => !S.sel.has(r.id));
    [...S.sel].forEach(id => delete S.byId[id]);
    S.sel.clear(); saveRuns(); renderGallery();
    toast('ok', `Removed ${n} run${n > 1 ? 's' : ''}`, 'Files were not deleted.');
  };
  $('#bulkDl').onclick = () => {
    let n = 0;
    for (const id of S.sel) for (const o of S.byId[id]?.outputs || []) {
      setTimeout(() => { const a = document.createElement('a'); a.href = viewUrl(o); a.download = o.filename; a.click(); }, n++ * 150);
    }
    if (!n) toast('warn', 'Nothing to download', 'The selection has no output files yet.');
  };
  $('#bulkEdit').onclick = () => {
    const assets = [...S.sel].map(id => S.byId[id]).flatMap(r => (r?.outputs || []).filter(o => o.kind === 'image'))
      .map(o => ({ filename: o.filename, subfolder: o.subfolder, type: o.type, kind: 'image' }));
    if (!assets.length) return toast('warn', 'Nothing to send', 'Select runs that produced images.');
    if (assets.length === 1) { sendTo('i2i', assets[0]); return; }
    if (S.mode !== 'multi') setMode('multi');
    for (const a of assets) { if (S.lists.multi.length >= 9) break; measure(a).then(m => { S.lists.multi.push(m); changed(); }); }
    toast('ok', `Sent ${assets.length} images to Multi-image`, 'Each becomes a Picture card (max 9).');
  };
  $('#themeBtn').onclick = cycleTheme;
  $('#err').onclick = e => { if (e.target.closest('.err-x')) showErr(''); };
  $('#modalClose').onclick = hideModal;
  $('#modal').onclick = e => { if (e.target.id === 'modal') hideModal(); };

  renderLoras(); changed(); renderGallery();
  connectWS(); heartbeat();
  setInterval(heartbeat, 5000);
  setInterval(setRunbar, 120);   // status strip ticker: elapsed/eta refresh between progress messages
  setInterval(() => { if (!S.ws || S.ws.readyState !== 1) pollPending(); }, 3000);
}
init();
