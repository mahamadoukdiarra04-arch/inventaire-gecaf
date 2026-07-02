(function () {
  "use strict";

  const APP_VERSION = "35";
  const STORAGE_KEY = "mamy-market-inventory-v1";
  const MISSION_ID = "mamy-market-2026";
  const ADMIN_TEAM = "equipe_admin";
  const ADMIN_AGENT = "admin1";
  const SYNC_BATCH_SIZE = 80;
  const CATALOG_URLS = [`mamy-products-v${APP_VERSION}.json`, "mamy-products.json"];

  const $ = (selector, root = document) => root.querySelector(selector);

  let catalog = [];
  let catalogSummary = {};
  let selectedProduct = null;
  let state = loadState();
  let supabaseClient = null;
  let syncTimer = null;
  let syncInFlight = false;
  let teamSyncRemoteAvailable = true;
  let scannerStream = null;
  let scannerTimer = null;
  let barcodeDetector = null;
  let zxingReader = null;
  let zxingControls = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindEvents();
    loadCatalog().then(() => {
      preloadTeams().catch(() => {});
      render();
      startSyncTimer();
      syncNow().catch(() => {});
    });
  }

  function bindEvents() {
    $("#mamyLoginForm")?.addEventListener("submit", handleLogin);
    $("#mamyLogoutButton")?.addEventListener("click", logout);
    $("#mamySearchInput")?.addEventListener("input", handleSearchInput);
    $("#mamyCountForm")?.addEventListener("submit", handleCountSubmit);
    $("#mamyAddQtyButton")?.addEventListener("click", () => saveCurrentCount({ mode: "add" }));
    $("#mamyZeroButton")?.addEventListener("click", () => {
      $("#mamyQtyInput").value = "0";
      saveCurrentCount({ mode: "replace", status: "zero" });
    });
    $("#mamyZoneInput")?.addEventListener("input", renderSelectedProduct);
    $("#mamyScanButton")?.addEventListener("click", startScanner);
    $("#mamyStopScanButton")?.addEventListener("click", stopScanner);
    $("#mamyExportButton")?.addEventListener("click", () => exportCountsCsv(getVisibleCounts(), "mamy-market-comptage.csv"));
    $("#mamyAdminExport")?.addEventListener("click", () => exportCountsCsv(getAllCounts(), "mamy-market-global.csv"));
    $("#mamyAdminButton")?.addEventListener("click", openAdmin);
    $("#mamyRefreshAdmin")?.addEventListener("click", () => syncNow({ forcePull: true }).catch(() => {}));
    $("#mamyAdminSearch")?.addEventListener("input", renderAdmin);
    $("#mamyTeamForm")?.addEventListener("submit", handleTeamSubmit);
    $("#mamyTeamList")?.addEventListener("click", handleTeamListClick);
    document.querySelectorAll("[data-close-mamy-admin]").forEach((node) => node.addEventListener("click", closeAdmin));
    window.addEventListener("online", () => syncNow().catch(() => {}));
    window.addEventListener("portal:change", (event) => {
      if (event.detail?.app !== "mamy") stopScanner();
    });
  }

  async function loadCatalog() {
    for (const url of CATALOG_URLS) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) continue;
        const payload = await response.json();
        catalog = Array.isArray(payload.products) ? payload.products : [];
        catalogSummary = payload.summary || {};
        return;
      } catch {}
    }
    catalog = [];
    catalogSummary = {};
  }

  async function handleLogin(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const team = clean(data.team);
    const agent = clean(data.agent);
    if (!team || !agent) return alert("Renseignez l'equipe et l'agent.");
    const isAdmin = isAdminCredentials(team, agent);
    if (!isAdmin && !(await validateTeamAccess(team))) {
      return alert("Cette equipe n'est pas encore creee ou active. Connectez-vous en admin pour l'ajouter.");
    }
    state.session = {
      connected: true,
      team,
      teamKey: normalize(team),
      agent,
      agentKey: normalize(agent),
      isAdmin,
      connectedAt: new Date().toISOString(),
    };
    saveState();
    render();
    syncNow({ forcePull: true }).catch(() => {});
  }

  function logout() {
    stopScanner();
    state.session = defaultState().session;
    saveState();
    render();
  }

  function handleTeamSubmit(event) {
    event.preventDefault();
    if (!isAdminSession()) return;
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const teamName = clean(data.teamName);
    if (!teamName) return;
    if (normalize(teamName) === ADMIN_TEAM) return alert("Ce nom est reserve a l'administration.");
    const team = upsertLocalTeam(teamName);
    queueTeamSync(team);
    event.currentTarget.reset();
    saveState();
    renderAdmin();
    syncNow().catch(() => {});
  }

  function handleTeamListClick(event) {
    if (!isAdminSession()) return;
    const button = event.target.closest("[data-mamy-team-action]");
    if (!button) return;
    const teamKey = button.dataset.teamKey;
    const nextActive = button.dataset.mamyTeamAction === "restore";
    const team = state.teams.find((item) => item.teamKey === teamKey);
    if (!team) return;
    if (!nextActive && !window.confirm(`Desactiver ${team.teamName} ?`)) return;
    const updated = setLocalTeamActive(teamKey, nextActive);
    queueTeamSync(updated);
    saveState();
    renderAdmin();
    syncNow().catch(() => {});
  }

  function handleSearchInput(event) {
    const query = clean(event.target.value);
    renderSearchResults(query);
    const exact = findExactBarcode(query);
    if (exact) selectProduct(exact);
  }

  function renderSearchResults(query = clean($("#mamySearchInput")?.value)) {
    const list = $("#mamySearchResults");
    if (!list) return;
    const results = searchProducts(query).slice(0, 35);
    if (!results.length) {
      list.innerHTML = `<div class="mamy-result-item"><span>Aucun produit trouve.</span></div>`;
      return;
    }
    list.innerHTML = results.map((product) => renderProductButton(product)).join("");
    list.querySelectorAll("[data-product-id]").forEach((button) => {
      button.addEventListener("click", () => selectProduct(catalog.find((item) => item.id === button.dataset.productId)));
    });
  }

  function renderProductButton(product) {
    const stockClass = Number(product.theoreticalQty) < 0 ? " is-negative" : "";
    const barcode = product.barcodeValid ? product.barcode : product.barcode ? "Code invalide" : "Sans code-barres";
    return `
      <button class="mamy-result-item" type="button" data-product-id="${escapeHtml(product.id)}">
        <div>
          <strong>${escapeHtml(product.name || "Produit sans nom")}</strong>
          <span>${escapeHtml(barcode)} - Ref. ${escapeHtml(product.internalRef || "n/a")}</span>
        </div>
        <span class="${stockClass}">${formatQty(product.theoreticalQty)}</span>
      </button>
    `;
  }

  function selectProduct(product) {
    if (!product) return;
    selectedProduct = product;
    $("#mamySearchInput").value = product.barcode || product.name || "";
    renderSelectedProduct();
  }

  function renderSelectedProduct() {
    const title = $("#mamySelectedName");
    const chip = $("#mamySelectedBarcode");
    const meta = $("#mamyProductMeta");
    if (!title || !chip || !meta) return;
    if (!selectedProduct) {
      title.textContent = "Aucun produit selectionne";
      chip.textContent = "Code-barres";
      meta.innerHTML = "";
      return;
    }
    const zone = clean($("#mamyZoneInput")?.value || state.lastZone || "Rayon");
    const existing = getCountFor(selectedProduct, zone);
    title.textContent = selectedProduct.name || "Produit sans nom";
    chip.textContent = selectedProduct.barcode || "Sans code";
    meta.innerHTML = `
      <div class="mamy-meta"><span>Stock Odoo</span><strong>${formatQty(selectedProduct.theoreticalQty)}</strong></div>
      <div class="mamy-meta"><span>Prix vente</span><strong>${formatMoney(selectedProduct.salePrice)}</strong></div>
      <div class="mamy-meta"><span>Coût</span><strong>${formatMoney(selectedProduct.cost)}</strong></div>
      <div class="mamy-meta"><span>Référence</span><strong>${escapeHtml(selectedProduct.internalRef || "n/a")}</strong></div>
      <div class="mamy-meta"><span>Déjà compté</span><strong>${existing ? formatQty(existing.countedQty) : "0"}</strong></div>
      <div class="mamy-meta"><span>Ecart actuel</span><strong>${existing ? formatQty(existing.differenceQty) : formatQty(-Number(selectedProduct.theoreticalQty || 0))}</strong></div>
    `;
    if (existing && !$("#mamyQtyInput").value) $("#mamyQtyInput").value = formatPlainNumber(existing.countedQty);
  }

  function handleCountSubmit(event) {
    event.preventDefault();
    saveCurrentCount({ mode: "replace" });
  }

  function saveCurrentCount({ mode = "replace", status = "counted" } = {}) {
    if (!state.session.connected) return alert("Connectez-vous d'abord.");
    if (!selectedProduct) return alert("Selectionnez un produit.");
    const zone = clean($("#mamyZoneInput").value) || "Rayon";
    const inputQty = parseNumber($("#mamyQtyInput").value);
    const note = clean($("#mamyNoteInput").value);
    const existing = getCountFor(selectedProduct, zone);
    const countedQty = mode === "add" ? Number(existing?.countedQty || 0) + inputQty : inputQty;
    const count = buildCount(selectedProduct, zone, countedQty, note, status);
    state.counts = [count, ...state.counts.filter((item) => item.id !== count.id)].sort(sortCounts);
    state.lastZone = zone;
    queueCountSync(count);
    saveState();
    render();
    $("#mamyQtyInput").value = "";
    $("#mamyNoteInput").value = "";
    syncNow().catch(() => {});
  }

  function buildCount(product, zone, countedQty, note, status) {
    const now = new Date().toISOString();
    const theoreticalQty = Number(product.theoreticalQty || 0);
    return {
      id: getCountId(product, zone, state.session.teamKey),
      missionId: MISSION_ID,
      teamKey: state.session.teamKey,
      teamName: state.session.team,
      agentKey: state.session.agentKey,
      agentName: state.session.agent,
      zone,
      productId: product.id,
      barcode: product.barcode || "",
      internalRef: product.internalRef || "",
      productName: product.name || "",
      salePrice: Number(product.salePrice || 0),
      cost: Number(product.cost || 0),
      theoreticalQty,
      countedQty,
      differenceQty: countedQty - theoreticalQty,
      status,
      note,
      updatedBy: state.session.agent,
      updatedAt: now,
    };
  }

  function queueCountSync(count) {
    state.syncQueue = state.syncQueue.filter((item) => item.id !== count.id);
    state.syncQueue.push({ ...count, queuedAt: new Date().toISOString(), attempts: 0 });
    state.syncStatus.pending = getPendingSyncCount();
  }

  async function startScanner() {
    if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
      alert("Camera indisponible. Utilisez la recherche manuelle.");
      return;
    }
    try {
      const video = $("#mamyScannerVideo");
      if (!video) return;
      $("#mamyScannerPanel").hidden = false;
      if (typeof window.BarcodeDetector === "function") {
        barcodeDetector = barcodeDetector || new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
        scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = scannerStream;
        await video.play();
        scannerTimer = window.setInterval(detectBarcodeFrame, 450);
        return;
      }
      if (window.ZXingBrowser?.BrowserMultiFormatOneDReader) {
        zxingReader = zxingReader || new window.ZXingBrowser.BrowserMultiFormatOneDReader(undefined, { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 250 });
        zxingControls = await zxingReader.decodeFromVideoDevice(undefined, video, (result) => {
          const value = clean(result?.getText?.() || result?.text);
          if (value) handleScannedCode(value);
        });
        return;
      }
      alert("Module de scan indisponible. Rechargez l'application en ligne, puis reessayez.");
      stopScanner();
    } catch (error) {
      stopScanner();
      alert("Impossible d'ouvrir la camera.");
    }
  }

  async function detectBarcodeFrame() {
    const video = $("#mamyScannerVideo");
    if (!barcodeDetector || !video || video.readyState < 2) return;
    try {
      const codes = await barcodeDetector.detect(video);
      const value = clean(codes?.[0]?.rawValue);
      if (!value) return;
      handleScannedCode(value);
    } catch {}
  }

  function handleScannedCode(value) {
    const code = clean(value);
    if (!code) return;
    $("#mamySearchInput").value = code;
    const product = findExactBarcode(code);
    if (product) {
      selectProduct(product);
      stopScanner();
      return;
    }
    renderSearchResults(code);
  }

  function stopScanner() {
    if (scannerTimer) window.clearInterval(scannerTimer);
    scannerTimer = null;
    if (zxingControls?.stop) zxingControls.stop();
    zxingControls = null;
    if (scannerStream) scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
    const panel = $("#mamyScannerPanel");
    if (panel) panel.hidden = true;
  }

  async function syncNow({ forcePull = false } = {}) {
    if (syncInFlight || !state.session.connected || !navigator.onLine || !hasRemoteConfig()) return;
    syncInFlight = true;
    state.syncStatus.remote = "syncing";
    state.syncStatus.message = "Synchronisation...";
    saveState();
    try {
      const client = getSupabaseClient();
      await syncTeamsNow(client);
      const batch = state.syncQueue.slice(0, SYNC_BATCH_SIZE);
      if (batch.length) {
        await upsertRemoteCounts(client, batch);
        const ids = new Set(batch.map((item) => item.id));
        state.syncQueue = state.syncQueue.filter((item) => !ids.has(item.id));
      }
      if (forcePull || !state.syncQueue.length) {
        try {
          await pullRemoteTeams(client);
        } catch (error) {
          if (!isMissingTeamRemoteObject(error)) throw error;
          teamSyncRemoteAvailable = false;
        }
        await pullRemoteCounts(client);
      }
      state.syncStatus.remote = getPendingSyncCount() ? "pending" : "synced";
      state.syncStatus.message = getPendingSyncCount() ? "Synchronisation en attente" : "Synchronise";
      state.syncStatus.lastSyncAt = new Date().toISOString();
    } catch (error) {
      state.syncStatus.remote = "error";
      state.syncStatus.message = getErrorMessage(error);
    } finally {
      syncInFlight = false;
      saveState();
      render();
    }
  }

  async function upsertRemoteCounts(client, counts) {
    const payload = counts.map(toRemoteCount);
    const rpc = await client.rpc("upsert_mamy_counts_newer", { p_counts: payload });
    if (!rpc.error) return;
    if (!isMissingRemoteObject(rpc.error)) throw rpc.error;
    const result = await client.from("mamy_inventory_counts").upsert(payload, { onConflict: "id" });
    if (result.error) throw result.error;
  }

  async function syncTeamsNow(client) {
    const batch = state.teamSyncQueue.slice(0, SYNC_BATCH_SIZE);
    if (!batch.length || !teamSyncRemoteAvailable) return;
    try {
      await upsertRemoteTeams(client, batch);
      const keys = new Set(batch.map((item) => item.teamKey));
      state.teamSyncQueue = state.teamSyncQueue.filter((item) => !keys.has(item.teamKey));
    } catch (error) {
      if (!isMissingTeamRemoteObject(error)) throw error;
      teamSyncRemoteAvailable = false;
      state.syncStatus.message = "Table equipes MAMY en attente";
    }
  }

  async function upsertRemoteTeams(client, teams) {
    const payload = teams.map(toRemoteTeam);
    const result = await client.from("mamy_inventory_teams").upsert(payload, { onConflict: "mission_id,team_key" });
    if (result.error) throw result.error;
  }

  async function pullRemoteCounts(client) {
    let query = client.from("mamy_inventory_counts").select("*").eq("mission_id", MISSION_ID).order("updated_at", { ascending: false }).limit(5000);
    if (!isAdminSession()) query = query.eq("team_key", state.session.teamKey);
    const { data, error } = await query;
    if (error) throw error;
    mergeRemoteCounts((data || []).map(fromRemoteCount));
  }

  function mergeRemoteCounts(remoteCounts) {
    const pendingIds = new Set(state.syncQueue.map((item) => item.id));
    const map = new Map(state.counts.map((count) => [count.id, count]));
    remoteCounts.forEach((remote) => {
      const local = map.get(remote.id);
      if (pendingIds.has(remote.id)) return;
      if (!local || String(remote.updatedAt || "") >= String(local.updatedAt || "")) map.set(remote.id, remote);
    });
    state.counts = Array.from(map.values()).sort(sortCounts);
  }

  async function preloadTeams() {
    if (!navigator.onLine || !hasRemoteConfig() || !window.supabase?.createClient) return;
    try {
      await pullRemoteTeams(getSupabaseClient());
      saveState();
    } catch (error) {
      if (!isMissingTeamRemoteObject(error)) throw error;
      teamSyncRemoteAvailable = false;
    }
  }

  async function pullRemoteTeams(client = getSupabaseClient()) {
    if (!teamSyncRemoteAvailable) return;
    const { data, error } = await client
      .from("mamy_inventory_teams")
      .select("*")
      .eq("mission_id", MISSION_ID)
      .order("team_name", { ascending: true });
    if (error) throw error;
    mergeRemoteTeams((data || []).map(fromRemoteTeam));
  }

  function mergeRemoteTeams(remoteTeams) {
    const pendingKeys = new Set(state.teamSyncQueue.map((item) => item.teamKey));
    const map = new Map(state.teams.map((team) => [team.teamKey, team]));
    remoteTeams.forEach((remote) => {
      if (!remote?.teamKey || pendingKeys.has(remote.teamKey)) return;
      const local = map.get(remote.teamKey);
      if (!local || String(remote.updatedAt || "") >= String(local.updatedAt || "")) map.set(remote.teamKey, remote);
    });
    state.teams = Array.from(map.values()).sort(sortTeams);
  }

  function render() {
    const app = $("#mamyApp");
    if (!app) return;
    app.classList.toggle("is-connected", Boolean(state.session.connected));
    $("#mamyAdminButton").style.display = isAdminSession() ? "" : "none";
    $("#mamySessionTitle").textContent = state.session.connected ? `${state.session.team} - ${state.session.agent}` : "Comptage terrain";
    $("#mamyZoneInput").value = $("#mamyZoneInput").value || state.lastZone || "Rayon";
    renderStats();
    renderSearchResults();
    renderSelectedProduct();
    renderRecent();
    renderAdmin();
    updateSyncBadge();
  }

  function renderStats() {
    const visible = getVisibleCounts();
    const diff = visible.filter((count) => Number(count.differenceQty || 0) !== 0);
    setText("#mamyTotalProducts", formatQty(catalog.length));
    setText("#mamyCountedProducts", formatQty(new Set(visible.map((count) => count.productId)).size));
    setText("#mamyDiffProducts", formatQty(diff.length));
    setText("#mamyNoBarcodeProducts", formatQty(Number(catalogSummary.missingBarcode || 0) + Number(catalogSummary.invalidBarcode || 0)));
  }

  function renderRecent() {
    const body = $("#mamyRecentRows");
    if (!body) return;
    const rows = getVisibleCounts().slice(0, 40);
    body.innerHTML = rows.length ? rows.map(renderCountRow).join("") : `<tr><td colspan="6">Aucune saisie.</td></tr>`;
  }

  function renderAdmin() {
    const rows = getFilteredAdminCounts();
    const diffValue = rows.reduce((sum, count) => sum + Number(count.differenceQty || 0) * Number(count.cost || 0), 0);
    setText("#mamyAdminLines", formatQty(rows.length));
    setText("#mamyAdminDiffValue", formatMoney(diffValue));
    setText("#mamyAdminAlerts", formatQty(rows.filter((count) => Number(count.differenceQty || 0) !== 0 || !count.barcode).length));
    setText("#mamyAdminTeams", formatQty(state.teams.filter((team) => team.active !== false).length));
    renderTeamAdmin();
    const body = $("#mamyAdminRows");
    if (!body) return;
    body.innerHTML = rows.length ? rows.slice(0, 500).map(renderAdminRow).join("") : `<tr><td colspan="7">Aucune ligne.</td></tr>`;
  }

  function renderTeamAdmin() {
    const list = $("#mamyTeamList");
    if (!list) return;
    const teams = state.teams.slice().sort(sortTeams);
    const activeCount = teams.filter((team) => team.active !== false).length;
    setText("#mamyTeamsMeta", `${activeCount} / ${teams.length}`);
    list.innerHTML = teams.length
      ? teams.map(renderTeamItem).join("")
      : `<div class="mamy-team-empty">Aucune equipe creee.</div>`;
  }

  function renderTeamItem(team) {
    const lines = state.counts.filter((count) => count.teamKey === team.teamKey).length;
    const isInactive = team.active === false;
    const action = isInactive ? "restore" : "disable";
    const label = isInactive ? "Reactiver" : "Desactiver";
    const buttonClass = isInactive ? "mamy-primary" : "mamy-secondary";
    return `
      <div class="mamy-team-item ${isInactive ? "is-muted" : ""}">
        <div>
          <strong>${escapeHtml(team.teamName)}</strong>
          <span>${escapeHtml(isInactive ? "inactive" : "active")} - ${formatQty(lines)} ligne(s)</span>
        </div>
        <button class="${buttonClass}" type="button" data-mamy-team-action="${action}" data-team-key="${escapeHtml(team.teamKey)}">${label}</button>
      </div>
    `;
  }

  function renderCountRow(count) {
    return `
      <tr>
        <td>${escapeHtml(count.productName)}</td>
        <td>${escapeHtml(count.zone)}</td>
        <td>${formatQty(count.theoreticalQty)}</td>
        <td>${formatQty(count.countedQty)}</td>
        <td class="${Number(count.differenceQty) < 0 ? "is-negative" : ""}">${formatQty(count.differenceQty)}</td>
        <td>${escapeHtml(count.agentName)}</td>
      </tr>
    `;
  }

  function renderAdminRow(count) {
    return `
      <tr>
        <td>${escapeHtml(count.productName)}</td>
        <td>${escapeHtml(count.zone)}</td>
        <td>${formatQty(count.theoreticalQty)}</td>
        <td>${formatQty(count.countedQty)}</td>
        <td class="${Number(count.differenceQty) < 0 ? "is-negative" : ""}">${formatQty(count.differenceQty)}</td>
        <td>${escapeHtml(count.teamName)}</td>
        <td>${escapeHtml(count.agentName)}</td>
      </tr>
    `;
  }

  function updateSyncBadge() {
    const badge = $("#mamySyncBadge");
    if (!badge) return;
    const pending = getPendingSyncCount();
    let text = "Local";
    if (!navigator.onLine) text = pending ? `Hors ligne (${pending})` : "Hors ligne";
    else if (pending) text = `A synchroniser (${pending})`;
    else if (state.syncStatus.remote === "syncing") text = "Sync...";
    else if (state.syncStatus.remote === "error") text = "Sync en attente";
    else if (hasRemoteConfig()) text = "Synchronise";
    badge.textContent = text;
    badge.dataset.status = !navigator.onLine ? "offline" : pending ? "pending" : state.syncStatus.remote;
    badge.title = state.syncStatus.message || text;
  }

  function openAdmin() {
    if (!isAdminSession()) return;
    $("#mamyAdminPanel").classList.add("is-open");
    $("#mamyAdminPanel").setAttribute("aria-hidden", "false");
    syncNow({ forcePull: true }).catch(() => {});
  }

  function closeAdmin() {
    $("#mamyAdminPanel").classList.remove("is-open");
    $("#mamyAdminPanel").setAttribute("aria-hidden", "true");
  }

  function exportCountsCsv(counts, filename) {
    const headers = ["Produit", "Code-barres", "Reference", "Zone", "Stock Odoo", "Compte", "Ecart", "Prix vente", "Cout", "Equipe", "Agent", "Observation", "Maj"];
    const rows = counts.map((count) => [
      count.productName,
      count.barcode,
      count.internalRef,
      count.zone,
      count.theoreticalQty,
      count.countedQty,
      count.differenceQty,
      count.salePrice,
      count.cost,
      count.teamName,
      count.agentName,
      count.note,
      count.updatedAt,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function getFilteredAdminCounts() {
    const query = normalize($("#mamyAdminSearch")?.value || "");
    const rows = getAllCounts();
    if (!query) return rows;
    return rows.filter((count) =>
      normalize([count.productName, count.barcode, count.internalRef, count.zone, count.teamName, count.agentName].join(" ")).includes(query),
    );
  }

  function getVisibleCounts() {
    if (isAdminSession()) return getAllCounts();
    return state.counts.filter((count) => count.teamKey === state.session.teamKey);
  }

  function getAllCounts() {
    return state.counts.slice().sort(sortCounts);
  }

  function getCountFor(product, zone) {
    return state.counts.find((count) => count.id === getCountId(product, zone, state.session.teamKey));
  }

  function getCountId(product, zone, teamKey) {
    return [MISSION_ID, teamKey || "team", normalize(zone || "rayon"), product.id].join(":");
  }

  function searchProducts(query) {
    const q = normalize(query);
    if (!q) return catalog.filter((product) => Number(product.theoreticalQty || 0) !== 0).slice(0, 35);
    const scored = [];
    catalog.forEach((product) => {
      const barcode = normalize(product.barcode);
      const ref = normalize(product.internalRef);
      const name = normalize(product.name);
      let score = 0;
      if (barcode === q) score += 100;
      else if (barcode.startsWith(q)) score += 60;
      if (ref === q) score += 70;
      else if (ref.startsWith(q)) score += 40;
      if (name.includes(q)) score += name.startsWith(q) ? 35 : 18;
      if (score) scored.push({ product, score });
    });
    return scored.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name)).map((item) => item.product);
  }

  function findExactBarcode(value) {
    const code = clean(value);
    if (!code) return null;
    return catalog.find((product) => product.barcode === code) || null;
  }

  function startSyncTimer() {
    if (syncTimer) return;
    syncTimer = window.setInterval(() => syncNow().catch(() => {}), Number(window.GECAF_CONFIG?.syncIntervalMs) || 5000);
  }

  function getSupabaseClient() {
    if (supabaseClient) return supabaseClient;
    if (!hasRemoteConfig() || !window.supabase?.createClient) throw new Error("Supabase indisponible");
    supabaseClient = window.supabase.createClient(window.GECAF_CONFIG.supabaseUrl, window.GECAF_CONFIG.supabaseAnonKey);
    return supabaseClient;
  }

  function hasRemoteConfig() {
    return Boolean(window.GECAF_CONFIG?.supabaseUrl && window.GECAF_CONFIG?.supabaseAnonKey);
  }

  function toRemoteCount(count) {
    return {
      id: count.id,
      mission_id: count.missionId || MISSION_ID,
      team_key: count.teamKey,
      team_name: count.teamName,
      agent_key: count.agentKey,
      agent_name: count.agentName,
      zone: count.zone,
      product_id: count.productId,
      barcode: count.barcode,
      internal_ref: count.internalRef,
      product_name: count.productName,
      sale_price: Number(count.salePrice || 0),
      cost: Number(count.cost || 0),
      theoretical_qty: Number(count.theoreticalQty || 0),
      counted_qty: Number(count.countedQty || 0),
      status: count.status || "counted",
      note: count.note || "",
      updated_by: count.updatedBy || count.agentName,
      updated_at: count.updatedAt || new Date().toISOString(),
    };
  }

  function fromRemoteCount(row) {
    return {
      id: row.id,
      missionId: row.mission_id || MISSION_ID,
      teamKey: row.team_key,
      teamName: row.team_name,
      agentKey: row.agent_key,
      agentName: row.agent_name,
      zone: row.zone || "",
      productId: row.product_id,
      barcode: row.barcode || "",
      internalRef: row.internal_ref || "",
      productName: row.product_name || "",
      salePrice: Number(row.sale_price || 0),
      cost: Number(row.cost || 0),
      theoreticalQty: Number(row.theoretical_qty || 0),
      countedQty: Number(row.counted_qty || 0),
      differenceQty: Number(row.difference_qty || 0),
      status: row.status || "counted",
      note: row.note || "",
      updatedBy: row.updated_by || "",
      updatedAt: row.updated_at || "",
    };
  }

  function toRemoteTeam(team) {
    return {
      mission_id: MISSION_ID,
      team_key: team.teamKey,
      team_name: team.teamName,
      active: team.active !== false,
      updated_at: team.updatedAt || new Date().toISOString(),
    };
  }

  function fromRemoteTeam(row) {
    return normalizeTeamRecord({
      teamName: row.team_name,
      teamKey: row.team_key,
      active: row.active !== false,
      updatedAt: row.updated_at || "",
    });
  }

  function defaultState() {
    return {
      session: { connected: false, team: "", teamKey: "", agent: "", agentKey: "", isAdmin: false, connectedAt: "" },
      counts: [],
      teams: [],
      syncQueue: [],
      teamSyncQueue: [],
      lastZone: "Rayon",
      syncStatus: { remote: "local", pending: 0, message: "Mode local", lastSyncAt: "" },
    };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed) return defaultState();
      const fallback = defaultState();
      return {
        ...fallback,
        ...parsed,
        session: { ...fallback.session, ...(parsed.session || {}), connected: false, isAdmin: false },
        counts: Array.isArray(parsed.counts) ? parsed.counts : [],
        teams: normalizeTeams(parsed.teams),
        syncQueue: Array.isArray(parsed.syncQueue) ? parsed.syncQueue : [],
        teamSyncQueue: normalizeTeams(parsed.teamSyncQueue),
        syncStatus: { ...fallback.syncStatus, ...(parsed.syncStatus || {}) },
      };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    state.syncStatus.pending = getPendingSyncCount();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, session: { ...state.session, connected: false, isAdmin: false } }));
    updateSyncBadge();
  }

  function upsertLocalTeam(teamName) {
    const name = clean(teamName) || "Equipe terrain";
    const teamKey = normalize(name);
    const now = new Date().toISOString();
    const existing = state.teams.find((team) => team.teamKey === teamKey);
    const team = { teamName: name, teamKey, active: true, updatedAt: now, createdAt: existing?.createdAt || now };
    state.teams = [...state.teams.filter((item) => item.teamKey !== teamKey), team].sort(sortTeams);
    return team;
  }

  function setLocalTeamActive(teamKey, isActive) {
    let updated = null;
    const now = new Date().toISOString();
    state.teams = state.teams
      .map((team) => {
        if (team.teamKey !== teamKey) return team;
        updated = { ...team, active: Boolean(isActive), updatedAt: now };
        return updated;
      })
      .sort(sortTeams);
    return updated;
  }

  function queueTeamSync(team) {
    if (!team?.teamKey) return;
    state.teamSyncQueue = state.teamSyncQueue.filter((item) => item.teamKey !== team.teamKey);
    state.teamSyncQueue.push({ ...team, queuedAt: new Date().toISOString(), attempts: 0 });
    state.syncStatus.pending = getPendingSyncCount();
  }

  async function validateTeamAccess(teamName) {
    if (state.teams.length && isAllowedTeam(teamName)) return true;
    if (!navigator.onLine || !hasRemoteConfig() || !window.supabase?.createClient) return !state.teams.length;
    try {
      await pullRemoteTeams(getSupabaseClient());
      saveState();
    } catch (error) {
      if (!isMissingTeamRemoteObject(error)) throw error;
      teamSyncRemoteAvailable = false;
      return !state.teams.length;
    }
    return state.teams.length ? isAllowedTeam(teamName) : true;
  }

  function isAllowedTeam(teamName) {
    const teamKey = normalize(teamName);
    if (!teamKey) return false;
    if (!state.teams.length) return true;
    return state.teams.some((team) => team.teamKey === teamKey && team.active !== false);
  }

  function normalizeTeams(teams) {
    if (!Array.isArray(teams)) return [];
    const map = new Map();
    teams.forEach((team) => {
      const normalized = normalizeTeamRecord(team);
      if (normalized) map.set(normalized.teamKey, normalized);
    });
    return Array.from(map.values()).sort(sortTeams);
  }

  function normalizeTeamRecord(team) {
    const teamName = clean(team?.teamName || team?.team_name);
    if (!teamName) return null;
    const teamKey = clean(team?.teamKey || team?.team_key) || normalize(teamName);
    if (!teamKey) return null;
    return {
      teamName,
      teamKey,
      active: team?.active !== false,
      updatedAt: team?.updatedAt || team?.updated_at || "",
      createdAt: team?.createdAt || team?.created_at || "",
    };
  }

  function getPendingSyncCount() {
    return (state.syncQueue?.length || 0) + (state.teamSyncQueue?.length || 0);
  }

  function isAdminCredentials(team, agent) {
    return normalize(team) === ADMIN_TEAM && normalize(agent) === ADMIN_AGENT;
  }

  function isAdminSession() {
    return Boolean(state.session.connected && (state.session.isAdmin || isAdminCredentials(state.session.team, state.session.agent)));
  }

  function sortCounts(a, b) {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  }

  function sortTeams(a, b) {
    return String(a.teamName || "").localeCompare(String(b.teamName || ""));
  }

  function isMissingRemoteObject(error) {
    const msg = String(error?.message || error?.details || "");
    return error?.code === "PGRST202" || error?.code === "42P01" || msg.includes("mamy_inventory_counts") || msg.includes("upsert_mamy_counts_newer");
  }

  function isMissingTeamRemoteObject(error) {
    const msg = String(error?.message || error?.details || "");
    return error?.code === "PGRST202" || error?.code === "42P01" || msg.includes("mamy_inventory_teams");
  }

  function getErrorMessage(error) {
    return clean(error?.message || error?.details || error) || "Synchronisation en attente";
  }

  function setText(selector, value) {
    const node = $(selector);
    if (node) node.textContent = value;
  }

  function parseNumber(value) {
    const number = Number(String(value || "0").replace(",", "."));
    return Number.isFinite(number) ? number : 0;
  }

  function formatPlainNumber(value) {
    const number = Number(value || 0);
    return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
  }

  function formatQty(value) {
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value || 0));
  }

  function formatMoney(value) {
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Number(value || 0))} FCFA`;
  }

  function clean(value) {
    return String(value ?? "").trim();
  }

  function normalize(value) {
    return clean(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
})();
