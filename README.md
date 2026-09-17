# TrafiLights 🛵

Routenplaner für Roller-/Motorradfahrer, der die Route mit den **wenigsten Ampeln in Fahrtrichtung** findet – statt der kürzesten oder schnellsten Strecke. Hintergrund: Wer sich an Ampeln bis nach vorne durchschlängeln kann, verliert kaum Zeit durch Stau, sondern durch die reine Anzahl der Ampelstopps.

## Funktionen

- Routenberechnung mit drei Varianten zum Vergleich: **wenigste Ampeln**, **schnellste Route**, **kürzeste Route** – jeweils mit Distanz, geschätzter Fahrzeit und Ampelanzahl.
- Ampeln werden auf der Karte markiert.
- **Demo-Modus**: eine kleine synthetische Beispielstadt, läuft komplett offline, kein Internetzugang nötig – ideal zum sofortigen Ausprobieren.
- **Live-Modus**: echte Adresssuche (Nominatim) und echtes Straßennetz inkl. Ampeln (OpenStreetMap/Overpass API) – benötigt Internetzugang.
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
- `public/` – Frontend als reines HTML/CSS/JavaScript (keine Frameworks), inkl. Canvas-basierter Kartenansicht.

### Wieso keine echten Kartenkacheln (z. B. Mapbox/MapLibre + OSM-Tiles)?

Die Karte wird aktuell selbst gezeichnet (Canvas, Straßen/Route als Linien, keine Kachel-Bilder). Grund: In der Entwicklungs-Sandbox, in der dieses Projekt gebaut wurde, sind sowohl der npm-Registry-Zugriff als auch externe Kartendienste (Overpass, Nominatim, Tile-Server) durch eine Netzwerk-Policy blockiert – React/Vite/MapLibre ließen sich dort nicht installieren oder testen. Die App wurde deshalb bewusst abhängigkeitsfrei gebaut, damit sie sofort läuft und sich vollständig (inkl. Browser-Test) verifizieren ließ.

**Wenn du die App auf deinem eigenen Rechner (mit normalem Internetzugang) betreibst**, funktioniert der Live-Modus wie vorgesehen. Eine echte Kartenansicht mit OSM-Kacheln lässt sich leicht ergänzen (`public/app.js`, `drawMap()` durch eine MapLibre-Karte ersetzen) – die Routing-Logik im Backend bleibt dabei unverändert.

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

## Tests

Reine Node-Core-Tests (keine Abhängigkeiten nötig), prüfen Graphaufbau, Einbahnstraßen-Logik und dass die Ampel-Minimierung tatsächlich weniger Ampeln liefert:

```bash
cd server
npm test
```

## Bekannte Grenzen / mögliche nächste Schritte

- **Ampel-Richtungslogik**: OpenStreetMap taggt Ampeln i. d. R. als einzelnen Knoten pro Kreuzung, nicht separat pro Fahrtrichtung. Diese App zählt eine Ampel, sobald die berechnete Route über diesen Knoten fährt – das ist für die allermeisten Kreuzungen korrekt, bildet aber keine Fälle ab, in denen OSM tatsächlich getrennte Signal-Knoten pro Richtung/Spur enthält.
- **Kartendarstellung**: aktuell schematisch (Canvas-Linien), kein echtes Kartenbild/OSM-Kacheln (siehe oben).
- **Turn-by-Turn-Navigation** ist nicht implementiert; die berechnete Route lässt sich aber leicht an eine bestehende Navi-App übergeben (Start-/Zielkoordinaten liegen vor).
- **Bounding-Box-Größe**: Für sehr lange Pendelstrecken (>~30 km) ist die Overpass-Abfrage ggf. groß/langsam; die Fläche ist aktuell gedeckelt.
