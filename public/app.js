(() => {
  "use strict";

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
  };

  const el = {
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

    // background
    ctx.fillStyle = "#0d151c";
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
