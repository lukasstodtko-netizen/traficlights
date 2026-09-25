import { maneuverDistancesAlongRoute, computeProgress, bearingDegrees, haversineMeters } from "/nav-math.js";

(() => {
  // iOS Safari ignores `user-scalable=no` in the viewport meta tag for accessibility
  // reasons and still lets the page itself be pinch-zoomed via its own "gesture" events.
  // Block those specifically so the layout always stays edge-to-edge. This is unrelated
  // to MapLibre's own touch handling for pinch-zooming the map, which is untouched.
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());

  const ROUTE_META = {
    fewestLights: { label: "Fewest lights", color: "#ff5470" },
    fastest: { label: "Fastest route", color: "#2ec4b6" },
    shortest: { label: "Shortest route", color: "#7c9cff" },
  };
  const ROUTE_ORDER = ["fewestLights", "fastest", "shortest"];

  const state = {
    fromPlace: null, // { lat, lon, label }
    toPlace: null,
    lastResult: null, // { start, end, routes }
    selectedRouteKey: "fewestLights",
    favorites: loadFavorites(),
    livePosition: null, // { lat, lon } - kept up to date whenever geolocation is available
    heading: 0, // degrees clockwise from north, updated by updateHeading()
    lastPositionForHeading: null,
  };

  const el = {
    planningSection: document.getElementById("planning-section"),
    panelHandle: document.getElementById("panel-handle"),
    panelToggleBtn: document.getElementById("panel-toggle-btn"),
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

  // ---------- Collapsible panel (tap the handle or the chevron to see more of the map) ----------

  function togglePanelCollapsed() {
    const collapsed = el.planningSection.classList.toggle("collapsed");
    const label = collapsed ? "Show the route panel" : "Show more of the map";
    el.panelHandle.setAttribute("aria-label", label);
    el.panelToggleBtn.setAttribute("aria-label", label);
  }
  el.panelHandle.addEventListener("click", togglePanelCollapsed);
  el.panelToggleBtn.addEventListener("click", togglePanelCollapsed);

  // Real map tiles (MapLibre GL JS + OSM raster tiles) are loaded from a CDN in index.html.
  // If that CDN or the tile servers can't be reached, we fall back to the built-in Canvas
  // map further below so the app still works (e.g. offline, or behind a restrictive proxy).
  const USE_MAPLIBRE = typeof window.maplibregl !== "undefined" && !window.__maplibreLoadFailed;

  // ---------- Live address autocomplete ----------

  const CURRENT_LOCATION_ICON = `
    <svg class="suggestion-current-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;

  function setupAutocomplete(input, list, onSelect) {
    let debounceTimer = null;
    let currentResults = [];

    function showCurrentLocationOption() {
      list.innerHTML = "";
      if (!state.livePosition) return;
      const li = document.createElement("li");
      li.className = "suggestion-current-location";
      li.innerHTML = `${CURRENT_LOCATION_ICON}<span class="suggestion-primary">Current location</span>`;
      li.addEventListener("click", () => {
        input.value = "Current location";
        list.innerHTML = "";
        onSelect({ lat: state.livePosition.lat, lon: state.livePosition.lon, label: "Current location" });
      });
      list.appendChild(li);
    }

    input.addEventListener("focus", () => {
      if (input.value.trim().length === 0) showCurrentLocationOption();
    });

    input.addEventListener("input", () => {
      onSelect(null); // typing invalidates a previous selection
      const query = input.value.trim();
      clearTimeout(debounceTimer);
      if (query.length === 0) {
        showCurrentLocationOption();
        return;
      }
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
            const primary = document.createElement("div");
            primary.className = "suggestion-primary";
            primary.textContent = r.primary || r.displayName;
            li.appendChild(primary);
            if (r.secondary) {
              const secondary = document.createElement("div");
              secondary.className = "suggestion-secondary";
              secondary.textContent = r.secondary;
              li.appendChild(secondary);
            }
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
    setStatus("Calculating route…");
    el.calcBtn.disabled = true;
    el.saveFavoriteBtn.disabled = true;

    try {
      if (!state.fromPlace || !state.toPlace) {
        throw new Error("Please select both a starting point and destination from the suggestions.");
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
      setStatus("Route calculated.", "ok");
      el.saveFavoriteBtn.disabled = false;
    } catch (err) {
      setStatus(err.message || "Unknown error", "error");
      el.results.classList.add("hidden");
    } finally {
      el.calcBtn.disabled = false;
    }
  });

  async function parseResponse(res) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
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
        <div class="lights-count">${route.trafficLightCount}<small>lights</small></div>
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
      console.error("MapLibre error (e.g. map tiles unavailable):", e?.error || e);
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
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText("Destination"))
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

  // A Google-Maps-style heading arrow instead of a plain dot, so the user's own
  // position also shows which way they're facing/moving.
  const LIVE_ARROW_SVG = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2 L20 20 L12 15.5 L4 20 Z" fill="#0a84ff" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round" />
    </svg>`;

  // lat/lon place the marker; follow/zoom/bearing (all optional) drive the camera:
  // follow recenters the map on the fix, zoom forces a zoom level (e.g. NAV_ZOOM
  // while navigating), bearing rotates both the arrow icon and - only when
  // following - the map itself to match the current direction of travel.
  function setLiveMarker(lat, lon, { follow = false, zoom, bearing } = {}) {
    state.livePosition = { lat, lon };
    if (USE_MAPLIBRE) {
      const map = mapLibreState.map;
      if (!map) return;
      if (!mapLibreState.liveMarker) {
        const arrow = document.createElement("div");
        arrow.className = "live-position-arrow";
        arrow.innerHTML = `<div class="live-position-pulse"></div>${LIVE_ARROW_SVG}`;
        mapLibreState.liveMarker = new maplibregl.Marker({
          element: arrow,
          rotationAlignment: "map",
          pitchAlignment: "map",
        })
          .setLngLat([lon, lat])
          .addTo(map);
      } else {
        mapLibreState.liveMarker.setLngLat([lon, lat]);
      }
      if (typeof bearing === "number" && typeof mapLibreState.liveMarker.setRotation === "function") {
        mapLibreState.liveMarker.setRotation(bearing);
      }
      if (follow) {
        const easeOptions = { center: [lon, lat], zoom: zoom ?? map.getZoom(), duration: 600 };
        if (typeof bearing === "number") easeOptions.bearing = bearing;
        map.easeTo(easeOptions);
      }
    } else if (state.lastResult) {
      drawCanvasMap(state.lastResult);
    } else {
      drawCanvasLiveOnly(lat, lon);
    }
  }

  // Priority: real device heading from the GPS fix when available; otherwise, the
  // bearing between the last fix and this one, once we've moved far enough for
  // that to be meaningful (avoids the arrow spinning randomly from GPS jitter
  // while stationary). Falls back to the previous heading if neither applies yet.
  const MIN_HEADING_UPDATE_DISTANCE_M = 3;

  function updateHeading(position, lat, lon) {
    const gpsHeading = position?.coords?.heading;
    if (typeof gpsHeading === "number" && !Number.isNaN(gpsHeading)) {
      state.heading = gpsHeading;
    } else if (state.lastPositionForHeading) {
      const moved = haversineMeters(state.lastPositionForHeading.lat, state.lastPositionForHeading.lon, lat, lon);
      if (moved > MIN_HEADING_UPDATE_DISTANCE_M) {
        state.heading = bearingDegrees(state.lastPositionForHeading.lat, state.lastPositionForHeading.lon, lat, lon);
      }
    }
    state.lastPositionForHeading = { lat, lon };
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

  function canvasBackgroundColor() {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "#1c1c1e" : "#e5e2da";
  }

  // The user's own position on the Canvas fallback map: a heading-facing arrow,
  // matching the MapLibre live marker. The canvas map itself stays north-up (no
  // camera to rotate here, unlike MapLibre), but the arrow still points the right
  // way using the same state.heading tracked in updateHeading().
  function drawLiveArrow(x, y, headingDeg) {
    const size = 10;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((headingDeg * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.62, size * 0.8);
    ctx.lineTo(0, size * 0.35);
    ctx.lineTo(-size * 0.62, size * 0.8);
    ctx.closePath();
    ctx.fillStyle = "#0a84ff";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  // Shown before any route has been calculated yet: just the live position, centered,
  // so the map isn't blank while the schematic fallback has nothing else to draw.
  function drawCanvasLiveOnly(lat, lon) {
    const { width, height } = resizeCanvasToDisplaySize();
    ctx.fillStyle = canvasBackgroundColor();
    ctx.fillRect(0, 0, width, height);
    drawLiveArrow(width / 2, height / 2, state.heading);
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
    ctx.fillStyle = canvasBackgroundColor();
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
    drawPin(project([end.lon, end.lat]), "#ff5470", "D");

    if (state.livePosition) {
      const [x, y] = project([state.livePosition.lon, state.livePosition.lat]);
      drawLiveArrow(x, y, state.heading);
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
      <div class="row"><span class="dot" style="background:${ROUTE_META.fewestLights.color}"></span> Fewest lights</div>
      <div class="row"><span class="dot" style="background:${ROUTE_META.fastest.color}"></span> Fastest route</div>
      <div class="row"><span class="dot" style="background:${ROUTE_META.shortest.color}"></span> Shortest route</div>
      <div class="row"><span class="dot" style="background:#ffd23f"></span> Traffic light (selected route)</div>
    `;
  }

  window.addEventListener("resize", () => {
    if (mapLibreState.map) mapLibreState.map.resize();
    if (state.lastResult && !USE_MAPLIBRE) drawCanvasMap(state.lastResult);
  });

  // ---------- Live location (always on) + real-time turn-by-turn navigation ----------

  const REROUTE_COOLDOWN_MS = 12000;
  const INITIAL_LOCATION_ZOOM = 15;
  const NAV_ZOOM = 17;

  const nav = {
    active: false,
    route: null, // the route currently being navigated (one of state.lastResult.routes[key])
    maneuverDistances: null,
    lastRerouteAt: 0,
    rerouting: false,
  };
  let hasCenteredOnUser = false;

  function formatDistance(meters) {
    if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function setNavRoute(route) {
    nav.route = route;
    nav.maneuverDistances = maneuverDistancesAlongRoute(route.coordinates, route.maneuvers);
  }

  // A single persistent geolocation watch, started once at app init, powers both the
  // always-visible "you are here" dot and (when active) turn-by-turn navigation - so
  // there's only ever one GPS subscription running, not a separate one per feature.
  function startLiveLocationTracking() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(handleGeolocationUpdate, handleGeolocationError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 20000,
    });
  }

  function handleGeolocationUpdate(position) {
    const { latitude: lat, longitude: lon } = position.coords;
    updateHeading(position, lat, lon);
    if (nav.active) {
      onPositionUpdate(position);
      return;
    }
    // The first fix we ever get (before any route exists) centers the map on the
    // user once; afterwards we leave the view alone so we don't fight the user
    // panning/zooming around while just browsing. The heading arrow itself still
    // updates on every fix regardless (handled by setLiveMarker above).
    const shouldCenter = !hasCenteredOnUser && !state.lastResult;
    setLiveMarker(lat, lon, { follow: shouldCenter, zoom: shouldCenter ? INITIAL_LOCATION_ZOOM : undefined, bearing: state.heading });
    if (shouldCenter) hasCenteredOnUser = true;
  }

  function handleGeolocationError(err) {
    if (nav.active) onPositionError(err);
    // Otherwise: live location is a nice-to-have outside of active navigation, so a
    // denied/unavailable permission here fails silently rather than nagging the user.
  }

  el.startNavBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setNavStatus("Geolocation is not supported by this browser.", "error");
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
    setNavStatus("Finding GPS position…");

    if (USE_MAPLIBRE && mapLibreState.map) {
      const center = state.livePosition
        ? [state.livePosition.lon, state.livePosition.lat]
        : route.coordinates[0];
      mapLibreState.map.easeTo({ center, zoom: NAV_ZOOM, duration: 800 });
    }

    // The persistent geolocation watch (started at app init) only fires again once
    // the position actually changes - if we already have a fix from before nav
    // started, use it right away instead of leaving the banner on "Finding GPS
    // position…" until the rider physically moves.
    if (state.livePosition) {
      updateNavigationForPosition(state.livePosition.lat, state.livePosition.lon);
    }
  });

  el.stopNavBtn.addEventListener("click", stopNavigation);

  function stopNavigation() {
    nav.active = false;
    nav.route = null;
    nav.maneuverDistances = null;
    el.navPanel.classList.add("hidden");
    el.navBottomBar.classList.add("hidden");
    el.planningSection.classList.remove("hidden");
    el.legend.classList.remove("hidden");
    // Back to a normal, north-up map once turn-by-turn ends.
    if (USE_MAPLIBRE && mapLibreState.map) {
      mapLibreState.map.easeTo({ bearing: 0, duration: 500 });
    }
  }

  function onPositionError(err) {
    setNavStatus(`GPS error: ${err.message}`, "error");
  }

  function onPositionUpdate(position) {
    updateNavigationForPosition(position.coords.latitude, position.coords.longitude);
  }

  function updateNavigationForPosition(lat, lon) {
    if (!nav.active || !nav.route) return;

    // Keep the camera zoomed in and rotated so "up" always matches the direction
    // of travel, like Google Maps' turn-by-turn view.
    setLiveMarker(lat, lon, { follow: true, zoom: NAV_ZOOM, bearing: state.heading });

    const progress = computeProgress(lat, lon, nav.route, nav.maneuverDistances);

    if (progress.hasArrived) {
      setNavStatus("");
      el.navInstruction.textContent = "Arrived!";
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
        setNavStatus("Drifted from the route…");
      }
    } else if (!nav.rerouting) {
      setNavStatus("");
    }

    const maneuver = nav.route.maneuvers[progress.activeManeuverIndex];
    el.navInstruction.textContent = maneuver.instruction;
    el.navIcon.dataset.turn = maneuver.type;
    el.navDistanceToManeuver.textContent =
      progress.activeManeuverIndex === nav.route.maneuvers.length - 1
        ? `${formatDistance(progress.distanceRemainingMeters)} to go`
        : `In ${formatDistance(progress.distanceToManeuverMeters)}`;

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
    setNavStatus("Recalculating route…");
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
      if (!newRoute) throw new Error("No new route found");

      state.lastResult = result;
      setNavRoute(newRoute);
      drawMap(result);
      setNavStatus("New route calculated.", "ok");
    } catch (err) {
      setNavStatus(`Recalculation failed: ${err.message || err}`, "error");
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
      return JSON.parse(localStorage.getItem("smoothride_favorites") || "[]");
    } catch {
      return [];
    }
  }

  function persistFavorites() {
    try {
      localStorage.setItem("smoothride_favorites", JSON.stringify(state.favorites));
    } catch {
      /* ignore storage errors (e.g. private browsing) */
    }
  }

  function renderFavorites() {
    el.favoritesList.innerHTML = "";
    for (const fav of state.favorites) {
      const li = document.createElement("li");
      li.className = "favorite-item";
      li.innerHTML = `<button type="button" class="load">★ ${fav.label}</button><button type="button" class="remove" title="Remove">✕</button>`;
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
  startLiveLocationTracking();
})();
