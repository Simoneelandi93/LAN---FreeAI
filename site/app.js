let models = [];
let history = [];
let statsById = {};
let activeView = "models";
let activeFilter = "all";
let activeChangesRange = "daily";
let visibleCount = 100;
let sortKey = "name";
let sortDir = "asc";

const FILTERS = {
  all: () => true,
  free: m => m.is_free,
  openrouter: m => m.provider_id === "openrouter",
  reasoning: m => m.reasoning,
  tool: m => m.tool_call,
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

function price(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function priceFmt(v) {
  if (v === null) return "—";
  return v === 0 ? "$0" : `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function sortValue(m, key) {
  switch (key) {
    case "name": return (m.name || "").toLowerCase();
    case "provider": return (m.provider || "").toLowerCase();
    case "score": {
      const s = m.llm_stats_id ? statsById[m.llm_stats_id] : null;
      return s && Number.isFinite(Number(s.score)) ? Number(s.score) : null;
    }
    case "input": return price(m.input_price_per_m);
    case "output": return price(m.output_price_per_m);
    case "context": return Number(m.context_window) || null;
    default: return null;
  }
}

function cmpModels(a, b) {
  const va = sortValue(a, sortKey);
  const vb = sortValue(b, sortKey);
  const aNull = va === null;
  const bNull = vb === null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  let r = 0;
  if (typeof va === "string") r = va.localeCompare(vb);
  else r = va - vb;
  return sortDir === "asc" ? r : -r;
}

function ctxFmt(v) {
  if (!v || !Number(v)) return "—";
  const n = Number(v);
  return n >= 1000 ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : n.toLocaleString();
}

async function loadData() {
  try {
    const [catalog, histData, statsData] = await Promise.all([
      fetchJson("models.json"),
      fetchJson("history.json").catch(() => []),
      fetchJson("llm_stats.json").catch(() => ({})),
    ]);
    models = catalog;
    history = histData;
    statsById = statsData && !Array.isArray(statsData) ? statsData : {};

    const hasStats = models.some(m => m.llm_stats_id && statsById[m.llm_stats_id]);
    document.body.classList.toggle("no-stats", !hasStats);

    const provSet = new Set(models.map(m => m.provider_id).filter(Boolean));
    document.getElementById("totalModels").textContent = models.length.toLocaleString();
    document.getElementById("totalProviders").textContent = provSet.size.toLocaleString();
    document.getElementById("totalFree").textContent = models.filter(m => m.is_free).length.toLocaleString();
    document.getElementById("totalReasoning").textContent = models.filter(m => m.reasoning).length.toLocaleString();
    const latest = history[0]?.detected_at;
    document.getElementById("lastUpdated").textContent = latest ? `Synced ${new Date(latest).toLocaleDateString()}` : "Catalog active";
  } catch (e) {
    document.getElementById("lastUpdated").textContent = "Offline";
    document.getElementById("modelBody").innerHTML = `<tr><td colspan="7"><div class="empty"><h3>Catalog unreachable</h3><p>Could not load model datasets.</p></div></td></tr>`;
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

function scoreCell(m) {
  const s = m.llm_stats_id ? statsById[m.llm_stats_id] : null;
  if (!s) return '<span class="score-na">—</span>';
  const bits = [];
  if (s.rank) bits.push(`#${s.rank}`);
  if (s.score !== null && s.score !== undefined && Number.isFinite(Number(s.score))) {
    bits.push(Number(s.score).toFixed(1));
  }
  const breakdown = [
    s.reasoning_score !== null && s.reasoning_score !== undefined ? `R ${Number(s.reasoning_score).toFixed(1)}` : null,
    s.coding_score !== null && s.coding_score !== undefined ? `C ${Number(s.coding_score).toFixed(1)}` : null,
    s.agent_score !== null && s.agent_score !== undefined ? `A ${Number(s.agent_score).toFixed(1)}` : null,
  ].filter(Boolean).join(" · ");
  const tip = [s.organization, breakdown || null, s.benchmark_count ? `${s.benchmark_count} benchmark${s.benchmark_count === 1 ? "" : "s"}` : null]
    .filter(Boolean).join(" · ");

  if (!bits.length) {
    return s.benchmark_count
      ? `<span class="score-na" title="${esc(tip)}">${s.benchmark_count} tests</span>`
      : '<span class="score-na">—</span>';
  }
  return `<a class="score-badge" href="${esc(s.url || 'https://llm-stats.com/')}" target="_blank" rel="noopener noreferrer" title="${esc(tip)}">${bits.join(" · ")}</a>`;
}

function renderModels(filtered) {
  const sorted = [...filtered].sort(cmpModels);
  const list = sorted.slice(0, visibleCount);
  const body = document.getElementById("modelBody");

  body.innerHTML = list.map(m => {
    const inp = price(m.input_price_per_m);
    const out = price(m.output_price_per_m);
    const inpFmt = priceFmt(inp);
    const outFmt = priceFmt(out);
    const ctx = ctxFmt(m.context_window);
    const inpCls = m.is_free ? "free" : (inp === null ? "na" : "");
    const outCls = m.is_free ? "free" : (out === null ? "na" : "");
    const ctxCls = ctx === "—" ? "na" : "";
    const orBadge = m.provider_id === "openrouter" ? `<span class="badge-or">OpenRouter</span>` : "";
    const url = m.provider_url || m.source_url || "#";

    return `<tr>
      <td>
        <a class="model-title" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(m.name)}</a>
        <span class="model-id">${esc(m.model_id)}</span>
      </td>
      <td><span class="provider-cell">${esc(m.provider)}</span></td>
      <td>${capPills(m)}</td>
      <td class="score-cell text-right">${scoreCell(m)}</td>
      <td class="price-cell text-right ${inpCls}">${inpFmt}</td>
      <td class="price-cell text-right ${outCls}">${outFmt}${orBadge}</td>
      <td class="context-cell text-right ${ctxCls}">${ctx}</td>
    </tr>`;
  }).join("");

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty"><h3>No models found</h3><p>Try refining your search query or reset filters.</p></div></td></tr>`;
  }
  document.getElementById("loadMore").hidden = filtered.length <= visibleCount;
}

function renderProviders(query) {
  const grid = document.getElementById("providerGrid");
  const list = document.getElementById("providerList");
  grid.classList.add("active");

  const provMap = {};
  for (const m of models) {
    const pid = m.provider_id;
    if (!pid) continue;
    if (!provMap[pid]) provMap[pid] = { id: pid, name: m.provider, url: m.provider_url || m.source_url || "#", total: 0, free: 0, reasoning: 0, tool: 0 };
    provMap[pid].total++;
    if (m.is_free) provMap[pid].free++;
    if (m.reasoning) provMap[pid].reasoning++;
    if (m.tool_call) provMap[pid].tool++;
  }

  let arr = Object.values(provMap);
  if (query) {
    arr = arr.filter(p => p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query));
  }
  arr.sort((a, b) => b.total - a.total);

  list.innerHTML = arr.map(p => `<article class="provider-card">
    <h3 class="pc-name"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a></h3>
    <p class="pc-meta">${esc(p.id)}</p>
    <div class="pc-stats">
      <div class="pc-stat"><strong>${p.total}</strong><span>Models</span></div>
      <div class="pc-stat"><strong class="${p.free ? 'text-emerald' : ''}">${p.free}</strong><span>Free</span></div>
      <div class="pc-stat"><strong>${p.reasoning}</strong><span>Reasoning</span></div>
      <div class="pc-stat"><strong>${p.tool}</strong><span>Tools</span></div>
    </div>
  </article>`).join("");

  if (!arr.length) list.innerHTML = `<div class="empty"><h3>No providers matched</h3><p>Try searching for an alternate identifier.</p></div>`;
  document.getElementById("loadMore").hidden = true;
}

