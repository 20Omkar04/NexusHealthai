/* ============================================================
   HealthAI Nexus — app.js
   All application logic in one file for hackathon reliability.
   Sections: Config → API → Utils → Dashboard → Phishing → Init
   ============================================================ */

/* ── CONFIG & STATE ─────────────────────────────────────── */
const keys = { gemini: '', groq: '', openrouter: '', hf: '' };
let healthData    = [];
let healthChart   = null;
let webLLMEngine  = null;   // WebLLM engine instance (loaded lazily)

// Phishing session state
let phishEmails   = [];
let phishAnswers  = [];
let currentEmail  = 0;
let sessionCorrect= 0;
let sessionWrong  = 0;
let sessionDone   = false;

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/* ── LOAD KEYS FROM .env (served via fetch when running locally) ─
   Falls back silently — user can always type keys in the UI.
   For Vercel/Netlify: set env vars in dashboard, not .env.
   ─────────────────────────────────────────────────────────── */
async function loadEnvKeys() {
  try {
    const res = await fetch('.env');
    if (!res.ok) return;
    const text = await res.text();
    const lines = text.split('\n');
    lines.forEach(line => {
      const [rawKey, ...rest] = line.split('=');
      const k = (rawKey || '').trim();
      const v = rest.join('=').trim().replace(/^["']|["']$/g, '');
      if (!v) return;
      if (k === 'GEMINI_API_KEY')     { keys.gemini = v;     applyKeyToUI('gemini', v); }
      if (k === 'GROQ_API_KEY')       { keys.groq = v;       applyKeyToUI('groq', v); }
      if (k === 'OPENROUTER_API_KEY') { keys.openrouter = v; applyKeyToUI('openrouter', v); }
      if (k === 'HF_API_KEY')         { keys.hf = v;         applyKeyToUI('hf', v); }
    });
  } catch (_) {
    // .env not served or not found — that's fine, user types keys
  }
}

function applyKeyToUI(type, val) {
  const inputId = type === 'hf' ? 'hfKey' : type + 'Key';
  const statusId = type === 'hf' ? 'hfStatus' : type + 'Status';
  const input = document.getElementById(inputId);
  const status = document.getElementById(statusId);
  if (input)  input.value = '••••••••';      // mask it in UI
  if (status) { status.textContent = '✓ set'; status.className = 'api-status ok'; }
  syncButtonStates();
}

/* ── KEY INPUT HANDLER ──────────────────────────────────── */
function onKeyInput(type) {
  const inputId  = type === 'hf' ? 'hfKey'    : type + 'Key';
  const statusId = type === 'hf' ? 'hfStatus' : type + 'Status';
  const val = document.getElementById(inputId).value.trim();
  keys[type] = val;
  const statusEl = document.getElementById(statusId);
  if (statusEl) {
    statusEl.textContent = val.length > 6 ? '✓ set' : 'not set';
    statusEl.className = 'api-status' + (val.length > 6 ? ' ok' : '');
  }
  syncButtonStates();
}

function anyKey() { return keys.gemini || keys.groq || keys.openrouter || keys.hf || 'webllm'; }

function syncButtonStates() {
  const has = !!anyKey();
  const analyzeBtn = document.getElementById('analyzeBtn');
  if (analyzeBtn && healthData.length > 0) analyzeBtn.disabled = false; // WebLLM fallback always available
  // startPhishBtn always enabled — falls back to WebLLM if no keys set
}

/* ── SAFE JSON PARSER ───────────────────────────────────── */
function safeParseJSON(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Empty AI response');
  }

  let clean = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  // extract FIRST valid JSON block only
  const firstBrace = clean.indexOf('{');
  const lastBrace  = clean.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in AI response');
  }

  clean = clean.slice(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error('Invalid JSON returned by AI');
  }
}

/* ── API ROUTING: Gemini 2.5 Flash → Groq → OpenRouter → HF → WebLLM ── */

/**
 * callAI — universal entry point used by the health-analysis module.
 * Falls through providers in order; WebLLM is always the final safety net.
 */
async function callAI(prompt, maxTokens = 700) {
  const errors = [];

  if (keys.gemini) {
    try { return await callGemini(prompt, maxTokens); }
    catch (e) { errors.push('Gemini: ' + e.message); console.warn('Gemini failed:', e.message); }
  }

  if (keys.groq) {
    try { return await callGroq(prompt, maxTokens); }
    catch (e) { errors.push('Groq: ' + e.message); console.warn('Groq failed:', e.message); }
  }

  if (keys.openrouter) {
    try { return await callOpenRouter(prompt, maxTokens); }
    catch (e) { errors.push('OpenRouter: ' + e.message); console.warn('OpenRouter failed:', e.message); }
  }

  if (keys.hf) {
    try { return await callHF(prompt); }
    catch (e) { errors.push('HF: ' + e.message); console.warn('HF failed:', e.message); }
  }

  // Final fallback: run the model entirely in-browser via WebGPU
  console.warn('All API providers failed or no keys set — falling back to WebLLM (in-browser)');
  try { return await callWebLLM(prompt, maxTokens); }
  catch (e) { errors.push('WebLLM: ' + e.message); }

  throw new Error('All providers failed. ' + errors.join(' | '));
}

