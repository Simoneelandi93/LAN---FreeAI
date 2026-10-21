let models = [];
let history = [];
let statsById = {};
let activeView = "models";
let activeFilter = "all";
let activeChangesRange = "daily";
let visibleCount = 100;

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

    // Hide the LLM Stats column entirely when no benchmark data was enriched
    document.body.classList.toggle("no-stats", !models.some(m => m.llm_stats_id && statsById[m.llm_stats_id]));

    const provSet = new Set(models.map(m => m.provider_id).filter(Boolean));
    document.getElementById("totalModels").textContent = models.length.toLocaleString();
    document.getElementById("totalProviders").textContent = provSet.size.toLocaleString();
    document.getElementById("totalFree").textContent = models.filter(m => m.is_free).length.toLocaleString();
    document.getElementById("totalReasoning").textContent = models.filter(m => m.reasoning).length.toLocaleString();
    const latest = history[0]?.detected_at;
    document.getElementById("lastUpdated").textContent = latest ? `Synced ${new Date(latest).toLocaleDateString()}` : "Catalog synced";
  } catch (e) {
    document.getElementById("lastUpdated").textContent = "Catalog unavailable";
    document.getElementById("modelBody").innerHTML = `<tr><td colspan="7"><div class="empty"><h3>Catalog unavailable</h3><p>Could not load model data. Run the sync workflow and reload.</p></div></td></tr>`;
    return;
  }
  render();
}

function capDots(m) {
  let html = '<span class="cap-dots">';
  html += `<span class="cap-dot ${m.reasoning ? 'on rag' : ''}"${m.reasoning ? ' title="Reasoning"' : ''}></span>`;
  html += `<span class="cap-dot ${m.tool_call ? 'on tool' : ''}"${m.tool_call ? ' title="Tool use"' : ''}></span>`;
  html += `<span class="cap-dot ${m.structured_output ? 'on str' : ''}"${m.structured_output ? ' title="Structured output"' : ''}></span>`;
  html += `<span class="cap-dot ${m.open_weights ? 'on open' : ''}"${m.open_weights ? ' title="Open weights"' : ''}></span>`;
  html += "</span>";
  return html;
}

function scoreCell(m) {
  const s = m.llm_stats_id ? statsById[m.llm_stats_id] : null;
  if (!s) return '<span class="score-na">—</span>';
  const bits = [];
  if (s.rank) bits.push(`#${s.rank}`);
  if (s.score !== null && s.score !== undefined && Number.isFinite(Number(s.score))) {
    bits.push(Number(s.score).toFixed(1));
  }
  const tip = [s.organization, s.benchmark_count ? `${s.benchmark_count} benchmark${s.benchmark_count === 1 ? "" : "s"}` : null]
    .filter(Boolean).join(" · ");
  if (!bits.length) {
    return s.benchmark_count
      ? `<span class="score-na" title="${esc(tip)}">${s.benchmark_count} scores</span>`
      : '<span class="score-na">—</span>';
  }
  return `<a class="score-link" href="${esc(s.url || 'https://llm-stats.com/')}" target="_blank" rel="noopener noreferrer" title="${esc(tip)}">${bits.join(" · ")}</a>`;
}

function renderModels(filtered) {
  const list = filtered.slice(0, visibleCount);
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
    const orBadge = m.provider_id === "openrouter" ? `<span class="badge-or">· OpenRouter</span>` : "";
    const url = m.provider_url || m.source_url || "#";
    return `<tr>
      <td><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(m.name)}</a><span class="model-id">${esc(m.model_id)}</span></td>
      <td><span class="provider-cell">${esc(m.provider)}</span></td>
      <td>${capDots(m)}</td>
      <td class="score-cell">${scoreCell(m)}</td>
      <td class="price-cell ${inpCls}">${inpFmt}</td>
      <td class="price-cell ${outCls}">${outFmt}${orBadge}</td>
      <td class="context-cell ${ctxCls}">${ctx}</td>
    </tr>`;
  }).join("");
  if (!list.length) body.innerHTML = `<tr><td colspan="7"><div class="empty"><h3>No matches</h3><p>Try a different search term or clear the active filter.</p></div></td></tr>`;
  document.getElementById("loadMore").hidden = filtered.length <= visibleCount;
}

