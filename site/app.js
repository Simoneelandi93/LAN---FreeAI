let models = [];
let offers = [];
let history = [];
let activeTab = "free";

async function fetchJson(name) {
  // GitHub Pages serves data/ next to index.html; a local repo-root server keeps it one level up.
  for (const path of [`data/${name}`, `../data/${name}`]) {
    try {
      const res = await fetch(path);
      if (res.ok) return await res.json();
    } catch (err) {
      // try the next candidate path
    }
  }
  throw new Error(`Could not load ${name}`);
}

async function loadData() {
  try {
    const [modelsData, offersData, historyData] = await Promise.all([
      fetchJson("models.json"),
      fetchJson("offers.json"),
      fetchJson("history.json")
    ]);
    models = modelsData;
    offers = offersData;
    history = historyData;

    document.getElementById("totalModels").textContent = models.length;
    document.getElementById("totalFree").textContent = models.filter(m => m.is_free).length;
    document.getElementById("totalOffers").textContent = offers.length;
    document.getElementById("lastUpdated").textContent = "Live Updated";

    render();
  } catch (err) {
    console.error("Error loading JSON data:", err);
    document.getElementById("lastUpdated").textContent = "Data offline";
  }
}

function render() {
  const container = document.getElementById("cardGrid");
  const query = document.getElementById("searchInput").value.toLowerCase();
  container.innerHTML = "";

  if (activeTab === "history") {
    container.innerHTML = history.map(ev => `
      <div class="card">
        <div class="card-header">
          <span class="card-title">${ev.model_id}</span>
          <span class="tag ${ev.type.includes('free') ? 'free' : ''}">${ev.type}</span>
        </div>
        <p style="font-size: 0.85rem; color: #8b949e;">${ev.details || ''}</p>
        <div style="font-size: 0.75rem; color: #57606a;">Detected: ${new Date(ev.detected_at).toLocaleString()}</div>
      </div>
    `).join("");
    return;
  }

  if (activeTab === "providers") {
    const filteredOffers = offers.filter(o =>
      o.provider.toLowerCase().includes(query) || o.title.toLowerCase().includes(query)
    );
    container.innerHTML = filteredOffers.map(o => `
      <div class="card free-card">
        <div class="card-header">
          <div>
            <div class="card-title">${o.title}</div>
            <span class="tag">${o.provider}</span>
          </div>
          <span class="tag free">${o.requires_card ? "Card Req." : "No Card"}</span>
        </div>
        <div class="pricing-row">
          <div class="pricing-item">
            <span>Rate Limit</span>
            <b>${o.rolling_window
              ? `${o.rolling_window.requests.toLocaleString()} req / ${o.rolling_window.window_hours}h`
              : (o.quota_requests_day ? o.quota_requests_day.toLocaleString() + ' req/day' : 'N/A')}</b>
          </div>
          <div class="pricing-item">
            <span>Throughput</span>
            <b>${o.quota_tokens_minute ? o.quota_tokens_minute.toLocaleString() + ' tok/min' : 'Standard'}</b>
          </div>
        </div>
        <a href="${o.source_url}" target="_blank" class="btn-link">Official Setup Docs →</a>
      </div>
    `).join("");
    return;
  }

  let list = models;
  if (activeTab === "free") list = models.filter(m => m.is_free);
  if (query) {
    list = list.filter(m =>
      m.model_id.toLowerCase().includes(query) ||
      m.name.toLowerCase().includes(query) ||
      (m.provider || "").toLowerCase().includes(query)
    );
  }

  container.innerHTML = list.slice(0, 100).map(m => `
    <div class="card ${m.is_free ? 'free-card' : ''}">
      <div class="card-header">
        <div>
          <div class="card-title">${m.name}</div>
          <span class="tag">${m.model_id}</span>
        </div>
        ${m.is_free ? '<span class="tag free">FREE</span>' : ''}
      </div>
      <div class="pricing-row">
        <div class="pricing-item">
          <span>Input / 1M</span>
          <b>${m.is_free ? '$0' : '$' + m.input_price_per_m}</b>
        </div>
        <div class="pricing-item">
          <span>Output / 1M</span>
          <b>${m.is_free ? '$0' : '$' + m.output_price_per_m}</b>
        </div>
        <div class="pricing-item">
          <span>Context</span>
          <b>${m.context_window ? (m.context_window / 1024).toFixed(0) + 'k' : 'N/A'}</b>
        </div>
      </div>
      <a href="${m.source_url}" target="_blank" class="btn-link">${m.provider === 'OpenCode' ? 'Open in OpenCode Zen →' : 'Test via OpenRouter →'}</a>
    </div>
  `).join("");
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    e.target.classList.add("active");
    activeTab = e.target.getAttribute("data-tab");
    render();
  });
});

document.getElementById("searchInput").addEventListener("input", render);
loadData();
