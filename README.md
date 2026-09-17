# TrafiLights 🛵

Routenplaner für Roller-/Motorradfahrer, der die Route mit den **wenigsten Ampeln in Fahrtrichtung** findet – statt der kürzesten oder schnellsten Strecke. Hintergrund: Wer sich an Ampeln bis nach vorne durchschlängeln kann, verliert kaum Zeit durch Stau, sondern durch die reine Anzahl der Ampelstopps.

## Funktionen

- Routenberechnung mit drei Varianten zum Vergleich: **wenigste Ampeln**, **schnellste Route**, **kürzeste Route** – jeweils mit Distanz, geschätzter Fahrzeit und Ampelanzahl.
- Ampeln werden auf der Karte markiert.
- **Demo-Modus**: eine kleine synthetische Beispielstadt, läuft komplett offline, kein Internetzugang nötig – ideal zum sofortigen Ausprobieren.
- **Live-Modus**: echte Adresssuche (Nominatim) und echtes Straßennetz inkl. Ampeln (OpenStreetMap/Overpass API) – benötigt Internetzugang.
- **Echte Kartenkacheln**: Wenn im Browser Internetzugang zu OpenStreetMap-Kartendiensten besteht, zeigt die App eine echte Karte (MapLibre GL JS + OSM-Kacheln) mit Zoom/Pan, farbigen Routenlinien und anklickbaren Ampel-/Start-/Zielmarkern. Ist das nicht der Fall, fällt sie automatisch auf eine schematische Canvas-Ansicht zurück (siehe unten).
- Favoriten (z. B. die tägliche Strecke Zuhause ↔ Arbeit), gespeichert im Browser (localStorage).

## Architektur

Bewusst **ohne Build-Tools und ohne externe npm-Pakete** umgesetzt:

- `server/` – Node.js-Backend, nur mit Node-Bordmitteln (`node:http`, `fetch`, …), kein `npm install` nötig.
  - `overpass.js` – lädt Straßen & Ampeln (`highway=traffic_signals`) aus OpenStreetMap via Overpass API.
  - `geocode.js` – Adresssuche via Nominatim.
  - `graph.js` – baut aus den OSM-Daten einen gerichteten Graphen (berücksichtigt Einbahnstraßen).
  - `routing.js` – Dijkstra-Routing; die "wenigste Ampeln"-Variante gewichtet jeden Ampel-Knoten mit einer sehr hohen Zusatzkoste, sodass zuerst die Ampelanzahl und erst danach die Distanz minimiert wird (lexikografische Optimierung).
  - `sampleData.js` / `demo.js` – die synthetische Demo-Stadt für den Offline-Modus.
  - `index.js` – HTTP-Server: API-Endpunkte + Ausliefern des Frontends.
- `public/` – Frontend als reines HTML/CSS/JavaScript (keine Frameworks, kein Build-Schritt).
  - `app.js` enthält zwei Karten-Renderer: eine echte Karte via **MapLibre GL JS** (aus einem CDN geladen, OSM-Rasterkacheln als Kartenhintergrund) und eine Canvas-Ansicht als Fallback.

### Wieso zwei Karten-Renderer (MapLibre + Canvas-Fallback)?

`index.html` lädt MapLibre GL JS per `<script>`-Tag von einem CDN (unpkg). Schlägt das fehl (kein Internetzugang, Firmen-/Schul-Proxy blockiert CDN oder Kartenkacheln, o. Ä.), erkennt `app.js` das automatisch (`USE_MAPLIBRE`-Check) und zeichnet stattdessen die Route schematisch auf einem `<canvas>` – ohne echtes Kartenbild, aber mit denselben Daten und Interaktionen. Ein kleiner Hinweistext auf der Karte zeigt an, welcher Modus aktiv ist.

Diese Zwei-Wege-Lösung wurde nötig, weil die Entwicklungs-Sandbox, in der dieses Projekt gebaut wurde, jeglichen Zugriff auf npm-Registry, CDNs und Kartendienste (Overpass, Nominatim, Tile-Server) per Netzwerk-Policy blockiert – React/Vite/MapLibre ließen sich dort nicht installieren, und selbst ein per CDN eingebundenes MapLibre konnte dort keine echten Kacheln laden. Der MapLibre-Codepfad wurde stattdessen mit einer lokalen Mock-Implementierung von `maplibregl` verifiziert (Kartenerstellung, Routen-/Ampel-Layer, `fitBounds`-Verhalten) – **auf einem Rechner mit normalem Internetzugang solltest du die echte Kartenansicht trotzdem einmal selbst gegenprüfen**, bevor du dich darauf verlässt.

