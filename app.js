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
  const REMOTE_PAGE_SIZE = 1000;
  const REMOTE_SHEET_BATCH_SIZE = 40;
  const SYNC_CELL_BATCH_SIZE = 80;
  const REMOTE_PROBE_TIMEOUT_MS = 8000;
  const SYNC_RETRY_BASE_MS = 4000;
  const SYNC_RETRY_MAX_MS = 60000;
  const LOCAL_ARCHIVE_SUMMARY_LIMIT = 500;
  const LOCAL_ARCHIVE_DETAIL_LIMIT = 30;
  const SHEET_ZOOM_KEY = STORAGE_KEY + ":sheetZoom";
  const MIN_SHEET_SCALE = 0.16;
  const MAX_SHEET_SCALE = 2.25;
  const ZOOM_STEP = 0.12;
  const PINCH_MIN_DISTANCE = 24;
  const TAP_MOVE_THRESHOLD = 12;
  const TAP_TIME_LIMIT = 700;

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
  let sheetScale = loadSheetScale();
  let sheetTap = null;
  let sheetPointers = new Map();
  let pinchGesture = null;
  let pendingCellEdit = false;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindLogin();
    bindSheet();
    bindEditor();
    bindExport();
    bindAdmin();
    bindConnectivity();
    bindLifecycleSafety();
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
        agentKey: "",
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
      viewingArchiveId: "",
      syncStatus: {
        online: navigator.onLine,
        remote: "local",
        pending: 0,
        lastSyncAt: "",
        lastAttemptAt: "",
        nextRetryAt: "",
        attempts: 0,
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
      session.agentKey = session.agentKey || normalizeTeam(session.agent);
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
        archives: normalizeArchives(parsed.archives, parsed.syncQueue),
        teams: normalizeTeams(parsed.teams),
        users: normalizeUsers(parsed.users),
        syncQueue: Array.isArray(parsed.syncQueue) ? parsed.syncQueue : [],
        viewingArchiveId: "",
        syncStatus: { ...fallback.syncStatus, ...(parsed.syncStatus || {}), online: navigator.onLine },
      };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    state.syncStatus.pending = state.syncQueue.length;
    state.syncStatus.online = navigator.onLine;
    persistStateToLocalStorage();
    mirrorStateToOfflineDb();
    updateSyncBadge();
  }

  function persistStateToLocalStorage() {
    const compactState = getPersistableState();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compactState));
    } catch {
      const emergencyState = {
        ...compactState,
        archives: compactState.archives.map((archive) => ({ ...archive, rows: [], hasDetails: false })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(emergencyState));
    }
  }

  function getPersistableState() {
    const compactArchives = compactArchivesForStorage(state.archives);
    return {
      ...state,
      archives: compactArchives,
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
      const nextTeamKey = normalizeTeam(nextTeam);
      const nextAgentKey = normalizeTeam(nextAgent);
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

        const previousTeamKey = state.session.teamKey || normalizeTeam(state.session.team);
        const previousAgentKey = state.session.agentKey || normalizeTeam(state.session.agent);
        const actorChanged =
          (previousTeamKey || previousAgentKey) && (previousTeamKey !== nextTeamKey || previousAgentKey !== nextAgentKey);
        if (actorChanged) {
          if (!state.viewingArchiveId) archiveCurrentSheet();
          state.sheetId = makeId("sheet");
          state.viewingArchiveId = "";
          state.header = { date: new Date().toISOString().slice(0, 10), agency: "", supervisor: "", locked: false };
          state.rows = [];
          active = { type: "row", order: 1, colIndex: 1 };
        }

        state.session = {
          connected: true,
          team: nextTeam,
          teamKey: nextTeamKey,
          agent: nextAgent,
          agentKey: nextAgentKey,
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
      pendingCellEdit = false;
      state.session.connected = false;
      state.session.isAdmin = false;
      state.session.connectedAt = "";
      state.viewingArchiveId = "";
      saveState();
      render();
    });
  }

  function bindSheet() {
    $("#addRowButton").addEventListener("click", () => {
      const row = getNextEmptyRow();
      active = { type: "row", order: row.order, colIndex: 1 };
      pendingCellEdit = false;
      saveState();
      renderSheet();
      scrollRowIntoView(row.order);
      openRowEditor(row.order, 1);
    });

    $("#newSheetButton").addEventListener("click", () => {
      flushOpenEditor();
      if (!state.viewingArchiveId) archiveCurrentSheet();
      createBlankCurrentSheet();
      active = { type: "header", key: "date" };
      pendingCellEdit = false;
      saveState();
      renderSheet();
      resumeRemoteSession({ force: true }).catch(() => {});
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
      loadArchive(button.dataset.archiveId).catch(() => {
        alert("Impossible de charger cette archive pour le moment.");
      });
    });

    const sheetWrap = $("#sheetWrap");
    sheetWrap.addEventListener("pointerdown", handleSheetGesturePointerDown);
    sheetWrap.addEventListener("pointermove", handleSheetGesturePointerMove, { passive: false });
    sheetWrap.addEventListener("pointerup", handleSheetGesturePointerEnd);
    sheetWrap.addEventListener("pointercancel", handleSheetGesturePointerEnd);
    sheetWrap.addEventListener("lostpointercapture", handleSheetGesturePointerEnd);
    sheetWrap.addEventListener("touchstart", handleSheetTouchStart, { passive: true });
    sheetWrap.addEventListener("touchmove", handleSheetTouchMove, { passive: false });
    sheetWrap.addEventListener("touchend", handleSheetTouchEnd);
    sheetWrap.addEventListener("touchcancel", handleSheetTouchEnd);

    $("#sheetGrid").addEventListener("click", (event) => {
      if (event.target.closest("[data-header-key], [data-row-order][data-col-index]")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    $("#sheetGrid").addEventListener("pointerdown", handleSheetPointerDown);
    $("#sheetGrid").addEventListener("pointermove", handleSheetPointerMove);
    $("#sheetGrid").addEventListener("pointerup", handleSheetPointerUp);
    $("#sheetGrid").addEventListener("pointercancel", clearSheetTap);
    $("#editCellButton").addEventListener("click", openActiveEditor);
    $("#zoomOutButton").addEventListener("click", () => adjustSheetZoom(-ZOOM_STEP));
    $("#zoomInButton").addEventListener("click", () => adjustSheetZoom(ZOOM_STEP));
    $("#zoomFitButton").addEventListener("click", fitSheetToWidth);
    window.addEventListener("resize", () => applySheetScale());
  }

  function handleSheetGesturePointerDown(event) {
    if (event.pointerType === "mouse" || (event.pointerType === "touch" && "TouchEvent" in window)) return;
    sheetPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (sheetPointers.size === 2) startPinchGesture(getGesturePoints());
  }

  function handleSheetGesturePointerMove(event) {
    if (!sheetPointers.has(event.pointerId)) return;

    sheetPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinchGesture || sheetPointers.size < 2) return;

    event.preventDefault();
    clearSheetTap();

    updatePinchGesture(getGesturePoints());
  }

  function handleSheetGesturePointerEnd(event) {
    if (!sheetPointers.has(event.pointerId)) return;

    sheetPointers.delete(event.pointerId);
    if (sheetPointers.size < 2 && pinchGesture) {
      pinchGesture = null;
      persistSheetScale();
      $("#sheetWrap").classList.remove("is-pinching");
    }
  }

  function handleSheetTouchStart(event) {
    if (event.touches.length === 2) startPinchGesture(getTouchGesturePoints(event));
  }

  function handleSheetTouchMove(event) {
    if (event.touches.length !== 2) return;
    if (!pinchGesture) startPinchGesture(getTouchGesturePoints(event));
    if (!pinchGesture) return;

    event.preventDefault();
    updatePinchGesture(getTouchGesturePoints(event));
  }

  function handleSheetTouchEnd(event) {
    if (event.touches.length >= 2 || !pinchGesture) return;
    pinchGesture = null;
    persistSheetScale();
    $("#sheetWrap").classList.remove("is-pinching");
  }

  function startPinchGesture(points) {
    const wrap = $("#sheetWrap");
    if (!wrap) return;

    const distance = getGestureDistance(points);
    if (distance < PINCH_MIN_DISTANCE) return;

    const center = getGestureCenter(points);
    const rect = wrap.getBoundingClientRect();
    pinchGesture = {
      startDistance: distance,
      startScale: sheetScale,
      anchorX: (wrap.scrollLeft + center.x - rect.left) / sheetScale,
      anchorY: (wrap.scrollTop + center.y - rect.top) / sheetScale,
    };
    clearSheetTap();
    wrap.classList.add("is-pinching");
  }

  function updatePinchGesture(points) {
    if (!pinchGesture) return;

    const distance = getGestureDistance(points);
    if (distance < PINCH_MIN_DISTANCE) return;

    const center = getGestureCenter(points);
    setSheetScale(pinchGesture.startScale * (distance / pinchGesture.startDistance), { persist: false });
    scrollSheetToAnchor(center, pinchGesture.anchorX, pinchGesture.anchorY);
  }

  function getGesturePoints() {
    return Array.from(sheetPointers.values()).slice(0, 2);
  }

  function getTouchGesturePoints(event) {
    return Array.from(event.touches)
      .slice(0, 2)
      .map((touch) => ({ x: touch.clientX, y: touch.clientY }));
  }

  function getGestureDistance(points) {
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  function getGestureCenter(points) {
    return {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
  }

  function handleSheetPointerDown(event) {
    const target = event.target.closest("[data-header-key], [data-row-order][data-col-index]");
    if (!target) {
      sheetTap = null;
      return;
    }

    sheetTap = {
      target,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
      moved: false,
    };
  }

  function handleSheetPointerMove(event) {
    if (!sheetTap || sheetTap.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - sheetTap.x, event.clientY - sheetTap.y);
    if (distance > TAP_MOVE_THRESHOLD) {
      sheetTap.moved = true;
      $("#sheetWrap").classList.add("is-dragging");
    }
  }

  function handleSheetPointerUp(event) {
    if (!sheetTap || sheetTap.pointerId !== event.pointerId) return;
    const tap = sheetTap;
    clearSheetTap();
    $("#sheetWrap").classList.remove("is-dragging");
    if (tap.moved || Date.now() - tap.time > TAP_TIME_LIMIT) return;
    handleSheetTap(tap.target);
  }

  function clearSheetTap() {
    sheetTap = null;
    $("#sheetWrap").classList.remove("is-dragging");
  }

  function handleSheetTap(target) {
    const headerCell = target.closest("[data-header-key]");
    if (headerCell) {
      const nextActive = { type: "header", key: headerCell.dataset.headerKey };
      if (shouldSelectBeforeEdit(nextActive)) return selectCellForEdit(nextActive);
      pendingCellEdit = false;
      openHeaderEditor(nextActive.key);
      return;
    }

    const rowCell = target.closest("[data-row-order][data-col-index]");
    if (!rowCell) return;
    const columnIndex = Number(rowCell.dataset.colIndex);
    const rowOrder = Number(rowCell.dataset.rowOrder);
    const nextActive = { type: "row", order: rowOrder, colIndex: Math.max(1, columnIndex) };
    if (shouldSelectBeforeEdit(nextActive)) return selectCellForEdit(nextActive);
    pendingCellEdit = false;
    openRowEditor(rowOrder, columnIndex);
  }

  function shouldSelectBeforeEdit(nextActive) {
    return isCoarsePointer() && (!pendingCellEdit || !sameActiveCell(nextActive));
  }

  function selectCellForEdit(nextActive) {
    active = nextActive;
    pendingCellEdit = true;
    saveState();
    renderSheet();
  }

  function openActiveEditor() {
    if (!state.session.connected) return;
    pendingCellEdit = false;
    if (active.type === "header") openHeaderEditor(active.key);
    else openRowEditor(active.order || 1, active.colIndex || 1);
  }

  function sameActiveCell(nextActive) {
    if (!active || active.type !== nextActive.type) return false;
    if (nextActive.type === "header") return active.key === nextActive.key;
    return Number(active.order) === Number(nextActive.order) && Number(active.colIndex) === Number(nextActive.colIndex);
  }

  function isCoarsePointer() {
    return window.matchMedia?.("(pointer: coarse)")?.matches;
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
    $("#adminSearch").addEventListener("input", renderAdminPanel);
    $("#adminRefreshButton").addEventListener("click", () => {
      refreshAdminData({ keepPanelOpen: true }).catch(() => {});
    });

    $("#teamForm").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!isAdminSession()) return;
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const team = upsertLocalTeam(data.teamName);
      queueSync("upsertTeam", team);
      event.currentTarget.reset();
      saveState();
      renderAdminPanel();
      syncNow({ force: true }).catch(() => {});
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
      syncNow({ force: true }).catch(() => {});
    });

    $("#adminTeamsList").addEventListener("click", handleAdminTeamsClick);
    $("#adminUsersList").addEventListener("click", handleAdminUsersClick);

    $("#adminArchivesList").addEventListener("click", (event) => {
      if (!isAdminSession()) return;
      const deleteButton = event.target.closest("[data-admin-delete-archive]");
      if (deleteButton) {
        deleteArchiveSheet(deleteButton.dataset.adminDeleteArchive);
        return;
      }
      const button = event.target.closest("[data-admin-open-archive]");
      if (!button) return;
      closeAdminPanel();
      loadArchive(button.dataset.adminOpenArchive).catch(() => {
        alert("Impossible de charger cette archive pour le moment.");
      });
    });
  }

  function bindConnectivity() {
    window.addEventListener("online", () => {
      state.syncStatus.online = true;
      state.syncStatus.message = "Connexion retablie";
      saveState();
      resumeRemoteSession({ force: true }).catch(() => {});
    });
    window.addEventListener("offline", () => {
      state.syncStatus.online = false;
      state.syncStatus.remote = "offline";
      state.syncStatus.message = "Hors ligne";
      saveState();
    });
  }

  function bindLifecycleSafety() {
    const persistCurrentWork = () => {
      flushOpenEditor();
      saveState();
    };

    window.addEventListener("pagehide", persistCurrentWork);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        persistCurrentWork();
        return;
      }
      if (state.session.connected) resumeRemoteSession().catch(() => {});
    });
    window.addEventListener("focus", () => {
      if (state.session.connected) resumeRemoteSession().catch(() => {});
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

  function getAdminSearchTerm() {
    return normalizeTeam($("#adminSearch")?.value || "");
  }

  function matchesAdminSearch(values, searchTerm) {
    if (!searchTerm) return true;
    return values.some((value) => normalizeTeam(value).includes(searchTerm));
  }

  function handleAdminTeamsClick(event) {
    const button = event.target.closest("[data-admin-team-action]");
    if (!button || !isAdminSession()) return;
    const teamKey = button.dataset.teamKey;
    const team = state.teams.find((item) => item.teamKey === teamKey);
    if (!team) return;

    const nextActive = button.dataset.adminTeamAction === "restore";
    if (!nextActive) {
      const usersCount = state.users.filter((user) => user.teamKey === teamKey && user.active !== false).length;
      const message = `Supprimer ${team.teamName} ? L'equipe sera desactivee avec ${usersCount} utilisateur(s).`;
      if (!window.confirm(message)) return;
    }

    const updatedTeam = setLocalTeamActive(teamKey, nextActive);
    const updatedUsers = nextActive ? [] : setLocalUsersActiveByTeam(teamKey, false);
    if (updatedTeam) queueSync("upsertTeam", updatedTeam);
    updatedUsers.forEach((user) => queueSync("upsertUser", user));
    saveState();
    renderAdminPanel();
    syncNow({ force: true }).catch(() => {});
  }

  function handleAdminUsersClick(event) {
    const button = event.target.closest("[data-admin-user-action]");
    if (!button || !isAdminSession()) return;
    const teamKey = button.dataset.teamKey;
    const agentKey = button.dataset.agentKey;
    const user = state.users.find((item) => item.teamKey === teamKey && item.agentKey === agentKey);
    if (!user) return;

    const nextActive = button.dataset.adminUserAction === "restore";
    if (!nextActive && !window.confirm(`Supprimer ${user.agentName} de ${user.teamName} ?`)) return;

    const updatedUser = setLocalUserActive(teamKey, agentKey, nextActive);
    if (updatedUser) queueSync("upsertUser", updatedUser);
    saveState();
    renderAdminPanel();
    syncNow({ force: true }).catch(() => {});
  }

  function deleteArchiveSheet(sheetId) {
    const archive = state.archives.find((item) => item.id === sheetId);
    if (!archive || !isAdminSession()) return;
    const title = getArchiveTitle(archive) || "cette fiche";
    if (!window.confirm(`Supprimer ${title} ? Les lignes associees seront aussi supprimees du serveur.`)) return;

    state.archives = state.archives.filter((item) => item.id !== sheetId);
    state.syncQueue = state.syncQueue.filter((item) => item.sheetId !== sheetId && item.sheet?.id !== sheetId);
    queueSync("deleteSheet", {
      sheetId,
      updatedAt: new Date().toISOString(),
      updatedBy: state.session.agent || ADMIN_AGENT,
    });
    if (state.sheetId === sheetId) {
      state.sheetId = makeId("sheet");
      state.header = { date: new Date().toISOString().slice(0, 10), agency: "", supervisor: "", locked: false };
      state.rows = [];
      active = { type: "row", order: 1, colIndex: 1 };
    }
    saveState();
    renderAdminPanel();
    syncNow({ force: true }).catch(() => {});
  }

  function renderAdminPanel() {
    if (!$("#adminPanel")) return;
    const searchTerm = getAdminSearchTerm();
    const archives = getVisibleArchives();
    const activeTeams = state.teams.filter((team) => team.active !== false);
    const activeUsers = state.users.filter((user) => user.active !== false);
    const filteredTeams = state.teams.filter((team) => matchesAdminSearch([team.teamName, team.teamKey, team.active === false ? "desactive" : "actif"], searchTerm));
    const filteredUsers = state.users.filter((user) =>
      matchesAdminSearch([user.agentName, user.agentKey, user.teamName, user.teamKey, user.active === false ? "desactive" : "actif"], searchTerm),
    );
    const filteredArchives = archives.filter((archive) =>
      matchesAdminSearch(
        [
          getArchiveTitle(archive),
          archive.session?.team,
          archive.session?.agent,
          archive.header?.agency,
          archive.status === "active" ? "active" : "archive",
          formatDateTime(archive.archivedAt),
        ],
        searchTerm,
      ),
    );

    $("#adminTeamCount").textContent = String(activeTeams.length);
    $("#adminUserCount").textContent = String(activeUsers.length);
    $("#adminArchiveCount").textContent = String(archives.length);
    $("#adminTeamsMeta").textContent = `${filteredTeams.length} / ${state.teams.length}`;
    $("#adminUsersMeta").textContent = `${filteredUsers.length} / ${state.users.length}`;
    $("#adminArchivesMeta").textContent = `${filteredArchives.length} / ${archives.length}`;

    $("#adminTeamsList").innerHTML = filteredTeams.length
      ? filteredTeams.map(renderAdminTeamItem).join("")
      : `<div class="archive-empty">Aucune equipe trouvee.</div>`;

    $("#adminUsersList").innerHTML = filteredUsers.length
      ? filteredUsers.map(renderAdminUserItem).join("")
      : `<div class="archive-empty">Aucun utilisateur trouve.</div>`;

    $("#adminArchivesList").innerHTML = filteredArchives.length
      ? filteredArchives.map(renderAdminArchiveItem).join("")
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
      hasDetails: true,
      filledRows: state.rows.filter(rowHasContent).length,
    };

    state.archives = [archive, ...state.archives.filter((item) => item.id !== archive.id)];
    queueArchiveSnapshotSync(archive);
  }

  function queueArchiveSnapshotSync(archive) {
    const sheetId = archive.id;
    const archivedAt = archive.archivedAt || new Date().toISOString();
    const teamKey = normalizeTeam(archive.session.team);
    const teamName = archive.session.team;
    const agentKey = archive.session.agentKey || normalizeTeam(archive.session.agent);
    const agentName = archive.session.agent;

    queueSync("archiveSheet", {
      sheetId,
      teamKey,
      teamName,
      agentKey,
      agentName,
      archivedAt,
      updatedBy: agentName,
    });

    headerFields.forEach((field) => {
      queueCellSnapshotChange({
        sheetId,
        teamKey,
        teamName,
        agentKey,
        agentName,
        rowOrder: 0,
        fieldKey: field.key,
        value: archive.header?.[field.key] || "",
        updatedAt: archivedAt,
        updatedBy: agentName,
        sheetStatus: "archived",
        archivedAt,
      });
    });

    (archive.rows || []).filter(rowHasContent).forEach((row) => {
      columns.slice(1).forEach((column) => {
        queueCellSnapshotChange({
          sheetId,
          teamKey,
          teamName,
          agentKey,
          agentName,
          rowOrder: row.order,
          fieldKey: column.key,
          value: row[column.key] || "",
          updatedAt: archivedAt,
          updatedBy: agentName,
          sheetStatus: "archived",
          archivedAt,
        });
      });
    });
  }

  function createBlankCurrentSheet() {
    state.sheetId = makeId("sheet");
    state.viewingArchiveId = "";
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

  async function loadArchive(id) {
    const archive = await ensureArchiveDetails(getVisibleArchives().find((item) => item.id === id), { forceRemote: true });
    if (!archive) return;
    const wasAdmin = isAdminSession();
    if (!wasAdmin && !state.viewingArchiveId) archiveCurrentSheet();
    stopRealtime();
    state.sheetId = archive.id;
    state.viewingArchiveId = archive.id;
    state.session = {
      ...state.session,
      ...archive.session,
      connected: true,
      teamKey: normalizeTeam(archive.session?.team),
      agentKey: archive.session?.agentKey || normalizeTeam(archive.session?.agent),
      isAdmin: wasAdmin || Boolean(archive.session?.isAdmin),
    };
    state.header = { ...archive.header };
    state.rows = (archive.rows || []).map((row) => ({ ...row }));
    active = { type: "row", order: 1, colIndex: 1 };
    pendingCellEdit = false;
    saveState();
    closeArchives();
    renderSheet();
  }

  async function ensureArchiveDetails(archive, { forceRemote = false } = {}) {
    if (!archive) return null;
    const hasLocalDetails = archive.hasDetails !== false && Array.isArray(archive.rows) && archive.rows.length;
    if (archiveHasPendingSync(archive.id) && hasRemoteConfig() && navigator.onLine) {
      await syncNow({ force: true }).catch(() => {});
    }
    const hasPendingSync = archiveHasPendingSync(archive.id);
    const canRefreshRemote = hasRemoteConfig() && navigator.onLine && !hasPendingSync;
    if (hasLocalDetails && !forceRemote && !canRefreshRemote) return archive;
    if (!hasRemoteConfig() || !navigator.onLine) {
      alert("Le detail de cette archive est sur le serveur. Reconnectez-vous pour l'ouvrir.");
      return null;
    }
    if (hasPendingSync) {
      alert("Cette fiche a encore des modifications locales en attente. Laissez la synchronisation se terminer avant de recharger le contenu serveur.");
      return hasLocalDetails ? archive : null;
    }

    const sheet = await fetchRemoteSheetById(archive.id);
    if (!sheet) return null;

    const client = getSupabaseClient();
    if (!client) return null;
    let cells = await fetchSheetCells(client, sheet.id);
    if (hasLocalDetails) {
      const recovered = queueNewerLocalArchiveCells(archive, sheet, cells);
      if (recovered) {
        saveState();
        await syncNow({ force: true }).catch(() => {});
        cells = await fetchSheetCells(client, sheet.id);
      }
    }
    const fullArchive = sheetToArchive(sheet, cells);
    fullArchive.hasDetails = true;
    fullArchive.filledRows = getArchiveFilledRows(fullArchive);
    state.archives = [fullArchive, ...state.archives.filter((item) => item.id !== fullArchive.id)].sort(sortArchives);
    state.syncStatus.remote = "synced";
    state.syncStatus.message = "Archive rechargee depuis le serveur";
    state.syncStatus.lastSyncAt = new Date().toISOString();
    saveState();
    return fullArchive;
  }

  function closeArchives() {
    $("#archivesPanel").classList.remove("is-open");
    $("#archivesPanel").setAttribute("aria-hidden", "true");
  }

  function getTeamArchives() {
    const teamKey = normalizeTeam(state.session.team);
    const agentKey = getSessionAgentKey();
    return state.archives.filter(
      (archive) =>
        normalizeTeam(archive.session?.team) === teamKey &&
        getArchiveAgentKey(archive) === agentKey &&
        (archive.status || "archived") === "archived",
    );
  }

  function getVisibleArchives() {
    return isAdminSession() ? state.archives : getTeamArchives();
  }

  function getArchiveTitle(archive) {
    return [archive.session?.team, formatHeaderValue("date", archive.header?.date), archive.header?.agency, archive.session?.agent]
      .map(clean)
      .filter(Boolean)
      .join(" - ");
  }

  function renderArchiveButton(archive) {
    const filledRows = getArchiveFilledRows(archive);
    const title = getArchiveTitle(archive);
    const isActiveSheet = archive.status === "active";
    const dateLabel = isActiveSheet ? "fiche active - mise a jour le" : "archivee le";
    const rowLabel = Number.isFinite(filledRows) ? `${filledRows} ligne(s)` : "detail serveur";
    return `
      <button class="archive-item" type="button" data-archive-id="${archive.id}">
        <strong>${escapeHtml(title || (isActiveSheet ? "Fiche active" : "Fiche archivee"))}</strong>
        <span>${rowLabel} - ${dateLabel} ${escapeHtml(formatDateTime(archive.archivedAt))}</span>
      </button>
    `;
  }

  function renderAdminTeamItem(team) {
    const usersCount = state.users.filter((user) => user.teamKey === team.teamKey && user.active !== false).length;
    const sheetsCount = state.archives.filter((archive) => normalizeTeam(archive.session?.team) === team.teamKey).length;
    const isInactive = team.active === false;
    const action = isInactive ? "restore" : "delete";
    const actionLabel = isInactive ? "Reactiver" : "Supprimer";
    const buttonClass = isInactive ? "ghost-button" : "danger-button";
    return `
      <div class="admin-list-item admin-manage-item ${isInactive ? "is-muted" : ""}">
        <div class="admin-item-main">
          <div class="admin-item-title">
            <strong>${escapeHtml(team.teamName)}</strong>
            <span class="status-pill ${isInactive ? "is-off" : "is-on"}">${isInactive ? "desactivee" : "active"}</span>
          </div>
          <span>${usersCount} utilisateur(s) actif(s) - ${sheetsCount} fiche(s)</span>
        </div>
        <div class="admin-item-actions">
          <button class="${buttonClass} mini" type="button" data-admin-team-action="${action}" data-team-key="${escapeHtml(team.teamKey)}">${actionLabel}</button>
        </div>
      </div>
    `;
  }

  function renderAdminUserItem(user) {
    const isInactive = user.active === false;
    const teamInactive = state.teams.some((team) => team.teamKey === user.teamKey && team.active === false);
    const action = isInactive ? "restore" : "delete";
    const actionLabel = isInactive ? "Reactiver" : "Supprimer";
    const buttonClass = isInactive ? "ghost-button" : "danger-button";
    return `
      <div class="admin-list-item admin-manage-item ${isInactive || teamInactive ? "is-muted" : ""}">
        <div class="admin-item-main">
          <div class="admin-item-title">
            <strong>${escapeHtml(user.agentName)}</strong>
            <span class="status-pill ${isInactive || teamInactive ? "is-off" : "is-on"}">${isInactive ? "desactive" : teamInactive ? "equipe inactive" : "actif"}</span>
          </div>
          <span>${escapeHtml(user.teamName)}</span>
        </div>
        <div class="admin-item-actions">
          <button class="${buttonClass} mini" type="button" data-admin-user-action="${action}" data-team-key="${escapeHtml(user.teamKey)}" data-agent-key="${escapeHtml(user.agentKey)}">${actionLabel}</button>
        </div>
      </div>
    `;
  }

  function renderAdminArchiveItem(archive) {
    const filledRows = getArchiveFilledRows(archive);
    const title = getArchiveTitle(archive);
    const isActiveSheet = archive.status === "active";
    const rowLabel = Number.isFinite(filledRows) ? `${filledRows} ligne(s)` : "detail a charger";
    return `
      <div class="admin-list-item admin-manage-item admin-archive-item">
        <div class="admin-item-main">
          <div class="admin-item-title">
            <strong>${escapeHtml(title || (isActiveSheet ? "Fiche active" : "Fiche archivee"))}</strong>
            <span class="status-pill ${isActiveSheet ? "is-live" : "is-archived"}">${isActiveSheet ? "active" : "archive"}</span>
          </div>
          <span>${rowLabel} - ${escapeHtml(formatDateTime(archive.archivedAt))}</span>
        </div>
        <div class="admin-item-actions">
          <button class="ghost-button mini" type="button" data-admin-open-archive="${escapeHtml(archive.id)}">Ouvrir</button>
          <button class="danger-button mini" type="button" data-admin-delete-archive="${escapeHtml(archive.id)}">Supprimer</button>
        </div>
      </div>
    `;
  }

  function render() {
    $("#loginView").classList.toggle("is-hidden", state.session.connected);
    $("#sheetView").classList.toggle("is-hidden", !state.session.connected);
    $("#adminButton").classList.toggle("is-visible", isAdminSession());
    updateEditButton();
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
    applySheetScale();
    updateZoomControls();
    updateEditButton();
  }

  function applySheetScale() {
    const grid = $("#sheetGrid");
    const stage = $("#sheetStage");
    if (!grid || !stage) return;

    grid.style.setProperty("--sheet-scale", String(sheetScale));
    updateSheetStageSize();
    requestAnimationFrame(updateSheetStageSize);
  }

  function updateSheetStageSize() {
    const grid = $("#sheetGrid");
    const stage = $("#sheetStage");
    if (!grid || !stage) return;

    const naturalWidth = grid.scrollWidth || grid.offsetWidth || 1;
    const naturalHeight = grid.scrollHeight || grid.offsetHeight || 1;
    stage.style.setProperty("--sheet-stage-width", `${Math.ceil(naturalWidth * sheetScale)}px`);
    stage.style.setProperty("--sheet-stage-height", `${Math.ceil(naturalHeight * sheetScale)}px`);
  }

  function adjustSheetZoom(delta) {
    const wrap = $("#sheetWrap");
    if (!wrap) {
      setSheetScale(sheetScale + delta);
      return;
    }

    const center = {
      x: wrap.getBoundingClientRect().left + wrap.clientWidth / 2,
      y: wrap.getBoundingClientRect().top + wrap.clientHeight / 2,
    };
    const anchorX = (wrap.scrollLeft + wrap.clientWidth / 2) / sheetScale;
    const anchorY = (wrap.scrollTop + wrap.clientHeight / 2) / sheetScale;
    setSheetScale(sheetScale + delta);
    scrollSheetToAnchor(center, anchorX, anchorY);
  }

  function fitSheetToWidth() {
    const wrap = $("#sheetWrap");
    const grid = $("#sheetGrid");
    if (!wrap || !grid) return;
    const naturalWidth = grid.scrollWidth || grid.offsetWidth || 1;
    const usableWidth = Math.max(240, wrap.clientWidth - 18);
    setSheetScale(usableWidth / naturalWidth);
    wrap.scrollLeft = 0;
  }

  function setSheetScale(nextScale, options = {}) {
    const { persist = true } = options;
    sheetScale = clamp(Number(nextScale) || 1, MIN_SHEET_SCALE, MAX_SHEET_SCALE);
    if (persist) persistSheetScale();
    applySheetScale();
    updateZoomControls();
  }

  function persistSheetScale() {
    try {
      localStorage.setItem(SHEET_ZOOM_KEY, String(sheetScale));
    } catch {}
  }

  function scrollSheetToAnchor(center, anchorX, anchorY) {
    const wrap = $("#sheetWrap");
    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const nextLeft = anchorX * sheetScale - (center.x - rect.left);
    const nextTop = anchorY * sheetScale - (center.y - rect.top);
    const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);

    wrap.scrollLeft = clamp(nextLeft, 0, maxLeft);
    wrap.scrollTop = clamp(nextTop, 0, maxTop);
  }

  function loadSheetScale() {
    try {
      const stored = Number(localStorage.getItem(SHEET_ZOOM_KEY));
      if (Number.isFinite(stored) && stored > 0) return clamp(stored, MIN_SHEET_SCALE, MAX_SHEET_SCALE);
    } catch {}
    return 1;
  }

  function updateZoomControls() {
    const fitButton = $("#zoomFitButton");
    if (!fitButton) return;
    fitButton.textContent = `${Math.round(sheetScale * 100)}%`;
  }

  function updateEditButton() {
    const button = $("#editCellButton");
    if (!button) return;
    button.classList.toggle("is-visible", Boolean(state.session.connected && pendingCellEdit && isCoarsePointer()));
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
    pendingCellEdit = false;
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
    pendingCellEdit = false;
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
    pendingCellEdit = false;
    $("#cellEditor").classList.remove("is-open");
    $("#cellEditor").setAttribute("aria-hidden", "true");
    renderSheet();
  }

  function writeActiveValue() {
    if (active.type === "header") {
      const value = clean(editorValue);
      if (clean(state.header[active.key]) === value) {
        saveState();
        return;
      }
      state.header[active.key] = value;
      queueCellChange(0, active.key, value);
      updateOpenArchiveSnapshot();
      saveState();
      return;
    }

    const row = ensureRow(active.order);
    const column = columns[active.colIndex];
    if (column && column.key !== "order") {
      const value = clean(editorValue);
      if (clean(row[column.key]) === value) {
        saveState();
        return;
      }
      row[column.key] = value;
      row.updatedAt = new Date().toISOString();
      row.updatedBy = state.session.agent;
      queueCellChange(row.order, column.key, value);
      updateOpenArchiveSnapshot();
    }
    saveState();
  }

  function updateOpenArchiveSnapshot() {
    if (!state.viewingArchiveId) return;
    const updatedAt = new Date().toISOString();
    const existing = state.archives.find((archive) => archive.id === state.viewingArchiveId) || {};
    const session = {
      connected: true,
      team: state.session.team || existing.session?.team || "",
      teamKey: state.session.teamKey || existing.session?.teamKey || "",
      agent: state.session.agent || existing.session?.agent || "",
      agentKey: getSessionAgentKey() || existing.session?.agentKey || "",
      isAdmin: false,
      connectedAt: updatedAt,
    };
    const archive = {
      ...existing,
      id: state.viewingArchiveId,
      status: "archived",
      archivedAt: existing.archivedAt || updatedAt,
      updatedAt,
      session,
      header: { ...state.header },
      rows: state.rows.map((row) => ({ ...row })),
      hasDetails: true,
      filledRows: state.rows.filter(rowHasContent).length,
    };
    state.archives = [archive, ...state.archives.filter((item) => item.id !== archive.id)].sort(sortArchives);
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
      await resumeRemoteSession({ force: true });
    } catch (error) {
      state.syncStatus.remote = "error";
      state.syncStatus.message = "Sync en attente";
      saveState();
    }
  }

  async function refreshAdminData({ keepPanelOpen = false } = {}) {
    if (!isAdminSession()) return;
    createSyncTimer();
    if (hasRemoteConfig() && navigator.onLine) {
      const refreshButton = $("#adminRefreshButton");
      try {
        if (refreshButton) refreshButton.disabled = true;
        state.syncStatus.remote = "syncing";
        state.syncStatus.message = "Chargement admin...";
        saveState();
        if (keepPanelOpen) renderAdminPanel();
        await syncNow({ force: true });
        await pullRemoteAdminData();
      } catch {
        state.syncStatus.remote = "error";
        state.syncStatus.message = "Admin local";
      } finally {
        if (refreshButton) refreshButton.disabled = false;
      }
    }
    saveState();
    renderAdminPanel();
  }

  function createSyncTimer() {
    if (syncTimer) return;
    syncTimer = window.setInterval(() => {
      if (state.session.connected) resumeRemoteSession().catch(() => {});
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

  async function resumeRemoteSession({ force = false } = {}) {
    if (!state.session.connected || isAdminSession()) {
      await syncNow({ force });
      return state.syncQueue.length === 0;
    }

    const drained = await syncNow({ force });
    if (!drained) return false;

    if (state.viewingArchiveId) {
      await pullRemoteArchivesForTeam(state.session.teamKey, getSessionAgentKey());
      state.syncStatus.remote = "synced";
      state.syncStatus.message = "Archive synchronisee";
      state.syncStatus.lastSyncAt = new Date().toISOString();
      saveState();
      return true;
    }

    const loaded = await loadRemoteActiveSheet({ skipIfLocalPending: true });
    await pullRemoteArchivesForTeam(state.session.teamKey, getSessionAgentKey());
    startRealtime();
    const hasPendingAfterLoad = state.syncQueue.length > 0;
    state.syncStatus.remote = hasPendingAfterLoad ? "pending" : "synced";
    state.syncStatus.message = loaded === false ? "Local protege" : hasPendingAfterLoad ? "A synchroniser" : "Synchronise";
    state.syncStatus.lastSyncAt = new Date().toISOString();
    saveState();
    render();
    return true;
  }

  async function syncNow({ force = false } = {}) {
    compactSyncQueue();

    if (!hasRemoteConfig() || !navigator.onLine) {
      state.syncStatus.remote = navigator.onLine ? "local" : "offline";
      state.syncStatus.pending = state.syncQueue.length;
      state.syncStatus.message = navigator.onLine ? "Mode local" : "Hors ligne";
      updateSyncBadge();
      return state.syncQueue.length === 0;
    }

    const client = getSupabaseClient();
    if (!client || !state.syncQueue.length) {
      state.syncStatus.remote = "synced";
      state.syncStatus.pending = 0;
      state.syncStatus.lastSyncAt = state.syncStatus.lastSyncAt || new Date().toISOString();
      updateSyncBadge();
      return true;
    }

    if (!force && state.syncStatus.nextRetryAt && Date.now() < Number(state.syncStatus.nextRetryAt)) {
      state.syncStatus.remote = "pending";
      state.syncStatus.pending = state.syncQueue.length;
      updateSyncBadge();
      return false;
    }

    if (syncInFlight) {
      state.syncStatus.remote = "syncing";
      state.syncStatus.pending = state.syncQueue.length;
      updateSyncBadge();
      return false;
    }

    syncInFlight = true;
    state.syncStatus.remote = "syncing";
    state.syncStatus.pending = state.syncQueue.length;
    state.syncStatus.lastAttemptAt = new Date().toISOString();
    state.syncStatus.message = "Synchronisation...";
    updateSyncBadge();

    const context = createSyncContext();
    try {
      while (state.syncQueue.length) {
        const batch = takeNextSyncBatch();
        try {
          await assertRemoteReachable();
          await sendSyncBatch(client, batch, context);
          const done = new Set(batch.map((item) => item.actionId));
          state.syncQueue = state.syncQueue.filter((item) => !done.has(item.actionId));
          state.syncStatus.attempts = 0;
          state.syncStatus.nextRetryAt = "";
          state.syncStatus.pending = state.syncQueue.length;
          state.syncStatus.lastSyncAt = new Date().toISOString();
          state.syncStatus.message = state.syncQueue.length ? "Synchronisation..." : "Synchronise";
          saveState();
        } catch (error) {
          markSyncBatchFailed(batch, error);
          state.syncStatus.remote = "error";
          state.syncStatus.message = "Sync en attente";
          saveState();
          console.warn("GECAF sync batch failed", batch.map((item) => item?.type).join(","), error);
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
    return state.syncQueue.length === 0;
  }

  function createSyncContext() {
    return {
      activeSheetsByOwner: new Map(),
      sheetIdMap: new Map(),
    };
  }

  function compactSyncQueue() {
    if (!Array.isArray(state.syncQueue) || !state.syncQueue.length) {
      state.syncQueue = [];
      return;
    }

    const latestByKey = new Map();
    state.syncQueue.forEach((item, index) => {
      const action = normalizeSyncAction(item, index);
      if (!action) return;
      latestByKey.set(getSyncCompactKey(action), action);
    });

    state.syncQueue = Array.from(latestByKey.values()).sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    state.syncStatus.pending = state.syncQueue.length;
  }

  function normalizeSyncAction(item, index) {
    if (!item?.type) return null;
    const action = {
      ...item,
      actionId: item.actionId || makeId("op"),
      queuedAt: item.queuedAt || item.updatedAt || new Date().toISOString(),
      sequence: Number.isFinite(Number(item.sequence)) ? Number(item.sequence) : Date.now() + index,
      attempts: Number(item.attempts || 0),
    };
    if (action.type === "upsertSheet") action.sheet = action.sheet || item.sheet || item;
    if (action.type === "upsertSheet") {
      action.sheet.agent_key = getSheetAgentKey(action.sheet);
      action.sheet.agent_name = getSheetAgentName(action.sheet);
    }
    if (["upsertCell", "archiveSheet"].includes(action.type)) {
      action.agentKey = getActionAgentKey(action);
      action.agentName = getActionAgentName(action);
    }
    return action;
  }

  function getSyncCompactKey(action) {
    if (action.type === "upsertCell") {
      return ["cell", action.sheetId, action.rowOrder, action.fieldKey].join(":");
    }
    if (action.type === "upsertSheet") return ["sheet", action.sheet?.id || action.id].join(":");
    if (action.type === "archiveSheet") return ["archive", action.sheetId].join(":");
    if (action.type === "deleteSheet") return ["delete-sheet", action.sheetId].join(":");
    if (action.type === "upsertTeam") return ["team", action.teamKey].join(":");
    if (action.type === "upsertUser") return ["user", action.teamKey, action.agentKey].join(":");
    return [action.type, action.actionId].join(":");
  }

  function takeNextSyncBatch() {
    const [first] = state.syncQueue;
    if (!first) return [];
    if (first.type !== "upsertCell") return [first];

    const batch = [];
    for (const action of state.syncQueue) {
      if (action.type !== "upsertCell" || batch.length >= SYNC_CELL_BATCH_SIZE) break;
      batch.push(action);
    }
    return batch;
  }

  async function sendSyncBatch(client, batch, context) {
    if (!batch.length) return;
    if (batch.every((action) => action.type === "upsertCell")) {
      await sendCellBatch(client, batch, context);
      return;
    }
    for (const action of batch) await sendSyncAction(client, action, context);
  }

  function markSyncBatchFailed(batch, error) {
    const attempts = Number(state.syncStatus.attempts || 0) + 1;
    const delay = Math.min(SYNC_RETRY_MAX_MS, SYNC_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 5));
    const nextRetryAt = Date.now() + delay;
    state.syncStatus.attempts = attempts;
    state.syncStatus.nextRetryAt = String(nextRetryAt);
    batch.forEach((failed) => {
      const queued = state.syncQueue.find((item) => item.actionId === failed.actionId);
      if (!queued) return;
      queued.attempts = Number(queued.attempts || 0) + 1;
      queued.lastError = getErrorMessage(error);
      queued.lastAttemptAt = new Date().toISOString();
    });
  }

  async function assertRemoteReachable() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REMOTE_PROBE_TIMEOUT_MS);
    try {
      const endpoint = `${REMOTE_CONFIG.supabaseUrl.replace(/\/$/, "")}/rest/v1/inventory_sheets?select=id&limit=1`;
      const response = await fetch(endpoint, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          apikey: REMOTE_CONFIG.supabaseAnonKey,
          Authorization: `Bearer ${REMOTE_CONFIG.supabaseAnonKey}`,
        },
      });
      if (!response.ok) throw new Error(`Serveur indisponible (${response.status})`);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function sendCellBatch(client, actions, context) {
    const groups = groupBy(actions, (action) => [action.sheetId, action.teamKey, getActionAgentKey(action), getActionSheetStatus(action)].join(":"));
    for (const groupActions of Object.values(groups)) {
      const first = groupActions[0];
      const sheetStatus = getActionSheetStatus(first);
      const archivedAt = sheetStatus === "archived" ? getActionArchivedAt(first) || maxIso(groupActions.map((action) => action.updatedAt)) : null;
      const sheet = await sendUpsertSheet(client, {
        id: first.sheetId,
        team_key: first.teamKey,
        team_name: first.teamName || state.session.team,
        agent_key: getActionAgentKey(first),
        agent_name: getActionAgentName(first),
        status: sheetStatus,
        archived_at: archivedAt,
        created_by: first.updatedBy,
        updated_by: first.updatedBy,
        updated_at: maxIso(groupActions.map((action) => action.updatedAt)),
      }, context);
      const sheetId = sheet?.id || getMappedSheetId(context, first.sheetId) || first.sheetId;
      const rows = groupActions.map((action) => ({
        sheet_id: sheetId,
        row_order: Number(action.rowOrder),
        field_key: action.fieldKey,
        value: clean(action.value),
        updated_at: action.updatedAt,
        updated_by: action.updatedBy,
      }));
      await upsertInventoryCells(client, rows);
    }
  }

  async function upsertInventoryCells(client, rows) {
    if (!rows.length) return;
    const rpcResult = await client.rpc("upsert_inventory_cells_newer", { p_cells: rows });
    if (!rpcResult.error) return;
    if (!isMissingRpcError(rpcResult.error)) throw rpcResult.error;

    await throwOnError(
      client.from("inventory_cells").upsert(rows, { onConflict: "sheet_id,row_order,field_key" }),
    );
  }

  function isMissingRpcError(error) {
    const message = String(error?.message || error?.details || "");
    return error?.code === "PGRST202" || error?.code === "42883" || message.includes("upsert_inventory_cells_newer");
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

    if (action.type === "deleteSheet") {
      await throwOnError(client.from("inventory_sheets").delete().eq("id", action.sheetId));
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
        agent_key: getActionAgentKey(action),
        agent_name: getActionAgentName(action),
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
      const sheetStatus = getActionSheetStatus(action);
      const sheet = await sendUpsertSheet(client, {
        id: action.sheetId,
        team_key: action.teamKey,
        team_name: action.teamName || state.session.team,
        agent_key: getActionAgentKey(action),
        agent_name: getActionAgentName(action),
        status: sheetStatus,
        archived_at: sheetStatus === "archived" ? getActionArchivedAt(action) || action.updatedAt : null,
        created_by: action.updatedBy,
        updated_by: action.updatedBy,
        updated_at: action.updatedAt,
      }, context);
      const sheetId = sheet?.id || getMappedSheetId(context, action.sheetId) || action.sheetId;
      await upsertInventoryCells(client, [{
        sheet_id: sheetId,
        row_order: action.rowOrder,
        field_key: action.fieldKey,
        value: action.value,
        updated_at: action.updatedAt,
        updated_by: action.updatedBy,
      }]);
    }
  }

  async function sendUpsertSheet(client, sheet, context = createSyncContext()) {
    if (!sheet?.id) return null;
    const agentName = getSheetAgentName(sheet);
    const agentKey = getSheetAgentKey({ ...sheet, agent_name: agentName });
    const sheetPayload = {
      id: getMappedSheetId(context, sheet.id) || sheet.id,
      team_key: sheet.team_key,
      team_name: sheet.team_name,
      agent_key: agentKey,
      agent_name: agentName,
      status: sheet.status,
      archived_at: sheet.archived_at || null,
      created_by: sheet.created_by,
      updated_by: sheet.updated_by,
      updated_at: sheet.updated_at,
    };

    if (sheetPayload.status === "active") {
      const activeSheet = await findRemoteActiveSheet(client, sheetPayload.team_key, sheetPayload.agent_key, context);
      if (activeSheet && activeSheet.id !== sheetPayload.id) {
        rememberSheetMapping(context, sheet.id, activeSheet.id);
        return activeSheet;
      }
    }

    const result = await client.from("inventory_sheets").upsert(sheetPayload, { onConflict: "id" });
    if (result.error) {
      const activeSheet =
        sheetPayload.status === "active" ? await findRemoteActiveSheet(client, sheetPayload.team_key, sheetPayload.agent_key, context, true) : null;
      if (activeSheet) {
        rememberSheetMapping(context, sheet.id, activeSheet.id);
        return activeSheet;
      }
      throw result.error;
    }

    if (sheetPayload.status === "active") {
      context.activeSheetsByOwner.set(getOwnerMapKey(sheetPayload.team_key, sheetPayload.agent_key), { ...sheetPayload });
    }
    return sheetPayload;
  }

  async function resolveArchiveSheetId(client, action, context) {
    const sheetId = getMappedSheetId(context, action.sheetId) || action.sheetId;
    const { data, error } = await client.from("inventory_sheets").select("id").eq("id", sheetId).limit(1);
    if (error) throw error;
    if (data?.[0]?.id) return data[0].id;

    const activeSheet = await findRemoteActiveSheet(client, action.teamKey, getActionAgentKey(action), context, true);
    if (activeSheet?.id) {
      rememberSheetMapping(context, action.sheetId, activeSheet.id);
      return activeSheet.id;
    }
    return sheetId;
  }

  async function findRemoteActiveSheet(client, teamKey, agentKey, context, refresh = false) {
    if (!teamKey || !agentKey) return null;
    const ownerKey = getOwnerMapKey(teamKey, agentKey);
    if (!refresh && context.activeSheetsByOwner.has(ownerKey)) return context.activeSheetsByOwner.get(ownerKey);
    const { data, error } = await client
      .from("inventory_sheets")
      .select("id,team_key,team_name,agent_key,agent_name,status,archived_at,created_by,updated_by,updated_at")
      .eq("team_key", teamKey)
      .eq("agent_key", agentKey)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const sheet = data?.[0] || null;
    if (sheet) context.activeSheetsByOwner.set(ownerKey, sheet);
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

  async function loadRemoteActiveSheet({ skipIfLocalPending = false } = {}) {
    const client = getSupabaseClient();
    if (!client || isAdminSession()) return;
    const teamKey = state.session.teamKey || normalizeTeam(state.session.team);
    const agentKey = getSessionAgentKey();
    if (skipIfLocalPending && hasLocalPendingWork(teamKey, agentKey)) {
      state.syncStatus.remote = "pending";
      state.syncStatus.message = "Local protege";
      saveState();
      return false;
    }
    const { data, error } = await client
      .from("inventory_sheets")
      .select("*")
      .eq("team_key", teamKey)
      .eq("agent_key", agentKey)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;

    const sheet = data?.[0];
    if (!sheet) {
      if (hasCurrentSheetContent()) queueCurrentSheetSnapshotSync();
      else queueSync("upsertSheet", currentSheetPayload("active"));
      await syncNow({ force: true });
      return true;
    }

    const cells = await fetchSheetCells(client, sheet.id);
    applyRemoteSheet(sheet, cells);
    return true;
  }

  async function pullRemoteArchivesForTeam(teamKey, agentKey = getSessionAgentKey()) {
    const client = getSupabaseClient();
    if (!client || !teamKey || !agentKey) return;
    const sheets = await fetchAllRemoteRows(() =>
      client
        .from("inventory_sheets")
        .select("*")
        .eq("team_key", teamKey)
        .eq("agent_key", agentKey)
        .eq("status", "archived")
        .order("archived_at", { ascending: false }),
    );
    await mergeRemoteArchives(client, sheets);
  }

  async function pullRemoteAdminData() {
    const client = getSupabaseClient();
    if (!client) return;
    const [teams, users, sheets] = await Promise.all([
      fetchAllRemoteRows(() => client.from("inventory_teams").select("*").order("team_name")),
      fetchAllRemoteRows(() => client.from("inventory_users").select("*").order("team_name").order("agent_name")),
      fetchAllRemoteRows(() => client.from("inventory_sheets").select("*").order("updated_at", { ascending: false })),
    ]);

    state.teams = normalizeTeams((teams || []).map((team) => ({ teamName: team.team_name, teamKey: team.team_key, active: team.active })));
    state.users = normalizeUsers(
      (users || []).map((user) => ({
        teamName: user.team_name,
        teamKey: user.team_key,
        agentName: user.agent_name,
        agentKey: user.agent_key,
        active: user.active,
      })),
    );
    await mergeRemoteArchives(client, sheets || []);
    state.syncStatus.remote = "synced";
    state.syncStatus.message = `${sheets.length} fiche(s) chargee(s)`;
    state.syncStatus.lastSyncAt = new Date().toISOString();
    saveState();
  }

  async function fetchAllRemoteRows(makeQuery, pageSize = REMOTE_PAGE_SIZE) {
    const rows = [];
    let from = 0;

    while (true) {
      const { data, error } = await makeQuery().range(from, from + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }

    return rows;
  }

  async function mergeRemoteArchives(client, sheets) {
    if (!sheets.length) return;
    const existing = new Map(state.archives.map((archive) => [archive.id, archive]));
    sheets
      .filter((sheet) => !hasPendingSheetDelete(sheet.id))
      .forEach((sheet) => existing.set(sheet.id, sheetToArchiveSummary(sheet, existing.get(sheet.id))));
    state.archives = Array.from(existing.values()).filter((archive) => !hasPendingSheetDelete(archive.id)).sort(sortArchives);
    saveState();
  }

  async function fetchSheetCells(client, sheetId) {
    return fetchCellsForSheetIds(client, [sheetId]);
  }

  async function fetchRemoteSheetById(sheetId) {
    const params = new URLSearchParams({
      select: "*",
      id: `eq.${sheetId}`,
    });
    const endpoint = `${REMOTE_CONFIG.supabaseUrl.replace(/\/$/, "")}/rest/v1/inventory_sheets?${params.toString()}`;
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        apikey: REMOTE_CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${REMOTE_CONFIG.supabaseAnonKey}`,
      },
    });
    if (!response.ok) throw new Error(`Lecture de la fiche impossible (${response.status})`);
    const rows = await response.json();
    return rows?.[0] || null;
  }

  async function fetchCellsForSheetIds(client, sheetIds) {
    const ids = Array.from(new Set(sheetIds.filter(Boolean)));
    const cells = [];

    for (let index = 0; index < ids.length; index += REMOTE_SHEET_BATCH_SIZE) {
      const batch = ids.slice(index, index + REMOTE_SHEET_BATCH_SIZE);
      let from = 0;

      while (true) {
        const page = await fetchRemoteCellsBatchPage(batch, from);
        cells.push(...page);
        if (page.length < REMOTE_PAGE_SIZE) break;
        from += REMOTE_PAGE_SIZE;
      }
    }

    return cells;
  }

  async function fetchRemoteCellsBatchPage(sheetIds, from) {
    const params = new URLSearchParams({
      select: "*",
      sheet_id: `in.(${sheetIds.join(",")})`,
      order: "sheet_id.asc,row_order.asc,field_key.asc",
    });
    const endpoint = `${REMOTE_CONFIG.supabaseUrl.replace(/\/$/, "")}/rest/v1/inventory_cells?${params.toString()}`;
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        apikey: REMOTE_CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${REMOTE_CONFIG.supabaseAnonKey}`,
        "Range-Unit": "items",
        Range: `${from}-${from + REMOTE_PAGE_SIZE - 1}`,
      },
    });
    if (!response.ok) throw new Error(`Lecture des cellules impossible (${response.status})`);
    return response.json();
  }

  function applyRemoteSheet(sheet, cells) {
    const localSnapshot = {
      sheetId: state.sheetId,
      header: { ...state.header },
      rows: state.rows.map((row) => ({ ...row })),
    };
    const remoteSnapshot = cellsToSnapshot(cells);
    const remoteCellKeys = new Set(cells.map((cell) => getCellSyncKey(cell.row_order, cell.field_key)));
    const shouldKeepLocalGaps = localSnapshot.sheetId === sheet.id && hasSheetSnapshotContent(localSnapshot.header, localSnapshot.rows);
    const mergedSnapshot = shouldKeepLocalGaps
      ? mergeRemoteSnapshotWithLocalGaps(remoteSnapshot, remoteCellKeys, localSnapshot)
      : { ...remoteSnapshot, preservedCells: [] };

    applyingRemote = true;
    state.sheetId = sheet.id;
    state.viewingArchiveId = "";
    state.session.team = sheet.team_name || state.session.team;
    state.session.teamKey = sheet.team_key || state.session.teamKey;
    state.session.agent = sheet.agent_name || state.session.agent;
    state.session.agentKey = sheet.agent_key || state.session.agentKey || normalizeTeam(state.session.agent);
    state.header = { date: "", agency: "", supervisor: "", locked: false, ...mergedSnapshot.header };
    state.rows = mergedSnapshot.rows;
    if (!state.header.date) state.header.date = new Date().toISOString().slice(0, 10);
    applyingRemote = false;
    if (mergedSnapshot.preservedCells.length) queuePreservedCellsSync(mergedSnapshot.preservedCells);
    saveState();
    renderSheet();
  }

  function applyRemoteCell(record) {
    if (!record || record.sheet_id !== state.sheetId) return;
    const rowOrder = Number(record.row_order);
    if (hasPendingCellChange(record.sheet_id, rowOrder, record.field_key)) return;
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

  function mergeRemoteSnapshotWithLocalGaps(remoteSnapshot, remoteCellKeys, localSnapshot) {
    const header = { date: "", agency: "", supervisor: "", locked: false, ...remoteSnapshot.header };
    const rowsByOrder = new Map((remoteSnapshot.rows || []).map((row) => [Number(row.order), { ...row }]));
    const preservedCells = [];

    headerFields.forEach((field) => {
      const value = clean(localSnapshot.header?.[field.key]);
      if (!value || remoteCellKeys.has(getCellSyncKey(0, field.key))) return;
      header[field.key] = value;
      preservedCells.push({ rowOrder: 0, fieldKey: field.key, value });
    });

    (localSnapshot.rows || []).forEach((localRow) => {
      if (!rowHasContent(localRow)) return;
      const order = Number(localRow.order);
      if (!Number.isFinite(order)) return;
      const row = rowsByOrder.get(order) || { id: "row-" + order, order };
      columns.slice(1).forEach((column) => {
        const value = clean(localRow[column.key]);
        if (!value || remoteCellKeys.has(getCellSyncKey(order, column.key))) return;
        row[column.key] = value;
        row.updatedAt = localRow.updatedAt || new Date().toISOString();
        row.updatedBy = localRow.updatedBy || state.session.agent;
        preservedCells.push({ rowOrder: order, fieldKey: column.key, value });
      });
      if (rowHasContent(row)) rowsByOrder.set(order, row);
    });

    return {
      header,
      rows: Array.from(rowsByOrder.values()).sort((a, b) => Number(a.order) - Number(b.order)),
      preservedCells,
    };
  }

  function queuePreservedCellsSync(cells) {
    queueSync("upsertSheet", currentSheetPayload("active"));
    cells.forEach((cell) => queueCellChange(cell.rowOrder, cell.fieldKey, cell.value));
  }

  function queueCurrentSheetSnapshotSync() {
    queueSync("upsertSheet", currentSheetPayload("active"));
    headerFields.forEach((field) => {
      const value = clean(state.header[field.key]);
      if (value) queueCellChange(0, field.key, value);
    });
    state.rows.filter(rowHasContent).forEach((row) => {
      columns.slice(1).forEach((column) => {
        const value = clean(row[column.key]);
        if (value) queueCellChange(row.order, column.key, value);
      });
    });
  }

  function hasCurrentSheetContent() {
    return hasSheetSnapshotContent(state.header, state.rows);
  }

  function hasSheetSnapshotContent(header, rows) {
    return Boolean(clean(header?.agency) || clean(header?.supervisor) || (rows || []).some(rowHasContent));
  }

  function getCellSyncKey(rowOrder, fieldKey) {
    return `${Number(rowOrder)}:${fieldKey}`;
  }

  function hasLocalPendingWork(teamKey = state.session.teamKey || normalizeTeam(state.session.team), agentKey = getSessionAgentKey()) {
    compactSyncQueue();
    return state.syncQueue.some((action) => {
      if (action.teamKey && action.teamKey !== teamKey) return false;
      if (action.sheet?.team_key && action.sheet.team_key !== teamKey) return false;
      const actionAgentKey = getActionAgentKey(action);
      const sheetAgentKey = action.sheet ? getSheetAgentKey(action.sheet) : "";
      if (actionAgentKey && actionAgentKey !== agentKey) return false;
      if (sheetAgentKey && sheetAgentKey !== agentKey) return false;
      return ["upsertSheet", "archiveSheet", "upsertCell"].includes(action.type);
    });
  }

  function hasPendingCellChange(sheetId, rowOrder, fieldKey) {
    return state.syncQueue.some(
      (action) =>
        action.type === "upsertCell" &&
        action.sheetId === sheetId &&
        Number(action.rowOrder) === Number(rowOrder) &&
        action.fieldKey === fieldKey,
    );
  }

  function startRealtime() {
    stopRealtime();
    const client = getSupabaseClient();
    if (!client || !state.sheetId || isAdminSession() || state.viewingArchiveId) return;
    const teamKey = state.session.teamKey || normalizeTeam(state.session.team);
    const agentKey = getSessionAgentKey();
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
          if (payload.new?.agent_key !== agentKey) return;
          if (payload.new?.status === "active" && payload.new.id !== state.sheetId) loadRemoteActiveSheet().catch(() => {});
          if (payload.new?.status === "archived") pullRemoteArchivesForTeam(teamKey, agentKey).catch(() => {});
        },
      )
      .subscribe();
  }

  function stopRealtime() {
    if (sheetChannel && supabaseClient) supabaseClient.removeChannel(sheetChannel);
    sheetChannel = null;
  }

  function currentSheetPayload(
    status = "active",
    sheetId = state.sheetId,
    teamKey = state.session.teamKey || normalizeTeam(state.session.team),
    agentKey = getSessionAgentKey(),
  ) {
    const now = new Date().toISOString();
    return {
      id: sheetId || makeId("sheet"),
      team_key: teamKey,
      team_name: state.session.team,
      agent_key: agentKey,
      agent_name: getSessionAgentName(),
      status,
      archived_at: status === "archived" ? now : null,
      created_by: state.session.agent,
      updated_by: state.session.agent,
      updated_at: now,
    };
  }

  function queueCellChange(rowOrder, fieldKey, value) {
    if (applyingRemote || !state.session.connected) return false;
    if (isAdminSession() && !state.viewingArchiveId) return false;
    const sheetStatus = getCurrentSheetStatus();
    const archivedAt = sheetStatus === "archived" ? getCurrentSheetArchivedAt() : "";
    const action = {
      actionId: makeId("op"),
      type: "upsertCell",
      sheetId: state.sheetId,
      teamKey: state.session.teamKey || normalizeTeam(state.session.team),
      teamName: state.session.team,
      agentKey: getSessionAgentKey(),
      agentName: getSessionAgentName(),
      rowOrder: Number(rowOrder),
      fieldKey,
      value: clean(value),
      updatedAt: new Date().toISOString(),
      updatedBy: state.session.agent,
      sheetStatus,
      archivedAt,
    };
    queueSync(action.type, action);
    return true;
  }

  function queueNewerLocalArchiveCells(archive, sheet, remoteCells) {
    if (!archive?.id || !Array.isArray(archive.rows)) return 0;
    const remoteByKey = new Map(remoteCells.map((cell) => [getCellSyncKey(cell.row_order, cell.field_key), cell]));
    const remoteUpdatedAt = newestIso([sheet.updated_at, sheet.archived_at, ...remoteCells.map((cell) => cell.updated_at)]);
    const localUpdatedAt = newestIso([archive.updatedAt, archive.session?.connectedAt, ...archive.rows.map((row) => row.updatedAt)]);
    if (!localUpdatedAt || (remoteUpdatedAt && localUpdatedAt <= remoteUpdatedAt)) return 0;

    const teamKey = archive.session?.teamKey || sheet.team_key || normalizeTeam(archive.session?.team || sheet.team_name);
    const teamName = archive.session?.team || sheet.team_name || state.session.team;
    const agentKey = getArchiveAgentKey(archive) || sheet.agent_key || normalizeTeam(archive.session?.agent || sheet.agent_name);
    const agentName = archive.session?.agent || sheet.agent_name || state.session.agent;
    const archivedAt = archive.archivedAt || sheet.archived_at || remoteUpdatedAt || localUpdatedAt;
    let recovered = 0;

    headerFields.forEach((field) => {
      const localValue = clean(archive.header?.[field.key]);
      if (!localValue) return;
      const remoteCell = remoteByKey.get(getCellSyncKey(0, field.key));
      const remoteValue = clean(remoteCell?.value);
      const localFieldUpdatedAt = archive.updatedAt || localUpdatedAt;
      if (localValue === remoteValue || (remoteCell?.updated_at && localFieldUpdatedAt <= remoteCell.updated_at)) return;
      queueArchiveCellRecovery({ sheetId: archive.id, teamKey, teamName, agentKey, agentName, archivedAt, rowOrder: 0, fieldKey: field.key, value: localValue, updatedAt: localFieldUpdatedAt });
      recovered += 1;
    });

    archive.rows.forEach((row) => {
      const rowOrder = Number(row.order);
      if (!Number.isFinite(rowOrder)) return;
      const localFieldUpdatedAt = row.updatedAt || archive.updatedAt || localUpdatedAt;
      columns.slice(1).forEach((column) => {
        const localValue = clean(row[column.key]);
        if (!localValue) return;
        const remoteCell = remoteByKey.get(getCellSyncKey(rowOrder, column.key));
        const remoteValue = clean(remoteCell?.value);
        if (localValue === remoteValue || (remoteCell?.updated_at && localFieldUpdatedAt <= remoteCell.updated_at)) return;
        queueArchiveCellRecovery({ sheetId: archive.id, teamKey, teamName, agentKey, agentName, archivedAt, rowOrder, fieldKey: column.key, value: localValue, updatedAt: localFieldUpdatedAt });
        recovered += 1;
      });
    });

    if (recovered) {
      state.syncStatus.remote = "pending";
      state.syncStatus.message = `${recovered} correction(s) locale(s) a synchroniser`;
    }
    return recovered;
  }

  function queueArchiveCellRecovery({ sheetId, teamKey, teamName, agentKey, agentName, archivedAt, rowOrder, fieldKey, value, updatedAt }) {
    queueSync("upsertCell", {
      actionId: makeId("op"),
      type: "upsertCell",
      sheetId,
      teamKey,
      teamName,
      agentKey,
      agentName,
      rowOrder: Number(rowOrder),
      fieldKey,
      value: clean(value),
      updatedAt: updatedAt || new Date().toISOString(),
      updatedBy: agentName || state.session.agent,
      sheetStatus: "archived",
      archivedAt,
    });
  }

  function queueCellSnapshotChange(payload) {
    queueSync("upsertCell", {
      actionId: makeId("op"),
      type: "upsertCell",
      ...payload,
      value: clean(payload.value),
      updatedAt: payload.updatedAt || new Date().toISOString(),
      updatedBy: payload.updatedBy || state.session.agent,
    });
  }

  function queueSync(type, payload) {
    if (applyingRemote) return;
    const now = new Date().toISOString();
    const action = payload?.type
      ? { ...payload }
      : { actionId: makeId("op"), type, ...payload, updatedAt: payload?.updatedAt || now };
    action.actionId = action.actionId || makeId("op");
    action.queuedAt = action.queuedAt || action.updatedAt || now;
    action.sequence = Number.isFinite(Number(action.sequence)) ? Number(action.sequence) : Date.now() + state.syncQueue.length;
    action.attempts = Number(action.attempts || 0);
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
    if (action.type === "deleteSheet") {
      state.syncQueue = state.syncQueue.filter((item) => item.sheetId !== action.sheetId && item.sheet?.id !== action.sheetId);
    }
    state.syncQueue.push(action);
    compactSyncQueue();
    state.syncStatus.pending = state.syncQueue.length;
  }

  function sheetToArchive(sheet, cells) {
    const snapshot = cellsToSnapshot(cells);
    const contentUpdatedAt = newestIso([sheet.updated_at, sheet.archived_at, ...cells.map((cell) => cell.updated_at)]);
    return {
      id: sheet.id,
      status: sheet.status || "archived",
      archivedAt: sheet.archived_at || sheet.updated_at,
      updatedAt: contentUpdatedAt || sheet.updated_at || sheet.archived_at,
      hasDetails: true,
      filledRows: snapshot.rows.filter(rowHasContent).length,
      session: {
        connected: true,
        team: sheet.team_name,
        teamKey: sheet.team_key,
        agent: sheet.agent_name || sheet.updated_by || sheet.created_by || "",
        agentKey: sheet.agent_key || normalizeTeam(sheet.agent_name || sheet.updated_by || sheet.created_by || ""),
        isAdmin: false,
        connectedAt: contentUpdatedAt || sheet.updated_at || "",
      },
      header: snapshot.header,
      rows: snapshot.rows,
    };
  }

  function sheetToArchiveSummary(sheet, existing = null) {
    const hasPendingDetails = existing && archiveHasPendingSync(existing.id);
    if (hasPendingDetails && existing?.rows?.length) return existing;
    const remoteUpdatedAt = sheet.updated_at || sheet.archived_at || "";
    const existingUpdatedAt = existing?.updatedAt || existing?.session?.connectedAt || existing?.archivedAt || "";
    const remoteHasNewerDetails = Boolean(existing?.rows?.length && remoteUpdatedAt && remoteUpdatedAt > existingUpdatedAt);
    const keepExistingRows = Boolean(existing?.hasDetails !== false && existing?.rows?.length && !remoteHasNewerDetails);
    const header = existing?.header || {
      date: String(sheet.archived_at || sheet.updated_at || "").slice(0, 10),
      agency: "",
      supervisor: "",
      locked: false,
    };
    return {
      id: sheet.id,
      status: sheet.status || "archived",
      archivedAt: sheet.archived_at || sheet.updated_at,
      updatedAt: remoteUpdatedAt,
      hasDetails: keepExistingRows,
      filledRows: keepExistingRows
        ? (Number.isFinite(existing?.filledRows) ? existing.filledRows : getArchiveFilledRows(existing))
        : null,
      session: {
        connected: true,
        team: sheet.team_name || existing?.session?.team || "",
        teamKey: sheet.team_key || existing?.session?.teamKey || "",
        agent: sheet.agent_name || sheet.updated_by || sheet.created_by || existing?.session?.agent || "",
        agentKey: sheet.agent_key || existing?.session?.agentKey || normalizeTeam(sheet.agent_name || sheet.updated_by || sheet.created_by || existing?.session?.agent || ""),
        isAdmin: false,
        connectedAt: remoteUpdatedAt || existing?.session?.connectedAt || "",
      },
      header,
      rows: keepExistingRows ? existing.rows : [],
    };
  }

  function getArchiveFilledRows(archive) {
    if (!archive) return NaN;
    if (Number.isFinite(archive.filledRows)) return archive.filledRows;
    if (!Array.isArray(archive.rows)) return NaN;
    if (!archive.rows.length && archive.hasDetails === false) return NaN;
    return archive.rows.filter(rowHasContent).length;
  }

  function sortArchives(a, b) {
    return String(b?.archivedAt || "").localeCompare(String(a?.archivedAt || ""));
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
    else if (remote === "pending") label = "Reprise sync...";
    else label = "Synchronise";
    badge.textContent = label;
    badge.title = state.syncQueue?.[0]?.lastError || state.syncStatus?.message || label;
    badge.dataset.status = !navigator.onLine ? "offline" : pending ? "pending" : remote;
  }

  function isAdminCredentials(team, agent) {
    return normalizeTeam(team) === ADMIN_TEAM && normalizeTeam(agent) === ADMIN_AGENT;
  }

  function isAdminSession() {
    return Boolean(state.session?.connected && (state.session?.isAdmin || isAdminCredentials(state.session?.team, state.session?.agent)));
  }

  function getSessionAgentKey(session = state.session) {
    return clean(session?.agentKey || session?.agent_key) || normalizeTeam(session?.agent || session?.agentName || session?.agent_name);
  }

  function getSessionAgentName(session = state.session) {
    return clean(session?.agent || session?.agentName || session?.agent_name) || "Agent";
  }

  function getOwnerMapKey(teamKey, agentKey) {
    return [teamKey || "", agentKey || ""].join(":");
  }

  function getSheetAgentKey(sheet) {
    return clean(sheet?.agent_key || sheet?.agentKey) || normalizeTeam(getSheetAgentName(sheet));
  }

  function getSheetAgentName(sheet) {
    return clean(sheet?.agent_name || sheet?.agentName || sheet?.updated_by || sheet?.updatedBy || sheet?.created_by || sheet?.createdBy) || getSessionAgentName();
  }

  function getActionAgentKey(action) {
    return clean(action?.agentKey || action?.agent_key || action?.sheet?.agent_key || action?.sheet?.agentKey) || normalizeTeam(getActionAgentName(action));
  }

  function getActionAgentName(action) {
    return (
      clean(action?.agentName || action?.agent_name || action?.sheet?.agent_name || action?.sheet?.agentName) ||
      clean(action?.updatedBy || action?.updated_by || action?.sheet?.updated_by || action?.sheet?.created_by) ||
      getSessionAgentName()
    );
  }

  function getActionSheetStatus(action) {
    return clean(action?.sheetStatus || action?.sheet_status || action?.sheet?.status || action?.status) === "archived" ? "archived" : "active";
  }

  function getActionArchivedAt(action) {
    return clean(action?.archivedAt || action?.archived_at || action?.sheet?.archived_at || action?.sheet?.archivedAt);
  }

  function getCurrentSheetStatus() {
    return state.viewingArchiveId === state.sheetId || state.archives.some((archive) => archive.id === state.sheetId && (archive.status || "archived") === "archived")
      ? "archived"
      : "active";
  }

  function getCurrentSheetArchivedAt() {
    const archive = state.archives.find((item) => item.id === state.sheetId && (item.status || "archived") === "archived");
    return archive?.archivedAt || "";
  }

  function getArchiveAgentKey(archive) {
    return getSessionAgentKey(archive?.session);
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

  function setLocalTeamActive(teamKey, isActive) {
    const now = new Date().toISOString();
    let updatedTeam = null;
    state.teams = state.teams
      .map((team) => {
        if (team.teamKey !== teamKey) return team;
        updatedTeam = { ...team, active: Boolean(isActive), updatedAt: now };
        return updatedTeam;
      })
      .sort((a, b) => a.teamName.localeCompare(b.teamName));
    return updatedTeam;
  }

  function setLocalUserActive(teamKey, agentKey, isActive) {
    const now = new Date().toISOString();
    let updatedUser = null;
    state.users = state.users
      .map((user) => {
        if (user.teamKey !== teamKey || user.agentKey !== agentKey) return user;
        updatedUser = { ...user, active: Boolean(isActive), updatedAt: now };
        return updatedUser;
      })
      .sort((a, b) => (a.teamName + a.agentName).localeCompare(b.teamName + b.agentName));
    return updatedUser;
  }

  function setLocalUsersActiveByTeam(teamKey, isActive) {
    const now = new Date().toISOString();
    const updatedUsers = [];
    state.users = state.users
      .map((user) => {
        if (user.teamKey !== teamKey) return user;
        const updatedUser = { ...user, active: Boolean(isActive), updatedAt: now };
        updatedUsers.push(updatedUser);
        return updatedUser;
      })
      .sort((a, b) => (a.teamName + a.agentName).localeCompare(b.teamName + b.agentName));
    return updatedUsers;
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

  function normalizeArchives(archives, syncQueue = []) {
    if (!Array.isArray(archives)) return [];
    return compactArchivesForStorage(archives, syncQueue).map((archive) => ({
      ...archive,
      header: { date: "", agency: "", supervisor: "", locked: false, ...(archive.header || {}) },
      session: { connected: true, team: "", teamKey: "", agent: "", agentKey: "", isAdmin: false, connectedAt: "", ...(archive.session || {}) },
      rows: Array.isArray(archive.rows) ? archive.rows : [],
      hasDetails: archive.hasDetails !== false && Array.isArray(archive.rows) && archive.rows.length > 0,
      filledRows: Number.isFinite(archive.filledRows) ? archive.filledRows : (archive.rows?.length ? getArchiveFilledRows(archive) : null),
    }));
  }

  function compactArchivesForStorage(archives, syncQueue = state?.syncQueue || []) {
    if (!Array.isArray(archives)) return [];
    return archives
      .slice()
      .sort(sortArchives)
      .slice(0, LOCAL_ARCHIVE_SUMMARY_LIMIT)
      .map((archive, index) => {
        const rows = Array.isArray(archive.rows) ? archive.rows : [];
        const keepDetails = archiveHasPendingSync(archive.id, syncQueue) || (index < LOCAL_ARCHIVE_DETAIL_LIMIT && rows.length > 0);
        return {
          ...archive,
          header: { date: "", agency: "", supervisor: "", locked: false, ...(archive.header || {}) },
          filledRows: Number.isFinite(archive.filledRows) ? archive.filledRows : (rows.length ? rows.filter(rowHasContent).length : null),
          hasDetails: keepDetails && rows.length > 0,
          rows: keepDetails ? rows.map((row) => ({ ...row })) : [],
        };
      });
  }

  function archiveHasPendingSync(archiveId, syncQueue = state?.syncQueue || []) {
    if (!archiveId) return false;
    return syncQueue.some((action) => action.sheetId === archiveId || action.sheet?.id === archiveId);
  }

  function hasPendingSheetDelete(sheetId, syncQueue = state?.syncQueue || []) {
    if (!sheetId) return false;
    return syncQueue.some((action) => action.type === "deleteSheet" && action.sheetId === sheetId);
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
        storedSession.agentKey = storedSession.agentKey || normalizeTeam(storedSession.agent);
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

  function maxIso(values) {
    const sorted = values.filter(Boolean).sort();
    return sorted[sorted.length - 1] || new Date().toISOString();
  }

  function newestIso(values) {
    const sorted = values.filter(Boolean).sort();
    return sorted[sorted.length - 1] || "";
  }

  function getErrorMessage(error) {
    return clean(error?.message || error?.details || error?.hint || error) || "Erreur de synchronisation";
  }

  function groupBy(items, key) {
    return items.reduce((groups, item) => {
      const value = typeof key === "function" ? key(item) : item[key];
      groups[value] = groups[value] || [];
      groups[value].push(item);
      return groups;
    }, {});
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
      navigator.serviceWorker.register("sw.js?v=35").catch(() => {});
    }
  }
})();
