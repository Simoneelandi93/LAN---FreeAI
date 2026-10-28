// Model Sources — OmniRouter (repo) + OpenRouter (API)
// Everything is read from the upstream repos — no local daemon, no API keys.

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";
// OmniRouter catalog is read from the upstream repo (curated free-tier file) —
// the daemon needs an API key and its /v1/models is 401.
const OMNIRROUTER_CATALOG_URL =
  "https://raw.githubusercontent.com/cheaper-inference/OmniRoute/main/open-sse/config/freeModelCatalog.data.ts";

let allModels = [];        // { id, name, owner, source, input_price_per_m, output_price_per_m, context_window, is_free }
let filtered = [];
let activeSource = "OmniRouter";  // "OmniRouter" | "OpenRouter" | "both" | "lookup" | "boards" | "changes"
let activeFilter = "all";      // "all" | "free" | "paid"
let sortKey = "name";
let sortDir = "asc";
let visibleCount = 100000;  // Load all models at once

// Changelog state
let history = [];
let activeChangesRange = "all";   // "all" | "weekly" | "daily"
let activeAlertFilter = "alerted";  // default: only events that were sent to Telegram
let activeTypeFilter = "all";       // "all" | "new" (new_model + new_free_model only)
let omniFailed = false;
let orFailed = false;
const MILLIS_DAY = 86400000;

// Lookup state (data/lookup.json, built by scripts/build_lookup.py)
let lookupIndex = null;      // { byKey: Map, searchTerms: [{term, key}], ... } built lazily
let lookupData = null;       // raw {generated_at, models}

// Boards state (data/leaderboard.json — OpenRouter usage; scores come from llm_stats.json)
let leaderboard = null;      // { generated_at, source, window, usage[] }
let activeBoard = "usage";   // "usage" | "free"
let scoreById = new Map();   // llm_stats_id -> {name, score, rank}

// ---------- Persisted view state ----------
// Remembers the last view across refreshes. Deliberately excludes the search
// box: a half-typed query surviving a reload is more annoying than useful.
const STORAGE_KEY = "modelSources.view.v1";

function loadSavedState() {
  let saved = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch (e) { /* storage unavailable or corrupt — fall back to defaults */ }
  if (!saved || typeof saved !== "object") return;

  // Guard each value against a left-over from a renamed or removed filter.
  const allowed = {
    activeSource: ["OmniRouter", "OpenRouter", "both", "lookup", "boards", "changes"],
    activeFilter: ["all", "free", "paid"],
    activeChangesRange: ["all", "weekly", "daily"],
    activeAlertFilter: ["alerted", "all", "silent"],
    activeTypeFilter: ["all", "new"],
    sortDir: ["asc", "desc"],
  };
  if (["usage", "free"].includes(saved.activeBoard)) activeBoard = saved.activeBoard;
  if (allowed.activeSource.includes(saved.activeSource)) activeSource = saved.activeSource;
  if (allowed.activeFilter.includes(saved.activeFilter)) activeFilter = saved.activeFilter;
  if (allowed.activeChangesRange.includes(saved.activeChangesRange)) activeChangesRange = saved.activeChangesRange;
  if (allowed.activeAlertFilter.includes(saved.activeAlertFilter)) activeAlertFilter = saved.activeAlertFilter;
  if (allowed.activeTypeFilter.includes(saved.activeTypeFilter)) activeTypeFilter = saved.activeTypeFilter;
  if (typeof saved.sortKey === "string" && saved.sortKey) sortKey = saved.sortKey;
  if (allowed.sortDir.includes(saved.sortDir)) sortDir = saved.sortDir;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      activeSource, activeFilter, sortKey, sortDir,
      activeChangesRange, activeAlertFilter, activeTypeFilter, activeBoard,
    }));
  } catch (e) { /* private mode / quota — nothing to do */ }
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
}

function isInvalidText(val) {
  if (val === null || val === undefined) return true;
  const s = String(val).trim().toLowerCase();
  return s === "" || s === "nan" || s === "null" || s === "undefined" || s === "none";
}

function getModelName(m) {
  if (!isInvalidText(m.name)) return String(m.name).trim();
  if (!isInvalidText(m.id)) return String(m.id).trim();
  return "Unnamed Model";
}

