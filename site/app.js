let models = [];
let history = [];
let statsById = {};
let activeView = "models";
let activeFilter = "all";
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

async function loadData() {
  try {
    const [catalog, histData, statsData] = await Promise.all([
      fetchJson("models.json"),
      fetchJson("history.json").catch(() => []),
      fetchJson("llm_stats.json").catch(() => ({})),
    ]);
    models = Array.isArray(catalog) ? catalog : [];
    history = Array.isArray(histData) ? histData : [];
    statsById = statsData && !Array.isArray(statsData) ? statsData : {};

    const hasStats = models.some(m => m.llm_stats_id && statsById[m.llm_stats_id]);
    document.body.classList.toggle("no-stats", !hasStats);

    const provSet = new Set(models.map(m => m.provider_id).filter(id => !isInvalidText(id)));
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
    return `<tr>
      <td class="text-center font-mono">${rank}</td>
      <td>
        <div class="model-cell">
          <div class="model-line">
            <a class="model-title" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(displayName)}</a>
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
      const tagCls = ev.type === "new_model" ? "new" : (ev.type === "price_change" ? "drop" : "free");
      const lbl = typeLabels[ev.type] || "Update";
      const providerLabel = ev.provider && !isInvalidText(ev.provider) ? `<span class="chg-providers">via ${esc(ev.provider)}</span>` : "";
      return `<div class="chg-row">
        <span class="chg-time">${esc(time)}</span>
        <span class="chg-tag ${tagCls}">${esc(lbl)}</span>
        <span class="chg-model">${esc(ev.model_id || "model")}</span>
        ${providerLabel}
      </div>`;
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
  const tableView = document.getElementById("tableView");
  const capLegend = document.getElementById("capLegend");
  const providerGrid = document.getElementById("providerGrid");
  const changesView = document.getElementById("changesView");

  if (modelFilters) modelFilters.style.display = isModels ? "flex" : "none";
  if (tableView) tableView.style.display = isModels ? "block" : "none";
  if (capLegend) capLegend.style.display = isModels ? "flex" : "none";
  if (providerGrid) providerGrid.style.display = isProviders ? "block" : "none";
  if (changesView) changesView.style.display = isChanges ? "block" : "none";

  if (isChanges) { renderChanges(query); return; }
  if (isProviders) { renderProviders(query); return; }

  const fn = FILTERS[activeFilter] || FILTERS.all;
  const filtered = models.filter(m => {
    if (!fn(m)) return false;
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