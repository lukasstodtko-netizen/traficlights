import { maneuverDistancesAlongRoute, computeProgress } from "/nav-math.js";

(() => {
  const ROUTE_META = {
    fewestLights: { label: "Wenigste Ampeln", color: "#ff5470" },
    fastest: { label: "Schnellste Route", color: "#2ec4b6" },
    shortest: { label: "Kürzeste Route", color: "#7c9cff" },
  };
  const ROUTE_ORDER = ["fewestLights", "fastest", "shortest"];

  const state = {
    fromPlace: null, // { lat, lon, label }
    toPlace: null,
    lastResult: null, // { start, end, routes }
    selectedRouteKey: "fewestLights",
    favorites: loadFavorites(),
    livePosition: null, // { lat, lon } while navigating, canvas-fallback only
  };

  const el = {
    planningSection: document.getElementById("planning-section"),
    fromAddress: document.getElementById("from-address"),
    toAddress: document.getElementById("to-address"),
    fromSuggestions: document.getElementById("from-suggestions"),
    toSuggestions: document.getElementById("to-suggestions"),
    form: document.getElementById("route-form"),
    calcBtn: document.getElementById("calc-btn"),
    status: document.getElementById("status"),
    results: document.getElementById("results"),
    routeCards: document.getElementById("route-cards"),
    canvas: document.getElementById("map-canvas"),
    mapLibreDiv: document.getElementById("map-libre"),
    mapFallbackNote: document.getElementById("map-fallback-note"),
    legend: document.getElementById("legend"),
    favoritesList: document.getElementById("favorites-list"),
    saveFavoriteBtn: document.getElementById("save-favorite-btn"),
    startNavBtn: document.getElementById("start-nav-btn"),
    stopNavBtn: document.getElementById("stop-nav-btn"),
    navPanel: document.getElementById("nav-panel"),
    navBottomBar: document.getElementById("nav-bottom-bar"),
    navIcon: document.getElementById("nav-icon"),
    navInstruction: document.getElementById("nav-instruction"),
    navDistanceToManeuver: document.getElementById("nav-distance-to-maneuver"),
    navDistanceRemaining: document.getElementById("nav-distance-remaining"),
    navTimeRemaining: document.getElementById("nav-time-remaining"),
    navStatus: document.getElementById("nav-status"),
  };

  const ctx = el.canvas.getContext("2d");

  // Real map tiles (MapLibre GL JS + OSM raster tiles) are loaded from a CDN in index.html.
  // If that CDN or the tile servers can't be reached, we fall back to the built-in Canvas
  // map further below so the app still works (e.g. offline, or behind a restrictive proxy).
  const USE_MAPLIBRE = typeof window.maplibregl !== "undefined" && !window.__maplibreLoadFailed;

  // ---------- Live address autocomplete ----------

  function setupAutocomplete(input, list, onSelect) {
    let debounceTimer = null;
    let currentResults = [];

    input.addEventListener("input", () => {
      onSelect(null); // typing invalidates a previous selection
      const query = input.value.trim();
      clearTimeout(debounceTimer);
      if (query.length < 3) {
        list.innerHTML = "";
        return;
      }
      debounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
          const data = await res.json();
          currentResults = data.results || [];
          list.innerHTML = "";
          for (const r of currentResults) {
            const li = document.createElement("li");
            li.textContent = r.displayName;
            li.addEventListener("click", () => {
              input.value = r.displayName;
              list.innerHTML = "";
              onSelect({ lat: r.lat, lon: r.lon, label: r.displayName });
            });
            list.appendChild(li);
          }
        } catch (err) {
          list.innerHTML = "";
        }
      }, 350);
    });

    document.addEventListener("click", (ev) => {
      if (!input.parentElement.contains(ev.target)) list.innerHTML = "";
    });
  }

  setupAutocomplete(el.fromAddress, el.fromSuggestions, (place) => {
    state.fromPlace = place;
  });
  setupAutocomplete(el.toAddress, el.toSuggestions, (place) => {
    state.toPlace = place;
  });

  // ---------- Route calculation ----------

  el.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setStatus("Berechne Route …");
    el.calcBtn.disabled = true;
    el.saveFavoriteBtn.disabled = true;

    try {
      if (!state.fromPlace || !state.toPlace) {
        throw new Error("Bitte Start und Ziel jeweils aus den Vorschlägen auswählen.");
      }
      const params = new URLSearchParams({
        fromLat: state.fromPlace.lat,
        fromLon: state.fromPlace.lon,
        toLat: state.toPlace.lat,
        toLon: state.toPlace.lon,
      });
      const res = await fetch(`/api/route?${params}`);
      const result = await parseResponse(res);

      state.lastResult = result;
      state.selectedRouteKey = pickDefaultRoute(result.routes);
      renderResults(result.routes);
      drawMap(result);
      setStatus("Route berechnet.", "ok");
      el.saveFavoriteBtn.disabled = false;
    } catch (err) {
      setStatus(err.message || "Unbekannter Fehler", "error");
      el.results.classList.add("hidden");
    } finally {
      el.calcBtn.disabled = false;
    }
  });

  async function parseResponse(res) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Anfrage fehlgeschlagen");
    return data;
  }

  function pickDefaultRoute(routes) {
    return ROUTE_ORDER.find((k) => routes[k]) || null;
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = "status" + (kind ? " " + kind : "");
  }

  // ---------- Results rendering ----------

  function renderResults(routes) {
    el.routeCards.innerHTML = "";
    el.results.classList.remove("hidden");

    for (const key of ROUTE_ORDER) {
      const route = routes[key];
      if (!route) continue;
      const meta = ROUTE_META[key];

      const card = document.createElement("div");
      card.className = "route-card" + (key === state.selectedRouteKey ? " selected" : "");
      card.style.setProperty("--color", meta.color);
      card.innerHTML = `
        <span class="swatch"></span>
        <div class="info">
          <div class="title">${meta.label}</div>
          <div class="stats">${(route.distanceMeters / 1000).toFixed(1)} km · ${formatDuration(route.estimatedTimeSec)}</div>
        </div>
        <div class="lights-count">${route.trafficLightCount}<small>Ampeln</small></div>
      `;
      card.addEventListener("click", () => {
        state.selectedRouteKey = key;
        renderResults(routes);
        if (state.lastResult) drawMap(state.lastResult);
      });
      el.routeCards.appendChild(card);
    }
  }

  function formatDuration(totalSeconds) {
    const minutes = Math.round(totalSeconds / 60);
    if (minutes < 1) return "<1 min";
    return `${minutes} min`;
  }

  // ---------- Map dispatcher (real OSM tiles via MapLibre, or Canvas fallback) ----------

  function drawMap(result) {
    if (USE_MAPLIBRE) {
      drawMapLibre(result);
    } else {
      drawCanvasMap(result);
    }
    renderLegend();
  }

  // ---------- MapLibre (real OpenStreetMap tiles) ----------

  const mapLibreState = {
    map: null,
    ready: false,
    pendingResult: null,
    lastRenderedResult: null,
    startMarker: null,
    endMarker: null,
    liveMarker: null,
  };

  function initMapLibre() {
    if (!USE_MAPLIBRE) {
      el.mapLibreDiv.classList.add("hidden");
      el.mapFallbackNote.classList.remove("hidden");
      return;
    }

    el.canvas.classList.add("hidden");

    // Plain OSM raster tiles - no API key needed. For real production traffic beyond
    // light personal use, OSM's tile usage policy asks you to run your own tile server
    // or use a supported provider instead of hotlinking tile.openstreetmap.org.
    const style = {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "&copy; OpenStreetMap contributors",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    };

    const map = new maplibregl.Map({
      container: "map-libre",
      style,
      center: [13.4, 52.5],
      zoom: 12,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapLibreState.map = map;

    map.on("load", () => {
      for (const key of ROUTE_ORDER) {
        map.addSource(`route-${key}`, { type: "geojson", data: emptyFeatureCollection() });
        map.addLayer({
          id: `route-${key}`,
          type: "line",
          source: `route-${key}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": ROUTE_META[key].color,
            "line-width": 3,
            "line-opacity": 0.35,
          },
        });
      }
      map.addSource("lights", { type: "geojson", data: emptyFeatureCollection() });
      map.addLayer({
        id: "lights",
        type: "circle",
        source: "lights",
        paint: {
          "circle-radius": 6,
          "circle-color": "#ffd23f",
          "circle-stroke-color": "#1a1206",
          "circle-stroke-width": 1.5,
        },
      });

      mapLibreState.ready = true;
      if (mapLibreState.pendingResult) {
        const pending = mapLibreState.pendingResult;
        mapLibreState.pendingResult = null;
        drawMapLibre(pending);
      }
    });

    map.on("error", (e) => {
      console.error("MapLibre-Fehler (z. B. Kartenkacheln nicht erreichbar):", e?.error || e);
    });
  }

  function emptyFeatureCollection() {
    return { type: "FeatureCollection", features: [] };
  }

  function lineFeature(coordinates) {
    return { type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} };
  }

  function drawMapLibre(result) {
    if (!mapLibreState.ready) {
      mapLibreState.pendingResult = result;
      return;
    }

    const map = mapLibreState.map;
    const { routes, start, end } = result;
    const isNewResult = mapLibreState.lastRenderedResult !== result;

    for (const key of ROUTE_ORDER) {
      const route = routes[key];
      const source = map.getSource(`route-${key}`);
      if (!source) continue;
      source.setData(route ? lineFeature(route.coordinates) : emptyFeatureCollection());
      const isSelected = key === state.selectedRouteKey;
      map.setPaintProperty(`route-${key}`, "line-opacity", isSelected ? 1 : 0.35);
      map.setPaintProperty(`route-${key}`, "line-width", isSelected ? 5 : 3);
    }

    const selectedRoute = routes[state.selectedRouteKey];
    const lightsSource = map.getSource("lights");
    if (lightsSource) {
      const features = (selectedRoute?.trafficLights || []).map((light) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [light.lon, light.lat] },
        properties: {},
      }));
      lightsSource.setData({ type: "FeatureCollection", features });
    }

    if (isNewResult) {
      if (mapLibreState.startMarker) mapLibreState.startMarker.remove();
      if (mapLibreState.endMarker) mapLibreState.endMarker.remove();
      mapLibreState.startMarker = new maplibregl.Marker({ color: "#35c4c9" })
        .setLngLat([start.lon, start.lat])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText("Start"))
        .addTo(map);
      mapLibreState.endMarker = new maplibregl.Marker({ color: "#ff5470" })
        .setLngLat([end.lon, end.lat])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText("Ziel"))
        .addTo(map);

      const allCoords = ROUTE_ORDER.flatMap((key) => routes[key]?.coordinates || []);
      if (allCoords.length > 0) {
        const lons = allCoords.map((c) => c[0]);
        const lats = allCoords.map((c) => c[1]);
        map.fitBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 60, maxZoom: 17, duration: 400 }
        );
      }
      mapLibreState.lastRenderedResult = result;
    }
  }

  function setLiveMarker(lat, lon, follow) {
    if (USE_MAPLIBRE) {
      const map = mapLibreState.map;
      if (!map) return;
      if (!mapLibreState.liveMarker) {
        const el = document.createElement("div");
        el.className = "live-position-dot";
        mapLibreState.liveMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
      } else {
        mapLibreState.liveMarker.setLngLat([lon, lat]);
      }
      if (follow) map.easeTo({ center: [lon, lat], duration: 500 });
    } else {
      state.livePosition = { lat, lon };
      if (state.lastResult) drawCanvasMap(state.lastResult);
    }
  }

  function clearLiveMarker() {
    if (mapLibreState.liveMarker) {
      mapLibreState.liveMarker.remove();
      mapLibreState.liveMarker = null;
    }
    state.livePosition = null;
    if (!USE_MAPLIBRE && state.lastResult) drawCanvasMap(state.lastResult);
  }

  // ---------- Canvas map (fallback when real map tiles aren't available) ----------

  function resizeCanvasToDisplaySize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = el.canvas.parentElement.getBoundingClientRect();
    const width = Math.max(rect.width, 300);
    const height = Math.max(rect.height, 300);
    el.canvas.width = Math.round(width * dpr);
    el.canvas.height = Math.round(height * dpr);
    el.canvas.style.width = width + "px";
    el.canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
  }

  function drawCanvasMap(result) {
    const { width, height } = resizeCanvasToDisplaySize();
    ctx.clearRect(0, 0, width, height);

    const { routes, start, end } = result;
    const allCoords = [];
    for (const key of ROUTE_ORDER) {
      if (routes[key]) allCoords.push(...routes[key].coordinates);
    }
    if (allCoords.length === 0) return;

    const lons = allCoords.map((c) => c[0]);
    const lats = allCoords.map((c) => c[1]);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const avgLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos((avgLat * Math.PI) / 180);

    const padding = 40;
    const lonSpan = Math.max(maxLon - minLon, 1e-6);
    const latSpan = Math.max(maxLat - minLat, 1e-6);

    // Equirectangular projection, corrected for longitude compression at this latitude.
    const scaleX = (width - padding * 2) / (lonSpan * cosLat);
    const scaleY = (height - padding * 2) / latSpan;
    const scale = Math.min(scaleX, scaleY);

    const project = ([lon, lat]) => {
      const x = padding + (lon - minLon) * cosLat * scale;
      const y = height - padding - (lat - minLat) * scale;
      return [x, y];
    };

    // background - a flat "map-ish" tone, matching the light/dark app theme
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    ctx.fillStyle = prefersDark ? "#1c1c1e" : "#e5e2da";
    ctx.fillRect(0, 0, width, height);

    // draw non-selected routes first (thinner, dimmed), selected route last (on top, bold)
    const keysInDrawOrder = ROUTE_ORDER.filter((k) => routes[k] && k !== state.selectedRouteKey).concat(
      routes[state.selectedRouteKey] ? [state.selectedRouteKey] : []
    );

    for (const key of keysInDrawOrder) {
      const route = routes[key];
      const isSelected = key === state.selectedRouteKey;
      ctx.beginPath();
      route.coordinates.forEach((coord, i) => {
        const [x, y] = project(coord);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = ROUTE_META[key].color;
      ctx.globalAlpha = isSelected ? 1 : 0.35;
      ctx.lineWidth = isSelected ? 5 : 3;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // traffic light markers for the selected route
    const selectedRoute = routes[state.selectedRouteKey];
    if (selectedRoute) {
      for (const light of selectedRoute.trafficLights) {
        const [x, y] = project([light.lon, light.lat]);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffd23f";
        ctx.fill();
        ctx.strokeStyle = "#1a1206";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // start / end markers
    drawPin(project([start.lon, start.lat]), "#35c4c9", "S");
    drawPin(project([end.lon, end.lat]), "#ff5470", "Z");

    if (state.livePosition) {
      const [x, y] = project([state.livePosition.lon, state.livePosition.lat]);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#4d8dff";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawPin([x, y], color, label) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#0d151c";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#0d151c";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  }

  function renderLegend() {
    el.legend.innerHTML = `
      <div class="row"><span class="dot" style="background:${ROUTE_META.fewestLights.color}"></span> Wenigste Ampeln</div>
      <div class="row"><span class="dot" style="background:${ROUTE_META.fastest.color}"></span> Schnellste Route</div>
      <div class="row"><span class="dot" style="background:${ROUTE_META.shortest.color}"></span> Kürzeste Route</div>
      <div class="row"><span class="dot" style="background:#ffd23f"></span> Ampel (gewählte Route)</div>
    `;
  }

  window.addEventListener("resize", () => {
    if (mapLibreState.map) mapLibreState.map.resize();
    if (state.lastResult && !USE_MAPLIBRE) drawCanvasMap(state.lastResult);
  });

  // ---------- Real-time turn-by-turn navigation ----------

  const REROUTE_COOLDOWN_MS = 12000;

  const nav = {
    active: false,
    watchId: null,
    route: null, // the route currently being navigated (one of state.lastResult.routes[key])
    maneuverDistances: null,
    lastRerouteAt: 0,
    rerouting: false,
  };

  function formatDistance(meters) {
    if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function setNavRoute(route) {
    nav.route = route;
    nav.maneuverDistances = maneuverDistancesAlongRoute(route.coordinates, route.maneuvers);
  }

  el.startNavBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setNavStatus("Geolocation wird von diesem Browser nicht unterstützt.", "error");
      return;
    }
    const route = state.lastResult?.routes?.[state.selectedRouteKey];
    if (!route) return;

    setNavRoute(route);
    nav.active = true;
    el.planningSection.classList.add("hidden");
    el.navPanel.classList.remove("hidden");
    el.navBottomBar.classList.remove("hidden");
    el.legend.classList.add("hidden");
    setNavStatus("Suche GPS-Position …");

    nav.watchId = navigator.geolocation.watchPosition(onPositionUpdate, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
  });

  el.stopNavBtn.addEventListener("click", stopNavigation);

  function stopNavigation() {
    if (nav.watchId != null) navigator.geolocation.clearWatch(nav.watchId);
    nav.active = false;
    nav.watchId = null;
    nav.route = null;
    nav.maneuverDistances = null;
    clearLiveMarker();
    el.navPanel.classList.add("hidden");
    el.navBottomBar.classList.add("hidden");
    el.planningSection.classList.remove("hidden");
    el.legend.classList.remove("hidden");
  }

  function onPositionError(err) {
    setNavStatus(`GPS-Fehler: ${err.message}`, "error");
  }

  async function onPositionUpdate(position) {
    if (!nav.active || !nav.route) return;
    const { latitude: lat, longitude: lon } = position.coords;

    setLiveMarker(lat, lon, true);

    const progress = computeProgress(lat, lon, nav.route, nav.maneuverDistances);

    if (progress.hasArrived) {
      setNavStatus("");
      el.navInstruction.textContent = "🏁 Ziel erreicht!";
      el.navDistanceToManeuver.textContent = "";
      stopNavigationSoon();
      return;
    }

    if (progress.isOffRoute && !nav.rerouting) {
      const now = Date.now();
      if (now - nav.lastRerouteAt > REROUTE_COOLDOWN_MS) {
        nav.lastRerouteAt = now;
        rerouteFrom(lat, lon);
      } else {
        setNavStatus("Abweichung von der Route erkannt …");
      }
    } else if (!nav.rerouting) {
      setNavStatus("");
    }

    const maneuver = nav.route.maneuvers[progress.activeManeuverIndex];
    el.navInstruction.textContent = maneuver.instruction;
    el.navIcon.dataset.turn = maneuver.type;
    el.navDistanceToManeuver.textContent =
      progress.activeManeuverIndex === nav.route.maneuvers.length - 1
        ? `noch ${formatDistance(progress.distanceRemainingMeters)}`
        : `in ${formatDistance(progress.distanceToManeuverMeters)}`;

    el.navDistanceRemaining.textContent = formatDistance(progress.distanceRemainingMeters);
    const fractionRemaining = nav.route.distanceMeters > 0 ? progress.distanceRemainingMeters / nav.route.distanceMeters : 0;
    el.navTimeRemaining.textContent = formatDuration(nav.route.estimatedTimeSec * fractionRemaining);
  }

  function stopNavigationSoon() {
    setTimeout(() => {
      if (nav.active) stopNavigation();
    }, 4000);
  }

  async function rerouteFrom(lat, lon) {
    if (!state.toPlace) return;
    nav.rerouting = true;
    setNavStatus("Route wird neu berechnet …");
    try {
      const params = new URLSearchParams({
        fromLat: lat,
        fromLon: lon,
        toLat: state.toPlace.lat,
        toLon: state.toPlace.lon,
      });
      const res = await fetch(`/api/route?${params}`);
      const result = await parseResponse(res);
      const fallbackKey = pickDefaultRoute(result.routes);
      const newRoute = result.routes[state.selectedRouteKey] || (fallbackKey && result.routes[fallbackKey]);
      if (!newRoute) throw new Error("Keine neue Route gefunden");

      state.lastResult = result;
      setNavRoute(newRoute);
      drawMap(result);
      setNavStatus("Neue Route berechnet.", "ok");
    } catch (err) {
      setNavStatus(`Neuberechnung fehlgeschlagen: ${err.message || err}`, "error");
    } finally {
      nav.rerouting = false;
    }
  }

  function setNavStatus(text, kind) {
    el.navStatus.textContent = text;
    el.navStatus.className = "nav-status" + (kind ? " " + kind : "");
  }

  // ---------- Favorites ----------

  function loadFavorites() {
    try {
      return JSON.parse(localStorage.getItem("trafilights_favorites") || "[]");
    } catch {
      return [];
    }
  }

  function persistFavorites() {
    try {
      localStorage.setItem("trafilights_favorites", JSON.stringify(state.favorites));
    } catch {
      /* ignore storage errors (e.g. private browsing) */
    }
  }

  function renderFavorites() {
    el.favoritesList.innerHTML = "";
    for (const fav of state.favorites) {
      const li = document.createElement("li");
      li.className = "favorite-item";
      li.innerHTML = `<button type="button" class="load">★ ${fav.label}</button><button type="button" class="remove" title="Entfernen">✕</button>`;
      li.querySelector(".load").addEventListener("click", () => applyFavorite(fav));
      li.querySelector(".remove").addEventListener("click", () => {
        state.favorites = state.favorites.filter((f) => f.id !== fav.id);
        persistFavorites();
        renderFavorites();
      });
      el.favoritesList.appendChild(li);
    }
  }

  function applyFavorite(fav) {
    el.fromAddress.value = fav.from.label;
    el.toAddress.value = fav.to.label;
    state.fromPlace = fav.from;
    state.toPlace = fav.to;
    el.form.requestSubmit();
  }

  el.saveFavoriteBtn.addEventListener("click", () => {
    if (!state.fromPlace || !state.toPlace) return;
    state.favorites.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      from: state.fromPlace,
      to: state.toPlace,
      label: `${shortLabel(state.fromPlace.label)} → ${shortLabel(state.toPlace.label)}`,
    });
    persistFavorites();
    renderFavorites();
  });

  function shortLabel(label) {
    return label.split(",")[0];
  }

  // ---------- Init ----------

  initMapLibre();
  renderFavorites();
})();