/**
 * callShiftingAI — same chain as callAI but used by the phishing module.
 * Replaces the old keyless callClaude() with a proper multi-provider fallback.
 */
async function callShiftingAI(prompt, maxTokens = 1200) {
  return callAI(prompt, maxTokens);
}

/* ── GEMINI 2.5 FLASH (primary, free-tier) ─────────────── */
async function callGemini(prompt, maxTokens = 900) {
  // Try newest/fastest models first; each has its own independent free-tier quota
  const geminiModels = [
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
  ];

  const body = JSON.stringify({
    contents: [{ parts: [{ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens }
  });

  for (const model of geminiModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys.gemini}`;
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      }, 25000);

      const data = await res.json();

      if (!res.ok) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        if (res.status === 429) { console.warn(`Gemini ${model} quota exceeded, trying next model`); continue; }
        if ([500, 503].includes(res.status)) { await sleep(1500); continue; }
        throw new Error(msg);
      }

      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
      if (!text) throw new Error('Empty Gemini response');
      return text;

    } catch (e) {
      if (e.message && (e.message.includes('quota') || e.message.includes('429'))) {
        console.warn(`Gemini ${model} quota hit, trying next`);
        continue;
      }
      throw e;
    }
  }
  throw new Error('All Gemini models exceeded free quota — falling through to Groq.');
}

/* ── GROQ (very fast, free-tier, Llama 3.3) ────────────── */
async function callGroq(prompt, maxTokens = 700) {
  // Groq free tier — llama-3.3-70b-versatile is extremely fast
  const models = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',       // smaller fallback if 70B hits rate limit
  ];

  for (const model of models) {
    try {
      const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keys.groq}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.4
        })
      }, 25000);

      const data = await res.json();
      if (!res.ok) {
        const msg = data.error?.message || `HTTP ${res.status}`;
        if (res.status === 429) { console.warn(`Groq ${model} rate limited, trying next`); await sleep(800); continue; }
        throw new Error(msg);
      }

      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Empty Groq response');
      return text;

    } catch (err) {
      console.warn(`Groq model failed: ${model}`, err.message);
    }
  }
  throw new Error('All Groq models failed — falling through to OpenRouter.');
}

/* ── OPENROUTER (free-tier, Llama 3.3 + fallbacks) ─────── */
async function callOpenRouter(prompt, maxTokens = 700) {
  // Llama 3.3 first, then additional free-tier fallbacks
  const models = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'meta-llama/llama-3.1-8b-instruct:free',
    'qwen/qwen3-8b:free',
    'microsoft/mai-ds-r1:free',
  ];

  for (const model of models) {
    try {
      const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keys.openrouter}`,
          'HTTP-Referer': window.location.href,
          'X-Title': 'HealthAI Nexus'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.4
        })
      }, 25000);

      const data = await res.json();
      if (!res.ok) {
        const errMsg = data.error?.message || `HTTP ${res.status}`;
        if (res.status === 404) { console.warn(`OpenRouter: ${model} not found, skipping`); continue; }
        if (res.status === 429) { console.warn(`OpenRouter: ${model} rate limited, skipping`); await sleep(800); continue; }
        throw new Error(errMsg);
      }

      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Empty response');
      return text;

    } catch (err) {
      console.warn(`OpenRouter model failed: ${model}`, err.message);
    }
  }
  throw new Error('All OpenRouter models failed — falling through to HuggingFace.');
}

/* ── HUGGING FACE (serverless inference, Mistral 7B) ────── */
async function callHF(prompt) {
  const res = await fetchWithTimeout('https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${keys.hf}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { max_new_tokens: 600, temperature: 0.35, return_full_text: false, use_cache: false }
    })
  }, 30000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text;
  if (data.generated_text) return data.generated_text;
  throw new Error('Unexpected HF response shape');
}

/* ── WEBLLM (in-browser, WebGPU — final fallback) ──────── */
/**
 * Loads the WebLLM engine lazily on first call.
 * Uses Llama-3.2-3B-Instruct-q4f32_1-MLC — small enough to load quickly,
 * capable enough for structured JSON tasks.
 * Requires a WebGPU-capable browser (Chrome 113+, Edge 113+).
 */
