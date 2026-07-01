(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", initPortal);

  function initPortal() {
    const initial = getInitialApp();
    setApp(initial);

    document.querySelectorAll("[data-open-app]").forEach((button) => {
      button.addEventListener("click", () => setApp(button.dataset.openApp || "portal", { updateHash: true }));
    });

    document.querySelectorAll("[data-back-portal]").forEach((button) => {
      button.addEventListener("click", () => setApp("portal", { updateHash: true }));
    });

    window.addEventListener("hashchange", () => setApp(getInitialApp(), { updateHash: false }));
  }

  function getInitialApp() {
    const hash = String(location.hash || "").replace("#", "").toLowerCase();
    if (hash === "soro" || hash === "mamy") return hash;
    return "portal";
  }

  function setApp(app, { updateHash = false } = {}) {
    const next = app === "soro" || app === "mamy" ? app : "portal";
    document.body.dataset.app = next;
    document.getElementById("portalView")?.setAttribute("aria-hidden", next === "portal" ? "false" : "true");
    document.getElementById("soroApp")?.setAttribute("aria-hidden", next === "soro" ? "false" : "true");
    document.getElementById("mamyApp")?.setAttribute("aria-hidden", next === "mamy" ? "false" : "true");
    if (updateHash) {
      const target = next === "portal" ? location.pathname + location.search : "#" + next;
      history.pushState(null, "", target);
    }
    window.dispatchEvent(new CustomEvent("portal:change", { detail: { app: next } }));
  }
})();
