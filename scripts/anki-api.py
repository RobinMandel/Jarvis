#!/usr/bin/env python3
"""
AnkiConnect API Helper
Provides simple functions to interact with Anki via AnkiConnect plugin.
"""

import requests
import json
import os
import sys
import time
import tempfile
import random
import contextlib
from typing import Any, Dict, List, Optional

ANKI_URL = 'http://localhost:8765'

# --- Concurrency / Resilience ---
# Parallele Anki-Aufrufe absichern:
#  1) Prozess-uebergreifender File-Lock fuer WRITE-Actions (verhindert dass
#     mehrere Scripts gleichzeitig Karten einfuegen — AnkiConnect serialisiert
#     das zwar intern, aber Anki's SQLite + UI-Thread reagieren empfindlich
#     auf Burst-Writes von aussen).
#  2) Retry mit exponential backoff + jitter bei transienten Fehlern
#     (ConnectionError, Timeout, 5xx).
#  3) Laengerer Default-Timeout fuer Bulk-Inserts.

_LOCK_PATH = os.path.join(tempfile.gettempdir(), 'jarvis_ankiconnect.lock')

# Write-Actions serialisieren; Reads laufen ungebremst
_WRITE_ACTIONS = {
    'addNote', 'addNotes', 'updateNoteFields', 'deleteNotes',
    'createDeck', 'deleteDecks', 'changeDeck',
    'addTags', 'removeTags', 'replaceTags',
    'storeMediaFile', 'deleteMediaFile',
    'updateNoteModel', 'suspend', 'unsuspend',
}


@contextlib.contextmanager
def _file_lock(path: str, timeout: float = 30.0):
    """Cross-platform exclusive file lock (msvcrt on Windows, fcntl elsewhere).

    Blockt maximal `timeout` Sekunden. Faellt bei Fehler leise auf "no lock"
    zurueck — besser unlocked als gar nicht.
    """
    f = None
    locked = False
    try:
        f = open(path, 'a+b')
        deadline = time.monotonic() + timeout
        if sys.platform == 'win32':
            import msvcrt
            while True:
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.05 + random.random() * 0.1)
        else:
            import fcntl
            while True:
                try:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.05 + random.random() * 0.1)
        yield locked
    except Exception:
        yield False
    finally:
        if f is not None:
            try:
                if locked:
                    if sys.platform == 'win32':
                        try:
                            import msvcrt
                            f.seek(0)
                            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                        except Exception:
                            pass
                    else:
                        try:
                            import fcntl
                            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                        except Exception:
                            pass
                f.close()
            except Exception:
                pass


def invoke(action: str, _retries: int = 4, _timeout: Optional[float] = None, **params) -> Any:
    """
    Call AnkiConnect API — mit Retry und Write-Lock gegen parallele Crashes.

    Args:
        action: API action name (e.g., 'deckNames', 'addNote')
        _retries: Max Versuche bei transienten Fehlern (default 4)
        _timeout: Request-Timeout in s. Default: 20s fuer Bulk, 10s sonst.
        **params: Action-specific parameters

    Returns:
        API response result

    Raises:
        Exception: If AnkiConnect returns a non-transient error
    """
    payload = {
        'action': action,
        'version': 6,
        'params': params,
    }

    is_write = action in _WRITE_ACTIONS
    is_bulk = action == 'addNotes' or (
        action == 'multi' and isinstance(params.get('actions'), list) and len(params['actions']) > 5
    )
    if _timeout is None:
        _timeout = 30.0 if is_bulk else 10.0

    def _do_request() -> Any:
        try:
            response = requests.post(ANKI_URL, json=payload, timeout=_timeout)
            response.raise_for_status()
        except requests.exceptions.ConnectionError as e:
            raise _Transient(f"Cannot connect to AnkiConnect: {e}")
        except requests.exceptions.Timeout as e:
            raise _Transient(f"AnkiConnect request timed out: {e}")
        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, 'status_code', 0) or 0
            if 500 <= status < 600:
                raise _Transient(f"AnkiConnect {status}: {e}")
            raise Exception(f"AnkiConnect HTTP {status}: {e}")

        try:
            result = response.json()
        except ValueError as e:
            raise _Transient(f"AnkiConnect returned non-JSON: {e}")

        if result.get('error'):
            err = str(result['error'])
            # "collection is not available" / "anki is busy" = transient
            low = err.lower()
            if 'collection is not available' in low or 'is busy' in low or 'cannot create note' in low and 'duplicate' not in low:
                raise _Transient(f"AnkiConnect busy: {err}")
            # duplicate und andere harte Fehler: nicht retrien
            raise Exception(f"AnkiConnect error: {err}")

        return result.get('result')

    def _attempt_loop():
        last_err: Optional[Exception] = None
        for attempt in range(max(1, _retries)):
            try:
                return _do_request()
            except _Transient as e:
                last_err = e
                if attempt == _retries - 1:
                    break
                # exp backoff: 0.25, 0.5, 1.0, 2.0s + jitter
                delay = (0.25 * (2 ** attempt)) + random.random() * 0.2
                time.sleep(delay)
        # Letzter Versuch fehlgeschlagen
        raise Exception(
            f"AnkiConnect failed after {_retries} attempts. "
            f"Last error: {last_err}. "
            f"Hinweis: Anki geoeffnet? AnkiConnect-Plugin aktiv? Anki nicht gerade am Syncen?"
        )

    if is_write:
        with _file_lock(_LOCK_PATH, timeout=30.0):
            return _attempt_loop()
    return _attempt_loop()