async function callWebLLM(prompt, maxTokens = 700) {
  // Inject WebLLM script tag if not already present
  if (!window.webllm) {
    await new Promise((resolve, reject) => {
      if (document.querySelector('script[data-webllm]')) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@latest/lib/index.js';
      s.setAttribute('data-webllm', '1');
      s.type = 'module';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load WebLLM script. Check your internet connection.'));
      document.head.appendChild(s);
    });
    // Give module a tick to register window.webllm
    await sleep(300);
  }

  // Dynamic import as a module alternative — works when CDN exposes a UMD build
  if (!window.webllm && !window.CreateMLCEngine) {
    // Try dynamic ESM import
    const mod = await import('https://esm.sh/@mlc-ai/web-llm');
    window.webllm = mod;
  }

  const CreateMLCEngine = window?.webllm?.CreateMLCEngine || window?.CreateMLCEngine;
  if (!CreateMLCEngine) throw new Error('WebLLM not available in this browser (requires WebGPU / Chrome 113+).');

  const MODEL_ID = 'Llama-3.2-3B-Instruct-q4f32_1-MLC';

  if (!webLLMEngine) {
    toast('🧠 Loading on-device AI model (~1.5 GB)… this takes ~30s the first time.', 'ok');
    webLLMEngine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: info => {
        // Surface download progress in the UI if possible
        const pct = Math.round((info.progress || 0) * 100);
        const toastEl = document.getElementById('toast');
        if (toastEl && toastEl.classList.contains('show')) {
          toastEl.textContent = `🧠 Loading model… ${pct}%`;
        }
      }
    });
  }

  const reply = await webLLMEngine.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.4,
    stream: false
  });

  const text = reply?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty WebLLM response');
  return text;
}


/* ── ANTHROPIC API (legacy — replaced by callShiftingAI) ─── */
// callClaude is kept as an alias so any future references still work.
// The phishing module now calls callShiftingAI directly (Gemini → Groq → OpenRouter → HF → WebLLM).
async function callClaude(prompt, maxTokens = 1200) {
  return callShiftingAI(prompt, maxTokens);
}

/* ── UTILS ──────────────────────────────────────────────── */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    if (e.name === 'AbortError') throw new Error('Request timed out after ' + (timeoutMs / 1000) + 's');
    throw e;
  }
}

function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function $(id) { return document.getElementById(id); }

/* ── TAB SWITCHING ──────────────────────────────────────── */
function showTab(name, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const panel = $('panel-' + name);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
}

/* ── INPUT MODE TOGGLE ──────────────────────────────────── */
function setInputMode(mode) {
  $('input-manual').style.display = mode === 'manual' ? 'block' : 'none';
  $('input-csv').style.display    = mode === 'csv'    ? 'block' : 'none';
  const manualBtn = $('modeManual');
  const csvBtn    = $('modeCSV');
  if (manualBtn) { manualBtn.style.borderColor = mode === 'manual' ? 'var(--cyan)' : ''; manualBtn.style.color = mode === 'manual' ? 'var(--cyan)' : ''; }
  if (csvBtn)    { csvBtn.style.borderColor    = mode === 'csv'    ? 'var(--cyan)' : ''; csvBtn.style.color    = mode === 'csv'    ? 'var(--cyan)' : ''; }
}

/* ══════════════════════════════════════════════════════════
   DASHBOARD MODULE
   ══════════════════════════════════════════════════════════ */

function addManualEntry() {
  const month  = $('in-month').value;
  const hr     = parseFloat($('in-hr').value)     || null;
  const sl     = parseFloat($('in-sleep').value)  || null;
  const act    = parseFloat($('in-act').value)    || null;
  const spo2   = parseFloat($('in-spo2').value)   || null;
  const stress = parseFloat($('in-stress').value) || null;

  if (!hr && !sl && !act) return toast('Enter at least one metric value.', 'err');

  const idx = healthData.findIndex(d => d.month === month);
  const entry = { month, hr, sleep: sl, act, spo2, stress };
  if (idx >= 0) healthData[idx] = entry; else healthData.push(entry);
  healthData.sort((a, b) => MONTHS.indexOf(a.month) - MONTHS.indexOf(b.month));

  updateStatsAndChart();
  updateRiskBars();
  const ec = $('entry-count');
  if (ec) ec.textContent = `${healthData.length} month${healthData.length !== 1 ? 's' : ''} entered`;
  if (anyKey()) { const ab = $('analyzeBtn'); if (ab) ab.disabled = false; }
  toast(`${month} added ✓`);
}

function loadSampleData() {
  healthData = [
    { month:'January',   hr:68, sleep:7.2, act:60, spo2:98, stress:35 },
    { month:'February',  hr:70, sleep:7.0, act:65, spo2:97, stress:38 },
    { month:'March',     hr:72, sleep:6.8, act:70, spo2:98, stress:42 },
    { month:'April',     hr:71, sleep:6.5, act:68, spo2:97, stress:44 },
    { month:'May',       hr:73, sleep:7.0, act:72, spo2:98, stress:40 },
    { month:'June',      hr:74, sleep:6.2, act:65, spo2:96, stress:52 },
    { month:'July',      hr:72, sleep:6.5, act:63, spo2:97, stress:48 },
    { month:'August',    hr:75, sleep:6.0, act:70, spo2:96, stress:55 },
    { month:'September', hr:73, sleep:6.8, act:67, spo2:97, stress:50 },
    { month:'October',   hr:78, sleep:5.8, act:58, spo2:95, stress:63 },
  ];
  updateStatsAndChart();
  updateRiskBars();
  const ec = $('entry-count');
  if (ec) ec.textContent = `${healthData.length} months entered`;
  if (anyKey()) { const ab = $('analyzeBtn'); if (ab) ab.disabled = false; }
  toast('Sample data loaded ✓');
}

