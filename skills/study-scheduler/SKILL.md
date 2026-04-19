---
name: study-scheduler
description: Lernplanung für Medizinstudium (OSCE/MC/Prüfungen), inklusive Tages- und Wochenplänen, Priorisierung nach Deadline/Risikothemen und realistischem Zeitbudget. Use when user asks for study plans, exam prep timelines, spaced repetition scheduling, or task prioritization.
---

# Study Scheduler

Erstelle umsetzbare Lernpläne mit klaren Prioritäten.

## Workflow
1. Erfasse Ziel (Prüfung, Datum, Format: MC/OSCE/mündlich).
2. Erfasse verfügbare Lernzeit (pro Tag/Woche) und Fixtermine.
3. Priorisiere Themen:
   - High: prüfungsrelevant + unsicher
   - Medium: prüfungsrelevant + mittel
   - Low: sicher/optional
4. Plane in Blöcken:
   - Fokusblock 45-60 min
   - 10 min Pause
   - 1 Wiederholungsblock am Tagesende
5. Plane Wiederholung:
   - Tag 1, Tag 3, Tag 7, Tag 14
6. Gib Output als:
   - Tagesplan (heute)
   - Wochenplan
   - 3 wichtigste Next Actions

## Output-Regeln
- Kurz und konkret.
- Keine überladenen Tabellen, wenn Bullets reichen.
- Bei knapper Zeit: zuerst High-Yield-Themen.

## Optional Scripts
- Nutze `scripts/plan-template.md` als Vorlage für manuelle Pläne.
- Nutze `scripts/generate-plan.ps1` für Auto-Plan:

```powershell
.\skills\study-scheduler\scripts\generate-plan.ps1 \
  -ExamDate "2026-04-15" \
  -WeekdayHours 2 \
  -WeekendHours 4 \
  -HighYieldTopics "ACLS","EKG","Schock" \
  -MediumTopics "Ethik","Statistik" \
  -OutputPath ".\study-plan.md"
```

Output: strukturierter Wochen-/Tagesplan mit Spaced-Repetition-Slots (1/3/7/14 Tage).
