---
name: anki-connect
version: 1.0.0
description: Full Anki integration via AnkiConnect API. Create cards, manage decks, get review stats, search cards. Optimized for medical students (OSCE, MC, anatomy). Triggers on "anki", "flashcard", "create card", "review stats", "deck".
---

# AnkiConnect - Full Anki Integration

## Overview

Direct integration with Anki via the AnkiConnect plugin. Create flashcards, manage decks, track review statistics, and search your card collection.

**Optimized for Medical Students:**
- OSCE scenario cards
- Multiple-choice question cards
- Anatomy/Physiology tagged cards
- Clinical algorithm cards
- Drug reference cards

## Prerequisites

**AnkiConnect Plugin must be installed in Anki:**
1. Open Anki
2. Tools → Add-ons → Get Add-ons
3. Enter code: `2055492159`
4. Restart Anki
5. API runs on `http://localhost:8765`

**Anki must be running** for the API to work.

## Trigger Scenarios

Use this skill when the user:
- Asks to create flashcards: "Erstelle Anki-Karten für EKG-Interpretation"
- Wants review statistics: "Wie viele Karten habe ich heute fällig?"
- Needs to search cards: "Zeige mir alle Karten zum Thema Anatomie"
- Wants to manage decks: "Liste alle meine Decks"
- Asks about study progress: "Wie läuft mein Anki-Review?"

## Core Actions

### 1. Create Cards

**Basic Card (Front/Back):**
```python
invoke('addNote', note={
    'deckName': 'Medizin::OSCE',
    'modelName': 'Basic',
    'fields': {
        'Front': 'Was ist die normale Herzfrequenz?',
        'Back': '60-100 bpm (Erwachsene)'
    },
    'tags': ['kardio', 'basics', 'osce']
})
```

**Cloze Deletion:**
```python
invoke('addNote', note={
    'deckName': 'Medizin::Pharmakologie',
    'modelName': 'Cloze',
    'fields': {
        'Text': 'Aspirin hemmt {{c1::COX-1 und COX-2}} und reduziert {{c2::Prostaglandin-Synthese}}.',
        'Extra': 'Wirkung: Analgetisch, antipyretisch, antiphlogistisch'
    },
    'tags': ['pharmakologie', 'nsaids', 'aspirin']
})
```

### 2. Get Review Stats

**Cards Due Today:**
```python
# Find all cards due today
result = invoke('findCards', query='is:due')
print(f"Du hast {len(result)} Karten fällig heute")
```

**Deck Statistics:**
```python
decks = invoke('deckNames')
for deck in decks:
    stats = invoke('getDeckStats', decks=[deck])
    print(f"{deck}: {stats}")
```

### 3. Search Cards

**By Tag:**
```python
# Find all anatomy cards
notes = invoke('findNotes', query='tag:anatomie')
info = invoke('notesInfo', notes=notes)
```

**By Deck:**
```python
# All OSCE cards
notes = invoke('findNotes', query='deck:OSCE')
```

**Complex Queries:**
```python
# Cards tagged 'kardio' that are due and difficult (again count > 5)
invoke('findCards', query='tag:kardio is:due rated:2:5')
```

### 4. Manage Decks

**List All Decks:**
```python
decks = invoke('deckNames')
# Returns: ['Default', 'Medizin::OSCE', 'Medizin::Anatomie', ...]
```

**Create Deck:**
```python
invoke('createDeck', deck='Medizin::Doktorarbeit::Statistik')
```

**Change Deck:**
```python
invoke('changeDeck', cards=[card_id], deck='Medizin::Archive')
```

## Medical Student Templates

### OSCE Scenario Card
```python
invoke('addNote', note={
    'deckName': 'Medizin::OSCE',
    'modelName': 'Basic',
    'fields': {
        'Front': '''
**OSCE Station: Akutes Abdomen**

Patient: 45-jährige Frau, plötzliche Bauchschmerzen rechts unten.

Was sind deine nächsten 3 Schritte?
''',
        'Back': '''
1. **Anamnese:** Schmerzcharakter (kolikartig?), Fieber, Übelkeit, letzte Periode
2. **Untersuchung:** Inspektion, Palpation (McBurney, Loslassschmerz), Perkussion
3. **Diagnostik:** Labor (Leukos, CRP), Sono Abdomen, ggf. CT

**Differentialdiagnose:** Appendizitis, Adnexitis, Ektope Gravidität, Zystitis
'''
    },
    'tags': ['osce', 'abdomen', 'notfall', 'chirurgie']
})
```

### Drug Reference Card
```python
invoke('addNote', note={
    'deckName': 'Medizin::Pharmakologie',
    'modelName': 'Basic',
    'fields': {
        'Front': 'Adrenalin - Dosierung bei Reanimation',
        'Back': '''
**Dosierung:** 1 mg i.v. alle 3-5 min (ERC Guidelines)

**Indikation:** Herzstillstand (VF, pVT, Asystolie, PEA)

**Kontraindikation:** Keine bei Reanimation

**Cave:** Nach ROSC niedrig dosiert titrieren
'''
    },
    'tags': ['pharmakologie', 'notfall', 'reanimation', 'erc']
})
```

### Anatomy Cloze
```python
invoke('addNote', note={
    'deckName': 'Medizin::Anatomie',
    'modelName': 'Cloze',
    'fields': {
        'Text': '''
Der {{c1::N. medianus}} verläuft durch den {{c2::Karpaltunnel}} und innerviert:
- Motorisch: {{c3::Thenarmuskulatur}} (außer Adductor pollicis)
- Sensibel: {{c4::Palmare Seite Daumen, Zeige-, Mittelfinger, radiale Hälfte Ringfinger}}
''',
        'Extra': 'Klinik: Karpaltunnelsyndrom → Thenar-Atrophie, Sensibilitätsstörung'
    },
    'tags': ['anatomie', 'neurologie', 'hand', 'nervus-medianus']
})
```