function price(v) {
  if (isInvalidText(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function fmtPrice(v) {
  if (v === null || v === undefined) return '<span class="cell-na">—</span>';
  if (v === 0) return '<span class="text-emerald font-semibold">$0</span>';
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

function fmtContext(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '<span class="cell-na">—</span>';
  return n >= 1000 ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}k` : String(n);
}

function fmtScore(m) {
  if (m.score === null || m.score === undefined) return '<span class="cell-na">—</span>';
  const s = Number(m.score);
  if (!Number.isFinite(s)) return '<span class="cell-na">—</span>';
  const elo = Number(m.elo);
  return `<span class="score-val" title="Artificial Analysis intelligence index${Number.isFinite(elo) && elo > 0 ? ` · Design Arena ELO ${elo}` : ""}">${s.toFixed(1)}</span>`;
}

function scoreSortValue(m) {
  if (m.score === null || m.score === undefined) return -1;  // unscored sort below all
  const s = Number(m.score);
  return Number.isFinite(s) ? s : -1;
}

function sourceBadge(source) {
  const label = source === "OmniRouter" ? "OmniRouter" : "OpenRouter";
  const cls = source === "OpenRouter" ? "source-badge-remote" : "source-badge-local";
  return `<span class="${cls}">${label}</span>`;
}

// ---------- Fetching ----------

// OmniRouter's free-tier catalog is a hand-curated TypeScript array. Parsing it
// in the browser keeps the page working even when the local daemon is down (401).
async function fetchOmniRouterModels() {
  try {
    const res = await fetch(OMNIRROUTER_CATALOG_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const list = parseOmniCatalog(text);
    document.getElementById("statusOmniRouterLabel").textContent = `Omni: ${list.length} free`;
    document.getElementById("statusOmniRouter").style.background = "#10b981";
    return list;
  } catch (e) {
    omniFailed = true;
    const msg = e instanceof Error && /^HTTP \d+$/.test(e.message) ? e.message : "offline";
    document.getElementById("statusOmniRouterLabel").textContent = `Omni: ${msg}`;
    document.getElementById("statusOmniRouter").style.background = "#f59e0b";
    return [];
  }
}

// Extracts entries like:
//   { provider: "agy", modelId: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", monthlyTokens: 0, creditTokens: 0, freeType: "keyless", poolKey: "agy", tos: "avoid" },
//   { provider: "xkiro", modelId: "qwen/qwen3-max:free", displayName: "Qwen3 Max (xKiro)", monthlyTokens: 150000000, creditTokens: 0, freeType: "recurring-daily", poolKey: "xkiro-free", tos: "caution", hardStopGuaranteed: true },
// freeType "discontinued" means the tier is gone — skip it.
function parseOmniCatalog(text) {
  const start = text.indexOf("FREE_MODEL_BUDGETS");
  if (start === -1) return [];
  const bracket = text.indexOf("[", start);
  const end = text.indexOf("];", bracket);
  if (bracket === -1 || end === -1) return [];
  const body = text.slice(bracket, end);

  const out = [];
  // [^}]* before the closing } handles optional trailing fields (e.g., hardStopGuaranteed)
  const lineRe = /\{\s*provider:\s*"([^"]*)"[\s\S]*?modelId:\s*"([^"]*)"[\s\S]*?displayName:\s*"([^"]*)"[\s\S]*?monthlyTokens:\s*(\d+)[\s\S]*?creditTokens:\s*(\d+)[\s\S]*?freeType:\s*"([^"]*)"[\s\S]*?poolKey:\s*"([^"]*)"[\s\S]*?tos:\s*"([^"]*)"[^}]*\}/g;
  let match;
  while ((match = lineRe.exec(body)) !== null) {
    const [, provider, modelId, displayName, monthlyTokens, creditTokens, freeType, poolKey, tos] = match;
    if (freeType === "discontinued") continue;
    const quota = Number(monthlyTokens) > 0
      ? `${(Number(monthlyTokens) / 1_000_000).toFixed(1)}M/mo`
      : Number(creditTokens) > 0
        ? `${(Number(creditTokens) / 1_000_000).toFixed(0)}M one-time`
        : "unlimited";
    out.push({
      id: `${provider}/${modelId}`,
      name: displayName,
      owner: provider,
      source: "OmniRouter",
      input_price_per_m: 0,
      output_price_per_m: 0,
      context_window: 0,
      is_free: true,
      free_type: freeType,
      quota,
      tos,
    });
  }
  return out;
}

async function fetchOpenRouterModels() {
  try {
    const res = await fetch(OPENROUTER_API_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body?.data) ? body.data : [];
    document.getElementById("statusOpenRouterLabel").textContent = `OR: ${list.length} models`;
    document.getElementById("statusOpenRouter").style.background = "#10b981";
    return list.map(m => {
      const prompt = Number(m.pricing?.prompt ?? 0) * 1_000_000;
      const completion = Number(m.pricing?.completion ?? 0) * 1_000_000;
      const isFree = String(m.id || "").includes(":free") || (prompt === 0 && completion === 0);
      return {
        id: m.id || "",
        name: m.name || m.id || "",
        owner: m.owned_by || m.id?.split("/")[0] || "",
        source: "OpenRouter",
        input_price_per_m: round4(prompt),
        output_price_per_m: round4(completion),
        context_window: Number(m.context_length ?? 0) || 0,
        is_free: isFree,
        // Artificial Analysis intelligence index (0–100), shipped in the same
        // payload — no extra request. design_arena ELO kept as a sub-line.
        score: ((m.benchmarks || {}).artificial_analysis || {}).intelligence_index ?? null,
        elo: (m.benchmarks?.design_arena || []).reduce((best, d) => (d?.elo > best ? d.elo : best), 0) || null,
      };
    }).filter(m => m.id);
  } catch (e) {
    orFailed = true;
    const msg = e instanceof Error && /^HTTP \d+$/.test(e.message) ? e.message : "offline";
    document.getElementById("statusOpenRouterLabel").textContent = `OR: ${msg}`;
    document.getElementById("statusOpenRouter").style.background = "#f59e0b";
    return [];
  }
}

function round4(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

// ---------- Score inheritance ----------
// OmniRouter rows have no benchmark data of their own. Each row inherits a
// score from OpenRouter (same API payload) or from the repo's llm_stats.json
// (built by the Telegram pipeline; read here, never written).

// Fetch llm_stats.json as {normalizedName: score}. Tries both relative paths
// so the page works when served from the repo root or from site/.
async function loadScoreIndex() {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const url of ["data/llm_stats.json", "../data/llm_stats.json"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const stats = await res.json();
      const idx = {};
      for (const v of Object.values(stats || {})) {
        const name = String(v?.name || "");
        const raw = v?.score;
        const score = Number(raw);
        if (!name || raw === null || raw === undefined || !Number.isFinite(score)) continue;
        const key = norm(name);
        if (!idx[key]) idx[key] = score;
        const sorted = norm(name.split(/\s+/).sort().join(" "));
        if (!idx[sorted]) idx[sorted] = score;
      }
      if (Object.keys(idx).length) return idx;
    } catch (e) { /* try the next path */ }
  }
  return {};
}

// Match chain (measured at 62% coverage on the live catalog):
// 1. OpenRouter exact id        — agnes/agnes-2.0-flash
// 2. OpenRouter normalized last segment or "Vendor: Name" — gemini38flash
// 3. displayName without parens vs llm_stats / OpenRouter names
// 4. word-order-insensitive displayName vs llm_stats
function assignScores(omniModels, orModels, scoreIndex) {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const or_exact = new Map();
  const or_seg = new Map();
  for (const m of orModels) {
    if (m.score === null || m.score === undefined) continue;
    const s = Number(m.score);
    if (!Number.isFinite(s)) continue;
    or_exact.set(m.id, s);
    or_seg.set(norm(m.id.split("/").pop()), s);
    or_seg.set(norm(m.name.split(":").pop().trim()), s);
  }
  for (const m of omniModels) {
    const modelId = m.id.split("/").slice(1).join("/") || m.id;
    const seg = norm(modelId.split(":")[0].split("/").pop());
    if (or_exact.has(modelId) || or_exact.has(m.id)) { m.score = or_exact.get(modelId) ?? or_exact.get(m.id); continue; }
    if (or_seg.has(seg)) { m.score = or_seg.get(seg); continue; }
    const dn = norm(String(m.name).split("(")[0].trim());
    if (dn && (dn in scoreIndex || or_seg.has(dn))) { m.score = scoreIndex[dn] ?? or_seg.get(dn); continue; }
    const dnSorted = norm(String(m.name).split("(")[0].trim().split(/\s+/).sort().join(" "));
    if (dnSorted && dnSorted in scoreIndex) m.score = scoreIndex[dnSorted];
    else m.score = null;
  }
  // OmniRouter rows start unscored; make sure fetched rows carry the field too.
  for (const m of omniModels) if (m.score === undefined) m.score = null;
}

// ---------- Changelog ----------
// data/history.json is the last 200 delta events written by the collect
// pipeline. Read-only here — the page never writes it.

async function fetchHistory() {
  // Same dual-path fallback as data/*.json: works from repo root and on Pages.
  for (const url of ["data/history.json", "../data/history.json"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) { /* try the next path */ }
  }
  return [];
}

// ---------- Model lookup ----------
// data/lookup.json groups every catalog row under one canonical name, with each
// provider's price/tier/quota attached. The search is deliberately forgiving:
// "glm5" must find "GLM-5.3", "opus 5.5" must find "Claude Opus 5.5".

async function fetchLookup() {
  for (const url of ["data/lookup.json", "../data/lookup.json"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.models) return data;
    } catch (e) { /* try the next path */ }
  }
  return null;
}

function normToken(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
}

function editDistanceLE(a, b, max) {
  // Optimal-string-alignment distance (Levenshtein + adjacent transposition):
  // "cluade" vs "claude" is a transposition and must count as distance 1.
  // Bails out early once even the best cell in a row exceeds max.
  if (Math.abs(a.length - b.length) > max) return false;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (prev2[j - 2] ?? Infinity) + 1);
      }
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return false;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] <= max;
}

function buildLookupIndex(data) {
  const byKey = new Map();
  const searchTerms = [];   // {term, key, weight}
  const idToKey = new Map();  // normalized provider model_id / full_id -> canonical key
  for (const [key, entry] of Object.entries(data.models)) {
    byKey.set(key, entry);
    // Canonical name, full weight; also token-split so "opus 5.5" matches "claude opus 5.5".
    searchTerms.push({ term: key, key, weight: 0 });
    for (const t of key.split(/\s+/)) {
      if (t.length >= 2) searchTerms.push({ term: t, key, weight: 1 });
    }
    // Model IDs carry spellings display names lack (claude-opus-5.5).
    const ids = new Set(entry.providers.map(p => normToken(p.model_id)).filter(t => t.length >= 4));
    for (const id of ids) {
      searchTerms.push({ term: id, key, weight: 2 });
      if (!idToKey.has(id)) idToKey.set(id, key);
    }
    for (const p of entry.providers) {
      const full = normToken(p.full_id);
      if (full.length >= 4 && !idToKey.has(full)) idToKey.set(full, key);
    }
  }
  return { byKey, searchTerms, idToKey };
}

// Resolves a board row (OpenRouter id or display name) to a canonical lookup
// entry, so the boards can show our score and link into the Lookup tab.
function entryForBoardRow({ openrouterId = "", name = "" } = {}) {
  if (!lookupIndex) return null;
  const byId = openrouterId ? lookupIndex.idToKey.get(normToken(openrouterId)) : null;
  if (byId) return lookupIndex.byKey.get(byId);
  if (!name) return null;
  const n = normToken(name);
  for (const [key, entry] of lookupIndex.byKey) {
    if (normToken(key) === n) return entry;
  }
  return null;
}

function scoreForEntry(entry) {
  if (!entry || !entry.llm_stats_id) return null;
  const s = Number((scoreById.get(entry.llm_stats_id) || {}).score);
  return Number.isFinite(s) ? s : null;
}

const LK_JUMP_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

function jumpBtnHTML(query) {
  return `<button class="lk-jump" data-jump="${esc(query)}" title="Open this model in the Lookup tab — all providers, free tiers, quotas">${LK_JUMP_SVG} Lookup</button>`;
}

function jumpToLookup(query) {
  activeSource = "lookup";
  const input = document.getElementById("searchInput");
  input.value = query;
  saveState();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function searchLookup(query) {
  if (!lookupIndex) return { exact: [], near: [] };
  const q = normToken(query);
  if (!q) return { exact: [], near: [] };
  const exact = new Map();   // key -> rank (lower = better)
  const near = new Map();

  const consider = (key, rank) => {
    const cur = exact.get(key);
    if (cur === undefined || rank < cur) exact.set(key, rank);
  };
  const suggest = (key, rank) => {
    const cur = near.get(key);
    if (cur === undefined || rank < cur) near.set(key, rank);
  };

  for (const { term, key, weight } of lookupIndex.searchTerms) {
    // Substring hits rank by position (earlier = more specific).
    const idx = term.indexOf(q);
    if (idx !== -1) {
      consider(key, weight * 100 + idx + (term.length === q.length ? -50 : 0));
      continue;
    }
    // Typo tolerance on the whole term, close in length only.
    if (q.length >= 4 && Math.abs(term.length - q.length) <= Math.max(2, q.length >> 2)
        && editDistanceLE(term, q, q.length <= 6 ? 1 : 2)) {
      suggest(key, 10 + weight);
    }
  }
  // Multi-word queries: "cluade opus" must match "claude opus 5.5" even though
  // the concatenated tokens are far apart. Score each term by how many of the
  // query's words it matches (substring or typo-distance-1).
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  if (words.length > 1 || (!exact.size && !near.size)) {
    for (const [key, entry] of lookupIndex.byKey) {
      const hay = key.split(/\s+/);
      let matched = 0;
      for (const w of words) {
        const wn = normToken(w);
        if (!wn) { matched++; continue; }
        // Longer words get distance 2 ("gmaio" → "gemini"); short ones only 1.
        const typoDist = wn.length >= 5 ? 2 : 1;
        let hit = hay.some(t => {
          const tn = normToken(t);
          if (tn.includes(wn)) return true;
          // IDs spelled claude-opus-5.5: compare pieces too.
          return tn.split(/[.-]/).some(piece => piece === wn || (wn.length >= 4 && piece.length >= 4 && editDistanceLE(piece, wn, 1)));
        });
        if (!hit && wn.length >= 4) {
          hit = hay.some(t => {
            const tn = normToken(t);
            return tn.length >= 4 && editDistanceLE(tn, wn, typoDist);
          });
        }
        if (hit) matched++;
      }
      if (matched === words.length && words.length) {
        // All words matched — a real (possibly typo'd) multi-word hit.
        consider(key, 200 + (entry.has_free ? 0 : 50));
      } else if (matched >= Math.ceil(words.length * 0.6) && words.length >= 2) {
        suggest(key, 20 + (words.length - matched));
      }
    }
  }
  const toSorted = (m, limit) => [...m.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => lookupIndex.byKey.get(key));
  return { exact: toSorted(exact, 8), near: toSorted(near, 6) };
}

// Same-family cards with a free provider, ranked by name similarity to the target.
function freeAlternatives(entry) {
  if (!lookupIndex) return [];
  const fam = entry.family;
  const nameTokens = new Set(normToken(entry.name).split(".").flatMap(t => t.split("-")).filter(t => t.length >= 3));
  const out = [];
  for (const [key, other] of lookupIndex.byKey) {
    if (other === entry || !other.has_free) continue;
    let score = 0;
    if (fam && other.family === fam) score += 2;
    let overlap = 0;
    for (const t of nameTokens) {
      for (const ot of key.split(/\s+/)) {
        if (ot === t || (t.length >= 4 && editDistanceLE(ot, t, 1))) { overlap++; break; }
      }
    }
    score += overlap;
    if (score >= 2) out.push([other, score]);
  }
  return out.sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name))
    .slice(0, 4).map(([e]) => e);
}

const TIER_LABELS = {
  free: "Free",
  free_quota: "Free · quota",
  credit: "Credits",
  paid: "Paid",
};
const TIER_DESC = {
  free: "No cost, no card — use it as long as the provider offers it.",
  free_quota: "No cost, but capped: check the request/token quota.",
  credit: "Free via signup credits or a trial — burns out.",
  paid: "Pay per token.",
};

function fmtCardPrice(p) {
  if (p.tier === "free") return "$0";
  if (p.tier === "free_quota") return "$0";
  const inP = Number(p.price_in), outP = Number(p.price_out);
  if (Number.isFinite(inP) || Number.isFinite(outP)) {
    const f = v => Number.isFinite(v) ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "?";
    return `${f(inP)} / ${f(outP)} per 1M`;
  }
  return "—";
}

function fmtChecked(p) {
  // Freshness label for community-reported quotas. After ~30 days the entry
  // gray-stamps: still shown, but visibly stale.
  if (!p.checked_at) return "";
  const d = new Date(p.checked_at);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / MILLIS_DAY);
  const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (days > 30) return `<span class="lk-stale" title="Quota last confirmed ${days} days ago — may be outdated">checked ${esc(label)} · stale</span>`;
  return `<span class="lk-checked" title="Quota confirmed against the provider directory ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}">checked ${esc(label)}</span>`;
}

function lookupCardHTML(entry, { isAlt = false } = {}) {
  const groups = {};
  for (const p of entry.providers) (groups[p.tier] = groups[p.tier] || []).push(p);
  const tierOrder = ["free", "free_quota", "credit", "paid"];
  const ctx = entry.context_window ? `<span class="lk-ctx">${fmtContext(entry.context_window)} context</span>` : "";
  const sections = tierOrder.filter(t => groups[t]).map(t => {
    const rows = groups[t].map(p => {
      const copyId = esc(p.model_id || "");
      const quota = p.quota ? `<span class="lk-quota">${esc(p.quota)}</span>` : "";
      const checked = fmtChecked(p);
      const card = p.requires_card ? `<span class="lk-card-req" title="Provider requires a payment method on file">card required</span>` : "";
      const link = p.provider_url || p.offer_url;
      const provName = esc(p.provider || p.provider_id || "provider");
      return `<div class="lk-provider">
        <span class="lk-provider-name">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${provName}</a>` : provName}</span>
        <code class="lk-model-id" title="Copy model ID" data-copy="${copyId}">${copyId}</code>
        <span class="lk-price">${fmtCardPrice(p)}</span>
        ${quota}${checked}${card}
      </div>`;
    }).join("");
    return `<div class="lk-tier lk-tier-${t}">
      <div class="lk-tier-head"><span class="lk-tier-label">${TIER_LABELS[t]}</span><span class="lk-tier-desc">${TIER_DESC[t]}</span></div>
      ${rows}
    </div>`;
  }).join("");
  const altTag = isAlt ? `<span class="lk-alt-tag">closest free alternative</span>` : "";
  return `<article class="lk-card${isAlt ? " lk-card-alt" : ""}">
    <div class="lk-card-head">
      <h4>${esc(entry.name)}</h4>
      ${ctx}${altTag}
    </div>
    ${sections}
  </article>`;
}

