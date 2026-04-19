#!/usr/bin/env python3
"""YouTube Transcript Fetcher — kein API-Key nötig"""

import sys
import re
import argparse

def get_transcript(url, lang=None, raw=False):
    from youtube_transcript_api import YouTubeTranscriptApi

    match = re.search(r'(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})', url)
    if not match:
        print("ERROR: Ungültige YouTube-URL", file=sys.stderr)
        sys.exit(1)
    video_id = match.group(1)

    try:
        api = YouTubeTranscriptApi()
        langs = [lang] if lang else ['de', 'en', 'en-US', 'en-GB']
        snippets = api.fetch(video_id, languages=langs)

        if raw:
            for entry in snippets:
                print(f"[{entry.start:.1f}s] {entry.text}")
        else:
            text = ' '.join([entry.text for entry in snippets])
            print(text)

    except Exception as e:
        # Fallback: ohne Sprachfilter
        try:
            api = YouTubeTranscriptApi()
            snippets = api.fetch(video_id)
            text = ' '.join([entry.text for entry in snippets])
            print(text)
        except Exception as e2:
            print(f"Kein Transcript verfügbar: {e2}", file=sys.stderr)
            sys.exit(1)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='YouTube Transcript Fetcher')
    parser.add_argument('url', help='YouTube URL')
    parser.add_argument('--lang', help='Sprache (z.B. de, en)', default=None)
    parser.add_argument('--raw', action='store_true', help='Mit Zeitstempeln ausgeben')
    args = parser.parse_args()
    get_transcript(args.url, lang=args.lang, raw=args.raw)