## Integration with Study-Scheduler

**Workflow:**
1. Study-Scheduler identifies upcoming exam topics
2. Query Anki for related cards: `invoke('findNotes', query='tag:kardio')`
3. Check review stats: How many cards due? Average ease?
4. Adjust study plan: Block time for Anki reviews
5. After session: Get completion stats, update memory

**Example:**
```python
# Check Anki workload for today
due_cards = invoke('findCards', query='is:due')
due_count = len(due_cards['result'])

# Estimate review time (assume 30 sec/card)
review_minutes = (due_count * 30) / 60

# Add to study plan
print(f"Anki Review: {due_count} Karten → ~{review_minutes:.0f} min einplanen")
```

## API Helper Functions

### Python Helper (use in scripts)

```python
import requests
import json

def anki_invoke(action, **params):
    """Call AnkiConnect API"""
    response = requests.post('http://localhost:8765', json={
        'action': action,
        'version': 6,
        'params': params
    })
    
    result = response.json()
    if result.get('error'):
        raise Exception(f"AnkiConnect error: {result['error']}")
    
    return result.get('result')

# Usage:
decks = anki_invoke('deckNames')
print(f"Available decks: {', '.join(decks)}")
```

### PowerShell Helper

```powershell
function Invoke-AnkiConnect {
    param(
        [string]$Action,
        [hashtable]$Params = @{}
    )
    
    $body = @{
        action = $Action
        version = 6
        params = $Params
    } | ConvertTo-Json -Depth 10
    
    $response = Invoke-RestMethod -Uri 'http://localhost:8765' -Method Post -Body $body -ContentType 'application/json'
    
    if ($response.error) {
        throw "AnkiConnect error: $($response.error)"
    }
    
    return $response.result
}

# Usage:
$decks = Invoke-AnkiConnect -Action 'deckNames'
Write-Host "Available decks: $($decks -join ', ')"
```

## Common Queries

### Study Progress Dashboard
```python
# Get comprehensive stats
decks = anki_invoke('deckNames')
total_due = len(anki_invoke('findCards', query='is:due'))
total_new = len(anki_invoke('findCards', query='is:new'))

print(f"""
📊 Anki Study Dashboard
======================
Total Decks: {len(decks)}
Cards Due Today: {total_due}
New Cards Available: {total_new}

Top Decks:
""")

for deck in decks[:5]:
    deck_due = len(anki_invoke('findCards', query=f'deck:"{deck}" is:due'))
    print(f"  - {deck}: {deck_due} fällig")
```

### Find Weak Cards (for focused review)
```python
# Cards with low ease factor (difficult cards)
weak_cards = anki_invoke('findCards', query='prop:ease<2.0 -is:suspended')
print(f"Du hast {len(weak_cards)} schwierige Karten (ease < 200%)")
```

### Exam Prep: Topic Coverage Check
```python
# Check coverage for upcoming exam
topics = ['kardio', 'respiratorisch', 'neurologie', 'pharma']

for topic in topics:
    cards = anki_invoke('findNotes', query=f'tag:{topic}')
    mature = anki_invoke('findCards', query=f'tag:{topic} prop:ivl>=21')
    
    print(f"{topic}: {len(cards)} Karten total, {len(mature)} mature (>21d)")
```

## Tagging Strategy (Medical Students)

**Recommended Tag Hierarchy:**
```
medizin/
├── fach/
│   ├── anatomie
│   ├── physiologie
│   ├── biochemie
│   ├── pharmakologie
│   └── ...
├── system/
│   ├── kardio
│   ├── respiratorisch
│   ├── neurologie
│   └── ...
├── format/
│   ├── osce
│   ├── mc
│   ├── mündlich
│   └── ...
└── priority/
    ├── prüfung-2026-04
    ├── wichtig
    └── wiederholung
```

## Troubleshooting

**"Connection refused" error:**
- Check if Anki is running
- Verify AnkiConnect plugin is installed (Tools → Add-ons)
- Restart Anki

**"Permission denied" error:**
- Check AnkiConnect config (Tools → Add-ons → AnkiConnect → Config)
- Ensure `webBindAddress` is `127.0.0.1` or `0.0.0.0`

**Cards not appearing:**
- Check deck name spelling (case-sensitive!)
- Verify model name exists: `invoke('modelNames')`
- Check field names match model: `invoke('modelFieldNames', modelName='Basic')`

## Best Practices

1. **Always tag cards** - Makes searching and filtering much easier
2. **Use hierarchical decks** - `Medizin::Anatomie::Herz` better than flat structure
3. **Include context in cards** - "Aspirin Dosierung" not just "Dosierung"
4. **Add images for anatomy** - AnkiConnect supports image fields
5. **Review stats regularly** - Adjust study schedule based on actual workload
6. **Don't create duplicates** - Search before creating: `invoke('findDuplicates')`

## Resources

- AnkiConnect GitHub: https://github.com/FooSoft/anki-connect
- Anki Manual: https://docs.ankiweb.net/
- Medical Anki Decks: AnKing, Zanki (for inspiration)

---

**When to use this skill:**
- User mentions Anki, flashcards, or spaced repetition
- Creating study materials for exams
- Tracking study progress
- Managing card collections
- Integration with study planning
