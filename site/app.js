// Model Sources — 9router (local) + OpenRouter (API)

const NINEROUTER_API_URL = "http://127.0.0.1:20128/v1/models";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";

let allModels = [];        // { id, name, owner, source, input_price_per_m, output_price_per_m, context_window, is_free }
let filtered = [];
let activeSource = "9router";  // "9router" | "openrouter" | "both"
let activeFilter = "all";      // "all" | "free" | "paid"
let sortKey = "name";
let sortDir = "asc";
let visibleCount = 200;
let routerApiKey = "";
try { routerApiKey = localStorage.getItem("routerApiKey") || ""; } catch { /* storage unavailable */ }

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

function sourceBadge(source) {
  const label = source === "9router" ? "9router" : "OpenRouter";
  const cls = source === "9router" ? "source-badge-local" : "source-badge-remote";
  return `<span class="${cls}">${label}</span>`;
}

// ---------- Fetching ----------

async function fetch9routerModels() {
  const headers = routerApiKey ? { Authorization: `Bearer ${routerApiKey}` } : {};
  try {
    const res = await fetch(NINEROUTER_API_URL, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      document.getElementById("status9routerLabel").textContent = `9r: HTTP ${res.status}`;
      document.getElementById("status9router").style.background = "#f59e0b";
      return [];
    }
    const body = await res.json();
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    document.getElementById("status9routerLabel").textContent = `9r: ${list.length} models`;
    document.getElementById("status9router").style.background = "#10b981";
    return list.map(m => {
      const prompt = Number(m.pricing?.prompt ?? 0) * 1_000_000;
      const completion = Number(m.pricing?.completion ?? 0) * 1_000_000;
      return {
        id: m.id || "",
        name: m.name || m.id || "",
        owner: m.owned_by || "",
        source: "9router",
        input_price_per_m: round4(prompt),
        output_price_per_m: round4(completion),
        context_window: Number(m.context_length ?? m.contextWindow ?? 0) || 0,
        is_free: prompt === 0 && completion === 0,
      };
    }).filter(m => m.id);
  } catch (e) {
    document.getElementById("status9routerLabel").textContent = "9r: offline";
    document.getElementById("status9router").style.background = "#f59e0b";
    return [];
  }
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

// ---------- Rendering ----------

function sortValue(m, key) {
  switch (key) {
    case "name": return getModelName(m).toLowerCase();
    case "source": return m.source;
    case "input": return price(m.input_price_per_m) ?? Infinity;
    case "output": return price(m.output_price_per_m) ?? Infinity;
    case "context": return Number(m.context_window) || 0;
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
      <td class="text-center">${costTag}</td>
    </tr>`;
  }).join("");

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty"><h3>No models found</h3><p>Check that 9router is running or try a different filter.</p></div></td></tr>`;
  }

  document.getElementById("resultCount").textContent = `Showing ${filtered.length.toLocaleString()} models`;
  document.getElementById("loadMore").hidden = filtered.length <= visibleCount;
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
  applyFilters();
  renderTable();
  updateSortIndicators();
}

// ---------- Init ----------

async function loadData() {
  document.getElementById("status9routerLabel").textContent = "9r: loading…";
  document.getElementById("statusOpenRouterLabel").textContent = "OR: loading…";

  const [nrModels, orModels] = await Promise.all([
    fetch9routerModels(),
    fetchOpenRouterModels(),
  ]);

  allModels = [...nrModels, ...orModels];

  document.getElementById("total9router").textContent = nrModels.length.toLocaleString();
  document.getElementById("totalOpenRouter").textContent = orModels.length.toLocaleString();
  document.getElementById("total9routerFree").textContent = nrModels.filter(m => m.is_free).length.toLocaleString();
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
    visibleCount = 200;
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

document.getElementById("searchInput").addEventListener("input", () => { visibleCount = 200; render(); });
document.getElementById("loadMore").addEventListener("click", () => { visibleCount += 200; render(); });

// Router key modal (kept for future use — /v1/models is keyless)
document.getElementById("routerKeyBtn")?.addEventListener("click", () => {
  document.getElementById("routerKeyInput").value = routerApiKey;
  document.getElementById("routerKeyOverlay").hidden = false;
  document.getElementById("routerKeyModal").hidden = false;
});

document.getElementById("routerKeyCancel")?.addEventListener("click", closeKeyModal);
document.getElementById("routerKeyCancel2")?.addEventListener("click", closeKeyModal);
document.getElementById("routerKeyOverlay")?.addEventListener("click", closeKeyModal);

function closeKeyModal() {
  document.getElementById("routerKeyOverlay").hidden = true;
  document.getElementById("routerKeyModal").hidden = true;
}

document.getElementById("routerKeySave")?.addEventListener("click", () => {
  routerApiKey = document.getElementById("routerKeyInput").value.trim();
  try {
    if (routerApiKey) localStorage.setItem("routerApiKey", routerApiKey);
    else localStorage.removeItem("routerApiKey");
  } catch { /* storage unavailable */ }
  closeKeyModal();
});

window.addEventListener("keydown", e => {
  if (e.key === "Escape") closeKeyModal();
  if (e.key === "/" && document.activeElement !== document.getElementById("searchInput")) {
    e.preventDefault();
    document.getElementById("searchInput").focus();
  }
});

loadData();
