let models = [];
let activeFilter = "all";
let visibleCount = 80;

const FILTERS = {
  all: () => true,
  free: model => model.is_free,
  reasoning: model => model.reasoning,
  tool: model => model.tool_call,
  openrouter: model => model.provider_id === "openrouter",
};

async function fetchJson(name) {
  for (const path of [`data/${name}`, `../data/${name}`]) {
    try {
      const response = await fetch(path);
      if (response.ok) return await response.json();
    } catch {}
  }
  throw new Error(`Could not load ${name}`);
}

async function loadData() {
  try {
    const [catalog, history] = await Promise.all([
      fetchJson("models.json"),
      fetchJson("history.json").catch(() => []),
    ]);
    models = catalog;
    const providers = new Set(models.map(model => model.provider_id).filter(Boolean));
    document.getElementById("totalModels").textContent = models.length.toLocaleString();
    document.getElementById("totalProviders").textContent = providers.size.toLocaleString();
    document.getElementById("totalFree").textContent = models.filter(model => model.is_free).length.toLocaleString();

    const latest = history[0]?.detected_at;
    document.getElementById("lastUpdated").textContent = latest
      ? `Last sync ${new Date(latest).toLocaleDateString()}`
      : "Catalog synced";
    render();
  } catch (error) {
    console.error("Could not load the catalog", error);
    document.getElementById("lastUpdated").textContent = "Catalog unavailable";
    document.getElementById("modelList").innerHTML = `
      <div class="empty">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke-width="1.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/>
        </svg>
        <h3>Catalog unavailable</h3>
        <p>Data could not be loaded. Check that the sync workflow has run, then reload the page.</p>
      </div>`;
    document.getElementById("resultCount").textContent = "";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") return "Not listed";
  const number = Number(value);
  if (!Number.isFinite(number)) return "Not listed";
  if (number === 0) return "$0";
  return `$${number.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function formatContext(value) {
  if (!value) return "Not listed";
  if (value >= 1000) {
    return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  }
  return value.toLocaleString();
}

function buildTags(model) {
  const tags = [];
  if (model.reasoning) tags.push('<span class="tag tag-reasoning">Reasoning</span>');
  if (model.tool_call) tags.push('<span class="tag tag-tool">Tool use</span>');
  if (model.open_weights) tags.push('<span class="tag tag-open">Open weights</span>');

  const modalities = [...(model.modalities_input || [])];
  const outputs = [...(model.modalities_output || [])];
  if (modalities.length || outputs.length) {
    const unique = [...new Set([...modalities, ...outputs])];
    tags.push(`<span class="tag tag-modalities">${escapeHtml(unique.join(" · "))}</span>`);
  }

  return tags.join("");
}

function renderModel(model) {
  const inputPrice = formatPrice(model.input_price_per_m);
  const outputPrice = formatPrice(model.output_price_per_m);
  const context = formatContext(model.context_window);
  const isTracked = model.provider_id === "openrouter";
  const providerUrl = model.provider_url || model.source_url;

  const inputClass = model.is_free ? "free" : (model.input_price_per_m === null ? "n-a" : "");
  const outputClass = model.is_free ? "free" : (model.output_price_per_m === null ? "n-a" : "");
  const contextClass = model.context_window ? "context-value" : "context-value n-a";

  return `<article class="model-row">
    <div class="model-main">
      <div class="model-heading">
        <h3 class="model-name"><a href="${escapeHtml(providerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(model.name)}</a></h3>
        ${model.is_free ? '<span class="free-badge">Free</span>' : ""}
      </div>
      <div class="provider-row">
        <a class="provider-link" href="${escapeHtml(providerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(model.provider)}</a>
        <code class="model-id">${escapeHtml(model.model_id)}</code>
      </div>
      ${model.description ? `<p class="model-description">${escapeHtml(model.description)}</p>` : ""}
      <div class="tags">${buildTags(model)}</div>
    </div>
    <div class="model-data">
      <div class="price-box${isTracked ? " tracked" : ""}">
        <span class="price-label">${isTracked ? "OpenRouter input / 1M" : "Input / 1M"}</span>
        <strong class="price-value ${inputClass}">${inputPrice}</strong>
      </div>
      <div class="price-box${isTracked ? " tracked" : ""}">
        <span class="price-label">${isTracked ? "OpenRouter output / 1M" : "Output / 1M"}</span>
        <strong class="price-value ${outputClass}">${outputPrice}</strong>
      </div>
      <div class="price-box">
        <span class="price-label">Context window</span>
        <strong class="${contextClass}">${context}</strong>
      </div>
    </div>
  </article>`;
}

function render() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const matchesFilter = FILTERS[activeFilter] || FILTERS.all;

  const filtered = models.filter(model => {
    if (!matchesFilter(model)) return false;
    if (!query) return true;
    const searchable = `${model.name} ${model.model_id} ${model.provider} ${model.description}`.toLowerCase();
    return searchable.includes(query);
  });

  const list = document.getElementById("modelList");
  const resultCount = document.getElementById("resultCount");

  resultCount.textContent = `${filtered.length.toLocaleString()} ${filtered.length === 1 ? "model" : "models"}`;

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke-width="1.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/>
        </svg>
        <h3>No matches</h3>
        <p>Try a different search term or clear the active filter.</p>
      </div>`;
    document.getElementById("loadMore").hidden = true;
    return;
  }

  const visible = filtered.slice(0, visibleCount);
  list.innerHTML = visible.map(renderModel).join("");
  document.getElementById("loadMore").hidden = filtered.length <= visibleCount;
}

document.getElementById("searchInput").addEventListener("input", () => {
  visibleCount = 80;
  render();
});

document.querySelectorAll(".filter").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach(item => {
      item.classList.remove("active");
      item.setAttribute("aria-selected", "false");
    });
    button.classList.add("active");
    button.setAttribute("aria-selected", "true");
    activeFilter = button.dataset.filter;
    visibleCount = 80;
    render();
  });
});

document.getElementById("loadMore").addEventListener("click", () => {
  visibleCount += 80;
  render();
});

loadData();