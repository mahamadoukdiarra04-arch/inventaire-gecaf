(function () {
  "use strict";

  const STORAGE_KEY = "gecaf-fiche-inventaire-v5";
  const LEGACY_STORAGE_KEYS = ["gecaf-fiche-inventaire-v4", "gecaf-fiche-inventaire-v3", "gecaf-fiche-inventaire-v2"];
  const IDB_NAME = "gecaf-inventory-offline";
  const IDB_VERSION = 1;
  const ADMIN_TEAM = "equipe_admin";
  const ADMIN_AGENT = "admin1";
  const DATA_ROWS = 200;
  const REMOTE_CONFIG = window.GECAF_CONFIG || {};

  const columns = [
    { key: "order", label: "N° ordre", type: "readonly" },
    { key: "location", label: "Emplacement", type: "text", placeholder: "Emplacement" },
    { key: "inventoryCode", label: "Code inventaire", type: "text", placeholder: "Code inventaire" },
    { key: "oldCode", label: "Ancien code", type: "text", placeholder: "Ancien code" },
    { key: "designation", label: "Désignation", type: "text", placeholder: "Désignation" },
    {
      key: "category",
      label: "Catégorie / Nature",
      type: "select",
      options: [
        "",
        "Mobilier de bureau",
        "Matériel de bureau",
        "Matériel informatique",
        "Matériel de transport",
        "Autre ouvrage d'infrastructure",
        "Batiment",
        "Autre matériel industriel",
        "Autre",
      ],
    },
    { key: "quantity", label: "Quantité", type: "number", placeholder: "Quantité" },
    { key: "holder", label: "Détenteur / service", type: "text", placeholder: "Détenteur / service" },
    {
      key: "funding",
      label: "Source financement",
      type: "select",
      options: ["", "Fonds propres", "Subvention", "Bailleur / projet", "A confirmer"],
    },
    { key: "tagged", label: "Étiquette posée ?", type: "select", options: ["", "Oui", "Non", "À poser"] },
    { key: "condition", label: "État physique", type: "select", options: ["", "Bon", "Passable", "Mauvais"] },
    { key: "observations", label: "Observations", type: "textarea", placeholder: "Observations" },
  ];

  const headerFields = [
    { key: "date", label: "Date :", type: "date" },
    { key: "agency", label: "Agence :", type: "text", placeholder: "Agence" },
    { key: "supervisor", label: "Superviseur :", type: "text", placeholder: "Superviseur" },
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  let state = loadState();
  let active = { type: "row", order: 1, colIndex: 1 };
  let editorValue = "";
  let dbPromise = openOfflineDb();
  let supabaseClient = null;
  let sheetChannel = null;
  let syncTimer = null;
  let syncInFlight = false;
  let applyingRemote = false;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindLogin();
    bindSheet();
    bindEditor();
    bindExport();
    bindAdmin();
    bindConnectivity();
    render();
    hydrateFromOfflineDb();
    registerServiceWorker();
  }

  function defaultState() {
    return {
      session: {
        connected: false,
        team: "",
        teamKey: "",
        agent: "",
        isAdmin: false,
        connectedAt: "",
      },
      sheetId: makeId("sheet"),
      header: {
        date: new Date().toISOString().slice(0, 10),
        agency: "",
        supervisor: "",
        locked: false,
      },
      rows: [],
      archives: [],
      teams: [],
      users: [],
      syncQueue: [],
      syncStatus: {
        online: navigator.onLine,
        remote: "local",
        pending: 0,
        lastSyncAt: "",
        message: "Mode local",
      },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const fallback = defaultState();
      const session = { ...fallback.session, ...(parsed.session || {}) };
      session.teamKey = session.teamKey || normalizeTeam(session.team);
      session.connected = false;
      session.isAdmin = false;
      session.connectedAt = "";
      return {
        ...fallback,
        ...parsed,
        sheetId: parsed.sheetId || makeId("sheet"),
        session,
        header: { ...fallback.header, ...(parsed.header || {}) },
        rows: Array.isArray(parsed.rows) ? parsed.rows : [],
        archives: Array.isArray(parsed.archives) ? parsed.archives : [],
        teams: normalizeTeams(parsed.teams),
        users: normalizeUsers(parsed.users),
        syncQueue: Array.isArray(parsed.syncQueue) ? parsed.syncQueue : [],
        syncStatus: { ...fallback.syncStatus, ...(parsed.syncStatus || {}), online: navigator.onLine },
      };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    state.syncStatus.pending = state.syncQueue.length;
    state.syncStatus.online = navigator.onLine;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getPersistableState()));
    mirrorStateToOfflineDb();
    updateSyncBadge();
  }

  function getPersistableState() {
    return {
      ...state,
      session: {
        ...state.session,
        connected: false,
        isAdmin: false,
        connectedAt: "",
      },
    };
  }

  function bindLogin() {
    $("#loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const nextTeam = clean(data.team);
      const nextAgent = clean(data.agent);
      const isAdmin = isAdminCredentials(nextTeam, nextAgent);

      if (!nextTeam || !nextAgent) {
        alert("Renseignez l'equipe et l'agent.");
        return;
      }

      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Verification...";
      }

      try {
        if (!isAdmin && !(await validateUserAccess(nextTeam, nextAgent))) {
          alert("Cet agent n'est pas encore actif dans cette equipe. Connectez-vous en admin pour l'ajouter.");
          return;
        }

        const teamChanged = normalizeTeam(state.session.team) && normalizeTeam(state.session.team) !== normalizeTeam(nextTeam);
        if (teamChanged) {
          archiveCurrentSheet();
          state.sheetId = makeId("sheet");
          state.header = { date: new Date().toISOString().slice(0, 10), agency: "", supervisor: "", locked: false };
          state.rows = [];
          active = { type: "row", order: 1, colIndex: 1 };
        }

        state.session = {
          connected: true,
          team: nextTeam,
          teamKey: normalizeTeam(nextTeam),
          agent: nextAgent,
          isAdmin,
          connectedAt: new Date().toISOString(),
        };
        saveState();
        render();
        if (isAdmin) {
          await refreshAdminData();
          openAdminPanel();
        } else {
          await startTeamSession();
        }
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = "Ouvrir la fiche";
        }
      }
    });

    $("#backToLogin").addEventListener("click", () => {
      stopRealtime();
      state.session.connected = false;
      state.session.isAdmin = false;
      state.session.connectedAt = "";
      saveState();
      render();
    });
  }

  function bindSheet() {
    $("#addRowButton").addEventListener("click", () => {
      const row = getNextEmptyRow();
      active = { type: "row", order: row.order, colIndex: 1 };
      saveState();
      renderSheet();
      scrollRowIntoView(row.order);
      openRowEditor(row.order, 1);
    });

    $("#newSheetButton").addEventListener("click", () => {
      flushOpenEditor();
      archiveCurrentSheet();
      createBlankCurrentSheet();
      active = { type: "header", key: "date" };
      saveState();
      renderSheet();
      syncNow();
    });

    $("#adminButton").addEventListener("click", async () => {
      if (!isAdminSession()) return;
      await refreshAdminData();
      openAdminPanel();
    });

    $("#archivesButton").addEventListener("click", () => {
      renderArchives();
      $("#archivesPanel").classList.add("is-open");
      $("#archivesPanel").setAttribute("aria-hidden", "false");
    });

    $$("[data-close-archives]").forEach((node) => {
      node.addEventListener("click", closeArchives);
    });

    $("#archivesList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-archive-id]");
      if (!button) return;
      loadArchive(button.dataset.archiveId);
    });

    $("#sheetGrid").addEventListener("click", (event) => {
      const headerCell = event.target.closest("[data-header-key]");
      if (headerCell) {
        openHeaderEditor(headerCell.dataset.headerKey);
        return;
      }

      const rowCell = event.target.closest("[data-row-order][data-col-index]");
      if (!rowCell) return;
      openRowEditor(Number(rowCell.dataset.rowOrder), Number(rowCell.dataset.colIndex));
    });
  }

  function bindEditor() {
    $$("[data-close-editor]").forEach((node) => node.addEventListener("click", closeEditor));
    $("#previousCell").addEventListener("click", () => moveEditor(-1));
    $("#nextCell").addEventListener("click", () => moveEditor(1));

    document.addEventListener("keydown", (event) => {
      if (!$("#cellEditor").classList.contains("is-open")) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        moveEditor(event.shiftKey ? -1 : 1);
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        const textarea = $("#editorControl").querySelector("textarea");
        if (textarea) return;
        event.preventDefault();
        moveEditor(1);
      }
    });
  }

  function bindExport() {
    $("#exportPdfButton").addEventListener("click", () => {
      flushOpenEditor();
      document.title = getExportBaseName() + ".pdf";
      document.body.classList.add("pdf-export-mode");
      requestAnimationFrame(() => window.print());
    });

    $("#exportExcelButton").addEventListener("click", () => {
      flushOpenEditor();
      downloadXlsx();
    });

    window.addEventListener("afterprint", () => {
      document.body.classList.remove("pdf-export-mode");
    });
  }

  function flushOpenEditor() {
    if ($("#cellEditor").classList.contains("is-open")) {
      writeActiveValue();
      renderSheet();
    }
  }

  function bindAdmin() {
    $$("[data-close-admin]").forEach((node) => node.addEventListener("click", closeAdminPanel));

    $("#teamForm").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!isAdminSession()) return;
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const team = upsertLocalTeam(data.teamName);
      queueSync("upsertTeam", team);
      event.currentTarget.reset();
      saveState();
      renderAdminPanel();
      syncNow();
    });

    $("#userForm").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!isAdminSession()) return;
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const team = upsertLocalTeam(data.teamName);
      const user = upsertLocalUser(team.teamName, data.agentName);
      queueSync("upsertTeam", team);
      queueSync("upsertUser", user);
      event.currentTarget.reset();
      saveState();
      renderAdminPanel();
      syncNow();
    });

    $("#adminArchivesList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-archive-id]");
      if (!button || !isAdminSession()) return;
      closeAdminPanel();
      loadArchive(button.dataset.archiveId);
    });
  }

  function bindConnectivity() {
    window.addEventListener("online", () => {
      state.syncStatus.online = true;
      state.syncStatus.message = "Connexion retablie";
      saveState();
      syncNow();
    });
    window.addEventListener("offline", () => {
      state.syncStatus.online = false;
      state.syncStatus.remote = "offline";
      state.syncStatus.message = "Hors ligne";
      saveState();
    });
  }

  function openAdminPanel() {
    renderAdminPanel();
    $("#adminPanel").classList.add("is-open");
    $("#adminPanel").setAttribute("aria-hidden", "false");
  }

  function closeAdminPanel() {
    $("#adminPanel").classList.remove("is-open");
    $("#adminPanel").setAttribute("aria-hidden", "true");
  }

  function renderAdminPanel() {
    if (!$("#adminPanel")) return;
    $("#adminTeamsList").innerHTML = state.teams.length
      ? state.teams
          .map(
            (team) => `
              <div class="admin-list-item">
                <strong>${escapeHtml(team.teamName)}</strong>
                <span>${escapeHtml(team.teamKey)}</span>
              </div>
            `,
          )
          .join("")
      : `<div class="archive-empty">Aucune equipe enregistree.</div>`;

    $("#adminUsersList").innerHTML = state.users.length
      ? state.users
          .map(
            (user) => `
              <div class="admin-list-item">
                <strong>${escapeHtml(user.agentName)}</strong>
                <span>${escapeHtml(user.teamName)} - ${user.active ? "actif" : "desactive"}</span>
              </div>
            `,
          )
          .join("")
      : `<div class="archive-empty">Aucun utilisateur enregistre.</div>`;

    const archives = getVisibleArchives();
    $("#adminArchivesList").innerHTML = archives.length
      ? archives.map(renderArchiveButton).join("")
      : `<div class="archive-empty">Aucune fiche disponible.</div>`;
  }

  function archiveCurrentSheet() {
    const hasHeader = clean(state.header.agency) || clean(state.header.supervisor);
    const hasRows = state.rows.some((row) => columns.slice(1).some((column) => clean(row[column.key])));
    if (!hasHeader && !hasRows) return;

    const archive = {
      id: state.sheetId || makeId("sheet"),
      status: "archived",
      archivedAt: new Date().toISOString(),
      session: { ...state.session },
      header: { ...state.header },
      rows: state.rows.map((row) => ({ ...row })),
    };

    state.archives = [archive, ...state.archives.filter((item) => item.id !== archive.id)];
    queueSync("archiveSheet", {
      sheetId: archive.id,
      teamKey: normalizeTeam(archive.session.team),
      teamName: archive.session.team,
      archivedAt: archive.archivedAt,
      updatedBy: archive.session.agent,
    });
  }

  function createBlankCurrentSheet() {
    state.sheetId = makeId("sheet");
    state.header = { date: new Date().toISOString().slice(0, 10), agency: "", supervisor: "", locked: false };
    state.rows = [];
    queueSync("upsertSheet", currentSheetPayload("active"));
    queueCellChange(0, "date", state.header.date);
  }

  function renderArchives() {
    const list = $("#archivesList");
    const archives = getVisibleArchives();
    if (!archives.length) {
      list.innerHTML = `<div class="archive-empty">Aucune fiche archivée pour ${escapeHtml(state.session.team || "cette équipe")}.</div>`;
      return;
    }

    list.innerHTML = archives.map(renderArchiveButton).join("");
  }

  function loadArchive(id) {
    const archive = getVisibleArchives().find((item) => item.id === id);
    if (!archive) return;
    const wasAdmin = isAdminSession();
    if (!wasAdmin) archiveCurrentSheet();
    state.sheetId = archive.id;
    state.session = {
      ...state.session,
      ...archive.session,
      connected: true,
      teamKey: normalizeTeam(archive.session?.team),
      isAdmin: wasAdmin || Boolean(archive.session?.isAdmin),
    };
    state.header = { ...archive.header };
    state.rows = archive.rows.map((row) => ({ ...row }));
    active = { type: "row", order: 1, colIndex: 1 };
    saveState();
    closeArchives();
    renderSheet();
  }

  function closeArchives() {
    $("#archivesPanel").classList.remove("is-open");
    $("#archivesPanel").setAttribute("aria-hidden", "true");
  }

  function getTeamArchives() {
    const teamKey = normalizeTeam(state.session.team);
    return state.archives.filter((archive) => normalizeTeam(archive.session?.team) === teamKey && (archive.status || "archived") === "archived");
  }

  function getVisibleArchives() {
    return isAdminSession() ? state.archives : getTeamArchives();
  }

  function renderArchiveButton(archive) {
    const filledRows = archive.rows.filter((row) => columns.slice(1).some((column) => clean(row[column.key]))).length;
    const title = [archive.session?.team, formatHeaderValue("date", archive.header.date), archive.header.agency, archive.session?.agent]
      .filter(Boolean)
      .join(" - ");
    const isActiveSheet = archive.status === "active";
    const dateLabel = isActiveSheet ? "fiche active - mise a jour le" : "archivee le";
    return `
      <button class="archive-item" type="button" data-archive-id="${archive.id}">
        <strong>${escapeHtml(title || (isActiveSheet ? "Fiche active" : "Fiche archivee"))}</strong>
        <span>${filledRows} ligne(s) - ${dateLabel} ${escapeHtml(formatDateTime(archive.archivedAt))}</span>
      </button>
    `;
  }

  function render() {
    $("#loginView").classList.toggle("is-hidden", state.session.connected);
    $("#sheetView").classList.toggle("is-hidden", !state.session.connected);
    $("#adminButton").classList.toggle("is-visible", isAdminSession());
    updateSyncBadge();

    if (!state.session.connected) {
      $("#loginForm").reset();
      return;
    }

    renderSheet();
  }

  function renderSheet() {
    $("#sheetGrid").innerHTML = [
      renderMergedRow("row-1", "FICHE D'INVENTAIRE DES IMMOBILISATIONS", "title-cell"),
      renderMergedRow(
        "row-2",
        "À renseigner sur le terrain. Les champs jaunes sont à compléter ; les statuts sont affinés après contrôle et rapprochement.",
        "instruction-cell",
      ),
      renderBlankRow("row-3", "meta-fill"),
      renderHeaderInputRow(4, headerFields[0]),
      renderHeaderInputRow(5, headerFields[1]),
      renderHeaderInputRow(6, headerFields[2]),
      renderBlankRow("row-7", "white-fill"),
      renderColumnHeaderRow(),
      ...Array.from({ length: DATA_ROWS }, (_, index) => renderDataRow(index + 1)),
    ].join("");
  }

  function renderMergedRow(rowClass, content, cellClass) {
    return `<div class="excel-row ${rowClass}"><div class="excel-cell merged ${cellClass}">${escapeHtml(content)}</div></div>`;
  }

  function renderBlankRow(rowClass, fillClass) {
    return `<div class="excel-row ${rowClass}">${columns.map(() => `<div class="excel-cell ${fillClass}"></div>`).join("")}</div>`;
  }

  function renderHeaderInputRow(rowNumber, field) {
    const value = state.header[field.key] || "";
    return `
      <div class="excel-row row-${rowNumber}">
        <div class="excel-cell meta-label">${escapeHtml(field.label)}</div>
        <button class="excel-cell meta-value" type="button" data-header-key="${field.key}">
          ${escapeHtml(formatHeaderValue(field.key, value))}
        </button>
        ${columns.slice(2).map(() => `<div class="excel-cell meta-fill"></div>`).join("")}
      </div>
    `;
  }

  function renderColumnHeaderRow() {
    return `
      <div class="excel-row row-8">
        ${columns.map((column) => `<div class="excel-cell column-head">${escapeHtml(column.label)}</div>`).join("")}
      </div>
    `;
  }

  function renderDataRow(order) {
    const row = findRow(order);
    const hasContent = rowHasContent(row);
    const emptyClass = hasContent ? "" : "is-empty";
    return `
      <div class="excel-row data-row ${emptyClass}" data-rendered-row="${order}">
        ${columns
          .map((column, colIndex) => {
            const value = column.key === "order" ? (hasContent ? String(order) : "") : clean(row?.[column.key]);
            const activeClass = active.type === "row" && active.order === order && active.colIndex === colIndex ? "is-active" : "";
            return `
              <button
                class="excel-cell data-cell ${activeClass}"
                type="button"
                data-row-order="${order}"
                data-col-index="${colIndex}"
                aria-label="Ligne ${order}, ${escapeHtml(column.label)}"
              >${escapeHtml(value)}</button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function openHeaderEditor(key) {
    const field = headerFields.find((item) => item.key === key);
    if (!field) return;
    active = { type: "header", key };
    editorValue = state.header[key] || "";
    $("#editorPosition").textContent = "Entete";
    $("#editorTitle").textContent = field.label;
    $("#editorControl").innerHTML = createControl(field, editorValue);
    openEditorPanel();
  }

  function openRowEditor(order, colIndex) {
    const columnIndex = Math.max(0, Math.min(columns.length - 1, colIndex));
    if (columnIndex === 0) {
      openRowEditor(order, 1);
      return;
    }

    const row = ensureRow(order);
    const column = columns[columnIndex];
    active = { type: "row", order: row.order, colIndex: columnIndex };
    editorValue = clean(row[column.key]);
    $("#editorPosition").textContent = "Ligne " + row.order + " - colonne " + (columnIndex + 1) + "/" + columns.length;
    $("#editorTitle").textContent = column.label;
    $("#editorControl").innerHTML = createControl(column, editorValue);
    saveState();
    renderSheet();
    openEditorPanel();
  }

  function openEditorPanel() {
    const control = $("#editorControl").querySelector("input, select, textarea");
    if (control) {
      control.addEventListener("input", () => {
        editorValue = control.value;
        writeActiveValue();
      });
      control.addEventListener("change", () => {
        editorValue = control.value;
        writeActiveValue();
      });
    }

    $("#cellEditor").classList.add("is-open");
    $("#cellEditor").setAttribute("aria-hidden", "false");

    requestAnimationFrame(() => {
      const input = $("#editorControl").querySelector("input, select, textarea");
      if (input) input.focus();
      if (input?.select && input.tagName !== "SELECT") input.select();
    });
  }

  function createControl(field, value) {
    const help = `<small>Entree ou Suivant passe au champ suivant. Le champ peut rester vide.</small>`;
    if (field.type === "textarea") {
      return `<textarea placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(value)}</textarea>${help}`;
    }
    if (field.type === "select") {
      return `
        <select>
          ${field.options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option || "Non renseigne")}</option>`).join("")}
        </select>
        ${help}
      `;
    }
    if (field.type === "number") {
      return `<input type="number" inputmode="numeric" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder || "")}" />${help}`;
    }
    if (field.type === "date") {
      return `<input type="date" value="${escapeHtml(value)}" />${help}`;
    }
    return `<input type="text" enterkeyhint="next" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder || "")}" />${help}`;
  }

  function moveEditor(direction) {
    writeActiveValue();

    if (active.type === "header") {
      const current = headerFields.findIndex((field) => field.key === active.key);
      const next = current + direction;
      if (next >= 0 && next < headerFields.length) openHeaderEditor(headerFields[next].key);
      else openRowEditor(1, 1);
      return;
    }

    let nextCol = active.colIndex + direction;
    let nextOrder = active.order;

    if (nextCol >= columns.length) {
      nextOrder = Math.min(DATA_ROWS, active.order + 1);
      nextCol = 1;
    }

    if (nextCol <= 0) {
      nextOrder = Math.max(1, active.order - 1);
      nextCol = columns.length - 1;
    }

    openRowEditor(nextOrder, nextCol);
    scrollRowIntoView(nextOrder);
  }

  function closeEditor() {
    writeActiveValue();
    $("#cellEditor").classList.remove("is-open");
    $("#cellEditor").setAttribute("aria-hidden", "true");
    renderSheet();
  }

  function writeActiveValue() {
    if (active.type === "header") {
      const value = clean(editorValue);
      state.header[active.key] = value;
      queueCellChange(0, active.key, value);
      saveState();
      return;
    }

    const row = ensureRow(active.order);
    const column = columns[active.colIndex];
    if (column && column.key !== "order") {
      const value = clean(editorValue);
      row[column.key] = value;
      row.updatedAt = new Date().toISOString();
      row.updatedBy = state.session.agent;
      queueCellChange(row.order, column.key, value);
    }
    saveState();
  }

  function ensureRow(order) {
    let row = findRow(order);
    if (!row) {
      row = {
        id: "row-" + order,
        order,
        location: "",
        inventoryCode: "",
        oldCode: "",
        designation: "",
        category: "",
        quantity: "",
        holder: "",
        funding: "",
        tagged: "",
        condition: "",
        observations: "",
        createdAt: new Date().toISOString(),
      };
      state.rows.push(row);
      state.rows.sort((a, b) => Number(a.order) - Number(b.order));
    }
    return row;
  }

  function findRow(order) {
    return state.rows.find((row) => Number(row.order) === Number(order));
  }

  function getNextEmptyRow() {
    for (let order = 1; order <= DATA_ROWS; order += 1) {
      const row = findRow(order);
      if (!row || !rowHasContent(row)) return ensureRow(order);
    }
    return ensureRow(DATA_ROWS);
  }

  function rowHasContent(row) {
    return Boolean(row && columns.slice(1).some((column) => clean(row[column.key])));
  }

  function scrollRowIntoView(order) {
    requestAnimationFrame(() => {
      const node = $(`[data-rendered-row="${order}"]`);
      if (node) node.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function buildExportRows() {
    const headers = [
      "Date",
      "Agence",
      "Superviseur",
      "Equipe",
      "Agent",
      ...columns.map((column) => column.label),
    ];
    const rows = state.rows
      .filter((row) => columns.slice(1).some((column) => clean(row[column.key])))
      .map((row) => [
        state.header.date,
        state.header.agency,
        state.header.supervisor,
        state.session.team,
        state.session.agent,
        ...columns.map((column) => (column.key === "order" ? row.order : clean(row[column.key]))),
      ]);
    return [headers, ...rows];
  }

  function toCSV(rows) {
    return "\ufeff" + rows.map((row) => row.map(csvCell).join(";")).join("\n");
  }

  function csvCell(value) {
    const text = String(value ?? "");
    if (/[;"\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type: type + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }

  function downloadXlsx() {
    const blob = buildXlsxBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = getExportBaseName() + ".xlsx";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }

  function buildXlsxBlob() {
    const files = {
      "[Content_Types].xml": contentTypesXml(),
      "_rels/.rels": rootRelsXml(),
      "xl/workbook.xml": workbookXml(),
      "xl/_rels/workbook.xml.rels": workbookRelsXml(),
      "xl/styles.xml": stylesXml(),
      "xl/worksheets/sheet1.xml": worksheetXml(),
      "docProps/core.xml": coreXml(),
      "docProps/app.xml": appXml(),
    };
    return zipFiles(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  function worksheetXml() {
    const colWidths = [
      "12.6328125",
      "30.6328125",
      "22.54296875",
      "27.90625",
      "37.1796875",
      "25.1796875",
      "14.08984375",
      "26",
      "20.6328125",
      "14",
      "21.1796875",
      "40.90625",
    ];

    const colXml = colWidths
      .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" style="2" customWidth="1"/>`)
      .join("");

    const rows = [
      xlsxRow(1, null, Array.from({ length: 12 }, (_, index) => cell(index, 1, 1, index === 0 ? "FICHE D'INVENTAIRE DES IMMOBILISATIONS" : ""))),
      xlsxRow(
        2,
        ' ht="16.5" customHeight="1"',
        Array.from({ length: 12 }, (_, index) =>
          cell(
            index,
            2,
            3,
            index === 0
              ? "À renseigner sur le terrain. Les champs jaunes sont à compléter ; les statuts sont affinés après contrôle et rapprochement."
              : "",
          ),
        ),
      ),
      xlsxRow(3, null, Array.from({ length: 12 }, (_, index) => cell(index, 3, 4, ""))),
      xlsxRow(4, null, headerCells(4, "Date :", formatHeaderValue("date", state.header.date))),
      xlsxRow(5, null, headerCells(5, "Agence :", state.header.agency)),
      xlsxRow(6, null, headerCells(6, "Superviseur :", state.header.supervisor)),
      xlsxRow(8, ' ht="48"', columns.map((column, index) => cell(index, 8, 6, column.label))),
    ];

    for (let order = 1; order <= DATA_ROWS; order += 1) {
      const row = findRow(order);
      const hasContent = rowHasContent(row);
      const values = columns.map((column) => (column.key === "order" ? (hasContent ? String(order) : "") : clean(row?.[column.key])));
      rows.push(
        xlsxRow(
          order + 8,
          ' s="8" customFormat="1" ht="43.5"',
          values.map((value, index) => cell(index, order + 8, 7, value)),
        ),
      );
    }

    const validations = dataValidationsXml([
      ["F9:F208", getColumnOptions("category")],
      ["K9:K208", getColumnOptions("condition")],
    ]);

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">
  <dimension ref="A1:L208"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr baseColWidth="10" defaultRowHeight="24" x14ac:dyDescent="0.35"/>
  <cols>${colXml}<col min="13" max="16384" width="10.90625" style="2"/></cols>
  <sheetData>${rows.join("")}</sheetData>
  <mergeCells count="2"><mergeCell ref="A1:L1"/><mergeCell ref="A2:L2"/></mergeCells>
  ${validations}
  <pageMargins left="0.70866141732283472" right="0.70866141732283472" top="0.74803149606299213" bottom="0.74803149606299213" header="0.31496062992125984" footer="0.31496062992125984"/>
  <pageSetup paperSize="9" scale="44" fitToHeight="0" orientation="landscape"/>
</worksheet>`;
  }

  function getColumnOptions(key) {
    return columns.find((column) => column.key === key)?.options || [];
  }

  function dataValidationsXml(validations) {
    const rules = validations
      .map(([range, options]) => dataValidationXml(range, options))
      .filter(Boolean);
    if (!rules.length) return "";
    return `<dataValidations count="${rules.length}">${rules.join("")}</dataValidations>`;
  }

  function dataValidationXml(range, options) {
    const values = options.filter(Boolean).map((option) => clean(option)).filter(Boolean);
    if (!values.length) return "";
    return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${range}"><formula1>&quot;${escapeXml(values.join(","))}&quot;</formula1></dataValidation>`;
  }

  function headerCells(rowNumber, label, value) {
    return [
      cell(0, rowNumber, 5, label),
      cell(1, rowNumber, 4, value || ""),
      ...Array.from({ length: 10 }, (_, index) => cell(index + 2, rowNumber, 4, "")),
    ];
  }

  function xlsxRow(rowNumber, attrs, cells) {
    return `<row r="${rowNumber}" spans="1:12"${attrs || ""} x14ac:dyDescent="0.35">${cells.join("")}</row>`;
  }

  function cell(colIndex, rowNumber, styleIndex, value) {
    const ref = columnName(colIndex + 1) + rowNumber;
    if (!clean(value)) return `<c r="${ref}" s="${styleIndex}"/>`;
    return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  }

  function columnName(index) {
    let name = "";
    let current = index;
    while (current > 0) {
      const remainder = (current - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      current = Math.floor((current - 1) / 26);
    }
    return name;
  }

  function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="6">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Gill Sans MT"/><family val="2"/></font>
    <font><sz val="16"/><color theme="1"/><name val="Gill Sans MT"/><family val="2"/></font>
    <font><i/><sz val="16"/><color theme="1"/><name val="Gill Sans MT"/><family val="2"/></font>
    <font><b/><i/><sz val="16"/><color theme="1"/><name val="Gill Sans MT"/><family val="2"/></font>
    <font><sz val="30"/><color theme="1"/><name val="Gill Sans MT"/><family val="2"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF00B0F0"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right><top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="10">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"/>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"/>
    <xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"/>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"/>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
  }

  function contentTypesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  }

  function rootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  function workbookXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Fiche inventaire" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  }

  function workbookRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }

  function coreXml() {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>GECAF INV</dc:creator>
  <cp:lastModifiedBy>GECAF INV</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  }

  function appXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>GECAF INV</Application>
</Properties>`;
  }

  function zipFiles(files, mimeType) {
    const encoder = new TextEncoder();
    const fileRecords = [];
    let offset = 0;
    const chunks = [];

    Object.entries(files).forEach(([name, content]) => {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(content);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);
      fileRecords.push({ nameBytes, dataLength: data.length, crc, offset });
      offset += local.length + data.length;
    });

    const centralStart = offset;
    fileRecords.forEach((record) => {
      const central = new Uint8Array(46 + record.nameBytes.length);
      const view = new DataView(central.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint16(14, 0, true);
      view.setUint32(16, record.crc, true);
      view.setUint32(20, record.dataLength, true);
      view.setUint32(24, record.dataLength, true);
      view.setUint16(28, record.nameBytes.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, record.offset, true);
      central.set(record.nameBytes, 46);
      chunks.push(central);
      offset += central.length;
    });

    const centralSize = offset - centralStart;
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, fileRecords.length, true);
    endView.setUint16(10, fileRecords.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralStart, true);
    chunks.push(end);
    return new Blob(chunks, { type: mimeType });
  }

  function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  async function startTeamSession() {
    createSyncTimer();
    if (!hasRemoteConfig()) {
      state.syncStatus.remote = "local";
      state.syncStatus.message = "Mode hors serveur";
      saveState();
      return;
    }

    const client = getSupabaseClient();
    if (!client || !navigator.onLine) {
      state.syncStatus.remote = "offline";
      state.syncStatus.message = "Hors ligne";
      saveState();
      return;
    }

    state.syncStatus.remote = "syncing";
    state.syncStatus.message = "Synchronisation...";
    saveState();

    try {
      await syncNow();
      await loadRemoteActiveSheet();
      await pullRemoteArchivesForTeam(state.session.teamKey);
      startRealtime();
      state.syncStatus.remote = "synced";
      state.syncStatus.message = "Synchronise";
      state.syncStatus.lastSyncAt = new Date().toISOString();
      saveState();
      render();
    } catch (error) {
      state.syncStatus.remote = "error";
      state.syncStatus.message = "Sync en attente";
      saveState();
    }
  }

  async function refreshAdminData() {
    if (!isAdminSession()) return;
    createSyncTimer();
    if (hasRemoteConfig() && navigator.onLine) {
      try {
        await syncNow();
        await pullRemoteAdminData();
      } catch {
        state.syncStatus.remote = "error";
        state.syncStatus.message = "Admin local";
      }
    }
    saveState();
    renderAdminPanel();
  }

  function createSyncTimer() {
    if (syncTimer) return;
    syncTimer = window.setInterval(() => {
      if (state.session.connected) syncNow();
    }, Number(REMOTE_CONFIG.syncIntervalMs) || 5000);
  }

  function hasRemoteConfig() {
    return Boolean(REMOTE_CONFIG.supabaseUrl && REMOTE_CONFIG.supabaseAnonKey && window.supabase?.createClient);
  }

  function getSupabaseClient() {
    if (!hasRemoteConfig()) return null;
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(REMOTE_CONFIG.supabaseUrl, REMOTE_CONFIG.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return supabaseClient;
  }

  async function syncNow() {
    if (!hasRemoteConfig() || !navigator.onLine) {
      state.syncStatus.remote = navigator.onLine ? "local" : "offline";
      state.syncStatus.pending = state.syncQueue.length;
      updateSyncBadge();
      return;
    }

    const client = getSupabaseClient();
    if (!client || !state.syncQueue.length) {
      state.syncStatus.remote = "synced";
      state.syncStatus.pending = 0;
      state.syncStatus.lastSyncAt = state.syncStatus.lastSyncAt || new Date().toISOString();
      updateSyncBadge();
      return;
    }

    if (syncInFlight) {
      state.syncStatus.remote = "syncing";
      state.syncStatus.pending = state.syncQueue.length;
      updateSyncBadge();
      return;
    }

    syncInFlight = true;
    state.syncStatus.remote = "syncing";
    state.syncStatus.pending = state.syncQueue.length;
    updateSyncBadge();

    const context = createSyncContext();
    try {
      for (const action of [...state.syncQueue]) {
        try {
          await sendSyncAction(client, action, context);
          state.syncQueue = state.syncQueue.filter((item) => item.actionId !== action.actionId);
          state.syncStatus.pending = state.syncQueue.length;
          state.syncStatus.lastSyncAt = new Date().toISOString();
          state.syncStatus.message = state.syncQueue.length ? "Synchronisation..." : "Synchronise";
          saveState();
        } catch (error) {
          state.syncStatus.remote = "error";
          state.syncStatus.message = "Sync en attente";
          saveState();
          console.warn("GECAF sync action failed", action?.type, error);
          break;
        }
      }
    } finally {
      syncInFlight = false;
    }

    state.syncStatus.pending = state.syncQueue.length;
    state.syncStatus.remote = state.syncQueue.length ? "error" : "synced";
    state.syncStatus.message = state.syncQueue.length ? "Sync en attente" : "Synchronise";
    saveState();
  }

  function createSyncContext() {
    return {
      activeSheetsByTeam: new Map(),
      sheetIdMap: new Map(),
    };
  }

  async function sendSyncAction(client, action, context = createSyncContext()) {
    if (action.type === "upsertTeam") {
      await throwOnError(
        client.from("inventory_teams").upsert(
          {
            team_key: action.teamKey,
            team_name: action.teamName,
            active: action.active !== false,
            updated_at: action.updatedAt,
          },
          { onConflict: "team_key" },
        ),
      );
      return;
    }

    if (action.type === "upsertUser") {
      await throwOnError(
        client.from("inventory_users").upsert(
          {
            team_key: action.teamKey,
            team_name: action.teamName,
            agent_key: action.agentKey,
            agent_name: action.agentName,
            active: action.active !== false,
            updated_at: action.updatedAt,
          },
          { onConflict: "team_key,agent_key" },
        ),
      );
      return;
    }

    if (action.type === "upsertSheet") {
      await sendUpsertSheet(client, action.sheet, context);
      return;
    }

    if (action.type === "archiveSheet") {
      const archiveSheetId = await resolveArchiveSheetId(client, action, context);
      await sendUpsertSheet(client, {
        id: archiveSheetId,
        team_key: action.teamKey,
        team_name: action.teamName || state.session.team,
        status: "archived",
        archived_at: action.archivedAt,
        created_by: action.updatedBy,
        updated_by: action.updatedBy,
        updated_at: action.archivedAt,
      });
      await throwOnError(
        client
          .from("inventory_sheets")
          .update({
            status: "archived",
            archived_at: action.archivedAt,
            updated_at: action.archivedAt,
            updated_by: action.updatedBy,
          })
          .eq("id", archiveSheetId),
      );
      return;
    }

    if (action.type === "upsertCell") {
      const sheet = await sendUpsertSheet(client, {
        id: action.sheetId,
        team_key: action.teamKey,
        team_name: action.teamName || state.session.team,
        status: "active",
        archived_at: null,
        created_by: action.updatedBy,
        updated_by: action.updatedBy,
        updated_at: action.updatedAt,
      }, context);
      const sheetId = sheet?.id || getMappedSheetId(context, action.sheetId) || action.sheetId;
      await throwOnError(
        client.from("inventory_cells").upsert(
          {
            sheet_id: sheetId,
            row_order: action.rowOrder,
            field_key: action.fieldKey,
            value: action.value,
            updated_at: action.updatedAt,
            updated_by: action.updatedBy,
          },
          { onConflict: "sheet_id,row_order,field_key" },
        ),
      );
    }
  }

  async function sendUpsertSheet(client, sheet, context = createSyncContext()) {
    if (!sheet?.id) return null;
    const sheetPayload = {
      id: getMappedSheetId(context, sheet.id) || sheet.id,
      team_key: sheet.team_key,
      team_name: sheet.team_name,
      status: sheet.status,
      archived_at: sheet.archived_at || null,
      created_by: sheet.created_by,
      updated_by: sheet.updated_by,
      updated_at: sheet.updated_at,
    };

    if (sheetPayload.status === "active") {
      const activeSheet = await findRemoteActiveSheet(client, sheetPayload.team_key, context);
      if (activeSheet && activeSheet.id !== sheetPayload.id) {
        rememberSheetMapping(context, sheet.id, activeSheet.id);
        return activeSheet;
      }
    }

    const result = await client.from("inventory_sheets").upsert(sheetPayload, { onConflict: "id" });
    if (result.error) {
      const activeSheet = sheetPayload.status === "active" ? await findRemoteActiveSheet(client, sheetPayload.team_key, context, true) : null;
      if (activeSheet) {
        rememberSheetMapping(context, sheet.id, activeSheet.id);
        return activeSheet;
      }
      throw result.error;
    }

    if (sheetPayload.status === "active") {
      context.activeSheetsByTeam.set(sheetPayload.team_key, { ...sheetPayload });
    }
    return sheetPayload;
  }

  async function resolveArchiveSheetId(client, action, context) {
    const sheetId = getMappedSheetId(context, action.sheetId) || action.sheetId;
    const { data, error } = await client.from("inventory_sheets").select("id").eq("id", sheetId).limit(1);
    if (error) throw error;
    if (data?.[0]?.id) return data[0].id;

    const activeSheet = await findRemoteActiveSheet(client, action.teamKey, context, true);
    if (activeSheet?.id) {
      rememberSheetMapping(context, action.sheetId, activeSheet.id);
      return activeSheet.id;
    }
    return sheetId;
  }

  async function findRemoteActiveSheet(client, teamKey, context, refresh = false) {
    if (!teamKey) return null;
    if (!refresh && context.activeSheetsByTeam.has(teamKey)) return context.activeSheetsByTeam.get(teamKey);
    const { data, error } = await client
      .from("inventory_sheets")
      .select("id,team_key,team_name,status,archived_at,created_by,updated_by,updated_at")
      .eq("team_key", teamKey)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const sheet = data?.[0] || null;
    if (sheet) context.activeSheetsByTeam.set(teamKey, sheet);
    return sheet;
  }

  function rememberSheetMapping(context, fromSheetId, toSheetId) {
    if (!fromSheetId || !toSheetId || fromSheetId === toSheetId) return;
    context.sheetIdMap.set(fromSheetId, toSheetId);
    if (state.sheetId === fromSheetId) state.sheetId = toSheetId;
    state.syncQueue.forEach((item) => {
      if (item.sheetId === fromSheetId) item.sheetId = toSheetId;
      if (item.sheet?.id === fromSheetId) item.sheet.id = toSheetId;
    });
  }

  function getMappedSheetId(context, sheetId) {
    return context.sheetIdMap.get(sheetId) || sheetId;
  }

  async function throwOnError(request) {
    const result = await request;
    if (result.error) throw result.error;
    return result.data;
  }

  async function ensureRemoteTeamAndUser() {
    const client = getSupabaseClient();
    if (!client || isAdminSession()) return;
    const team = upsertLocalTeam(state.session.team);
    const user = upsertLocalUser(state.session.team, state.session.agent);
    await sendSyncAction(client, { actionId: makeId("op"), type: "upsertTeam", ...team, updatedAt: new Date().toISOString() });
    await sendSyncAction(client, { actionId: makeId("op"), type: "upsertUser", ...user, updatedAt: new Date().toISOString() });
  }

  async function loadRemoteActiveSheet() {
    const client = getSupabaseClient();
    if (!client || isAdminSession()) return;
    const teamKey = state.session.teamKey || normalizeTeam(state.session.team);
    const { data, error } = await client
      .from("inventory_sheets")
      .select("*")
      .eq("team_key", teamKey)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;

    const sheet = data?.[0];
    if (!sheet) {
      queueSync("upsertSheet", currentSheetPayload("active"));
      await syncNow();
      return;
    }

    const cells = await fetchSheetCells(client, sheet.id);
    applyRemoteSheet(sheet, cells);
  }

  async function pullRemoteArchivesForTeam(teamKey) {
    const client = getSupabaseClient();
    if (!client || !teamKey) return;
    const { data, error } = await client
      .from("inventory_sheets")
      .select("*")
      .eq("team_key", teamKey)
      .eq("status", "archived")
      .order("archived_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    await mergeRemoteArchives(client, data || []);
  }

  async function pullRemoteAdminData() {
    const client = getSupabaseClient();
    if (!client) return;
    const [teamsResult, usersResult, sheetsResult] = await Promise.all([
      client.from("inventory_teams").select("*").order("team_name"),
      client.from("inventory_users").select("*").order("team_name").order("agent_name"),
      client.from("inventory_sheets").select("*").order("updated_at", { ascending: false }).limit(500),
    ]);
    if (teamsResult.error) throw teamsResult.error;
    if (usersResult.error) throw usersResult.error;
    if (sheetsResult.error) throw sheetsResult.error;

    state.teams = normalizeTeams((teamsResult.data || []).map((team) => ({ teamName: team.team_name, teamKey: team.team_key, active: team.active })));
    state.users = normalizeUsers(
      (usersResult.data || []).map((user) => ({
        teamName: user.team_name,
        teamKey: user.team_key,
        agentName: user.agent_name,
        agentKey: user.agent_key,
        active: user.active,
      })),
    );
    await mergeRemoteArchives(client, sheetsResult.data || []);
  }

  async function mergeRemoteArchives(client, sheets) {
    if (!sheets.length) return;
    const sheetIds = sheets.map((sheet) => sheet.id);
    const { data, error } = await client.from("inventory_cells").select("*").in("sheet_id", sheetIds);
    if (error) throw error;
    const cellsBySheet = groupBy(data || [], "sheet_id");
    const remoteArchives = sheets.map((sheet) => sheetToArchive(sheet, cellsBySheet[sheet.id] || []));
    const existing = new Map(state.archives.map((archive) => [archive.id, archive]));
    remoteArchives.forEach((archive) => existing.set(archive.id, archive));
    state.archives = Array.from(existing.values()).sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")));
  }

  async function fetchSheetCells(client, sheetId) {
    const { data, error } = await client.from("inventory_cells").select("*").eq("sheet_id", sheetId);
    if (error) throw error;
    return data || [];
  }

  function applyRemoteSheet(sheet, cells) {
    applyingRemote = true;
    state.sheetId = sheet.id;
    state.session.team = sheet.team_name || state.session.team;
    state.session.teamKey = sheet.team_key || state.session.teamKey;
    state.header = { date: "", agency: "", supervisor: "", locked: false };
    state.rows = [];
    cells.forEach(applyRemoteCell);
    if (!state.header.date) state.header.date = new Date().toISOString().slice(0, 10);
    applyingRemote = false;
    saveState();
    renderSheet();
  }

  function applyRemoteCell(record) {
    if (!record || record.sheet_id !== state.sheetId) return;
    const rowOrder = Number(record.row_order);
    if (rowOrder === 0) {
      if (headerFields.some((field) => field.key === record.field_key)) state.header[record.field_key] = record.value || "";
      return;
    }
    const row = ensureRow(rowOrder);
    if (columns.some((column) => column.key === record.field_key)) {
      row[record.field_key] = record.value || "";
      row.updatedAt = record.updated_at;
      row.updatedBy = record.updated_by;
    }
  }

  function startRealtime() {
    stopRealtime();
    const client = getSupabaseClient();
    if (!client || !state.sheetId || isAdminSession()) return;
    const teamKey = state.session.teamKey || normalizeTeam(state.session.team);
    sheetChannel = client
      .channel(`inventory:${state.sheetId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "inventory_cells", filter: `sheet_id=eq.${state.sheetId}` },
        (payload) => {
          applyingRemote = true;
          applyRemoteCell(payload.new);
          applyingRemote = false;
          saveState();
          renderSheet();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "inventory_sheets", filter: `team_key=eq.${teamKey}` },
        (payload) => {
          if (payload.new?.status === "active" && payload.new.id !== state.sheetId) loadRemoteActiveSheet().catch(() => {});
          if (payload.new?.status === "archived") pullRemoteArchivesForTeam(teamKey).catch(() => {});
        },
      )
      .subscribe();
  }

  function stopRealtime() {
    if (sheetChannel && supabaseClient) supabaseClient.removeChannel(sheetChannel);
    sheetChannel = null;
  }

  function currentSheetPayload(status = "active", sheetId = state.sheetId, teamKey = state.session.teamKey || normalizeTeam(state.session.team)) {
    const now = new Date().toISOString();
    return {
      id: sheetId || makeId("sheet"),
      team_key: teamKey,
      team_name: state.session.team,
      status,
      archived_at: status === "archived" ? now : null,
      created_by: state.session.agent,
      updated_by: state.session.agent,
      updated_at: now,
    };
  }

  function queueCellChange(rowOrder, fieldKey, value) {
    if (applyingRemote || !state.session.connected || isAdminSession()) return;
    const action = {
      actionId: makeId("op"),
      type: "upsertCell",
      sheetId: state.sheetId,
      teamKey: state.session.teamKey || normalizeTeam(state.session.team),
      teamName: state.session.team,
      rowOrder: Number(rowOrder),
      fieldKey,
      value: clean(value),
      updatedAt: new Date().toISOString(),
      updatedBy: state.session.agent,
    };
    queueSync(action.type, action);
  }

  function queueSync(type, payload) {
    if (applyingRemote) return;
    const action = payload?.type ? payload : { actionId: makeId("op"), type, ...payload, updatedAt: payload?.updatedAt || new Date().toISOString() };
    if (action.type === "upsertCell") {
      state.syncQueue = state.syncQueue.filter(
        (item) =>
          !(
            item.type === "upsertCell" &&
            item.sheetId === action.sheetId &&
            item.rowOrder === action.rowOrder &&
            item.fieldKey === action.fieldKey
          ),
      );
    }
    if (action.type === "upsertSheet") {
      action.sheet = action.sheet || payload;
      state.syncQueue = state.syncQueue.filter((item) => !(item.type === "upsertSheet" && item.sheet?.id === action.sheet?.id));
    }
    state.syncQueue.push(action);
    state.syncStatus.pending = state.syncQueue.length;
  }

  function sheetToArchive(sheet, cells) {
    const snapshot = cellsToSnapshot(cells);
    return {
      id: sheet.id,
      status: sheet.status || "archived",
      archivedAt: sheet.archived_at || sheet.updated_at,
      session: {
        connected: true,
        team: sheet.team_name,
        teamKey: sheet.team_key,
        agent: sheet.updated_by || sheet.created_by || "",
        isAdmin: false,
        connectedAt: sheet.updated_at || "",
      },
      header: snapshot.header,
      rows: snapshot.rows,
    };
  }

  function cellsToSnapshot(cells) {
    const header = { date: "", agency: "", supervisor: "", locked: false };
    const rowsByOrder = new Map();
    cells.forEach((cellItem) => {
      const rowOrder = Number(cellItem.row_order);
      if (rowOrder === 0) {
        if (headerFields.some((field) => field.key === cellItem.field_key)) header[cellItem.field_key] = cellItem.value || "";
        return;
      }
      const row = rowsByOrder.get(rowOrder) || { id: "row-" + rowOrder, order: rowOrder };
      row[cellItem.field_key] = cellItem.value || "";
      row.updatedAt = cellItem.updated_at;
      row.updatedBy = cellItem.updated_by;
      rowsByOrder.set(rowOrder, row);
    });
    if (!header.date) header.date = new Date().toISOString().slice(0, 10);
    return {
      header,
      rows: Array.from(rowsByOrder.values()).sort((a, b) => Number(a.order) - Number(b.order)),
    };
  }

  function updateSyncBadge() {
    const badge = $("#syncBadge");
    if (!badge) return;
    const pending = state.syncQueue?.length || 0;
    const remote = state.syncStatus?.remote || "local";
    let label = "Local";
    if (!navigator.onLine) label = pending ? `Hors ligne (${pending})` : "Hors ligne";
    else if (!hasRemoteConfig()) label = "Local";
    else if (pending) label = `A synchroniser (${pending})`;
    else if (remote === "syncing") label = "Sync...";
    else if (remote === "error") label = "Sync en attente";
    else label = "Synchronise";
    badge.textContent = label;
    badge.dataset.status = !navigator.onLine ? "offline" : pending ? "pending" : remote;
  }

  function isAdminCredentials(team, agent) {
    return normalizeTeam(team) === ADMIN_TEAM && normalizeTeam(agent) === ADMIN_AGENT;
  }

  function isAdminSession() {
    return Boolean(state.session?.connected && (state.session?.isAdmin || isAdminCredentials(state.session?.team, state.session?.agent)));
  }

  function isAllowedUser(teamName, agentName) {
    const teamKey = normalizeTeam(teamName);
    const agentKey = normalizeTeam(agentName);
    if (!teamKey || !agentKey || !state.users.length) return false;
    const team = state.teams.find((item) => item.teamKey === teamKey);
    if (team && team.active === false) return false;
    return state.users.some((user) => user.active !== false && user.teamKey === teamKey && user.agentKey === agentKey);
  }

  async function validateUserAccess(teamName, agentName) {
    if (isAllowedUser(teamName, agentName)) return true;
    const client = getSupabaseClient();
    if (!client || !navigator.onLine) return false;

    const teamKey = normalizeTeam(teamName);
    const agentKey = normalizeTeam(agentName);
    try {
      const { data, error } = await client
        .from("inventory_users")
        .select("team_key,team_name,agent_key,agent_name,active")
        .eq("team_key", teamKey)
        .eq("agent_key", agentKey)
        .eq("active", true)
        .limit(1);
      if (error) throw error;
      const user = data?.[0];
      if (!user) return false;
      upsertLocalUser(user.team_name || teamName, user.agent_name || agentName);
      return true;
    } catch {
      return isAllowedUser(teamName, agentName);
    }
  }

  function upsertLocalTeam(teamName) {
    const name = clean(teamName) || "Equipe terrain";
    const team = { teamName: name, teamKey: normalizeTeam(name), active: true, updatedAt: new Date().toISOString() };
    state.teams = [...state.teams.filter((item) => item.teamKey !== team.teamKey), team].sort((a, b) => a.teamName.localeCompare(b.teamName));
    return team;
  }

  function upsertLocalUser(teamName, agentName) {
    const team = upsertLocalTeam(teamName);
    const name = clean(agentName) || "Agent";
    const user = {
      teamName: team.teamName,
      teamKey: team.teamKey,
      agentName: name,
      agentKey: normalizeTeam(name),
      active: true,
      updatedAt: new Date().toISOString(),
    };
    state.users = [
      ...state.users.filter((item) => !(item.teamKey === user.teamKey && item.agentKey === user.agentKey)),
      user,
    ].sort((a, b) => (a.teamName + a.agentName).localeCompare(b.teamName + b.agentName));
    return user;
  }

  function ensureLocalTeamAndUser(teamName, agentName) {
    if (!clean(teamName)) return;
    upsertLocalTeam(teamName);
    if (clean(agentName)) upsertLocalUser(teamName, agentName);
  }

  function normalizeTeams(teams) {
    if (!Array.isArray(teams)) return [];
    const map = new Map();
    teams.forEach((team) => {
      const teamName = clean(team.teamName || team.team_name);
      if (!teamName) return;
      const teamKey = clean(team.teamKey || team.team_key) || normalizeTeam(teamName);
      map.set(teamKey, { teamName, teamKey, active: team.active !== false, updatedAt: team.updatedAt || team.updated_at || "" });
    });
    return Array.from(map.values()).sort((a, b) => a.teamName.localeCompare(b.teamName));
  }

  function normalizeUsers(users) {
    if (!Array.isArray(users)) return [];
    const map = new Map();
    users.forEach((user) => {
      const teamName = clean(user.teamName || user.team_name);
      const agentName = clean(user.agentName || user.agent_name);
      if (!teamName || !agentName) return;
      const teamKey = clean(user.teamKey || user.team_key) || normalizeTeam(teamName);
      const agentKey = clean(user.agentKey || user.agent_key) || normalizeTeam(agentName);
      map.set(teamKey + ":" + agentKey, {
        teamName,
        teamKey,
        agentName,
        agentKey,
        active: user.active !== false,
        updatedAt: user.updatedAt || user.updated_at || "",
      });
    });
    return Array.from(map.values()).sort((a, b) => (a.teamName + a.agentName).localeCompare(b.teamName + b.agentName));
  }

  async function hydrateFromOfflineDb() {
    try {
      const stored = await idbGet("state");
      if (!stored) {
        await mirrorStateToOfflineDb();
        return;
      }
      const localUpdated = Number(localStorage.getItem(STORAGE_KEY + ":savedAt") || 0);
      const indexedUpdated = Number(stored.savedAt || 0);
      if (indexedUpdated > localUpdated) {
        const fallback = defaultState();
        const storedSession = { ...fallback.session, ...(stored.value?.session || {}) };
        storedSession.teamKey = storedSession.teamKey || normalizeTeam(storedSession.team);
        storedSession.connected = false;
        storedSession.isAdmin = false;
        storedSession.connectedAt = "";
        state = {
          ...fallback,
          ...stored.value,
          session: storedSession,
          teams: normalizeTeams(stored.value?.teams),
          users: normalizeUsers(stored.value?.users),
        };
        saveState();
        render();
      }
    } catch {}
  }

  async function mirrorStateToOfflineDb() {
    try {
      const savedAt = Date.now();
      localStorage.setItem(STORAGE_KEY + ":savedAt", String(savedAt));
      await idbSet("state", { key: "state", savedAt, value: getPersistableState() });
    } catch {}
  }

  function openOfflineDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbSet(key, value) {
    const db = await dbPromise;
    if (!db) return;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("kv", "readwrite");
      transaction.objectStore("kv").put({ ...value, key });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function idbGet(key) {
    const db = await dbPromise;
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("kv", "readonly");
      const request = transaction.objectStore("kv").get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function groupBy(items, key) {
    return items.reduce((groups, item) => {
      const value = item[key];
      groups[value] = groups[value] || [];
      groups[value].push(item);
      return groups;
    }, {});
  }

  function makeId(prefix) {
    const random = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `${prefix}_${random}`;
  }

  function getExportBaseName() {
    const date = state.header.date || new Date().toISOString().slice(0, 10);
    const agency = clean(state.header.agency).replace(/[^\p{L}\p{N}]+/gu, "_") || "Agence";
    const agent = clean(state.session.agent || state.session.team).replace(/[^\p{L}\p{N}]+/gu, "_") || "Agent";
    return `fiche_inventaire_${agency}_${agent}_${date}`;
  }

  function formatHeaderValue(key, value) {
    if (key !== "date" || !value) return value;
    const [year, month, day] = value.split("-");
    return year && month && day ? `${day}/${month}/${year}` : value;
  }

  function formatDateTime(value) {
    if (!value) return "";
    try {
      return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
    } catch {
      return value;
    }
  }

  function clean(value) {
    return String(value ?? "").trim();
  }

  function normalizeTeam(value) {
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

  function escapeXml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js?v=14").catch(() => {});
    }
  }
})();
