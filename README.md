# HealthAI Nexus 🏥⚡

> A HIPAA-aware clinical intelligence platform built for hackathons.  
> Two tools, zero backend, one file to open.

---

## What It Does

### 📊 Patient Dashboard
Enter (or upload) monthly health metrics and get a live AI-powered analysis.

- **Manual entry** — add heart rate, sleep hours, activity score, SpO2, and stress index month by month
- **CSV upload** — drag and drop your wearable export; flexible column names are auto-detected
- **Live chart** — multi-axis Chart.js line graph updates every time you add a data point
- **Risk indicators** — five risk bars (cardiovascular, sleep deficit, sedentary, stress, SpO2) recalculate from real averages on every data change, not just after AI runs
- **AI insight** — one click sends your anonymised data to the LLM and returns a clinical-neutral summary, a probabilistic risk flag, and one lifestyle recommendation in structured JSON
- **No key required** — if no API keys are set the app falls back to an on-device model running entirely in your browser via WebGPU

### 🎣 Phishing Simulation
A security awareness quiz where you judge emails cold — no hints, no highlights.

- **Configure your session** — pick a target role (patient, clinician, admin), difficulty (basic → advanced), and number of emails (3, 5, or 8)
- **Read each email** — the AI generates a realistic mix of phishing AND legitimate emails so you can't just click "Phishing" every time
- **Make your call** — two buttons: Phishing or Legitimate. No pre-highlighted red flags — you have to spot them yourself
- **Reveal after each answer** — red flags and a one-sentence explanation appear only after you've committed; auto-advances after 2 seconds
- **Live score ring** — accuracy percentage and correct/wrong tally update in real time
- **Final AI report** — at the end, request a personalised 2–3 sentence grade with a specific security tip

---

## How to Run It

This is a static app — no Node, no npm, no build step.

### Option 1 — Just open the file (quickest)
```
double-click index.html
```
Works in Chrome and Edge. Firefox may block local `fetch()` calls for the `.env` loader — use Option 2 if that happens.

### Option 2 — Local static server (recommended)
```bash
# Python (built into every Mac/Linux)
cd healthai-nexus
python3 -m http.server 8080

# Then open:
http://localhost:8080
```

```bash
# Or with Node if you have it
npx serve .
```

### Option 3 — Deploy to Vercel (one command)
```bash
npm i -g vercel
cd healthai-nexus
vercel
```
Set your API keys as environment variables in the Vercel dashboard — they will **not** be read from `.env` in production (see Keys section below).

---

## API Keys

The app tries providers in order and shifts automatically if one fails or hits a quota:

```
Gemini 2.5 Flash → Groq (Llama 3.3 70B) → OpenRouter (Llama 3.3 70B) → HuggingFace (Mistral 7B) → WebLLM (in-browser)
```

**You don't need any key.** If nothing is configured the app loads a quantised Llama 3.2 model directly into your browser using WebGPU (~1.5 GB download, cached after the first run). For hackathon use, grabbing a free Gemini key takes 30 seconds and gives you the fastest, most reliable JSON output.

### Option A — Type them into the UI
Paste your key into the banner at the top of the page. Done.

### Option B — Store in `.env` (auto-loads on startup)
Edit the `.env` file in the project root:

```env
GEMINI_API_KEY=AIza...
GROQ_API_KEY=gsk_...
OPENROUTER_API_KEY=sk-or-...
HF_API_KEY=hf_...
```

Keys are read on page load via `fetch('.env')` and masked in the UI.  
**This only works when served locally** (Option 2 above). The file is gitignored.

### Where to get keys

| Provider | Link | Free tier | Notes |
|---|---|---|---|
| Gemini 2.5 Flash | [aistudio.google.com](https://aistudio.google.com/app/apikey) | Yes — generous | Primary; best JSON reliability |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | Yes — very fast | Llama 3.3 70B, near-instant responses |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | Yes — pay per token | Llama 3.3 70B free tier |
| HuggingFace | [hf.co/settings/tokens](https://huggingface.co/settings/tokens) | Yes — rate limited | Mistral 7B fallback |
| WebLLM | *(no key needed)* | Always free | Runs in-browser via WebGPU; requires Chrome 113+ or Edge 113+ |

### Adding the Groq key input to your HTML

The UI banner needs one new row for the Groq key (alongside the existing Gemini / OpenRouter / HF inputs):

```html
<input id="groqKey" placeholder="Groq API key (free at console.groq.com)"
       oninput="onKeyInput('groq')" />
<span id="groqStatus" class="api-status">not set</span>
```

---

## CSV Format

For the patient dashboard upload, use this column structure:

```csv
month,heartRate,sleepHours,activityScore,spo2,stressIndex
January,68,7.2,60,98,35
February,70,7.0,65,97,38
```

Flexible column name variants are accepted (`heart_rate`, `hr`, `sleep`, `activity`, etc.).  
Missing columns are tolerated.

---

## File Structure

```
healthai-nexus/
├── index.html        ← open this
├── .env              ← put your API keys here (gitignored)
├── .gitignore
├── css/
│   └── styles.css    ← all styles
└── js/
    └── app.js        ← all logic
```

---

## HIPAA Notice

This app is built with HIPAA principles in mind but **is not a certified HIPAA-compliant system**.

- All AI outputs are informational only — not diagnostic
- No patient data is stored, logged, or persisted anywhere
- De-identify all data before submission (remove names, DOB, MRN, and all 18 Safe Harbor identifiers)
- Your API key is stored in browser memory only and cleared on page close
- Do not enter real patient data without a signed BAA with your AI provider

---

## Built With

- Vanilla HTML, CSS, JavaScript — no framework, no bundler
- [Chart.js 4.4](https://www.chartjs.org/) — health trend visualisation
- [Gemini 2.5 Flash](https://deepmind.google/technologies/gemini/) — primary AI provider
- [Groq](https://groq.com/) — fast inference fallback (Llama 3.3 70B)
- [OpenRouter](https://openrouter.ai/) — secondary fallback (Llama 3.3 70B)
- [HuggingFace Inference API](https://huggingface.co/inference-api) — tertiary fallback (Mistral 7B)
- [WebLLM](https://webllm.mlc.ai/) — final fallback; runs Llama 3.2 entirely in-browser via WebGPU
- Space Grotesk + Syne + Space Mono — typography via Google Fonts