function renderLookup(query) {
  const results = document.getElementById("lookupResults");
  const intro = document.getElementById("lookupIntro");
  if (!lookupData) {
    intro.hidden = false;
    results.innerHTML = `<div class="empty"><h3>Lookup data unavailable</h3><p>The next catalog sync will generate it (scripts/build_lookup.py).</p></div>`;
    return;
  }
  if (!query) {
    intro.hidden = false;
    // Landing state: a few free picks so the tab is never blank.
    const picks = Object.entries(lookupData.models)
      .filter(([, e]) => e.has_free && e.providers.length >= 2)
      .slice(0, 6).map(([, e]) => lookupCardHTML(e)).join("");
    results.innerHTML = `<div class="lk-section-title">Recently available free models</div>${picks}`;
    return;
  }
  intro.hidden = true;
  const { exact, near } = searchLookup(query);
  if (!exact.length && !near.length) {
    results.innerHTML = `<div class="empty"><h3>No match for "${esc(query)}"</h3><p>Try a shorter fragment of the name — "opus", "gemini", "kimi".</p></div>`;
    return;
  }
  const exactHTML = exact.map(e => lookupCardHTML(e)).join("");
  let html = exact.length ? `<div class="lk-section-title">${exact.length} match${exact.length === 1 ? "" : "es"}</div>${exactHTML}` : "";
  if (!exact.length && near.length) {
    // Query matched only fuzzily — show those as primary.
    html = `<div class="lk-section-title">Did you mean…</div>${near.map(e => lookupCardHTML(e)).join("")}`;
  } else if (near.length) {
    html += `<div class="lk-section-title">Similar names</div>${near.map(e => lookupCardHTML(e)).join("")}`;
  }
  // Killer feature: a dead-end query (exact match exists, no free provider)
  // must still return something actionable. Near-duplicate cards ("Claude Opus
  // 5.5" / "Anthropic Claude Opus 5.5") share alternatives, so collect and
  // dedupe instead of emitting a section per card.
  const deadEnds = exact.filter(e => !e.has_free);
  if (deadEnds.length) {
    const seenAlts = new Set();
    const alts = [];
    for (const e of deadEnds) {
      for (const a of freeAlternatives(e)) {
        if (!seenAlts.has(a.name)) { seenAlts.add(a.name); alts.push(a); }
      }
    }
    const label = deadEnds.length === 1
      ? `No free source for ${esc(deadEnds[0].name)} — closest free alternatives`
      : `No free source for ${esc(deadEnds[0].name)}${deadEnds.length > 2 ? ` and ${deadEnds.length - 1} similar` : " and similar"} — closest free alternatives`;
    if (alts.length) {
      html += `<div class="lk-section-title lk-alt-title">${label}</div>${alts.map(a => lookupCardHTML(a, { isAlt: true })).join("")}`;
    } else {
      html += `<div class="lk-alt-title lk-none">No free source for ${esc(deadEnds[0].name)} is known right now — and no close free alternative either. Cheapest paid: ${esc((deadEnds[0].providers[0] || {}).provider || "?")} at ${fmtCardPrice(deadEnds[0].providers[0] || {})}</div>`;
    }
  }
  results.innerHTML = html;
}