function renderChanges() {
  const feed = document.getElementById("changesFeed");
  const now = new Date();
  let cutoff;
  if (activeChangesRange === "daily") cutoff = new Date(now.getTime() - MILLIS_DAY);
  else if (activeChangesRange === "weekly") cutoff = new Date(now.getTime() - 7 * MILLIS_DAY);
  else cutoff = null;

  let items = history;
  if (cutoff) items = items.filter(ev => new Date(ev.detected_at) >= cutoff);

  if (!items.length) {
    feed.innerHTML = `<div class="empty"><h3>No recent delta events</h3><p>No price modifications or catalog updates in this timeframe.</p></div>`;
    return;
  }

  const groups = {};
  for (const ev of items) {
    const d = new Date(ev.detected_at);
    const key = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (!groups[key]) groups[key] = { label: key, date: d, events: [] };
    groups[key].events.push(ev);
  }

  const sortedDays = Object.values(groups).sort((a, b) => b.date.getTime() - a.date.getTime());
  const typeLabels = { new_model: "New", price_change: "Drop", model_became_free: "Free" };

  feed.innerHTML = sortedDays.map(day => {
    const rows = day.events.map(ev => {
      const t = new Date(ev.detected_at);
      const time = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const tagCls = ev.type === "new_model" ? "new" : (ev.type === "price_change" ? "drop" : "free");
      const lbl = typeLabels[ev.type] || "Update";
      const providers = ev.provider ? `<span class="chg-providers">via ${esc(ev.provider)}</span>` : "";

      return `<div class="chg-row">
        <span class="chg-time">${esc(time)}</span>
        <span class="chg-tag ${tagCls}">${esc(lbl)}</span>
        <span class="chg-model">${esc(ev.model_id)}</span>
        ${providers}
      </div>`;
    }).join("");

    return `<div class="chg-day">
      <h3><span>${esc(day.label)}</span> <span>${day.events.length} events</span></h3>
      ${rows}
    </div>`;
  }).join("");

  document.getElementById("loadMore").hidden = true;
}