class _Transient(Exception):
    """Interner Marker fuer retry-bare Fehler."""
    pass


# === Convenience Functions ===

def get_decks() -> List[str]:
    """Get list of all deck names."""
    return invoke('deckNames')


def create_deck(deck_name: str) -> int:
    """Create a new deck. Returns deck ID."""
    return invoke('createDeck', deck=deck_name)


def add_basic_card(
    deck: str,
    front: str,
    back: str,
    tags: Optional[List[str]] = None
) -> int:
    """
    Add a basic flashcard (front/back).
    
    Returns:
        Note ID
    """
    note = {
        'deckName': deck,
        'modelName': 'Basic',
        'fields': {
            'Front': front,
            'Back': back
        },
        'tags': tags or []
    }
    return invoke('addNote', note=note)


def add_cloze_card(
    deck: str,
    text: str,
    extra: str = '',
    tags: Optional[List[str]] = None
) -> int:
    """
    Add a cloze deletion card.
    Use {{c1::text}} for cloze deletions.
    
    Returns:
        Note ID
    """
    note = {
        'deckName': deck,
        'modelName': 'Cloze',
        'fields': {
            'Text': text,
            'Extra': extra
        },
        'tags': tags or []
    }
    return invoke('addNote', note=note)


def add_notes_batch(notes: List[Dict[str, Any]], chunk_size: int = 50) -> Dict[str, Any]:
    """
    Fuegt viele Notes in einem Rutsch ueber AnkiConnect's natives `addNotes` hinzu.

    Vorteile gegenueber einer Schleife mit add_basic_card/add_cloze_card:
    - 1 HTTP-Request pro Chunk (50 Karten) statt 1 pro Karte
    - Write-Lock gilt nur einmal pro Chunk, nicht N-mal
    - Keine Race-Conditions zwischen den Einzel-Inserts

    Args:
        notes: Liste von AnkiConnect-Note-Dicts (deckName, modelName, fields, tags)
        chunk_size: Max Notes pro Request (50 ist safe; Anki kann mehr, aber
                    kleinere Chunks = besserer Progress + weniger lange Locks)

    Returns:
        {"created": int, "attempted": int, "note_ids": [...], "errors": [...]}
    """
    note_ids: List[Optional[int]] = []
    errors: List[str] = []
    for start in range(0, len(notes), max(1, chunk_size)):
        chunk = notes[start:start + chunk_size]
        try:
            ids = invoke('addNotes', notes=chunk) or []
        except Exception as e:
            errors.append(f"Chunk {start}-{start + len(chunk)}: {e}")
            note_ids.extend([None] * len(chunk))
            continue
        # AnkiConnect liefert None fuer fehlgeschlagene (z.B. Duplikat) Notes zurueck
        note_ids.extend(ids)
        for idx, nid in enumerate(ids):
            if nid is None:
                errors.append(f"Note {start + idx}: addNotes returned null (Duplikat? Invalid?)")
    created = sum(1 for x in note_ids if x)
    return {
        "created": created,
        "attempted": len(notes),
        "note_ids": note_ids,
        "errors": errors,
    }


def find_cards(query: str) -> List[int]:
    """
    Find cards by query.
    
    Examples:
        - 'is:due' - cards due today
        - 'tag:anatomie' - cards tagged 'anatomie'
        - 'deck:OSCE' - cards in OSCE deck
    """
    return invoke('findCards', query=query)


def find_notes(query: str) -> List[int]:
    """Find notes by query (similar to find_cards)."""
    return invoke('findNotes', query=query)


def get_note_info(note_ids: List[int]) -> List[Dict]:
    """Get detailed info for notes."""
    return invoke('notesInfo', notes=note_ids)


