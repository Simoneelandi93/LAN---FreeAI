// Model Sources — 9router (repo) + OmniRouter (repo) + OpenRouter (API)
// Everything is read from the upstream repos — no local daemon, no API keys.

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";
// OmniRouter catalog is read from the upstream repo (curated free-tier file) —
// the daemon needs an API key and its /v1/models is 401.
const OMNIRROUTER_CATALOG_URL =
  "https://raw.githubusercontent.com/cheaper-inference/OmniRoute/main/open-sse/config/freeModelCatalog.data.ts";
// 9router keeps its catalog as per-provider registry files in the repo. The tree
// listing comes from the GitHub API (one request, 60/hr unauthenticated); the
// files themselves come from raw.githubusercontent.com, which is not
// rate-limited like the API.
const NINEROUTER_TREE_URL =
  "https://api.github.com/repos/decolua/9router/git/trees/master?recursive=1";
const NINEROUTER_RAW_URL =
  (path) => `https://raw.githubusercontent.com/decolua/9router/master/open-sse/providers/registry/${path}`;

let allModels = [];        // { id, name, owner, source, input_price_per_m, output_price_per_m, context_window, is_free }
let filtered = [];
let activeSource = "9router";  // "9router" | "openrouter" | "both"
let activeFilter = "all";      // "all" | "free" | "paid"
let sortKey = "name";
let sortDir = "asc";
let visibleCount = 100000;  // Load all models at once

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
  const label = source === "9router" ? "9router" : source === "OmniRouter" ? "OmniRouter" : "OpenRouter";
  const cls = source === "OpenRouter" ? "source-badge-remote" : "source-badge-local";
  return `<span class="${cls}">${label}</span>`;
}

const KIND_LABELS = {
  image: "image",
  stt: "speech→text",
  tts: "text→speech",
  embedding: "embedding",
  video: "video",
};

// ---------- Fetching ----------

function n9routerModel(m) {
  return {
    id: m.id || "",
    name: m.name || m.id || "",
    owner: m.owned_by || "",
    source: "9router",
    input_price_per_m: null,
    output_price_per_m: null,
    context_window: Number(m.context_length ?? m.capabilities?.contextWindow ?? 0) || 0,
    is_free: !!m.is_free,
    kind: m.kind || "",
    category: m.category || "",
    notice: m.notice || "",
  };
}

async function fetch9routerModels() {
  try {
    const repo = await fetch9routerModelsFromRepo();
    if (repo.length) {
      document.getElementById("status9routerLabel").textContent = `9r: ${repo.length} models (repo)`;
      document.getElementById("status9router").style.background = "#10b981";
      return repo;
    }
    document.getElementById("status9routerLabel").textContent = "9r: offline";
    document.getElementById("status9router").style.background = "#f59e0b";
    return [];
  } catch (e) {
    document.getElementById("status9routerLabel").textContent = "9r: offline";
    document.getElementById("status9router").style.background = "#f59e0b";
    return [];
  }
}

// The 9router repo keeps its model catalog as ~145 per-provider registry files
// (open-sse/providers/registry/*.js), each exporting a provider object with
// alias, display {name, notice}, category ("freeTier" | "oauth" | "free" | ...)
// and a `models: [...]` array of { id, name, kind?, ... } literals.
const N9REPO_REG_PREFIX = "open-sse/providers/registry/";