function render() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const isProviders = activeView === "providers";
  const isChanges = activeView === "changes";

  document.getElementById("modelFilters")?.classList.toggle("hidden", isProviders || isChanges);
  document.getElementById("tableView")?.classList.toggle("hidden", isProviders || isChanges);
  document.getElementById("capLegend")?.classList.toggle("hidden", isProviders || isChanges);
  document.getElementById("providerGrid")?.classList.toggle("active", isProviders);
  document.getElementById("changesView")?.classList.toggle("active", isChanges);

  if (isChanges) {
    renderChanges();
    document.getElementById("resultCount").textContent = "";
    return;
  }

  if (isProviders) {
    renderProviders(query);
    document.getElementById("resultCount").textContent = "";
    return;
  }

  const fn = FILTERS[activeFilter] || FILTERS.all;
  const filtered = models.filter(m => fn(m) && (!query ||
    `${m.name} ${m.model_id} ${m.provider} ${m.description || ""}`.toLowerCase().includes(query)));

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
    if (th.dataset.sort === sortKey) {
      ind.innerHTML = sortDir === "asc" ? upIcon : downIcon;
    } else {
      ind.innerHTML = "";
    }
  });
}

// Global hotkey: press "/" to focus search
window.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== document.getElementById("searchInput")) {
    e.preventDefault();
    document.getElementById("searchInput").focus();
  }
});

document.getElementById("searchInput").addEventListener("input", () => {
  visibleCount = 100;
  render();
});

document.querySelectorAll(".tab-pri").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-pri").forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeView = btn.dataset.view;
    visibleCount = 100;
    render();
  });
});

document.querySelectorAll(".filter").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeFilter = btn.dataset.filter;
    visibleCount = 100;
    render();
  });
});

document.querySelectorAll(".chg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chg-btn").forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    activeChangesRange = btn.dataset.range;
    render();
  });
});

document.getElementById("loadMore").addEventListener("click", () => {
  visibleCount += 100;
  render();
});

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