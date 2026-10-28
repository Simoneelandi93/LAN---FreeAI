// Model Sources — OmniRouter (repo) + OpenRouter (API)
// Everything is read from the upstream repos — no local daemon, no API keys.

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";
// OmniRouter catalog is read from the upstream repo (curated free-tier file) —
// the daemon needs an API key and its /v1/models is 401.
const OMNIRROUTER_CATALOG_URL =
  "https://raw.githubusercontent.com/cheaper-inference/OmniRoute/main/open-sse/config/freeModelCatalog.data.ts";

let allModels = [];        // { id, name, owner, source, input_price_per_m, output_price_per_m, context_window, is_free }
let filtered = [];
let activeSource = "OmniRouter";  // "OmniRouter" | "OpenRouter" | "both"
let activeFilter = "all";      // "all" | "free" | "paid"
let sortKey = "name";
let sortDir = "asc";
let visibleCount = 100000;  // Load all models at once

// Changelog state
let history = [];
let activeChangesRange = "all";   // "all" | "weekly" | "daily"
let activeAlertFilter = "alerted";  // default: only events that were sent to Telegram
let activeTypeFilter = "all";       // "all" | "new" (new_model + new_free_model only)
const MILLIS_DAY = 86400000;

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
    if (!res.ok) {
      document.getElementById("statusOmniRouterLabel").textContent = `Omni: HTTP ${res.status}`;
      document.getElementById("statusOmniRouter").style.background = "#f59e0b";
      return [];
    }
    const text = await res.text();
    const list = parseOmniCatalog(text);
    document.getElementById("statusOmniRouterLabel").textContent = `Omni: ${list.length} free`;
    document.getElementById("statusOmniRouter").style.background = "#10b981";
    return list;
  } catch (e) {
    document.getElementById("statusOmniRouterLabel").textContent = "Omni: offline";
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
    if (!res.ok) {
      document.getElementById("statusOpenRouterLabel").textContent = `OR: HTTP ${res.status}`;
      document.getElementById("statusOpenRouter").style.background = "#f59e0b";
      return [];
    }
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
    document.getElementById("statusOpenRouterLabel").textContent = "OR: offline";
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

function render() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const isChanges = activeSource === "changes";

  const toolbar = document.getElementById("sourceFilters");
  if (toolbar) toolbar.style.display = isChanges ? "none" : "flex";

  const tableView = document.getElementById("modelTableContainer");
  const changesView = document.getElementById("changesView");
  if (tableView) tableView.style.display = isChanges ? "none" : "block";
  if (changesView) changesView.hidden = !isChanges;

  document.getElementById("searchInput").placeholder = isChanges
    ? "Search changelog updates..."
    : "Search models...";

  if (isChanges) { renderChanges(query); return; }

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

  document.getElementById("totalOmniRouter").textContent = omniModels.length.toLocaleString();
  document.getElementById("totalOpenRouter").textContent = orModels.length.toLocaleString();
  document.getElementById("totalOmniRouterFree").textContent = omniModels.filter(m => m.is_free).length.toLocaleString();
  document.getElementById("totalOpenRouterFree").textContent = orModels.filter(m => m.is_free).length.toLocaleString();
  document.getElementById("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString()}`;

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
    render();
  });
});

document.querySelectorAll("#modelTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
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

loadData();