/* ── CSV PARSING ────────────────────────────────────────── */
function handleCSVFile() {
  const file = $('csvFile')?.files[0];
  if (file) processCSV(file);
}
function handleCSVDrop(e) {
  e.preventDefault();
  $('csvDropZone')?.classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.csv')) processCSV(file);
  else toast('Please drop a .csv file.', 'err');
}

function processCSV(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const raw = ev.target.result.replace(/\r/g, '').trim();
      const rows = raw.split('\n').filter(r => r.trim());
      if (rows.length < 2) throw new Error('File appears empty or has no data rows.');
      const headers = rows[0].toLowerCase().split(',').map(h => h.trim().replace(/["']/g, ''));
      const parsed  = [];

      for (let i = 1; i < rows.length; i++) {
        const vals = rows[i].split(',').map(v => v.trim().replace(/["']/g, ''));
        if (vals.length < 2) continue;
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });

        const m = (obj.month || '').toString().trim();;
        const hr = parseFloat(obj.heartrate  || obj.heart_rate  || obj.heartrate  || obj.hr    || 0) || null;
        const sl = parseFloat(obj.sleephours || obj.sleep_hours || obj.sleephours || obj.sleep  || 0) || null;
        const ac = parseFloat(obj.activityscore || obj.activity_score || obj.activityscore || obj.activity || 0) || null;
        const sp = parseFloat(obj.spo2 || obj.spo2 || obj.oxygen || 0) || null;;
        const st = parseFloat(obj.stressindex|| obj.stress_index|| obj.stressindex|| obj.stress || 0)      || null;
        if (!m) continue;
        parsed.push({ month: m, hr, sleep: sl, act: ac, spo2: sp, stress: st });
      }

      if (parsed.length === 0) throw new Error('No valid rows found. Check column names match the expected format.');
      healthData = parsed.sort((a, b) => MONTHS.indexOf(a.month) - MONTHS.indexOf(b.month));
      updateStatsAndChart();
      updateRiskBars();

      const succ = $('csvSuccess');
      if (succ) { succ.textContent = `✓ ${file.name} — ${parsed.length} months loaded`; succ.style.display = 'block'; }
      const ec = $('entry-count');
      if (ec) ec.textContent = `${parsed.length} months from CSV`;
      if (anyKey()) { const ab = $('analyzeBtn'); if (ab) ab.disabled = false; }
      toast(`CSV loaded: ${parsed.length} months ✓`);
    } catch (err) {
      toast('CSV error: ' + err.message, 'err');
    }
  };
  reader.readAsText(file);
}

/* ── CHART & STATS ──────────────────────────────────────── */
function updateStatsAndChart() {
  if (healthData.length === 0) return;
  const last = healthData[healthData.length - 1];
  const prev = healthData.length > 1 ? healthData[healthData.length - 2] : null;

  function setStat(id, val, unit) {
    const el = $(id); if (!el) return;
    el.innerHTML = val !== null ? `${val}<span> ${unit}</span>` : `—<span> ${unit}</span>`;
  }
  function setDelta(id, curr, prv, higherIsBetter = true) {
    const el = $(id); if (!el) return;
    if (curr === null || prv === null) { el.textContent = '—'; el.className = 'stat-delta delta-flat'; return; }
    const diff = (curr - prv).toFixed(1);
    const up   = parseFloat(diff) > 0;
    const good = higherIsBetter ? up : !up;
    el.textContent = `${up ? '↑' : '↓'} ${Math.abs(diff)} vs prior month`;
    el.className   = `stat-delta ${good ? 'delta-up' : 'delta-down'}`;
  }

  setStat('stat-hr',    last.hr,    'bpm');
  setStat('stat-sleep', last.sleep, 'hrs');
  setStat('stat-act',   last.act,   '/100');
  if (prev) {
    setDelta('delta-hr',    last.hr,    prev.hr,    false);  // lower HR → better
    setDelta('delta-sleep', last.sleep, prev.sleep, true);
    setDelta('delta-act',   last.act,   prev.act,   true);
  }
  renderChart();
}

function renderChart() {
  const canvas = $('healthChart');
  if (!canvas) return;
  if (healthChart) { healthChart.destroy(); healthChart = null; }

  healthChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: healthData.map(d => d.month.slice(0, 3)),
      datasets: [
        { label:'Heart Rate',  data: healthData.map(d => d.hr),    borderColor:'#fb7185', backgroundColor:'rgba(251,113,133,0.07)', borderWidth:2, tension:0.4, pointRadius:3, pointBackgroundColor:'#fb7185', fill:true, yAxisID:'y'  },
        { label:'Sleep (hrs)', data: healthData.map(d => d.sleep), borderColor:'#818cf8', backgroundColor:'rgba(129,140,248,0.07)', borderWidth:2, tension:0.4, pointRadius:3, pointBackgroundColor:'#818cf8', fill:true, yAxisID:'y1' },
        { label:'Activity',    data: healthData.map(d => d.act),   borderColor:'#22d3ee', backgroundColor:'rgba(34,211,238,0.06)',  borderWidth:2, tension:0.4, pointRadius:3, pointBackgroundColor:'#22d3ee', fill:true, yAxisID:'y2' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend:  { labels: { color:'rgba(226,232,240,0.5)', font:{ family:"'Space Mono'", size:9 }, boxWidth:10 } },
        tooltip: { backgroundColor:'rgba(8,12,18,0.95)', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, titleColor:'#e2e8f0', bodyColor:'#7c8fa6', padding:12 }
      },
      scales: {
        x:  { grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ color:'rgba(124,143,166,0.7)', font:{ size:9 } } },
        y:  { position:'left',  grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ color:'rgba(251,113,133,0.7)', font:{ size:9 } }, title:{ display:true, text:'BPM', color:'rgba(251,113,133,0.4)', font:{ size:9 } } },
        y1: { position:'right', grid:{ display:false },                  ticks:{ color:'rgba(129,140,248,0.7)', font:{ size:9 } }, title:{ display:true, text:'HRS', color:'rgba(129,140,248,0.4)', font:{ size:9 } } },
        y2: { position:'right', grid:{ display:false }, display:false }
      }
    }
  });
}