async function fetch9routerModelsFromRepo() {
  const res = await fetch(NINEROUTER_TREE_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`tree HTTP ${res.status}`);
  const tree = await res.json();
  const files = (tree?.tree || [])
    .map(t => t.path)
    .filter(p => p.startsWith(N9REPO_REG_PREFIX) && p.endsWith(".js") && !p.endsWith("/index.js"));

  const seen = new Map();
  const CHUNK = 8;
  for (let i = 0; i < files.length; i += CHUNK) {
    const results = await Promise.all(files.slice(i, i + CHUNK).map(async path => {
      const provider = path.slice(N9REPO_REG_PREFIX.length, -3);
      try {
        const r = await fetch(NINEROUTER_RAW_URL(path.replace(N9REPO_REG_PREFIX, "")), { signal: AbortSignal.timeout(15000) });
        return r.ok ? { text: await r.text(), provider } : null;
      } catch { return null; }
    }));
    for (const result of results) {
      if (!result) continue;
      const text = result.text;
      const alias = (text.match(/\balias:\s*"([^"]+)"/) || [])[1] || result.provider;
      const displayName = (text.match(/\bname:\s*"([^"]+)"/) || [])[1] || "";
      // Free-tier signal: the provider block advertises hasFree, or the whole
      // registry is a free/oauth tier (category free/freeTier/oauth).
      const hasFree = /hasFree:\s*true/.test(text);
      const category = (text.match(/\bcategory:\s*"([^"]+)"/) || [])[1] || "";
      const providerFree = hasFree || ["free", "freeTier", "oauth"].includes(category);
      const noticeKind = (text.match(/(apiKeyUrl|signupUrl):\s*"([^"]+)"/) || [])[2] || "";
      const m = text.match(/models:\s*\[([\s\S]*?)\n\s*\]/);
      if (!m) continue;
      const entryRe = /\{\s*id:\s*"([^"]+)"[^}]*\}/g;
      let e;
      while ((e = entryRe.exec(m[1])) !== null) {
        const entry = e[0];
        const name = entry.match(/name:\s*"([^"]*)"/);
        const kind = entry.match(/kind:\s*"([^"]*)"/);
        if (!seen.has(e[1])) seen.set(e[1], {
          id: e[1],
          name: name ? name[1] : "",
          owned_by: displayName || alias,
          is_free: providerFree,
          kind: kind ? kind[1] : "",
          category,
          notice: noticeKind,
        });
      }
    }
  }
  return [...seen.values()].map(n9routerModel).filter(m => m.id);
}

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

// 9router rows carry no pricing (the repo lists none), so free rows with an
// unknown price sort as $0 instead of being pushed to the paid end.
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
    const kindLabel = m.kind ? KIND_LABELS[m.kind] || m.kind : "";
    return `<tr>
      <td>
        <div class="model-cell">
          <div class="model-line">
            <span class="model-title">${esc(getModelName(m))}</span>
            ${kindLabel ? `<span class="kind-badge">${esc(kindLabel)}</span>` : ""}
          </div>
          <span class="model-provider-sub">${esc(m.id)}</span>
        </div>
      </td>
      <td class="text-center">${sourceBadge(m.source)}</td>
      <td class="owner-cell">${esc(m.owner || "—")}${m.notice ? `<a class="owner-link" href="${esc(m.notice)}" target="_blank" rel="noopener noreferrer" title="Provider signup / API keys">↗</a>` : ""}</td>
      <td class="text-right font-mono">${fmtPrice(inp)}</td>
      <td class="text-right font-mono">${fmtPrice(out)}</td>
      <td class="text-right font-mono">${fmtContext(m.context_window)}</td>
      <td class="text-center font-mono text-dim">${esc(m.quota || (m.is_free ? "unlimited" : "—"))}</td>
      <td class="text-center">${costTag}</td>
    </tr>`;
  }).join("");

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="8"><div class="empty"><h3>No models found</h3><p>Try a different filter, or the source may be unreachable right now.</p></div></td></tr>`;
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
  applyFilters();
  renderTable();
  updateSortIndicators();
}

// ---------- Init ----------

async function loadData() {
  document.getElementById("status9routerLabel").textContent = "9r: loading…";
  document.getElementById("statusOmniRouterLabel").textContent = "Omni: loading…";
  document.getElementById("statusOpenRouterLabel").textContent = "OR: loading…";

  const [nrModels, omniModels, orModels] = await Promise.all([
    fetch9routerModels(),
    fetchOmniRouterModels(),
    fetchOpenRouterModels(),
  ]);

  allModels = [...nrModels, ...omniModels, ...orModels];

  document.getElementById("total9router").textContent = nrModels.length.toLocaleString();
  document.getElementById("totalOmniRouter").textContent = omniModels.length.toLocaleString();
  document.getElementById("totalOpenRouter").textContent = orModels.length.toLocaleString();
  document.getElementById("total9routerFree").textContent = nrModels.filter(m => m.is_free).length.toLocaleString();
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