// Copy-to-clipboard via event delegation: cards re-render on every keystroke.
// The boards body gets its own listener for the Lookup jump buttons — same
// delegation pattern, since board tables re-render on every tab switch.
function setupLookupCopy() {
  // One shared copy handler for every container that can hold a .lk-model-id
  // (lookup cards AND board rows) — delegated, since both re-render often.
  const copyHandler = async e => {
    const el = e.target.closest(".lk-model-id");
    if (!el) return;
    const text = el.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Clipboard API denied (non-secure origin / permission): fall back to a
      // temporary textarea + execCommand, which still works in most browsers.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* give up silently */ }
      ta.remove();
    }
    el.classList.add("copied");
    el.title = "Copied!";
    setTimeout(() => { el.classList.remove("copied"); el.title = "Copy model ID"; }, 1200);
  };
  document.getElementById("lookupResults").addEventListener("click", copyHandler);
  document.getElementById("boardsBody").addEventListener("click", copyHandler);

  document.getElementById("boardsBody").addEventListener("click", e => {
    const btn = e.target.closest(".lk-jump");
    if (!btn) return;
    jumpToLookup(btn.dataset.jump);
  });
}

// ---------- Boards ----------
// "Most Used" = real OpenRouter token volume (ingested daily).
// "Best FREE" = LLM Stats benchmark score joined onto free providers from lookup.json.
// Usage ≠ quality: the two boards intentionally disagree.

