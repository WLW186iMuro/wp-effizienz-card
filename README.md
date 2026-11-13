# WP Effizienz-Rechner & JAZ – Buderus WLW186i für Home Assistant

[![Open in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=WLW186iMuro&repository=wp-effizienz-card&category=plugin)

Zwei Dashboard-Karten für die Luft-Wasser-Wärmepumpe **Buderus Logatherm WLW186i** (Bosch-Schwestermodell: Compress 5800i/6800i AW), ausgelesen über [EMS-ESP](https://emsesp.org).

> Der Effizienz-Rechner basiert auf dem Simulator von **Matthias Röckl** ([bosch-buderus-wp.github.io](https://bosch-buderus-wp.github.io/)). Er wurde für Home Assistant angepasst und erweitert (Live-Werte aus EMS-ESP, Wärmeabgabe der Fußbodenheizung, Takten unter der Mindestleistung) und wird mit seiner Erlaubnis unter seiner MIT-Lizenz verwendet. Danke dafür.

| Karte | Typ | Zweck |
|---|---|---|
| Effizienz-Rechner | `custom:wp-simulator-card` | Heizkurve, Heizlast und COP durchrechnen. Regler verschieben und sofort sehen, wie sich Vorlauf, Spreizung, Pumpendruck, COP und Stromverbrauch pro Tag ändern. |
| JAZ & SCOP | `custom:wp-jaz-card` | Jahresarbeitszahl und Monatsarbeitszahlen aus der Langzeitstatistik, Vergleich mit dem SCOP laut Datenblatt. |

![Effizienz-Rechner](docs/simulator.png)

![JAZ & SCOP](docs/jaz.png)

## Installation

1. Auf **Open in HACS** klicken. Alternativ: HACS → ⋮ → *Benutzerdefinierte Repositories* → diese Repository-URL, Kategorie **Dashboard**.
2. **Herunterladen**. HACS trägt die Ressource selbst ein und hält sie aktuell.
3. Browser-Cache leeren (Strg+F5), dann stehen beide Karten in der Kartenauswahl.

Dashboards im YAML-Modus: Ressource `/hacsfiles/wp-effizienz-card/wp-effizienz-card.js` als *JavaScript-Modul* von Hand eintragen.

## Dashboard anlegen

Fertige Konfiguration mit beiden Ansichten zum Einfügen: [`examples/dashboard.yaml`](examples/dashboard.yaml). Beide Ansichten als Typ **Panel**.

**Vor dem ersten Einsatz die Anlagenwerte setzen.** Die eingebauten Werte stammen von einer Beispielanlage (WLW186i-7 AR mit TP70 und Fußbodenheizung):

```yaml
type: custom:wp-simulator-card
defaults:
  nat: -10      # Normaußentemperatur des Standorts
  loadKw: 5.0   # Gebäudeheizlast bei NAT in kW (aus der Heizlastberechnung)
  limit: 15     # Heizgrenze
  ti: 21        # gewünschte Raumtemperatur
```

Die Einstellungen der Wärmepumpe (Fußpunkt, Auslegungstemperatur, Raumsoll, Spreizung, Pumpendruck usw.) holt die Schaltfläche **Aus EMS-ESP laden** direkt aus der Anlage. Ebenso übernimmt die Karte die gedämpfte Außentemperatur live.

## Voraussetzungen

- Home Assistant mit EMS-ESP (MQTT-Discovery) und den Standardnamen `sensor.boiler_…`, `sensor.thermostat_…`, `number.thermostat_…`
- Das Rechenmodell kennt die Außeneinheiten **4, 5, 7, 10 und 12 kW** (WLW176i/186i AR, Inneneinheit TP70, Fußbodenheizung). Die Größe wählst du im Rechner unter „Außeneinheit“ oder per `defaults: { model: "10 kW" }`. **Nur das 7-kW-Profil ist an einer echten Anlage geprüft.** Die anderen Größen sind aus den Datenblattwerten der Buderus-Planungsunterlage (Tabelle 8.3.1) abgeleitet; Abweichung der Modell-COPs vom Datenblatt 1–5 %. Die Punkte bei −20, −15, +15 und +20 °C sowie die Mindestleistungen sind aus Bild 9 der Unterlage abgelesen (etwa ±0,1 kW). Bei 10/12 kW zeigt die Mindestleistungskurve bei +2 °C etwa 3,1 kW, die Tabelle nennt 2,1 kW als Modulationsbereich; der Rechner folgt der Kurve. Die Pumpenkennlinie PC0 stammt von der 7-kW-Anlage. Die Leistungskurven bei 45 und 55 °C Vorlauf (Bild 11 und 13) sind je Größe eingebaut, auch die Mindestleistung. Die Nenn-COP-Kurven der Unterlage (Bild 10, 12, 14) liegen bei 45 und 55 °C deutlich unter dem, was der Rechner liefert (bis etwa 30 %); sie gelten für den Nennpunkt mit Inneneinheit und sind mit den Tabellenwerten bei Maximalleistung nicht deckungsgleich. Bei Vorlauftemperaturen ab 45 °C ist der berechnete COP daher eher optimistisch. Je Größe ist der Abfall von 35 auf 55 °C an das SCOP-Verhältnis W55/W35 der Unterlage angeglichen. Wer Heizkörper oder ein schlecht gedämmtes Haus hat, kann den Regler „Zusätzlicher COP-Abfall über 35 °C“ (%/K, Standard 0, per `defaults: { copSlope: 1 }` voreinstellbar) erhöhen, etwa auf 1 bis 2 %/K, bis der Rechner zur gemessenen JAZ passt. Unterhalb von 35 °C Vorlauf hat der Regler keine Wirkung. Rückmeldungen mit Messwerten anderer Größen sind willkommen.
- Die JAZ-Karte nutzt `recorder/statistics_during_period`. Die Energiezähler der Wärmepumpe müssen also in der Langzeitstatistik stehen (Standard bei EMS-ESP-Entitäten mit `state_class`).

Ein eigener Helfer ist nicht nötig. Den Primärkreis-Durchfluss rechnet die Karte mit der eingebauten Pumpenkennlinie selbst. Wer einen eigenen Sensor hat, gibt ihn unter `entities: { pc0flow: … }` an.

## Optionen

### Effizienz-Rechner

- `title`: Überschrift
- `defaults`: Startwerte der Regler (siehe oben)
- `entities`: abweichende Entitäten, auch im Karten-Editor einstellbar
- `controls`: Bereich und Schrittweite einzelner Regler, z. B. `loadKw: { min: 2, max: 20, step: 0.5 }`
- `shift`: Parallelverschiebung der Heizkurve (`room`, `offset`, `ref`), an der eigenen Anlage ermitteln
- `storage_key`: eigener Speicherplatz im Browser, wenn die Karte mehrfach verwendet wird

Reglerstellungen, Standardwerte und Bestwerte liegen nur im Browser (localStorage), nichts verlässt deinen Home Assistant.

### JAZ & SCOP

```yaml
type: custom:wp-jaz-card
scop35: 4.58          # SCOP laut Datenblatt bei 35 °C
scop55: 3.52          # SCOP laut Datenblatt bei 55 °C
season_start_month: 7 # Beginn der Heizperiode
```

Weitere Optionen: `heat_heating`, `heat_dhw`, `el_heating`, `el_dhw` (Listen möglich), `outdoor`, `months`, `min_kwh`.

## Regler „Zusätzlicher COP-Abfall über 35 °C“ einstellen

Der Regler senkt den berechneten COP für jedes Kelvin Vorlauftemperatur **über 35 °C** um den eingestellten Prozentsatz. Bei 2 %/K sind das −20 % bei 45 °C und −40 % bei 55 °C. Unter 35 °C Vorlauf wirkt er nicht, für eine Fußbodenheizung mit niedrigem Vorlauf bleibt er auf 0.

1. Zuerst die Anlage im Rechner richtig einstellen: Außeneinheit, Heizlast und Normaußentemperatur, Heizkurve (Fußpunkt, Auslegungstemperatur) und Heizgrenze.
2. Warten, bis die JAZ-Karte mehrere Heizmonate hat (besser eine ganze Heizperiode). Dort steht unter dem SCOP-Vergleich „Rechner-Modell … · gemessen −x %“.
3. Gehört die Abweichung zu einem hohen Vorlauf (Heizkörper, ungedämmtes Haus), den Wert so schätzen: **Abfall in %/K ≈ (1 − Messung ÷ Modell) ÷ (mittlerer Vorlauf − 35 K) × 100**. Beispiel: Modell 3,6, Messung 3,1 → 0,14; mittlerer Vorlauf 50 °C → 15 K → ca. 0,9 %/K.
4. Wert einstellen („Als Standard speichern“ oder `defaults: { copSlope: 0.9 }`), die JAZ-Karte neu laden und prüfen, ob die Abweichung gegen 0 geht. Bei Bedarf nachstellen. Sinnvolle Werte liegen meist zwischen 0 und 2 %/K, ein negativer Wert hebt den COP an, falls das Modell zu pessimistisch ist.

Nicht alle Abweichungen kommen von der Vorlauftemperatur. Heizstab-Betrieb (steckt in der Messung, nicht im Modell), Abtauphasen, Hilfsenergie und falsche Heizlast-Werte wirken ähnlich. Den Regler deshalb erst nach diesen Prüfungen und nur bei hohem Vorlauf verwenden.

## Hinweise

- Der Effizienz-Rechner ist ein Rechenmodell, kein Messgerät. Grundlage sind die Kennwerte der Buderus-Planungsunterlage WLW176i/186i AR (2024/04) und der Rechenkern des Simulators von **Matthias Röckl** ([bosch-buderus-wp.github.io](https://bosch-buderus-wp.github.io/), MIT-Lizenz, Verwendung vom Autor erlaubt). Details und Lizenztext in [NOTICE.md](NOTICE.md).
- Sind beide Karten installiert, zeigt die JAZ-Karte unter dem SCOP-Vergleich zusätzlich die „Rechner-Modell“-Arbeitszahl der Heizperiode (Außentemperatur je Monat, deine Reglerwerte aus dem Effizienz-Rechner, gewichtet mit der gemessenen Wärme) und die Abweichung der Messung davon. Hat der Rechner einen eigenen `storage_key`, gibt man ihn in der JAZ-Karte als `simulator_key` an.
- Die JAZ-Karte nutzt die internen Energiezähler der Wärmepumpe, keinen geeichten Zähler. Die reale JAZ liegt etwas niedriger, weil Hilfsenergie darin evtl. fehlt.
- Privates Hobbyprojekt, keine Verbindung zu Bosch oder Buderus. Die Namen sind Marken der jeweiligen Inhaber. Nutzung auf eigene Verantwortung; die Karten verändern keine Einstellungen an der Heizung.

Lizenz: [MIT](LICENSE), Drittcode siehe [NOTICE.md](NOTICE.md)
