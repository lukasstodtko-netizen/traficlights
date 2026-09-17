# TrafiLights 🛵

Routenplaner für Roller-/Motorradfahrer, der die Route mit den **wenigsten Ampeln in Fahrtrichtung** findet – statt der kürzesten oder schnellsten Strecke. Hintergrund: Wer sich an Ampeln bis nach vorne durchschlängeln kann, verliert kaum Zeit durch Stau, sondern durch die reine Anzahl der Ampelstopps.

## Funktionen

- Routenberechnung mit drei Varianten zum Vergleich: **wenigste Ampeln**, **schnellste Route**, **kürzeste Route** – jeweils mit Distanz, geschätzter Fahrzeit und Ampelanzahl.
- Ampeln werden auf der Karte markiert.
- Echte Adresssuche (Nominatim) und echtes Straßennetz inkl. Ampeln (OpenStreetMap/Overpass API) – benötigt Internetzugang.
- **Echte Kartenkacheln**: Wenn im Browser Internetzugang zu OpenStreetMap-Kartendiensten besteht, zeigt die App eine echte Karte (MapLibre GL JS + OSM-Kacheln) mit Zoom/Pan, farbigen Routenlinien und anklickbaren Ampel-/Start-/Zielmarkern. Ist das nicht der Fall, fällt sie automatisch auf eine schematische Canvas-Ansicht zurück (siehe unten).
- Favoriten (z. B. die tägliche Strecke Zuhause ↔ Arbeit), gespeichert im Browser (localStorage).
- **Verkehrsregeln**: Abbiegeverbote/-gebote aus OpenStreetMap (`no_left_turn`, `only_straight_on`, …) werden respektiert – die Route schlägt keine Abbiegung vor, die dort verboten ist.
- **Echtzeit-Navigation**: Turn-by-Turn-Anweisungen mit Live-Standort (GPS), automatischer Fortschrittsanzeige und automatischer Neuberechnung, wenn du von der Route abweichst.
- **Design im Stil von Apple Maps**: Vollbild-Karte als Hintergrund, ein schwebendes Glas-Panel (Blur-Effekt) für Suche/Favoriten/Routenoptionen – auf dem Desktop als Karte oben links, auf dem Handy als Bottom-Sheet mit Zieh-Griff. Die Turn-by-Turn-Anweisung erscheint als dunkles Banner oben (mit rotierendem Abbiege-Pfeil), Distanz/Fahrzeit unten – inkl. automatischem Hell-/Dunkelmodus je nach Systemeinstellung.

## Architektur

Bewusst **ohne Build-Tools und ohne externe npm-Pakete** umgesetzt:

- `server/` – Node.js-Backend, nur mit Node-Bordmitteln (`node:http`, `fetch`, …), kein `npm install` nötig.
  - `overpass.js` – lädt Straßen, Ampeln (`highway=traffic_signals`) und Abbiegeverbote (`relation[type=restriction]`) aus OpenStreetMap via Overpass API.
  - `geocode.js` – Adresssuche via Nominatim.
  - `graph.js` – baut aus den OSM-Daten einen gerichteten Graphen (berücksichtigt Einbahnstraßen), entscheidet pro Kreuzung, ob eine Ampel für die jeweilige Fahrtrichtung überhaupt relevant ist, und baut die Abbiegeverbote-Tabelle auf (siehe unten).
  - `routing.js` – Dijkstra-Routing; die "wenigste Ampeln"-Variante gewichtet jeden Ampel-Knoten mit einer sehr hohen Zusatzkoste, sodass zuerst die Ampelanzahl und erst danach die Distanz minimiert wird (lexikografische Optimierung). Der Zustand pro Dijkstra-Schritt ist (Knoten, angekommen über welche Straße) statt nur (Knoten), damit Abbiegeverbote korrekt greifen können. Erzeugt außerdem Turn-by-Turn-Anweisungen (`maneuvers`) pro Route.
  - `sampleData.js` – synthetisches Straßennetz, ausschließlich als Fixture für die automatisierten Tests (`test/routing.test.js`) genutzt, nicht Teil der laufenden App.
  - `index.js` – HTTP-Server: API-Endpunkte + Ausliefern des Frontends.
- `public/` – Frontend als reines HTML/CSS/JavaScript (keine Frameworks, kein Build-Schritt; `app.js` läuft als ES-Modul).
  - `app.js` enthält zwei Karten-Renderer: eine echte Karte via **MapLibre GL JS** (aus einem CDN geladen, OSM-Rasterkacheln als Kartenhintergrund) und eine Canvas-Ansicht als Fallback. Außerdem die Echtzeit-Navigation (siehe unten).
  - `nav-math.js` – reine, abhängigkeitsfreie Geometriefunktionen für die Navigation (Position auf Route projizieren, Fortschritt/Abweichung berechnen) – bewusst von der DOM-/Geolocation-Logik in `app.js` getrennt, damit sie sich mit Node testen lassen.