function renderProviders(filtered) {
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
  if (filtered) {
    const q = filtered.toLowerCase();
    arr = arr.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }
  arr.sort((a, b) => b.total - a.total);
  list.innerHTML = arr.map(p => `<article class="provider-card">
    <h3 class="pc-name"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a></h3>
    <p class="pc-meta">${esc(p.id)}</p>
    <div class="pc-stats">
      <div class="pc-stat"><strong>${p.total.toLocaleString()}</strong><span>Models</span></div>
      <div class="pc-stat"><strong>${p.free.toLocaleString()}</strong><span>Free</span></div>
      <div class="pc-stat"><strong>${p.reasoning.toLocaleString()}</strong><span>Reasoning</span></div>
      <div class="pc-stat"><strong>${p.tool.toLocaleString()}</strong><span>Tool use</span></div>
    </div>
  </article>`).join("");
  if (!arr.length) list.innerHTML = `<div class="empty"><h3>No providers match</h3><p>Try a different search term.</p></div>`;
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
    feed.innerHTML = `<div class="chg-empty">No changes detected in this period.</div>`;
    return;
  }

  // Group by date
  const groups = {};
  for (const ev of items) {
    const d = new Date(ev.detected_at);
    const key = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (!groups[key]) groups[key] = { label: key, date: d, events: [] };
    groups[key].events.push(ev);
  }

  const sortedDays = Object.values(groups).sort((a, b) => b.date.getTime() - a.date.getTime());
  const typeLabels = { new_model: "New", price_change: "Drop", model_became_free: "Free" };
  const typeTags = { new_model: "new", price_change: "drop", model_became_free: "free" };

  feed.innerHTML = sortedDays.map(day => {
    // Count types per day
    const tally = {};
    for (const ev of day.events) tally[ev.type] = (tally[ev.type] || 0) + 1;
    const summary = Object.entries(tally)
      .filter(([t]) => typeLabels[t])
      .map(([t, c]) => `${c} ${typeLabels[t]}`)
      .join(", ");

    const rows = day.events.map(ev => {
      const t = new Date(ev.detected_at);
      const time = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const tag = typeTags[ev.type] || "new";
      const lbl = typeLabels[ev.type] || ev.type;
      const providers = ev.provider ? `<span class="chg-providers">via ${esc(ev.provider)}</span>` : "";
      const details = ev.details ? `<span class="chg-price">${esc(ev.details)}</span>` : "";
      return `<div class="chg-row">
        <span class="chg-time">${esc(time)}</span>
        <div class="chg-body">
          <span class="chg-tag ${tag}">${esc(lbl)}</span><span class="chg-model">${esc(ev.model_id)}</span>
          ${providers}${details}
        </div>
      </div>`;
    }).join("");

    return `<div class="chg-day">
      <h3>${esc(day.label)} <span style="color:var(--muted);font-size:12px;font-weight:400;">· ${esc(summary)}</span></h3>
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
  document.getElementById("providerGrid")?.classList.toggle("active", isProviders);
  document.getElementById("changesView")?.classList.toggle("active", isChanges);

  if (isChanges) {
    renderChanges();
    return;
  }

  if (isProviders) {
    renderProviders(query);
    document.getElementById("resultCount").textContent = "";
    return;
  }

  const fn = FILTERS[activeFilter] || FILTERS.all;
  const filtered = models.filter(m => fn(m) && (!query ||
    `${m.name} ${m.model_id} ${m.provider} ${m.description}`.toLowerCase().includes(query)));
  document.getElementById("resultCount").textContent = `${filtered.length.toLocaleString()} ${filtered.length === 1 ? "model" : "models"}`;
  renderModels(filtered);
}

document.getElementById("searchInput").addEventListener("input", () => { visibleCount = 100; render(); });

document.querySelectorAll(".tab-pri").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-pri").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active"); btn.setAttribute("aria-selected", "true");
    activeView = btn.dataset.view;
    visibleCount = 100;
    if (activeView === "providers") {
      document.getElementById("searchInput").value = "";
      document.querySelectorAll("#modelFilters .filter").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      document.querySelector("#modelFilters .filter[data-filter='all']")?.classList.add("active");
    }
    document.getElementById("searchInput").value = "";
    render();
  });
});

document.querySelectorAll(".filter").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active"); btn.setAttribute("aria-selected", "true");
    activeFilter = btn.dataset.filter;
    visibleCount = 100;
    render();
  });
});

document.querySelectorAll(".chg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chg-btn").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active"); btn.setAttribute("aria-selected", "true");
    activeChangesRange = btn.dataset.range;
    render();
  });
});

document.getElementById("loadMore").addEventListener("click", () => { visibleCount += 100; render(); });

loadData();