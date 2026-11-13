/* wp-effizienz-card – Ladedatei.
 * HACS trägt nur diese Datei als Dashboard-Ressource ein; sie lädt die beiden Karten aus demselben Ordner:
 *   custom:wp-simulator-card  (Effizienz-Rechner)
 *   custom:wp-jaz-card        (Jahresarbeitszahl & SCOP)
 * Die Versionskennung (?v=…) der Ressource wird an die Karten weitergegeben, damit der Browser nach einem HACS-Update
 * nicht die alten Dateien aus dem Cache lädt.
 */
const q = new URL(import.meta.url).search;
import(`./wp-simulator-card.js${q}`);
import(`./wp-jaz-card.js${q}`);