### Wieso zwei Karten-Renderer (MapLibre + Canvas-Fallback)?

`index.html` lädt MapLibre GL JS per `<script>`-Tag von einem CDN (unpkg). Schlägt das fehl (kein Internetzugang, Firmen-/Schul-Proxy blockiert CDN oder Kartenkacheln, o. Ä.), erkennt `app.js` das automatisch (`USE_MAPLIBRE`-Check) und zeichnet stattdessen die Route schematisch auf einem `<canvas>` – ohne echtes Kartenbild, aber mit denselben Daten und Interaktionen. Ein kleiner Hinweistext auf der Karte zeigt an, welcher Modus aktiv ist.

Diese Zwei-Wege-Lösung wurde nötig, weil die Entwicklungs-Sandbox, in der dieses Projekt gebaut wurde, jeglichen Zugriff auf npm-Registry, CDNs und Kartendienste (Overpass, Nominatim, Tile-Server) per Netzwerk-Policy blockiert – React/Vite/MapLibre ließen sich dort nicht installieren, und selbst ein per CDN eingebundenes MapLibre konnte dort keine echten Kacheln laden. Der MapLibre-Codepfad wurde stattdessen mit einer lokalen Mock-Implementierung von `maplibregl` verifiziert (Kartenerstellung, Routen-/Ampel-Layer, `fitBounds`-Verhalten) – **auf einem Rechner mit normalem Internetzugang solltest du die echte Kartenansicht trotzdem einmal selbst gegenprüfen**, bevor du dich darauf verlässt.