Hinweis zu den Kartenkacheln: Es wird direkt `tile.openstreetmap.org` verwendet (keine Kosten, kein API-Key). Für mehr als sehr gelegentliche private Nutzung verlangt die [OSM-Tile-Nutzungsrichtlinie](https://operations.osmfoundation.org/policies/tiles/) einen eigenen Tile-Server oder einen unterstützten Anbieter (z. B. MapTiler, Stadia Maps) – für dieses Prototyp-/Pendel-Tool ist die direkte Nutzung in Ordnung.

## Starten

Kein `npm install` erforderlich (keine externen Abhängigkeiten):

```bash
cd server
node src/index.js
```

Dann im Browser öffnen: <http://localhost:3001>

Für automatischen Neustart bei Änderungen:

```bash
npm run dev -w server   # oder: node --watch server/src/index.js
```

## Deployment (Netlify)

Die App ist zusätzlich für Netlify vorbereitet:

- `public/` wird als statische Website ausgeliefert (`netlify.toml` → `publish = "public"`).
- Die vier API-Routen laufen dort als **Netlify Functions** (`netlify/functions/*.mts`) statt als Dauer-Prozess – jede Function importiert dieselbe Logik aus `server/src/api.js`, die auch der lokale Node-Server nutzt (`getGeocodeResults`, `getLiveRoute`, `getDemoPlacesList`, `getDemoRoute`). Dadurch verhalten sich lokaler Server und Netlify-Deployment identisch, ohne Code doppelt zu pflegen.
- Die Functions sind über `config.path` exakt auf dieselben Pfade gemappt, die das Frontend ohnehin aufruft (`/api/geocode`, `/api/route`, `/api/demo/places`, `/api/demo/route`, `/api/health`) – am Frontend musste dafür nichts geändert werden.
- `package.json` (Repo-Root) enthält `@netlify/functions` als Dev-Dependency für die TypeScript-Typen der Functions.

**Live-Route auf Netlify beachten**: Serverlose Functions haben ein Zeitlimit (üblicherweise 10 s). `netlify/functions/route.mts` bricht die Overpass-Abfrage deshalb nach 9 s sauber mit einer Fehlermeldung ab, statt dass die Plattform die Function hart killt. Für sehr große Bounding-Boxen (sehr lange Pendelstrecken) kann das knapp werden.

### Ein Projekt wurde bereits angelegt

Über die Netlify-Tools wurde das Projekt **`trafilights`** erstellt (<https://app.netlify.com/projects/trafilights>, spätere URL: `https://trafilights.netlify.app`). Der eigentliche Deploy (Hochladen + Build) ließ sich aus dieser Entwicklungs-Sandbox heraus **nicht** auslösen, da dafür sowohl `npx` (npm-Registry) als auch ein Netlify-Proxy-Endpunkt erreichbar sein müssten – beides ist hier per Netzwerk-Policy blockiert (siehe oben).

**So schließt du den Deploy ab (einmalig, 2 Minuten):**

1. Im Netlify-Dashboard das Projekt `trafilights` öffnen → **Site configuration → Build & deploy → Continuous deployment** → **Link repository**.
2. `lukasstodtko-netizen/traficlights` auswählen, Branch `claude/sharp-mayer-13byde` (oder den aktuell gewünschten Hauptbranch).
3. Build-Einstellungen sind bereits über `netlify.toml` festgelegt (kein Build-Befehl nötig, nur „Publish“). Deploy auslösen.

Ab dann deployt Netlify automatisch bei jedem Push. Alternativ, falls du lieber per CLI deployst (von einem Rechner mit Internetzugang, nicht aus dieser Sandbox):

```bash
npx -y netlify-cli deploy --prod --site df9ff3a5-eeb4-4a12-b797-570836b0b46e
```

## Tests

Reine Node-Core-Tests (keine Abhängigkeiten nötig), prüfen Graphaufbau, Einbahnstraßen-Logik und dass die Ampel-Minimierung tatsächlich weniger Ampeln liefert:

```bash
cd server
npm test
```

## Bekannte Grenzen / mögliche nächste Schritte

- **Ampel-Richtungslogik**: OpenStreetMap taggt Ampeln i. d. R. als einzelnen Knoten pro Kreuzung, nicht separat pro Fahrtrichtung. Diese App zählt eine Ampel, sobald die berechnete Route über diesen Knoten fährt – das ist für die allermeisten Kreuzungen korrekt, bildet aber keine Fälle ab, in denen OSM tatsächlich getrennte Signal-Knoten pro Richtung/Spur enthält.
- **Kartendarstellung**: Der echte Karten-Renderer (MapLibre + OSM-Kacheln) wurde in dieser Sandbox nur über eine Mock-Bibliothek getestet, nicht mit echten Kartenkacheln (siehe oben) – bitte auf deinem eigenen Rechner einmal gegenprüfen.
- **Turn-by-Turn-Navigation** ist nicht implementiert; die berechnete Route lässt sich aber leicht an eine bestehende Navi-App übergeben (Start-/Zielkoordinaten liegen vor).
- **Bounding-Box-Größe**: Für sehr lange Pendelstrecken (>~30 km) ist die Overpass-Abfrage ggf. groß/langsam; die Fläche ist aktuell gedeckelt.