def get_deck_stats(deck_names: List[str]) -> Dict:
    """Get statistics for specific decks."""
    return invoke('getDeckStats', decks=deck_names)


def get_due_count() -> int:
    """Get count of cards due today."""
    cards = find_cards('is:due')
    return len(cards)


def get_new_count() -> int:
    """Get count of new (never seen) cards."""
    cards = find_cards('is:new')
    return len(cards)


def search_by_tag(tag: str) -> List[int]:
    """Find all notes with specific tag."""
    return find_notes(f'tag:{tag}')


def get_study_dashboard() -> Dict[str, Any]:
    """
    Get comprehensive study dashboard.
    
    Returns:
        Dict with decks, due count, new count, etc.
    """
    decks = get_decks()
    total_due = get_due_count()
    total_new = get_new_count()
    
    deck_stats = []
    for deck in decks:
        try:
            due = len(find_cards(f'deck:"{deck}" is:due'))
            new = len(find_cards(f'deck:"{deck}" is:new'))
            deck_stats.append({
                'name': deck,
                'due': due,
                'new': new
            })
        except:
            continue
    
    return {
        'total_decks': len(decks),
        'total_due': total_due,
        'total_new': total_new,
        'decks': deck_stats
    }


# === Medical Student Helpers ===

def add_osce_card(
    scenario: str,
    approach: str,
    tags: Optional[List[str]] = None
) -> int:
    """
    Add an OSCE scenario card.
    
    Args:
        scenario: The clinical scenario/question
        approach: How to approach it (differential, steps, etc.)
        tags: Tags (automatically adds 'osce')
    """
    if tags is None:
        tags = []
    tags.append('osce')
    
    return add_basic_card(
        deck='Medizin::OSCE',
        front=f"**OSCE Szenario:**\n\n{scenario}",
        back=approach,
        tags=tags
    )


def add_drug_card(
    drug_name: str,
    dosage: str,
    indication: str,
    contraindications: str = '',
    notes: str = '',
    tags: Optional[List[str]] = None
) -> int:
    """
    Add a drug reference card.
    
    Args:
        drug_name: Name of the drug
        dosage: Dosing information
        indication: When to use
        contraindications: When NOT to use
        notes: Additional notes (side effects, interactions, etc.)
        tags: Tags (automatically adds 'pharmakologie')
    """
    if tags is None:
        tags = []
    tags.append('pharmakologie')
    
    back_text = f"""**Dosierung:** {dosage}

**Indikation:** {indication}"""
    
    if contraindications:
        back_text += f"\n\n**Kontraindikation:** {contraindications}"
    
    if notes:
        back_text += f"\n\n**Cave/Notizen:** {notes}"
    
    return add_basic_card(
        deck='Medizin::Pharmakologie',
        front=f"{drug_name}",
        back=back_text,
        tags=tags
    )


def check_exam_coverage(exam_tags: List[str]) -> Dict[str, Dict]:
    """
    Check card coverage for exam topics.
    
    Args:
        exam_tags: List of tags relevant for exam
    
    Returns:
        Dict with stats per tag
    """
    coverage = {}
    
    for tag in exam_tags:
        total = len(find_notes(f'tag:{tag}'))
        mature = len(find_cards(f'tag:{tag} prop:ivl>=21'))  # >21 days interval
        due = len(find_cards(f'tag:{tag} is:due'))
        
        coverage[tag] = {
            'total_cards': total,
            'mature_cards': mature,
            'due_today': due,
            'maturity_rate': (mature / total * 100) if total > 0 else 0
        }
    
    return coverage


# === CLI for testing ===

if __name__ == '__main__':
    import sys
    
    # Test connection
    try:
        print("Testing AnkiConnect connection...")
        decks = get_decks()
        print(f"[OK] Connected! Found {len(decks)} decks:")
        for deck in decks:
            print(f"  - {deck}")
        
        print(f"\nStudy Stats:")
        print(f"  Cards due today: {get_due_count()}")
        print(f"  New cards: {get_new_count()}")
        
        # Full dashboard
        if '--dashboard' in sys.argv:
            dashboard = get_study_dashboard()
            print(f"\nFull Dashboard:")
            print(f"  Total Decks: {dashboard['total_decks']}")
            print(f"  Total Due: {dashboard['total_due']}")
            print(f"  Total New: {dashboard['total_new']}")
            print(f"\n  Deck Breakdown:")
            for deck_stat in dashboard['decks']:
                if deck_stat['due'] > 0 or deck_stat['new'] > 0:
                    print(f"    {deck_stat['name']}: {deck_stat['due']} due, {deck_stat['new']} new")
        
    except Exception as e:
        print(f"[ERROR] {e}")
        sys.exit(1)