Hinweis zu den Kartenkacheln: Es wird direkt `tile.openstreetmap.org` verwendet (keine Kosten, kein API-Key). Für mehr als sehr gelegentliche private Nutzung verlangt die [OSM-Tile-Nutzungsrichtlinie](https://operations.osmfoundation.org/policies/tiles/) einen eigenen Tile-Server oder einen unterstützten Anbieter (z. B. MapTiler, Stadia Maps) – für dieses Prototyp-/Pendel-Tool ist die direkte Nutzung in Ordnung.

### Richtungsabhängige Ampelzählung

Der ganze Sinn der App ist, nur die Ampeln zu zählen, die für die eigene Fahrtrichtung wirklich ausschlaggebend sind. `graph.js` prüft dafür pro Kreuzungsknoten:

1. Trägt OpenStreetMap für den Knoten `traffic_signals:direction` (oder ersatzweise `direction`) mit dem Wert `forward`/`backward`, zählt die Ampel nur für die dazu passende Fahrtrichtung entlang des Straßenverlaufs (die jeweils andere Fahrtrichtung sieht diese Ampel gar nicht erst).
2. Ist dort stattdessen eine Kompass-Gradzahl hinterlegt (z. B. `direction=70`), wird die tatsächliche Peilung der Anfahrt berechnet und nur gezählt, wenn sie grob (±90°) zur Ampel-Ausrichtung passt.
3. Ist gar keine Richtung getaggt (der häufigste Fall – eine Kreuzung mit einem gemeinsamen Ampel-Knoten für alle Anfahrten), zählt die Ampel weiterhin für jede Fahrtrichtung, die durch diesen Knoten fährt – das ist für die meisten einfachen Kreuzungen korrekt, da dort ohnehin jede Anfahrt ihre eigene Rotphase hat.

Das deckt die Fälle ab, in denen OSM tatsächlich Richtungsinformationen pflegt (z. B. getrennte Ampeln pro Fahrtrichtung auf einer Kreuzung, oder eine Ampel, die nur eine Abbiegespur betrifft); wo OSM keine Richtung hinterlegt hat, bleibt es bei der bisherigen, i. d. R. korrekten Annahme "ein Knoten = eine Ampel für alle Anfahrten".

### Verkehrsregeln: Abbiegeverbote/-gebote

Die Route respektiert Abbiegeverbote und -gebote aus OpenStreetMap (`relation[type=restriction]`, z. B. `no_left_turn`, `no_u_turn`, `only_straight_on`). Technisch bedeutet das: Der Dijkstra-Zustand ist nicht nur "an welchem Knoten", sondern "an welchem Knoten, angekommen über welche Straße" – nur so lässt sich prüfen, ob die nächste Abbiegung von genau dieser Anfahrt aus verboten ist. Ohne diese Erweiterung könnte die App Routen vorschlagen, die zwar kürzer/ampelärmer wären, aber real verboten sind (und die man als Fahrer:in so gar nicht fahren dürfte).

Einschränkungen: Ausgewertet wird die einfache, häufigste Form (`from`-Way → `via`-**Knoten** → `to`-Way). Restriktionen über einen `via`-**Weg** (seltene, komplexe Mehrspur-Kreuzungen) sowie fahrzeugspezifische/bedingte Varianten (`restriction:motorcycle`, `restriction:conditional`) werden nicht ausgewertet – hier gilt weiterhin die normale (unbeschränkte) Kantenlogik.

### Echtzeit-Navigation

Nach der Routenberechnung kann per **"▶ Navigation starten"** eine Turn-by-Turn-Führung gestartet werden:

- Nutzt `navigator.geolocation.watchPosition()` für den Live-Standort (Browser-Berechtigung erforderlich; funktioniert auf `localhost` auch ohne HTTPS, sonst nur über HTTPS).
- Die aktuelle Position wird auf die Route projiziert (`public/nav-math.js`), daraus werden abgeleitet: die aktuell relevante Anweisung, Distanz bis zur nächsten Abbiegung, Distanz/Zeit bis zum Ziel.
- Weicht die Position mehr als 40 m von der Route ab, wird automatisch (mit 12 s Cooldown, um nicht bei jedem GPS-Wackler neu zu rechnen) eine neue Route von der aktuellen Position zum ursprünglichen Ziel berechnet.
- Die Ankunftserkennung prüft die direkte Distanz zum Zielpunkt (nicht die Streckenprojektion) – sonst könnte eine Position weit neben der Route fälschlich als "angekommen" gelten, weil die Projektion aufs Streckenende einrastet (das ist als Regressionstest in `nav-math.test.js` festgehalten).
- Turn-by-Turn-Anweisungen (`routing.js`, `maneuvers`) entstehen aus Straßennamen-Wechseln entlang der Route plus der berechneten Abbiege-Peilung (leicht/normal/scharf links bzw. rechts) – wie bei den meisten einfachen Routenplanern, keine spurgenaue Führung.

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
- Die API-Routen laufen dort als **Netlify Functions** (`netlify/functions/*.mts`) statt als Dauer-Prozess – jede Function importiert dieselbe Logik aus `server/src/api.js`, die auch der lokale Node-Server nutzt (`getGeocodeResults`, `getLiveRoute`). Dadurch verhalten sich lokaler Server und Netlify-Deployment identisch, ohne Code doppelt zu pflegen.
- Die Functions sind über `config.path` exakt auf dieselben Pfade gemappt, die das Frontend ohnehin aufruft (`/api/geocode`, `/api/route`, `/api/health`) – am Frontend musste dafür nichts geändert werden.
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

Reine Node-Core-Tests (keine Abhängigkeiten nötig), prüfen Graphaufbau, Einbahnstraßen-Logik, Ampel-Minimierung, Abbiegeverbote/-gebote, Turn-by-Turn-Anweisungen und die Navigations-Fortschrittsberechnung:

```bash
cd server
npm test
```

## Bekannte Grenzen / mögliche nächste Schritte

- **Ampel-Richtungslogik**: Wird über `traffic_signals:direction`/`direction` in OSM ausgewertet (siehe oben). Wo OSM keine Richtung hinterlegt hat (der Normalfall bei einfachen Kreuzungen), zählt die Ampel weiterhin für jede Fahrtrichtung – das ist in aller Regel korrekt, könnte aber in seltenen, nicht getaggten Sonderfällen (z. B. eine Ampel, die nur eine einzelne Abbiegespur regelt) zu viel zählen.
- **Kartendarstellung**: Der echte Karten-Renderer (MapLibre + OSM-Kacheln) wurde in dieser Sandbox nur über eine Mock-Bibliothek getestet, nicht mit echten Kartenkacheln (siehe oben) – bitte auf deinem eigenen Rechner einmal gegenprüfen.
- **Abbiegeverbote**: Nur `via`-Knoten-Restriktionen werden ausgewertet, keine `via`-Weg-Restriktionen oder fahrzeugspezifischen/bedingten Varianten (siehe oben).
- **Echtzeit-Navigation**: Die komplette Navigations-UI (Live-Marker, Fortschritt, Neuberechnung bei Abweichung) wurde in dieser Sandbox nur mit gemockter Geolocation und gemockten API-Antworten per Playwright getestet, nicht mit echtem GPS/echten Overpass-Daten unterwegs – bitte auf deinem Rollerl/Motorrad einmal gegenprüfen, bevor du dich blind darauf verlässt. Keine spurgenaue Führung (siehe oben).
- **Bounding-Box-Größe**: Für sehr lange Pendelstrecken (>~30 km) ist die Overpass-Abfrage ggf. groß/langsam; die Fläche ist aktuell gedeckelt.
