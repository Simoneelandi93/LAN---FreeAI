let models = [];
let history = [];
let statsById = {};
let activeView = "models";
let activeFilter = "all";
let selectedProviders = new Set();
let allAvailableProviders = [];
let activeChangesRange = "all";
let visibleCount = 100;
let sortKey = "name";
let sortDir = "asc";

const FILTERS = {
  all: () => true,
  free: m => Boolean(m.is_free),
  openrouter: m => m.provider_id === "openrouter",
};

const MILLIS_DAY = 86400000;
const NINEROUTER_API_URL = "http://localhost:20128/v1/models";
const OMNIROUTER_API_URL = "http://localhost:10129/v1/models";
let nineRouterModels = [];
let nineRouterNormMap = new Map();
let omniRouterModels = [];
let omniRouterNormMap = new Map();
let routerStatus = { "9router": { ok: false, count: 0 }, "OmniRouter": { ok: false, count: 0 } };
let currentModelIdx = null;

function normalizeSlug(value) {
  return String(value ?? "").toLowerCase().replace(/^openrouter\//, "").replace(/[^a-z0-9]/g, "");
}

async function fetchNineRouterModels() {
  try {
    const response = await fetch(NINEROUTER_API_URL, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return;
    const body = await response.json();
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    nineRouterModels = list.map(m => ({ id: m.id || "", owned_by: m.owned_by || "" })).filter(m => m.id);
    nineRouterNormMap.clear();
    for (const nr of nineRouterModels) {
      nineRouterNormMap.set(normalizeSlug(nr.id), nr.id);
      const slash = nr.id.indexOf("/");
      if (slash >= 0) nineRouterNormMap.set(normalizeSlug(nr.id.slice(slash + 1)), nr.id);
    }
    routerStatus["9router"] = { ok: true, count: nineRouterModels.length };
  } catch {
    nineRouterModels = [];
    nineRouterNormMap.clear();
    routerStatus["9router"] = { ok: false, count: 0 };
  }
  await fetchOmniRouterModels();
}

async function fetchOmniRouterModels() {
  try {
    const response = await fetch(OMNIROUTER_API_URL, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return;
    const body = await response.json();
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    omniRouterModels = list.map(m => ({ id: m.id || "", owned_by: m.owned_by || "" })).filter(m => m.id);
    omniRouterNormMap.clear();
    for (const nr of omniRouterModels) {
      omniRouterNormMap.set(normalizeSlug(nr.id), nr.id);
      const slash = nr.id.indexOf("/");
      if (slash >= 0) omniRouterNormMap.set(normalizeSlug(nr.id.slice(slash + 1)), nr.id);
    }
    routerStatus["OmniRouter"] = { ok: true, count: omniRouterModels.length };
  } catch {
    omniRouterModels = [];
    omniRouterNormMap.clear();
    routerStatus["OmniRouter"] = { ok: false, count: 0 };
  }
}

function clean(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveRouterId(model, routerModels, routerLabel) {
  const catProv = clean(model.provider_id);
  const catModel = clean(model.model_id || model.name);

  // 1. MATCH PERFETTO: stesso provider AND stesso modello
  for (const nr of routerModels) {
    const nrOwner = clean(nr.owned_by);
    const nrCleanId = clean(nr.id);
    const providerMatches = (nrOwner && (nrOwner === catProv || catProv.includes(nrOwner) || nrOwner.includes(catProv)))
      || nrCleanId.startsWith(catProv);
    if (providerMatches) {
      const modelPart = nr.id.includes("/") ? nr.id.split("/").slice(1).join("/") : nr.id;
      if (clean(modelPart) === catModel || nrCleanId.includes(catModel) || catModel.includes(clean(modelPart))) {
        return { id: nr.id, status: "verified", tooltip: `Verified in ${routerLabel} (${model.provider_id}): ${nr.id}` };
      }
    }
  }

  // 2. Modello esiste ma sotto ALTRO provider
  for (const nr of routerModels) {
    const modelPart = nr.id.includes("/") ? nr.id.split("/").slice(1).join("/") : nr.id;
    if (clean(modelPart) === catModel && clean(modelPart).length > 3) {
      const formatted = model.model_id && model.model_id.startsWith(`${model.provider_id}/`) ? model.model_id : `${model.provider_id}/${model.model_id || model.name || "model"}`;
      return { id: formatted, status: "wrong_provider", tooltip: `In ${routerLabel} via '${nr.owned_by || "altro"}', not '${model.provider_id}'` };
    }
  }

  // 3. Non trovato
  const formatted = model.model_id && model.model_id.startsWith(`${model.provider_id}/`) ? model.model_id : `${model.provider_id}/${model.model_id || model.name || "model"}`;
  return { id: formatted, status: "not_configured", tooltip: `Not in ${routerLabel}. Copy: ${formatted}` };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard copy failed");
}

async function fetchJson(name) {
  for (const path of [`data/${name}`, `../data/${name}`]) {
    try { const r = await fetch(path); if (r.ok) return await r.json(); } catch {}
  }
  throw new Error(`Cannot load ${name}`);
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
  if (!isInvalidText(m.model_id)) return String(m.model_id).trim();
  if (!isInvalidText(m.id)) return String(m.id).trim();
  return "Unnamed Model";
}

function getProviderName(m, s) {
  if (!isInvalidText(m.provider)) return String(m.provider).trim();
  if (s && !isInvalidText(s.organization)) return String(s.organization).trim();
  if (!isInvalidText(m.provider_id)) return String(m.provider_id).trim();
  return "—";
}

function formatSpeed(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? `${Math.round(n)} t/s` : '<span class="cell-na">—</span>';
}

function price(v) {
  if (isInvalidText(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function priceFmt(v) {
  if (v === null) return '<span class="cell-na">—</span>';
  return v === 0 ? '<span class="text-emerald font-semibold">$0.00</span>' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function ctxFmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '<span class="cell-na">—</span>';
  return n >= 1000 ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : n.toLocaleString();
}

function fmtScore(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '<span class="cell-na">—</span>';
  return `<span class="score-val">${n.toFixed(1)}</span>`;
}

function sortValue(m, key) {
  const s = m.llm_stats_id ? statsById[m.llm_stats_id] : null;
  switch (key) {
    case "rank": return s && Number.isFinite(Number(s.rank)) ? Number(s.rank) : 99999;
    case "name": return getModelName(m).toLowerCase();
    case "score": return s && Number.isFinite(Number(s.score)) ? Number(s.score) : null;
    case "reasoning": return s && Number.isFinite(Number(s.reasoning_score)) ? Number(s.reasoning_score) : null;
    case "coding": return s && Number.isFinite(Number(s.coding_score)) ? Number(s.coding_score) : null;
    case "agent": return s && Number.isFinite(Number(s.agent_score)) ? Number(s.agent_score) : null;
    case "speed": {
      const sp = s && Number.isFinite(Number(s.speed)) ? Number(s.speed) : Number(m.speed);
      return Number.isFinite(sp) ? sp : null;
    }
    case "input": return price(m.input_price_per_m);
    case "context": {
      const c = Number(m.context_window);
      return Number.isFinite(c) ? c : null;
    }
    default: return null;
  }
}

function cmpModels(a, b) {
  const va = sortValue(a, sortKey);
  const vb = sortValue(b, sortKey);
  const aNull = va === null || va === 99999;
  const bNull = vb === null || vb === 99999;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  let r = 0;
  if (typeof va === "string") r = va.localeCompare(vb);
  else r = va - vb;
  return sortDir === "asc" ? r : -r;
}

function populateProviderDropdown(provSet) {
  allAvailableProviders = [...provSet].sort();
  selectedProviders = new Set(allAvailableProviders);
  const container = document.getElementById("providerCheckboxList");
  container.innerHTML = allAvailableProviders.map(pid => `
    <label class="prov-item">
      <input type="checkbox" value="${esc(pid)}" checked>
      <span>${esc(pid)}</span>
    </label>
  `).join("");
  container.querySelectorAll("input[type='checkbox']").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedProviders.add(checkbox.value);
      else selectedProviders.delete(checkbox.value);
      updateProviderDropdownLabel();
      visibleCount = 100;
      render();
    });
  });
  document.getElementById("provSelectAll").onclick = () => {
    selectedProviders = new Set(allAvailableProviders);
    container.querySelectorAll("input[type='checkbox']").forEach(checkbox => checkbox.checked = true);
    updateProviderDropdownLabel();
    visibleCount = 100;
    render();
  };
  document.getElementById("provDeselectAll").onclick = () => {
    selectedProviders.clear();
    container.querySelectorAll("input[type='checkbox']").forEach(checkbox => checkbox.checked = false);
    updateProviderDropdownLabel();
    visibleCount = 100;
    render();
  };
  updateProviderDropdownLabel();
}

function updateProviderDropdownLabel() {
  const total = allAvailableProviders.length;
  const selected = selectedProviders.size;
  const label = selected === total ? "Providers (Tutti)" : selected === 0
    ? "Providers (Nessuno)" : `Providers (${selected}/${total})`;
  document.getElementById("providerDropdownLabel").textContent = label;
}

const providerDropdownButton = document.getElementById("providerDropdownBtn");
const providerDropdownMenu = document.getElementById("providerDropdownMenu");
providerDropdownButton.addEventListener("click", event => {
  event.stopPropagation();
  const open = providerDropdownMenu.classList.toggle("show");
  providerDropdownButton.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", event => {
  if (!document.getElementById("providerDropdownContainer").contains(event.target)) {
    providerDropdownMenu.classList.remove("show");
    providerDropdownButton.setAttribute("aria-expanded", "false");
  }
});

function updateRouterStatusUI() {
  const setStatus = (indicatorId, labelId, id) => {
    const s = routerStatus[id] || { ok: false, count: 0 };
    const dot = document.getElementById(indicatorId);
    const label = document.getElementById(labelId);
    if (dot) { dot.style.background = s.ok ? "#10b981" : "#64748b"; dot.style.boxShadow = s.ok ? "0 0 8px #10b981" : "none"; }
    if (label) label.textContent = s.ok ? `${s.count} mod` : "offline";
  };
  setStatus("status9router", "status9routerLabel", "9router");
  setStatus("statusOmniRouter", "statusOmniRouterLabel", "OmniRouter");
}

async function loadData() {
  try {
    const [catalog, histData, statsData] = await Promise.all([
      fetchJson("models.json"),
      fetchJson("history.json").catch(() => []),
      fetchJson("llm_stats.json").catch(() => ({})),
      fetchNineRouterModels(),
    ]);
    models = Array.isArray(catalog) ? catalog : [];
    history = Array.isArray(histData) ? histData : [];
    statsById = statsData && !Array.isArray(statsData) ? statsData : {};

    const hasStats = models.some(m => m.llm_stats_id && statsById[m.llm_stats_id]);
    document.body.classList.toggle("no-stats", !hasStats);

    updateRouterStatusUI();

    const provSet = new Set(models.map(m => m.provider_id).filter(id => !isInvalidText(id)));
    populateProviderDropdown(provSet);
    document.getElementById("totalModels").textContent = models.length.toLocaleString();
    document.getElementById("totalProviders").textContent = provSet.size.toLocaleString();
    document.getElementById("totalFree").textContent = models.filter(m => m.is_free).length.toLocaleString();
    document.getElementById("totalReasoning").textContent = models.filter(m => m.reasoning).length.toLocaleString();

    const latest = history[0]?.detected_at;
    document.getElementById("lastUpdated").textContent = latest
      ? `Synced ${new Date(latest).toLocaleDateString()}` : "Catalog active";
  } catch (e) {
    document.getElementById("lastUpdated").textContent = "Offline";
    document.getElementById("modelBody").innerHTML = `<tr><td colspan="10"><div class="empty"><h3>Catalog unreachable</h3><p>Could not load model datasets.</p></div></td></tr>`;
    return;
  }
  render();
}

function capPills(m) {
  return `<span class="cap-pills">
    <span class="cap-pill pill-reasoning ${m.reasoning ? 'pill-active' : ''}" title="Reasoning Engine">R</span>
    <span class="cap-pill pill-tool ${m.tool_call ? 'pill-active' : ''}" title="Function / Tool Calling">T</span>
    <span class="cap-pill pill-json ${m.structured_output ? 'pill-active' : ''}" title="Structured JSON Output">{}</span>
    <span class="cap-pill pill-open ${m.open_weights ? 'pill-active' : ''}" title="Open Weights">W</span>
  </span>`;
}

function renderModels(filtered) {
  const sorted = [...filtered].sort(cmpModels);
  const list = sorted.slice(0, visibleCount);
  const body = document.getElementById("modelBody");

  body.innerHTML = list.map(m => {
    const s = m.llm_stats_id ? statsById[m.llm_stats_id] : null;
    const rank = s && Number.isFinite(Number(s.rank)) ? `<span class="rank-badge">#${s.rank}</span>` : '<span class="cell-na">—</span>';
    const overallScore = s && Number.isFinite(Number(s.score)) ? `<span class="score-primary">${Number(s.score).toFixed(1)}</span>` : '<span class="cell-na">—</span>';
    const reasoning = fmtScore(s ? s.reasoning_score : null);
    const coding = fmtScore(s ? s.coding_score : null);
    const agent = fmtScore(s ? s.agent_score : null);
    const speed = formatSpeed(s && s.speed ? s.speed : m.speed);
    const inp = price(m.input_price_per_m);
    const inpFmt = priceFmt(inp);
    const ctx = ctxFmt(m.context_window);
    const licenseTag = m.open_weights ? '<span class="license-tag open">Open</span>' : '<span class="license-tag proprietary">Proprietary</span>';
    const url = m.provider_url || m.source_url || "#";
    const displayName = getModelName(m);
    const displayProvider = getProviderName(m, s);
    const nrMatch = resolveRouterId(m, nineRouterModels, "9router");
    const omniMatch = resolveRouterId(m, omniRouterModels, "OmniRouter");
    const nrClass = nrMatch.status === "verified" ? "matched" : nrMatch.status === "wrong_provider" ? "warn" : "";
    const omniClass = omniMatch.status === "verified" ? "matched" : omniMatch.status === "wrong_provider" ? "warn" : "";
    return `<tr>
      <td class="text-center font-mono">${rank}</td>
      <td>
        <div class="model-cell">
          <div class="model-line">
            <a class="model-title" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(displayName)}</a>
            <button class="cfg-btn" data-model-idx="${models.indexOf(m)}" title="Configure model routing" type="button">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="1.6"></circle><circle cx="8" cy="16" r="1.6"></circle><circle cx="16" cy="16" r="1.6"></circle></svg>
            </button>
            ${capPills(m)}
          </div>
          <span class="model-provider-sub">${esc(displayProvider)}</span>
        </div>
      </td>
      <td class="text-right col-score">${overallScore}</td>
      <td class="text-right font-mono col-bench">${reasoning}</td>
      <td class="text-right font-mono col-bench">${coding}</td>
      <td class="text-right font-mono col-bench">${agent}</td>
      <td class="text-right font-mono">${ctx}</td>
      <td class="text-right font-mono speed-cell">${speed}</td>
      <td class="text-right font-mono">${inpFmt}</td>
      <td class="text-center">${licenseTag}</td>
    </tr>`;
  }).join("");

function showConfigModal(idx) {
  currentModelIdx = idx;
  const m = models[idx];
  if (!m) return;
  const s = m.llm_stats_id ? statsById[m.llm_stats_id] : null;
  const displayName = getModelName(m);
  const displayProvider = getProviderName(m, s);
  const nrMatch = resolveRouterId(m, nineRouterModels, "9router");
  const omniMatch = resolveRouterId(m, omniRouterModels, "OmniRouter");
  const modelId = m.model_id || m.name || m.id || "model";
  const fullId = modelId.startsWith(`${m.provider_id}/`) ? modelId : `${m.provider_id}/${modelId}`;
  const nrUrl = nrMatch.status !== "not_configured" ? `http://localhost:20128/v1/models/${esc(nrMatch.id)}` : "";
  const omniUrl = omniMatch.status !== "not_configured" ? `http://localhost:10129/v1/models/${esc(omniMatch.id)}` : "";
  const url = m.provider_url || m.source_url || "#";

  const nrClass = nrMatch.status === "verified" ? "matched" : nrMatch.status === "wrong_provider" ? "warn" : "";
  const omniClass = omniMatch.status === "verified" ? "matched" : omniMatch.status === "wrong_provider" ? "warn" : "";

  document.getElementById("modalModelName").textContent = displayName;
  document.getElementById("modalModelProvider").textContent = displayProvider;
  document.getElementById("modalModelId").textContent = modelId;
  document.getElementById("modalFullId").textContent = fullId;
  document.getElementById("modalSourceUrl").textContent = url;
  document.getElementById("modalSourceUrl").href = url;

  // 9router section
  document.getElementById("modalNrStatus").className = `router-badge ${nrClass}`;
  document.getElementById("modalNrStatus").textContent = nrMatch.status === "verified" ? "Verified" : nrMatch.status === "wrong_provider" ? "Wrong Provider" : "Not Configured";
  document.getElementById("modalNrTooltip").textContent = nrMatch.tooltip;
  document.getElementById("modalNrId").textContent = nrMatch.id;
  document.getElementById("modalNrId").dataset.copy = nrMatch.id;
  document.getElementById("modalNrUrl").textContent = nrUrl || "—";
  if (nrUrl) document.getElementById("modalNrUrl").dataset.copy = nrUrl;
  document.getElementById("modalNrUrlCopy").style.display = nrUrl ? "" : "none";

  // OmniRouter section
  document.getElementById("modalOmniStatus").className = `router-badge ${omniClass}`;
  document.getElementById("modalOmniStatus").textContent = omniMatch.status === "verified" ? "Verified" : omniMatch.status === "wrong_provider" ? "Wrong Provider" : "Not Configured";
  document.getElementById("modalOmniTooltip").textContent = omniMatch.tooltip;
  document.getElementById("modalOmniId").textContent = omniMatch.id;
  document.getElementById("modalOmniId").dataset.copy = omniMatch.id;
  document.getElementById("modalOmniUrl").textContent = omniUrl || "—";
  if (omniUrl) document.getElementById("modalOmniUrl").dataset.copy = omniUrl;
  document.getElementById("modalOmniUrlCopy").style.display = omniUrl ? "" : "none";

  document.getElementById("configOverlay").classList.add("show");
  document.getElementById("configModal").classList.add("show");
}

function closeModal() {
  document.getElementById("configOverlay").classList.remove("show");
  document.getElementById("configModal").classList.remove("show");
  currentModelIdx = null;
}

async function modalCopy(id) {
  const el = document.getElementById(id);
  // If el has dataset.copy use it, otherwise use textContent (for cm-value spans)
  const text = el.dataset.copy !== undefined ? el.dataset.copy : el.textContent;
  if (!text || text === "—") return;
  try {
    await copyText(text);
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 1200);
  } catch {}
}

  body.querySelectorAll(".cfg-btn").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const idx = parseInt(button.dataset.modelIdx, 10);
      showConfigModal(idx);
    });
  });

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="10"><div class="empty"><h3>No models found</h3><p>Try refining your search query or reset filters.</p></div></td></tr>`;
  }
  document.getElementById("loadMore").hidden = filtered.length <= visibleCount;
}

function renderProviders(query) {
  const list = document.getElementById("providerList");
  const provMap = {};
  for (const m of models) {
    const pid = !isInvalidText(m.provider_id) ? m.provider_id : (!isInvalidText(m.provider) ? String(m.provider).toLowerCase().replace(/\s+/g, '-') : null);
    if (isInvalidText(pid)) continue;
    const provName = getProviderName(m);
    if (!provMap[pid]) {
      provMap[pid] = { id: pid, name: provName !== "—" ? provName : pid, url: m.provider_url || m.source_url || "#", total: 0, free: 0, reasoning: 0, tool: 0 };
    }
    provMap[pid].total++;
    if (m.is_free) provMap[pid].free++;
    if (m.reasoning) provMap[pid].reasoning++;
    if (m.tool_call) provMap[pid].tool++;
  }
  let arr = Object.values(provMap);
  if (query) {
    arr = arr.filter(p => (p.name && p.name.toLowerCase().includes(query)) || (p.id && p.id.toLowerCase().includes(query)));
  }
  arr.sort((a, b) => b.total - a.total);
  document.getElementById("resultCount").textContent = `Showing ${arr.length.toLocaleString()} providers`;
  list.innerHTML = arr.map(p => `
    <article class="provider-card">
      <div class="pc-head">
        <h3 class="pc-name"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a></h3>
        <span class="pc-badge">${p.total} models</span>
      </div>
      <p class="pc-meta">${esc(p.id)}</p>
      <div class="pc-stats">
        <div class="pc-stat"><strong class="${p.free ? 'text-emerald' : ''}">${p.free}</strong><span>Free Tier</span></div>
        <div class="pc-stat"><strong class="${p.reasoning ? 'text-purple' : ''}">${p.reasoning}</strong><span>Reasoning</span></div>
        <div class="pc-stat"><strong class="${p.tool ? 'text-amber' : ''}">${p.tool}</strong><span>Function Call</span></div>
      </div>
    </article>
  `).join("");
  if (!arr.length) list.innerHTML = `<div class="empty"><h3>No providers matched</h3><p>Try searching with another keyword.</p></div>`;
  document.getElementById("loadMore").hidden = true;
}

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
  document.getElementById("resultCount").textContent = `Showing ${items.length.toLocaleString()} changelog events`;
  if (!items.length) {
    feed.innerHTML = `<div class="empty"><h3>No recent delta events</h3><p>No price modifications or catalog updates found in this timeframe.</p></div>`;
    document.getElementById("loadMore").hidden = true;
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
  const typeLabels = { new_model: "New Model", price_change: "Price Drop", model_became_free: "Free Tier" };
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
        : (typeLabels[ev.type] || "Update");
      const tagCls = ev.type === "new_model" ? "new"
        : isPrice ? (direction === "increase" ? "rise" : "drop")
        : "free";
      const providerLabel = ev.provider && !isInvalidText(ev.provider) ? `<span class="chg-providers">${esc(ev.provider)}</span>` : "";
      const pricing = pricingMatch.length ? `<div class="chg-pricing">${pricingMatch.map(([, kind, oldValue, newValue]) => {
        const oldPrice = Number(oldValue);
        const newPrice = Number(newValue);
        const priceDirection = newPrice < oldPrice ? "lower" : newPrice > oldPrice ? "higher" : "same";
        return `<div class="chg-price-line"><span class="chg-price-kind">${esc(kind)}</span><span class="chg-price-old">$${oldPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span><span class="chg-price-arrow" aria-hidden="true">→</span><strong class="chg-price-new ${priceDirection}">$${newPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong><span class="chg-price-unit">per 1M tokens</span></div>`;
      }).join("")}</div>` : "";
      return `<article class="chg-row">
        <div class="chg-row-meta"><span class="chg-time">${esc(time)}</span><span class="chg-tag ${tagCls}">${esc(lbl)}</span></div>
        <div class="chg-row-content"><span class="chg-model">${esc(ev.model_id || "model")}</span>${providerLabel}${pricing}</div>
      </article>`;
    }).join("");
    return `<div class="chg-day">
      <div class="chg-day-header"><span>${esc(day.label)}</span><span class="badge-counter">${day.events.length} event${day.events.length === 1 ? '' : 's'}</span></div>
      ${rows}
    </div>`;
  }).join("");
  document.getElementById("loadMore").hidden = true;
}

function render() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const isModels = activeView === "models";
  const isProviders = activeView === "providers";
  const isChanges = activeView === "changes";

  const modelFilters = document.getElementById("modelFilters");
  const providerDropdown = document.getElementById("providerDropdownContainer");
  const tableView = document.getElementById("tableView");
  const capLegend = document.getElementById("capLegend");
  const providerGrid = document.getElementById("providerGrid");
  const changesView = document.getElementById("changesView");

  if (modelFilters) modelFilters.style.display = isModels ? "flex" : "none";
  if (providerDropdown) providerDropdown.style.display = isModels ? "inline-block" : "none";
  if (tableView) tableView.style.display = isModels ? "block" : "none";
  if (capLegend) capLegend.style.display = isModels ? "flex" : "none";
  if (providerGrid) providerGrid.style.display = isProviders ? "block" : "none";
  if (changesView) changesView.style.display = isChanges ? "block" : "none";

  if (isChanges) { renderChanges(query); return; }
  if (isProviders) { renderProviders(query); return; }

  const fn = FILTERS[activeFilter] || FILTERS.all;
  const filtered = models.filter(m => {
    if (!fn(m)) return false;
    if (selectedProviders && !selectedProviders.has(m.provider_id)) return false;
    if (!query) return true;
    const name = getModelName(m).toLowerCase();
    const prov = getProviderName(m).toLowerCase();
    const pid = String(m.model_id || "").toLowerCase();
    const desc = String(m.description || "").toLowerCase();
    return name.includes(query) || prov.includes(query) || pid.includes(query) || desc.includes(query);
  });

  document.getElementById("resultCount").textContent = `Showing ${filtered.length.toLocaleString()} matching models`;
  updateSortIndicators();
  renderModels(filtered);
}

function updateSortIndicators() {
  const upIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
  const downIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
  document.querySelectorAll("th.sortable").forEach(th => {
    const ind = th.querySelector(".sort-ind");
    if (!ind) return;
    if (th.dataset.sort === sortKey) ind.innerHTML = sortDir === "asc" ? upIcon : downIcon;
    else ind.innerHTML = "";
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
  if (e.key === "/" && document.activeElement !== document.getElementById("searchInput")) {
    e.preventDefault();
    document.getElementById("searchInput").focus();
  }
});

document.getElementById("searchInput").addEventListener("input", () => { visibleCount = 100; render(); });

document.querySelectorAll(".tab-pri").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-pri").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeView = btn.dataset.view;
    visibleCount = 100;
    const searchInput = document.getElementById("searchInput");
    if (activeView === "providers") searchInput.placeholder = "Search providers by name or id...";
    else if (activeView === "changes") searchInput.placeholder = "Search changelog updates...";
    else searchInput.placeholder = "Search models, providers, architectures...";
    render();
  });
});

document.querySelectorAll(".filter").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeFilter = btn.dataset.filter;
    visibleCount = 100;
    render();
  });
});

document.querySelectorAll(".chg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chg-btn").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeChangesRange = btn.dataset.range;
    render();
  });
});

document.getElementById("loadMore").addEventListener("click", () => { visibleCount += 100; render(); });

document.querySelectorAll("th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
    visibleCount = 100;
    render();
  });
});

loadData();