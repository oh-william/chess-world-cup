"use strict";
/* boot.js — detect server mode, load data, wire router + tablist, route. Loads LAST. */
(function () {
  const CWC = window.CWC;

  function setModeChip(live) {
    const chip = document.getElementById("mode-chip");
    if (!chip) return;
    chip.classList.toggle("mode--live", live);
    chip.classList.toggle("mode--replay", !live);
    chip.textContent = live ? "● LIVE" : "◦ REPLAY";
    chip.title = live ? "Connected to the live server" : "Static replay (no live server)";
  }

  function wireTablist() {
    const tabs = Array.from(document.querySelectorAll(".tablist .tab"));
    tabs.forEach(t => {
      t.addEventListener("click", () => { location.hash = "#/" + t.dataset.view; });
      t.addEventListener("keydown", e => {
        const i = tabs.indexOf(t);
        let ni = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") ni = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") ni = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") ni = 0;
        else if (e.key === "End") ni = tabs.length - 1;
        else if (e.key === "Enter" || e.key === " ") { location.hash = "#/" + t.dataset.view; e.preventDefault(); return; }
        if (ni >= 0) { e.preventDefault(); tabs[ni].focus(); location.hash = "#/" + tabs[ni].dataset.view; }
      });
    });
  }

  async function boot() {
    // 1) server mode
    try {
      const cfg = await fetch("/api/config", { headers: { Accept: "application/json" } });
      if (cfg.ok) {
        CWC.state.live = true;
        try { CWC.state.serverCfg = await cfg.json(); } catch (e) { /* ignore */ }
      } else { CWC.state.live = false; }
    } catch (e) { CWC.state.live = false; }
    setModeChip(CWC.state.live);

    // 2) load tournament data (tolerate absence)
    try {
      const res = await fetch("data/tournament.json", { headers: { Accept: "application/json" } });
      if (res.ok) { CWC.state.data = await res.json(); CWC.bus.emit("data:loaded", CWC.state.data); }
      else { CWC.ui.toast("tournament.json not found — running with empty data", "warn"); }
    } catch (e) {
      CWC.ui.toast("Could not load tournament.json", "warn");
    }

    // 3) wire router + tablist
    wireTablist();
    window.addEventListener("hashchange", () => CWC.route(location.hash));

    // 4) init all registered views
    Object.keys(CWC._views).forEach(id => {
      const v = CWC._views[id];
      if (!v._inited) { try { v.init(); } catch (e) { console.error("init " + id, e); } v._inited = true; }
    });

    // 5) route to current hash (default #/tournament)
    if (!location.hash) location.hash = "#/tournament";
    CWC.route(location.hash);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