async function loadScoreMap() {
  // {llm_stats_id: payload} — same file loadScoreIndex() reads, richer payload.
  for (const url of ["data/llm_stats.json", "../data/llm_stats.json"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const stats = await res.json();
      const map = new Map();
      for (const v of Object.values(stats || {})) {
        if (v && v.id) map.set(v.id, v);
      }
      if (map.size) return map;
    } catch (e) { /* try the next path */ }
  }
  return new Map();
}
// "Most Used" = real OpenRouter token volume (ingested daily).
// "Best FREE" = LLM Stats benchmark score joined onto free providers from lookup.json.
// Usage ≠ quality: the two boards intentionally disagree.

async function fetchLeaderboard() {
  for (const url of ["data/leaderboard.json", "../data/leaderboard.json"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.usage)) return data;
    } catch (e) { /* try the next path */ }
  }
  return null;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n.toLocaleString();
}

function renderUsageBoard() {
  const body = document.getElementById("boardsBody");
  const note = document.getElementById("boardsNote");
  if (!leaderboard || !leaderboard.usage.length) {
    note.textContent = "";
    body.innerHTML = `<div class="empty"><h3>Usage rankings unavailable</h3><p>The next catalog sync will fetch them.</p></div>`;
    return;
  }
  note.textContent = `Used: OpenRouter token volume, ${leaderboard.window} · ingested ${new Date(leaderboard.generated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} — market demand, not quality. Traffic concentrates on cheap models.`;
  const rows = leaderboard.usage.map(r => {
    const change = Number(r.change);
    const changeCls = change > 0 ? "rise" : change < 0 ? "drop" : "";
    const changeTxt = change > 0 ? `▲${change}` : change < 0 ? `▼${Math.abs(change)}` : "·";
    const entry = entryForBoardRow({ openrouterId: r.openrouter_id, name: r.name });
    const score = scoreForEntry(entry);
    const scoreCell = score === null ? '<span class="cell-na">—</span>' : `<span class="score-val">${score.toFixed(1)}</span>`;
    const query = entry ? entry.name : r.name;
    return `<tr>
      <td class="text-right">${r.rank}</td>
      <td><span class="lb-name">${esc(r.name)}</span>${r.free ? `<span class="lb-free-badge">free</span>` : ""}</td>
      <td class="text-center">${esc(r.provider)}</td>
      <td class="text-right lb-tokens">${esc(r.tokens_display || fmtTokens(r.tokens))}</td>
      <td class="text-right">${fmtTokens(r.requests)}</td>
      <td class="text-center score-col">${scoreCell}</td>
      <td class="text-center"><span class="chg-tag ${changeCls}">${changeTxt}</span></td>
      <td class="text-center">${jumpBtnHTML(query)}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `<table class="model-table lb-table">
    <thead><tr>
      <th class="text-right">#</th><th>Model</th><th class="text-center">Provider</th>
      <th class="text-right">Tokens/wk</th><th class="text-right">Requests/wk</th>
      <th class="text-center score-col" title="LLM Stats benchmark score — quality, from a different source than usage">Score</th>
      <th class="text-center">±</th><th class="text-center">Providers</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// Best FREE: lookup cards with a free provider, ranked by LLM Stats score.
// Free tier quality of the provider row itself isn't benchmarked separately —
// the score is the model family's, which is the honest framing shown in the note.
function bestFreeRows() {
  if (!lookupIndex) return [];
  const rows = [];
  for (const entry of lookupIndex.byKey.values()) {
    if (!entry.has_free || !entry.llm_stats_id) continue;
    const stats = scoreById.get(entry.llm_stats_id);
    if (!stats || !Number.isFinite(Number(stats.score))) continue;
    const freeProviders = entry.providers.filter(p => p.tier === "free" || p.tier === "free_quota");
    rows.push({ entry, stats, freeProviders, score: Number(stats.score) });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 25);
}

function renderFreeBoard() {
  const body = document.getElementById("boardsBody");
  const note = document.getElementById("boardsNote");
  const rows = bestFreeRows();
  if (!rows.length) {
    note.textContent = "";
    body.innerHTML = `<div class="empty"><h3>No scored free models</h3><p>Needs both lookup.json and llm_stats.json — waiting on the next sync.</p></div>`;
    return;
  }
  note.textContent = "Best: LLM Stats benchmark score (artificial-analysis-style intelligence index), filtered to models with a free provider. Free-tier quotas are on each model's Lookup card.";
  const trs = rows.map((r, i) => {
    const provs = r.freeProviders.slice(0, 3).map(p => esc(p.provider)).join(", ");
    const more = r.freeProviders.length > 3 ? ` +${r.freeProviders.length - 3}` : "";
    const firstId = r.freeProviders[0]?.model_id || "";
    return `<tr>
      <td class="text-right">${i + 1}</td>
      <td><span class="lb-name lk-model-id" data-copy="${esc(firstId)}" title="Copy ${esc(firstId)} — open Lookup for all providers">${esc(r.entry.name)}</span></td>
      <td class="text-right"><span class="score-val">${r.score.toFixed(1)}</span></td>
      <td class="text-center">${fmtContext(r.entry.context_window)}</td>
      <td>${provs}${more}</td>
      <td class="text-center">${jumpBtnHTML(r.entry.name)}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `<table class="model-table lb-table">
    <thead><tr>
      <th class="text-right">#</th><th>Model</th><th class="text-right">Score</th>
      <th class="text-center">Context</th><th>Free at</th><th class="text-center">Details</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}

function renderBoards() {
  const note = document.getElementById("boardsNote");
  document.querySelectorAll("#boardsView .board-btn").forEach(b => {
    const on = b.dataset.board === activeBoard;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  if (activeBoard === "usage") renderUsageBoard();
  else renderFreeBoard();
  if (note.textContent) {
    const src = activeBoard === "usage" ? leaderboard?.source : "llm-stats.com via data/llm_stats.json";
    note.title = src ? `Source: ${src}` : "";
  }
}

const CHANGE_TYPE_LABELS = {
  new_model: "New Model",
  new_free_model: "New Free Model",
  price_change: "Price Change",
  model_became_free: "Free Tier",
};

function renderChanges(query) {
  const feed = document.getElementById("changesFeed");
  const now = new Date();
  let cutoff = null;
  if (activeChangesRange === "daily") cutoff = new Date(now.getTime() - MILLIS_DAY);
  else if (activeChangesRange === "weekly") cutoff = new Date(now.getTime() - 7 * MILLIS_DAY);

  let items = history;
  if (cutoff) items = items.filter(ev => new Date(ev.detected_at) >= cutoff);
  if (query) {
    items = items.filter(ev =>
      (ev.model_id && ev.model_id.toLowerCase().includes(query)) ||
      (ev.provider && ev.provider.toLowerCase().includes(query)) ||
      (ev.type && ev.type.toLowerCase().includes(query))
    );
  }
  if (activeAlertFilter === "alerted") items = items.filter(ev => ev.alerted);
  else if (activeAlertFilter === "silent") items = items.filter(ev => !ev.alerted);
  if (activeTypeFilter === "new") items = items.filter(ev => ev.type === "new_model" || ev.type === "new_free_model");
  document.getElementById("resultCount").textContent = `Showing ${items.length.toLocaleString()} changelog events`;
  if (!items.length) {
    feed.innerHTML = `<div class="empty"><h3>No recent delta events</h3><p>No price modifications or catalog updates found in this timeframe.</p></div>`;
    return;
  }
  const groups = {};
  for (const ev of items) {
    const d = new Date(ev.detected_at);
    const key = isNaN(d.getTime()) ? "Recent Updates" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (!groups[key]) groups[key] = { label: key, date: isNaN(d.getTime()) ? new Date(0) : d, events: [] };
    groups[key].events.push(ev);
  }
  const sortedDays = Object.values(groups).sort((a, b) => b.date.getTime() - a.date.getTime());
  feed.innerHTML = sortedDays.map(day => {
    const rows = day.events.map(ev => {
      const t = new Date(ev.detected_at);
      const time = isNaN(t.getTime()) ? "—" : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const isPrice = ev.type === "price_change";
      const pricingMatch = isPrice && typeof ev.details === "string"
        ? [...ev.details.matchAll(/(Input|output):\s*\$([\d.]+)\s*->\s*\$([\d.]+)/gi)]
        : [];
      const direction = ev.direction
        || (pricingMatch.length
          ? (pricingMatch.some(([, , o, n]) => Number(n) > Number(o)) ? "increase"
            : pricingMatch.some(([, , o, n]) => Number(n) < Number(o)) ? "decrease" : "same")
          : "same");
      const lbl = isPrice
        ? (direction === "increase" ? "Price Increase" : direction === "decrease" ? "Price Drop" : "Price Change")
        : (CHANGE_TYPE_LABELS[ev.type] || "Update");
      const tagCls = ev.type === "new_model" || ev.type === "new_free_model" ? "new"
        : isPrice ? (direction === "increase" ? "rise" : "drop")
        : "free";
      const providerLabel = ev.provider && !isInvalidText(ev.provider) ? `<span class="chg-providers">${esc(ev.provider)}</span>` : "";
      const alertedBadge = ev.alerted ? `<span class="chg-alerted">📢 Telegram</span>` : `<span class="chg-silent">dashboard only</span>`;
      const pricing = pricingMatch.length ? `<div class="chg-pricing">${pricingMatch.map(([, kind, oldValue, newValue]) => {
        const oldPrice = Number(oldValue);
        const newPrice = Number(newValue);
        const priceDirection = newPrice < oldPrice ? "lower" : newPrice > oldPrice ? "higher" : "same";
        return `<div class="chg-price-line"><span class="chg-price-kind">${esc(kind)}</span><span class="chg-price-old">$${oldPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span><span class="chg-price-arrow" aria-hidden="true">→</span><strong class="chg-price-new ${priceDirection}">$${newPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong><span class="chg-price-unit">per 1M tokens</span></div>`;
      }).join("")}</div>` : "";
      return `<article class="chg-row">
        <div class="chg-row-meta"><span class="chg-time">${esc(time)}</span><span class="chg-tag ${tagCls}">${esc(lbl)}</span></div>
        <div class="chg-row-content"><span class="chg-model">${esc(ev.model_id || "model")}</span>${providerLabel}${pricing}</div>
        <div class="chg-row-badges">${alertedBadge}</div>
      </article>`;
    }).join("");
    return `<div class="chg-day">
      <div class="chg-day-header"><span>${esc(day.label)}</span><span class="badge-counter">${day.events.length} event${day.events.length === 1 ? '' : 's'}</span></div>
      ${rows}
    </div>`;
  }).join("");
}

// ---------- Rendering ----------

function applyFilters() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  filtered = allModels.filter(m => {
    if (activeSource !== "both" && m.source !== activeSource) return false;
    if (activeFilter === "free" && !m.is_free) return false;
    if (activeFilter === "paid" && m.is_free) return false;
    if (!query) return true;
    return getModelName(m).toLowerCase().includes(query)
      || m.id.toLowerCase().includes(query)
      || m.owner.toLowerCase().includes(query);
  });
  filtered.sort(cmpModels);
}

// OpenRouter rows without pricing (rare) sort by their free status.
function sortValue(m, key) {
  switch (key) {
    case "name": return getModelName(m).toLowerCase();
    case "source": return m.source;
    case "input": {
      const v = price(m.input_price_per_m);
      return v === null ? (m.is_free ? 0 : Infinity) : v;
    }
    case "output": {
      const v = price(m.output_price_per_m);
      return v === null ? (m.is_free ? 0 : Infinity) : v;
    }
    case "context": return Number(m.context_window) || 0;
    case "score": return scoreSortValue(m);
    default: return getModelName(m).toLowerCase();
  }
}

function cmpModels(a, b) {
  const va = sortValue(a, sortKey);
  const vb = sortValue(b, sortKey);
  let r;
  if (typeof va === "string") r = va.localeCompare(vb);
  else r = va - vb;
  return sortDir === "asc" ? r : -r;
}

function renderTable() {
  const list = filtered.slice(0, visibleCount);
  const body = document.getElementById("modelBody");

  body.innerHTML = list.map(m => {
    const inp = price(m.input_price_per_m);
    const out = price(m.output_price_per_m);
    const costTag = m.is_free
      ? '<span class="license-tag open">Free</span>'
      : '<span class="license-tag proprietary">Paid</span>';
    return `<tr>
      <td>
        <div class="model-cell">
          <div class="model-line">
            <span class="model-title">${esc(getModelName(m))}</span>
          </div>
          <span class="model-provider-sub">${esc(m.id)}</span>
        </div>
      </td>
      <td class="text-center">${sourceBadge(m.source)}</td>
      <td class="owner-cell">${esc(m.owner || "—")}</td>
      <td class="text-right font-mono">${fmtPrice(inp)}</td>
      <td class="text-right font-mono">${fmtPrice(out)}</td>
      <td class="text-right font-mono">${fmtContext(m.context_window)}</td>
      <td class="text-center font-mono score-cell">${fmtScore(m)}</td>
      <td class="text-center font-mono text-dim">${esc(m.quota || (m.is_free ? "unlimited" : "—"))}</td>
      <td class="text-center">${costTag}</td>
    </tr>`;
  }).join("");

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="9"><div class="empty"><h3>No models found</h3><p>Try a different filter, or the source may be unreachable right now.</p></div></td></tr>`;
  }

  document.getElementById("resultCount").textContent = `Showing ${filtered.length.toLocaleString()} models`;
}

function updateSortIndicators() {
  const upIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
  const downIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
  document.querySelectorAll("#modelTable th.sortable").forEach(th => {
    const ind = th.querySelector(".sort-ind");
    if (!ind) return;
    if (th.dataset.sort === sortKey) ind.innerHTML = sortDir === "asc" ? upIcon : downIcon;
    else ind.innerHTML = "";
  });
}

// Pushes the current filter state back into the control styling. Needed because
// loadSavedState restores state without firing any click handler.
function syncControls() {
  document.querySelectorAll(".tab-pri[data-source]").forEach(b => {
    const on = b.dataset.source === activeSource;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".filter[data-filter]").forEach(b => {
    const on = b.dataset.filter === activeFilter;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("#changesView .chg-btn[data-range]").forEach(b => {
    const on = b.dataset.range === activeChangesRange;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("#changesView .chg-btn[data-alert]").forEach(b => {
    const on = b.dataset.alert === activeAlertFilter;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("#changesView .chg-btn[data-changes-type]").forEach(b => {
    const on = b.dataset.changesType === activeTypeFilter;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
}

function render() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const isChanges = activeSource === "changes";
  const isLookup = activeSource === "lookup";
  const isBoards = activeSource === "boards";

  syncControls();

  const toolbar = document.getElementById("sourceFilters");
  if (toolbar) toolbar.style.display = isChanges || isLookup || isBoards ? "none" : "flex";

  const tableView = document.getElementById("modelTableContainer");
  const changesView = document.getElementById("changesView");
  const lookupView = document.getElementById("lookupView");
  const boardsView = document.getElementById("boardsView");
  if (tableView) tableView.style.display = isChanges || isLookup || isBoards ? "none" : "block";
  if (changesView) changesView.hidden = !isChanges;
  if (lookupView) lookupView.hidden = !isLookup;
  if (boardsView) boardsView.hidden = !isBoards;

  document.getElementById("searchInput").placeholder = isChanges
    ? "Search changelog updates..."
    : isLookup
      ? "Search a model — \"opus 5.5\", \"glm5\", \"gemini flash\"..."
      : isBoards
        ? "Search models..."
        : "Search models...";

  if (isChanges) { renderChanges(query); return; }
  if (isLookup) { renderLookup(query); return; }
  if (isBoards) { renderBoards(); return; }

  applyFilters();
  renderTable();
  updateSortIndicators();
}

// ---------- Init ----------

async function loadData() {
  document.getElementById("statusOmniRouterLabel").textContent = "Omni: loading…";
  document.getElementById("statusOpenRouterLabel").textContent = "OR: loading…";

  const [omniModels, orModels] = await Promise.all([
    fetchOmniRouterModels(),
    fetchOpenRouterModels(),
  ]);

  const scoreIndex = await loadScoreIndex();
  assignScores(omniModels, orModels, scoreIndex);

  allModels = [...omniModels, ...orModels];

  history = await fetchHistory();
  lookupData = await fetchLookup();
  lookupIndex = lookupData ? buildLookupIndex(lookupData) : null;
  leaderboard = await fetchLeaderboard();
  scoreById = await loadScoreMap();

  document.getElementById("totalOmniRouter").textContent = omniModels.length.toLocaleString();
  document.getElementById("totalOpenRouter").textContent = orModels.length.toLocaleString();
  document.getElementById("totalOmniRouterFree").textContent = omniModels.filter(m => m.is_free).length.toLocaleString();
  document.getElementById("totalOpenRouterFree").textContent = orModels.filter(m => m.is_free).length.toLocaleString();
  document.getElementById("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString()}`;

  // Only surface Retry when a source actually failed — a slow-but-successful
  // load must not leave a permanent button in the header.
  const retry = document.getElementById("retryBtn");
  retry.hidden = !(omniFailed || orFailed);

  render();
}

// ---------- Event listeners ----------

document.querySelectorAll(".tab-pri[data-source]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-pri[data-source]").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeSource = btn.dataset.source;
    visibleCount = 100000;  // Load all models at once
    saveState();
    render();
  });
});

// Boards tab switcher
document.querySelectorAll("#boardsView .board-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    activeBoard = btn.dataset.board;
    saveState();
    render();
  });
});

// Changelog range + alert filters
document.querySelectorAll("#changesView .chg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const scope = btn.dataset.range !== undefined ? "range"
      : btn.dataset.alert !== undefined ? "alert" : "type";
    const group = scope === "range" ? ".chg-btn[data-range]"
      : scope === "alert" ? ".chg-btn[data-alert]" : ".chg-btn[data-changes-type]";
    document.querySelectorAll(`#changesView ${group}`).forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    if (scope === "range") activeChangesRange = btn.dataset.range;
    else if (scope === "alert") activeAlertFilter = btn.dataset.alert;
    else activeTypeFilter = btn.dataset.changesType;
    saveState();
    render();
  });
});

document.querySelectorAll(".filter[data-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter[data-filter]").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeFilter = btn.dataset.filter;
    visibleCount = 200;
    saveState();
    render();
  });
});

document.querySelectorAll("#modelTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
    saveState();
    visibleCount = 200;
    render();
  });
});

document.getElementById("searchInput").addEventListener("input", () => { render(); });

window.addEventListener("keydown", e => {
  if (e.key === "/" && document.activeElement !== document.getElementById("searchInput")) {
    e.preventDefault();
    document.getElementById("searchInput").focus();
  }
});

document.getElementById("retryBtn").addEventListener("click", () => {
  omniFailed = false;
  orFailed = false;
  loadData();
});

loadSavedState();
setupLookupCopy();
loadData();
