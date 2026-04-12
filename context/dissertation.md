# Dissertation ITI — Aktueller Stand

> Status: **AKTIV** | Prioritaet: Hoch

---

## Eckdaten

- **Institut:** Institute of Clinical and Experimental Trauma Immunology (ITI), Uni Ulm
- **AG:** Huber-Lang
- **Thema:** Rolle neutrophiler Granulozyten beim akuten Nierenversagen (AKI) nach kardiochirurgischen Eingriffen
- **Stipendium:** Promotionsprogramm Experimentelle Medizin, Uni Ulm (ab Fruehjahr 2025)
- **Schlagwoerter:** Neutrophile, TRAKI, KDIGO, Kardiochirurgie, kardiopulmonaler Bypass, Ischämie-Reperfusions-Injury

---

## Datenlage

| Typ | Anzahl | Format |
|---|---|---|
| Flow Cytometry | 229 | .fcs |
| GraphPad Prism | 43 | .pzfx (XML, skriptbar) |
| Prism Archive | 12 | .prism (ZIP mit JSON) |
| Excel | 38 | .xlsx |
| CSV | 42 | .csv |

---

## Analyse-Workflow

1. Inventar aller Dateien (erledigt)
2. `.pzfx` -> CSV/JSON Export (erledigt)
3. `.prism` -> Metadaten + Datensatzstruktur
4. Klinische Tabellen / Baseline / KDIGO mit PRISM-Korrelations-Hub verzahnen (**naechster Schritt**)
5. GraphPad nur fuer Spezialfaelle / visuelle Endkontrolle

**Tools:** Zotero (Literatur-Hub), Word Online (kollaborativ), BioRender (Figuren), GraphPad Prism

---

## Zotero-Bibliothek

- 99 Paper (Stand Maerz 2026)
- Key-Cluster: Neutrophile (AG Huber-Lang), KDIGO/AKI, Kardiochirurgie, NGAL/MPO/Biomarker

### Wichtige Paper
- **Jovanovski et al. (2025)** — Multimodal monitoring of neutrophil activity during cardiac surgery (direkter AG-Treffer)
- **He et al. (2025)** — CD11b -> NETs -> renale IRI
- **Wang et al. (2025)** — scRNA-seq bei CS-AKI
- **Westermann et al. (2025)** — CD10low PMNs als fruehes AKI-Biomarker (steigen 24h vor CRP, IL-6, NGAL)

---

## Workspace-Struktur

Unterordner im Jarvis Workspace:
`Schreiben/`, `Literatur/`, `Figuren-BioRender/`, `Diagramme/`, `Datenextraktion/`, `Prism-Exports/`, `Protocols/`, `Reviews/`, `Submissions/`

Nacht-Recherche-Cron lief taeglich 02:00 Uhr (Output: `Literatur/nacht-recherche-[DATUM].md`)

---

*Letzte Aktualisierung: 2026-04-13*