/* ── RISK BARS ──────────────────────────────────────────── */
function updateRiskBars() {
  if (healthData.length === 0) return;

  const avg = key => {
    const vals = healthData.map(d => d[key]).filter(v => v !== null && v !== undefined && !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const lastVal = key => {
    for (let i = healthData.length - 1; i >= 0; i--) if (healthData[i][key] !== null && healthData[i][key] !== undefined) return healthData[i][key];
    return null;
  };

  const avgHR     = avg('hr');
  const avgSleep  = avg('sleep');
  const avgAct    = avg('act');
  const avgStress = avg('stress');
  const latestSPO2= lastVal('spo2');

  if (avgHR     !== null) { const r = Math.min(100, Math.max(0, (avgHR - 55) * 2.5));   setRiskBar('cardio',    r, r < 30 ? 'Low' : r < 55 ? 'Moderate' : 'Elevated'); }
  if (avgSleep  !== null) { const r = Math.min(100, Math.max(0, 7 - avgSleep) * 35);     setRiskBar('sleep',     r, r < 20 ? 'None': r < 50 ? 'Moderate' : 'High'); }
  if (avgAct    !== null) { const r = Math.min(100, Math.max(0, (70 - avgAct) * 2));     setRiskBar('sedentary', r, r < 25 ? 'Low' : r < 55 ? 'Moderate' : 'High'); }
  if (avgStress !== null) {                                                                setRiskBar('stress', avgStress, avgStress < 35 ? 'Low' : avgStress < 55 ? 'Moderate' : 'Elevated'); }
  if (latestSPO2!== null) { const r = Math.min(100, Math.max(0, (98 - latestSPO2) * 20));setRiskBar('spo2',     r, r < 10 ? 'Normal' : r < 40 ? 'Watch' : 'Concern'); }
}

function setRiskBar(key, pct, label) {
  const rv = $('rv-' + key); const rb = $('rb-' + key);
  if (rv) rv.textContent = label;
  if (rb) { rb.style.width = pct + '%'; rb.style.background = pct < 30 ? 'var(--green)' : pct < 60 ? 'var(--amber)' : 'var(--rose)'; }
}

/* ── HEALTH AI ANALYSIS ─────────────────────────────────── */
async function analyzeHealth() {
  if (healthData.length === 0) return toast('Enter health data first.', 'err');

  const analyzeBtn = $('analyzeBtn');
  const loader     = $('healthLoader');
  const insight    = $('healthInsight');
  if (analyzeBtn) analyzeBtn.disabled = true;
  if (loader)     loader.classList.add('show');
  if (insight)    insight.style.display = 'none';

  // Compact serialization — caps tokens
  const rows = healthData.map(d =>
  [
    (d.month || '').slice(0, 3),
    d.hr ?? 'null',
    d.sleep ?? 'null',
    d.act ?? 'null',
    d.spo2 ?? 'null',
    d.stress ?? 'null'
  ].join(',')
).join('\n');

  const prompt = `You are a HIPAA-compliant health analytics assistant. All outputs are informational only — never diagnostic.
Analyze these CSV-formatted rows (DO NOT interpret as spreadsheet file, only raw text): (columns: month, HR_bpm, sleep_hrs, activity_0-100, spo2_%, stress_0-100):
${rows}

Return STRICT JSON ONLY. No markdown fences. No text before or after. Output must start with { and end with }:
{"summary":"<3 sentences: dominant trend, notable changes, overall trajectory — clinical neutral tone>","risk":"<1-2 sentences: one probabilistic risk using language like patterns may suggest or data indicates potential for>","recommendation":"<1 sentence: one evidence-based lifestyle action, no medication>"}`;

  try {
    const raw  = await callAI(prompt, 500);
    const json = safeParseJSON(raw);
    const text = $('insightText');
    const model= $('insightModel');
    if (text) text.innerHTML =
      `<strong style="color:var(--text);display:block;margin-bottom:6px">📋 Summary</strong>${json.summary || '—'}` +
      `<br><br><strong style="color:var(--amber);display:block;margin:8px 0 6px">⚠ Predicted Risk</strong>${json.risk || '—'}` +
      `<br><br><strong style="color:var(--green);display:block;margin:8px 0 6px">💡 Recommendation</strong>${json.recommendation || '—'}`;
    if (model) model.textContent = `AI Insight — ${
      keys.gemini      ? 'Gemini 2.5 Flash' :
      keys.groq        ? 'Groq (Llama 3.3 70B)' :
      keys.openrouter  ? 'OpenRouter (Llama 3.3 70B)' :
      keys.hf          ? 'HuggingFace (Mistral 7B)' :
                         'WebLLM (on-device Llama 3.2)'
    }`;
    if (insight) insight.style.display = 'block';
    toast('Analysis complete ✓');
  } catch (e) {
    toast('Analysis failed: ' + e.message, 'err');
  } finally {
    if (analyzeBtn) analyzeBtn.disabled = false;
    if (loader)     loader.classList.remove('show');
  }
}

/* ══════════════════════════════════════════════════════════
   PHISHING MODULE
   ══════════════════════════════════════════════════════════ */
function loadEmail(index) {
  const email = phishEmails?.[index];
  if (!email) return console.warn("No email at index", index);

  const set = (id, val) => {
    const el = $(id);
    if (el) el.textContent = val;
  };

  set('email-from', email.from);
  set('email-subject', email.subject);
  set('email-body', email.body);

  const flagEl = $('email-flags');
  if (flagEl) {
    flagEl.innerHTML = (email.redFlags || [])
      .map(f => `<span class="flag">${f}</span>`)
      .join('');
  }

  updateScoreRing();
}

/**
 * submitAnswer — called by the two quiz buttons in index.html:
 *   onclick="submitAnswer(true)"   → user guesses "Phishing"
 *   onclick="submitAnswer(false)"  → user guesses "Legitimate"
 *
 * Flow: record answer → show inline feedback → auto-advance after 2.2s
 */
function submitAnswer(userSaysPhishing) {
  if (sessionDone) return;

  const email   = phishEmails[currentEmail];
  if (!email) return;

  const correct = (userSaysPhishing === email.isPhishing);

  // Record answer
  phishAnswers[currentEmail] = {
    correct,
    userGuess: userSaysPhishing,
    email
  };

  if (correct) sessionCorrect++; else sessionWrong++;

  // Update score ring immediately
  updateScoreRing();

  // Update round pill for this email
  const pills = document.querySelectorAll('.round-pill');
  if (pills[currentEmail]) {
    pills[currentEmail].classList.add(correct ? 'pill-correct' : 'pill-wrong');
  }

  // Show feedback banner
  showAnswerFeedback(correct, email);

  // Disable both answer buttons to prevent double-submit
  setAnswerButtonsDisabled(true);

  // Auto-advance after 2.2 s
  setTimeout(() => {
    hideFeedback();
    setAnswerButtonsDisabled(false);
    nextEmail();
  }, 2200);
}

function showAnswerFeedback(correct, email) {
  // Try a dedicated feedback element first; fall back to a toast
  const fb = $('answer-feedback');
  if (fb) {
    fb.textContent  = correct
      ? `✅ Correct! ${email.explanation}`
      : `❌ Wrong — ${email.explanation}`;
    fb.className    = 'answer-feedback show ' + (correct ? 'feedback-correct' : 'feedback-wrong');
    fb.style.display = 'block';
    return;
  }
  // Fallback: toast
  toast(correct ? `✅ Correct! ${email.explanation}` : `❌ Wrong — ${email.explanation}`, correct ? 'ok' : 'err');
}

function hideFeedback() {
  const fb = $('answer-feedback');
  if (fb) { fb.classList.remove('show'); fb.style.display = 'none'; }
}

function setAnswerButtonsDisabled(disabled) {
  // Buttons are identified by data-answer attribute or by common IDs
  ['phishBtn', 'legitBtn', 'answerPhish', 'answerLegit'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = disabled;
  });
  // Also target any button with onclick containing submitAnswer
  document.querySelectorAll('button[onclick*="submitAnswer"]').forEach(btn => {
    btn.disabled = disabled;
  });
}

async function startPhishingSession() {

  const role  = $('phish-role')?.value || 'patient';
  const diff  = $('phish-difficulty')?.value || 'intermediate';
  const count = parseInt($('phish-count')?.value || '5');

  const startBtn = $('startPhishBtn');
  const loader   = $('phishLoader');

  if (startBtn) startBtn.disabled = true;
  if (loader) loader.classList.add('show');

  const phishCount   = Math.ceil(count * 0.6);   // ~60% phishing
  const legitCount   = count - phishCount;        // ~40% legitimate

  const diffGuide = {
    basic:        "Make phishing emails have very obvious red flags: misspelled domains, urgent ALL-CAPS threats, obvious grammar errors.",
    intermediate: "Mix subtle and obvious phishing. Some phishing emails look nearly legitimate; some legit emails look slightly suspicious.",
    advanced:     "Phishing emails must look almost indistinguishable from real hospital communications. Use correct grammar, plausible sender names, and realistic scenarios."
  }[diff] || '';

  const roleContext = {
    patient:         "The recipient is a hospital patient. Use scenarios like appointment reminders, lab results, insurance billing, patient portal logins, and prescription notifications.",
    nurse:           "The recipient is a hospital nurse. Use scenarios like shift schedule changes, EHR system updates, HR payroll, staff training links, and IT helpdesk tickets.",
    administrator:   "The recipient is a hospital administrator. Use scenarios like vendor invoices, compliance audits, board meeting links, budget approvals, and IT policy updates.",
    doctor:          "The recipient is a hospital physician. Use scenarios like CME credits, peer review requests, HIPAA policy updates, hospital credentialing, and referral case notes."
  }[role] || "The recipient is a hospital employee.";

  const prompt = `You are a hospital cybersecurity training expert generating realistic email simulation data.

${roleContext}
Difficulty: ${diffGuide}

Generate EXACTLY ${count} emails: ${phishCount} phishing and ${legitCount} legitimate. Mix their order randomly.

STRICT OUTPUT RULES:
- Output ONLY valid JSON — no markdown, no backticks, no explanations, no comments
- Output must start with { and end with }
- Every email body must be at least 3 sentences long and feel like a real work email
- Phishing emails must have EXACTLY 3 specific red flags in the redFlags array
- Legitimate emails must have redFlags = ["No phishing indicators — this is a legitimate email"]
- Sender addresses for phishing should use subtle typos or lookalike domains (e.g. medporta1.com, hospital-hr-dept.net)
- Sender addresses for legitimate emails should use believable real domains (e.g. noreply@massgeneral.org, hr@clevelandclinic.org)

JSON schema (respond with ONLY this structure):
{
  "emails": [
    {
      "from": "string (email address)",
      "subject": "string",
      "body": "string (minimum 3 sentences, realistic email tone)",
      "isPhishing": boolean,
      "redFlags": ["string", "string", "string"],
      "explanation": "string (1-2 sentences explaining why this is or isn't phishing)"
    }
  ]
}`;


  try {
    const raw = await callClaude(prompt, 1200);

    console.log("RAW MODEL OUTPUT:", raw);

    let json;
    try {
      json = safeParseJSON(raw);
    } catch (err) {
      console.error("PARSE FAILED RAW OUTPUT:", raw);
      throw new Error("Model output is not valid JSON");
    }

    if (!json || !Array.isArray(json.emails)) {
      console.error("INVALID STRUCTURE:", json);
      throw new Error("AI did not return emails array");
    }

    phishEmails = json.emails.map((e, i) => ({
      from: e.from || `noreply@medportal-health.com`,
      subject: e.subject || `Important Notice #${i + 1}`,
      body: e.body || "Email content unavailable.",
      isPhishing: typeof e.isPhishing === "boolean" ? e.isPhishing : false,
      redFlags: Array.isArray(e.redFlags) ? e.redFlags : [],
      explanation: e.explanation || "No explanation provided."
    }));

    phishAnswers = [];
    currentEmail = 0;
    sessionCorrect = 0;
    sessionWrong = 0;
    sessionDone = false;

    $('phish-setup').style.display = 'none';
    $('phish-result')?.classList.remove('show');
    $('phish-quiz').style.display = 'block';

    renderRoundPills();
    loadEmail(0);
    updateScoreRing();

    toast('Session started ✓');

  } catch (e) {
    toast('Failed to generate emails: ' + e.message, 'err');
    console.error(e);
  } finally {
    if (loader) loader.classList.remove('show');
    if (startBtn) startBtn.disabled = false;
  }
}

function renderRoundPills() {
  const el = $('result-pills');
  if (!el || !Array.isArray(phishEmails)) return;

  el.innerHTML = phishEmails.map((_, i) =>
    `<span class="round-pill">${i + 1}</span>`
  ).join('');
}

function nextEmail() {
  if (sessionDone) return;
  if (currentEmail >= phishEmails.length - 1) {
    sessionDone = true;
    showFinalScore();
    return;
  }
  currentEmail++;
  loadEmail(currentEmail);
}

function updateScoreRing() {
  const answered = sessionCorrect + sessionWrong;
  const pct = answered > 0 ? Math.round((sessionCorrect / answered) * 100) : 0;

  const arc = $('scoreArc');
  if (arc) {
    arc.style.strokeDashoffset = 276 - (276 * pct / 100);
    arc.style.stroke =
      pct >= 70 ? 'var(--green)' :
      pct >= 40 ? 'var(--amber)' :
      'var(--rose)';
  }

  const sv = $('scoreVal');
  if (sv) sv.textContent = pct + '%';

  const cc = $('correctCount');
  if (cc) cc.textContent = sessionCorrect;

  const wc = $('wrongCount');
  if (wc) wc.textContent = sessionWrong;
}

function showFinalScore() {
  const quiz  = $('phish-quiz');
  const panel = $('phish-result');

  if (quiz) quiz.style.display = 'none';
  if (panel) panel.classList.add('show');

  const total = phishEmails.length;
  const pct = total > 0 ? Math.round((sessionCorrect / total) * 100) : 0;

  const grade =
    pct >= 90 ? '🏆 Expert' :
    pct >= 70 ? '🥈 Proficient' :
    pct >= 50 ? '👍 Developing' :
    pct >= 30 ? '⚠ Needs Work' :
    '🚨 Vulnerable';

  const rs = $('result-score');
  const rt = $('result-title');
  const rb = $('result-sub');
  const rp = $('result-pills');

  if (rs) {
    rs.textContent = `${sessionCorrect}/${total}`;
    rs.style.color =
      pct >= 70 ? 'var(--green)' :
      pct >= 40 ? 'var(--amber)' :
      'var(--rose)';
  }

  if (rt) rt.textContent = grade + ' Awareness';
  if (rb) rb.textContent = `${pct}% accuracy across ${total} email${total !== 1 ? 's' : ''}`;

  if (rp) {
    rp.innerHTML = phishAnswers.map((a, i) =>
      `<span class="round-pill ${a.correct ? 'pill-correct' : 'pill-wrong'}" title="Email ${i + 1}: ${a.correct ? 'Correct' : 'Missed'}">${i + 1}</span>`
    ).join('');
  }
}

async function gradeSession() {

  const gradeBtn = $('gradeBtn');
  const resultLoader = $('resultLoader');
  const aiBox = $('result-ai-box');
  const aiText = $('result-ai-text');

  if (gradeBtn) gradeBtn.disabled = true;
  if (resultLoader) resultLoader.classList.add('show');

  const total = phishEmails.length;
  const pct = total > 0 ? Math.round((sessionCorrect / total) * 100) : 0;

  const missed = phishAnswers
    .filter(a => !a.correct)
    .map(a => a.email.isPhishing
      ? 'missed a phishing email'
      : 'flagged a legitimate email as phishing'
    )
    .join(', ');

  const prompt = `A user completed a hospital phishing awareness simulation. Score: ${sessionCorrect}/${total} (${pct}%). Errors: ${missed || 'none'}.
In 2-3 sentences, grade their awareness and give one specific actionable security tip. Be encouraging but direct.`;

  try {
    const raw = await callClaude(prompt, 400);
    if (aiText) aiText.textContent = raw.trim().replace(/^["']|["']$/g, '');
    if (aiBox) aiBox.style.display = 'block';
  } catch (e) {
    toast('Grading failed: ' + e.message, 'err');
  } finally {
    if (gradeBtn) gradeBtn.disabled = false;
    if (resultLoader) resultLoader.classList.remove('show');
  }
}

function resetPhishing() {
  phishEmails = [];
  phishAnswers = [];
  currentEmail = 0;
  sessionCorrect = 0;
  sessionWrong = 0;
  sessionDone = false;

  const quiz = $('phish-quiz');
  const result = $('phish-result');
  const setup = $('phish-setup');
  const startBtn = $('startPhishBtn');
  const aiBox = $('result-ai-box');
  const aiText = $('result-ai-text');

  if (quiz) quiz.style.display = 'none';
  if (result) result.classList.remove('show');
  if (setup) setup.style.display = 'block';
  if (startBtn) startBtn.disabled = false; // keyless — always available
  if (aiBox) aiBox.style.display = 'none';
  if (aiText) aiText.textContent = '';
}

document.addEventListener('DOMContentLoaded', () => {
  loadEnvKeys();

  // analyzeBtn is enabled once data is entered — WebLLM fallback means no key required
  const ab = $('analyzeBtn');
  if (ab) ab.disabled = true; // still disabled until data is entered

  // startPhishBtn always enabled — falls back through providers to WebLLM
  const sb = $('startPhishBtn');
  if (sb) sb.disabled = false;
});