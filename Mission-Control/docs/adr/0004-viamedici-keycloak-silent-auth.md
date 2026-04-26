# ADR-0004: ViaMedici via Keycloak Silent-Auth + Offline-Token

**Status:** Accepted (2026-04-23)

## Context

MC's Karten-Generator zieht bei jeder Generierung Bilder + Artikel-Text aus
Thiemes ViaMedici-Plattform (zusätzlich zu Amboss). ViaMedici hat keine
öffentliche API; der Zugriff läuft über dieselbe OAuth2-PKCE-Infrastruktur,
die die Web-SPA nutzt.

Ein früher Arena-Bot-Bau hatte eine `amboss_client.py` mit erfundenem Endpoint
(`api.amboss.com` — existiert als Domain nicht). Lehre: **externe APIs immer
via Browser-Capture + Introspection reverse-engineeren**, nie raten.

Erste Integration nutzte `_KC_SCOPE = "openid profile email taal"` — das lieferte
einen Access-Token (10 min) + Refresh-Token (~19 h). Die UI schätzte „~28 Tage
noch gültig" (hardkodiert), in Wahrheit war nach ~24 h alles tot. Robin musste
jeden Tag neue Cookies pasten.

## Decision

`viamedici_client.py` nutzt **Keycloak Silent-Auth mit `offline_access`-Scope**:

- `_KC_SCOPE_PRIMARY = "openid profile email taal offline_access"`
- `_KC_SCOPE_FALLBACK = "openid profile email taal"` (falls Keycloak-Client
  offline-Scope nicht erlaubt → Code fällt automatisch zurück)

Der Offline-Refresh-Token überlebt SSO-Session-Ende, d.h. der Token ist
unabhängig von `KEYCLOAK_SESSION`-Cookie-Lifetime und hält wochenlang (typisch
30 Tage oder unlimited absolute je nach Keycloak-Admin-Config).

`get_session_info()` liefert echte JWT-Expiries (KC_IDENTITY + Refresh-Token)
plus `is_offline`-Flag. Die UI zeigt diese echten Werte statt einer hard­
kodierten Schätzung:
- Offline-Session → „Offline-Session · noch N Tage gültig" (grün)
- Normal-Session → „läuft in N Std/Tagen ab" (orange/rot nach Dringlichkeit)

## Consequences

**Positiv:**
- Einmal Cookies pasten hält wochenlang statt einen Tag.
- Ehrliche UI-Statusanzeige statt einer Lüge.
- Fehlerpfade (`not_logged_in`, `model_not_allowed`, `rate_limit`, `quota_exceeded`)
  werden in `SilentAuthError`-Klasse mit dedizierten Codes unterschieden — UI
  kann unterschiedliche Handhabungen anbieten.

**Negativ:**
- Wenn Thieme jemals den Keycloak-Client-Scope einschränkt (`invalid_scope`),
  fallen wir auf den alten 19h-Flow zurück. Robin muss dann wieder regelmäßig
  pasten. Dafür gibt es einen sichtbaren Warnhinweis im UI.
- `thieme_client.py` aus einer frühen Experiment-Phase zielte auf
  `thieme-connect.de` (falsche Plattform!) — ist jetzt Legacy, `viamedici_client.py`
  ist kanonisch. Legacy-Datei wurde nicht gelöscht, nur als deprecated markiert.

## Nicht-Ziele

- API-Key-Auth statt OAuth — Thieme bietet keinen Endnutzer-API-Key an.
- Automatischer Cookie-Refresh bei Ablauf — der `offline_access`-Scope umgeht
  das Problem; wenn der jemals wegfällt, wäre das der nächste Schritt.
