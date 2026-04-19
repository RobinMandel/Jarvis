#!/usr/bin/env python3
"""
iCloud Calendar via CalDAV - Standalone script
Usage:
  python icloud-calendar.py list-calendars
  python icloud-calendar.py list-events [--calendar NAME] [--days N]
  python icloud-calendar.py create-event --title TITLE --start ISO --duration MIN [--calendar NAME] [--location LOC]
"""
import sys, os, json, uuid, argparse
from datetime import datetime, timedelta, timezone, date
from xml.etree import ElementTree as ET

try:
    import requests
    from requests.auth import HTTPBasicAuth
except ImportError:
    print("pip install requests"); sys.exit(1)

try:
    from icalendar import Calendar
except ImportError:
    Calendar = None

# Load credentials
def load_creds():
    apple_id = os.environ.get('APPLE_ID')
    app_pw = os.environ.get('APPLE_APP_PASSWORD')
    if not apple_id or not app_pw:
        cred_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'secrets', 'icloud-cred.json')
        if os.path.exists(cred_path):
            with open(cred_path) as f:
                creds = json.load(f)
            apple_id = creds.get('apple_id', apple_id)
            app_pw = creds.get('app_password', app_pw)
    if not apple_id or not app_pw:
        print("Error: Set APPLE_ID and APPLE_APP_PASSWORD or create secrets/icloud-cred.json")
        sys.exit(1)
    return apple_id, app_pw

BASE = "https://caldav.icloud.com"

def propfind(session, url, body, depth=0):
    resp = session.request('PROPFIND', url, data=body, headers={
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': str(depth)
    })
    resp.raise_for_status()
    return ET.fromstring(resp.content)

def get_calendar_home(session):
    """Discover calendar home URL"""
    # Get principal
    body = '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>'
    root = propfind(session, BASE, body, depth=0)
    principal_el = root.find('.//{DAV:}current-user-principal/{DAV:}href')
    if principal_el is None:
        raise Exception("Could not find principal")
    principal = principal_el.text
    
    # Get calendar home
    body2 = '<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><prop><cal:calendar-home-set/></prop></propfind>'
    purl = principal if principal.startswith('https') else BASE + principal
    root2 = propfind(session, purl, body2, depth=0)
    home_el = root2.find('.//{urn:ietf:params:xml:ns:caldav}calendar-home-set/{DAV:}href')
    if home_el is None:
        raise Exception("Could not find calendar home")
    href = home_el.text
    return href if href.startswith('https') else BASE + href

def list_calendars(session):
    home = get_calendar_home(session)
    # Extract shard base URL from home (e.g. https://p180-caldav.icloud.com:443)
    from urllib.parse import urlparse
    parsed_home = urlparse(home)
    shard_base = f"{parsed_home.scheme}://{parsed_home.netloc}"
    
    body = '''<?xml version="1.0"?>
<propfind xmlns="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <prop>
    <displayname/>
    <resourcetype/>
    <cs:getctag/>
  </prop>
</propfind>'''
    root = propfind(session, home, body, depth=1)
    calendars = []
    for resp in root.findall('.//{DAV:}response'):
        href = resp.findtext('.//{DAV:}href', '')
        name = resp.findtext('.//{DAV:}displayname', '')
        rtype = resp.find('.//{DAV:}resourcetype')
        is_cal = rtype is not None and rtype.find('{urn:ietf:params:xml:ns:caldav}calendar') is not None
        if is_cal and name:
            url = href if href.startswith('https') else shard_base + href
            calendars.append({'name': name, 'url': url})
    return calendars

def list_events(session, calendar_name=None, days=7):
    cals = list_calendars(session)
    
    if calendar_name:
        target_cals = [c for c in cals if c['name'] == calendar_name]
        if not target_cals:
            print(f"Calendar '{calendar_name}' not found. Available: {[c['name'] for c in cals]}")
            return []
    else:
        # Search all calendars
        target_cals = cals
    
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=days)
    all_events = []
    
    for cal in target_cals:
        # Use REPORT with time-range filter for efficiency
        start_str = now.strftime('%Y%m%dT%H%M%SZ')
        end_str = end.strftime('%Y%m%dT%H%M%SZ')
        
        body = f'''<?xml version="1.0" encoding="utf-8"?>
<cal:calendar-query xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <cal:calendar-data/>
  </D:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VEVENT">
        <cal:time-range start="{start_str}" end="{end_str}"/>
      </cal:comp-filter>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>'''
        
        try:
            resp = session.request('REPORT', cal['url'], data=body, headers={
                'Content-Type': 'application/xml; charset=utf-8',
                'Depth': '1'
            })
            if resp.status_code not in (200, 207):
                continue
            root = ET.fromstring(resp.content)
            
            for response in root.findall('.//{DAV:}response'):
                caldata_el = response.find('.//{urn:ietf:params:xml:ns:caldav}calendar-data')
                if caldata_el is None or not caldata_el.text:
                    continue
                
                event = parse_ics(caldata_el.text)
                if event:
                    event['calendar'] = cal['name']
                    all_events.append(event)
        except Exception as e:
            print(f"Warning: Error reading {cal['name']}: {e}", file=sys.stderr)
    
    # Sort by start date
    def sort_key(ev):
        d = ev.get('dtstart')
        if d is None:
            return datetime.min.replace(tzinfo=timezone.utc)
        if isinstance(d, date) and not isinstance(d, datetime):
            return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        if d.tzinfo is None:
            return d.replace(tzinfo=timezone.utc)
        return d
    
    all_events.sort(key=sort_key)
    return all_events

def parse_ics(ics_text):
    """Parse ICS text to event dict"""
    if Calendar:
        try:
            cal = Calendar.from_ical(ics_text)
            for comp in cal.walk():
                if comp.name == "VEVENT":
                    return {
                        'summary': str(comp.get('summary', 'Untitled')),
                        'dtstart': comp.get('dtstart').dt if comp.get('dtstart') else None,
                        'dtend': comp.get('dtend').dt if comp.get('dtend') else None,
                        'location': str(comp.get('location', '') or ''),
                        'description': str(comp.get('description', '') or ''),
                        'uid': str(comp.get('uid', ''))
                    }
        except Exception:
            pass
    
    # Fallback: manual parsing
    result = {'summary': 'Untitled', 'dtstart': None, 'dtend': None, 'location': '', 'description': '', 'uid': ''}
    for line in ics_text.split('\n'):
        line = line.strip()
        if line.startswith('SUMMARY:'):
            result['summary'] = line[8:]
        elif line.startswith('LOCATION:'):
            result['location'] = line[9:]
        elif line.startswith('UID:'):
            result['uid'] = line[4:]
        elif 'DTSTART' in line and ':' in line:
            val = line.split(':', 1)[1]
            try:
                if len(val) == 8:  # Date only
                    result['dtstart'] = datetime.strptime(val, '%Y%m%d').date()
                elif 'T' in val:
                    val_clean = val.rstrip('Z')
                    result['dtstart'] = datetime.strptime(val_clean, '%Y%m%dT%H%M%S').replace(tzinfo=timezone.utc)
            except ValueError:
                pass
    return result if result['summary'] != 'Untitled' or result['dtstart'] else None

def create_event(session, title, start, duration_min=60, calendar_name='Kalender', location='', description='', all_day=False):
    cals = list_calendars(session)
    cal = next((c for c in cals if c['name'] == calendar_name), None)
    if not cal:
        print(f"Calendar '{calendar_name}' not found")
        return False
    
    uid = f"openclaw-{int(datetime.now().timestamp())}-{uuid.uuid4().hex[:8]}@openclaw.local"
    dtstamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    
    if all_day:
        if isinstance(start, str):
            start_date = datetime.fromisoformat(start).strftime('%Y%m%d')
        dtstart_line = f"DTSTART;VALUE=DATE:{start_date}"
        dtend_date = (datetime.strptime(start_date, '%Y%m%d') + timedelta(days=1)).strftime('%Y%m%d')
        dtend_line = f"DTEND;VALUE=DATE:{dtend_date}"
    else:
        if isinstance(start, str):
            start_dt = datetime.fromisoformat(start)
        else:
            start_dt = start
        end_dt = start_dt + timedelta(minutes=duration_min)
        dtstart_line = f"DTSTART:{start_dt.strftime('%Y%m%dT%H%M%S')}"
        dtend_line = f"DTEND:{end_dt.strftime('%Y%m%dT%H%M%S')}"
    
    ics = f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//OpenClaw//Jarvis//EN
BEGIN:VEVENT
UID:{uid}
DTSTAMP:{dtstamp}
{dtstart_line}
{dtend_line}
SUMMARY:{title}
LOCATION:{location}
DESCRIPTION:{description}
END:VEVENT
END:VCALENDAR"""
    
    filename = f"openclaw-{uuid.uuid4().hex[:12]}.ics"
    event_url = cal['url'].rstrip('/') + '/' + filename
    
    resp = session.put(event_url, data=ics.encode('utf-8'), headers={
        'Content-Type': 'text/calendar; charset=utf-8'
    })
    
    if resp.status_code in (201, 204):
        print(f"Created: {title} ({start})")
        return True
    else:
        print(f"Error creating event: {resp.status_code} {resp.text}")
        return False

def format_dt(dt):
    if dt is None:
        return '?'
    if isinstance(dt, date) and not isinstance(dt, datetime):
        return dt.strftime('%a %d.%m.%Y (ganztaegig)')
    if dt.tzinfo:
        # Convert to Berlin time
        from zoneinfo import ZoneInfo
        dt = dt.astimezone(ZoneInfo('Europe/Berlin'))
    return dt.strftime('%a %d.%m. %H:%M')

def main():
    parser = argparse.ArgumentParser(description='iCloud Calendar CLI')
    sub = parser.add_subparsers(dest='command')
    
    sub.add_parser('list-calendars')
    
    ev = sub.add_parser('list-events')
    ev.add_argument('--calendar', '-c', default=None, help='Calendar name (default: all)')
    ev.add_argument('--days', '-d', type=int, default=7)
    ev.add_argument('--json', action='store_true', help='Output as JSON')
    
    cr = sub.add_parser('create-event')
    cr.add_argument('--title', '-t', required=True)
    cr.add_argument('--start', '-s', required=True, help='ISO datetime')
    cr.add_argument('--duration', type=int, default=60, help='Minutes')
    cr.add_argument('--calendar', '-c', default='Kalender')
    cr.add_argument('--location', '-l', default='')
    cr.add_argument('--description', default='')
    cr.add_argument('--all-day', action='store_true')
    
    args = parser.parse_args()
    
    apple_id, app_pw = load_creds()
    session = requests.Session()
    session.auth = HTTPBasicAuth(apple_id, app_pw)
    
    if args.command == 'list-calendars':
        cals = list_calendars(session)
        for c in cals:
            print(f"  {c['name']}")
    
    elif args.command == 'list-events':
        events = list_events(session, args.calendar, args.days)
        if getattr(args, 'json', False):
            def dt_serial(o):
                if hasattr(o, 'isoformat'):
                    return o.isoformat()
                return str(o)
            out = []
            for e in events:
                dt = e.get('dtstart')
                out.append({
                    'summary': e.get('summary', ''),
                    'start': dt.isoformat() if hasattr(dt, 'isoformat') else str(dt or ''),
                    'end': (e.get('dtend').isoformat() if e.get('dtend') and hasattr(e.get('dtend'), 'isoformat') else str(e.get('dtend') or '')),
                    'location': e.get('location', ''),
                    'calendar': e.get('calendar', ''),
                })
            print(json.dumps(out, ensure_ascii=False, default=dt_serial))
        elif not events:
            print("Keine Events gefunden.")
        else:
            current_day = None
            for e in events:
                dt = e.get('dtstart')
                day_str = dt.strftime('%A, %d.%m.%Y') if dt else '?'
                if day_str != current_day:
                    current_day = day_str
                    print(f"\n{day_str}")
                    print('-' * len(day_str))
                loc = f" @ {e['location']}" if e.get('location') else ''
                cal_tag = f" [{e['calendar']}]" if e.get('calendar') else ''
                print(f"  {format_dt(dt)} | {e['summary']}{loc}{cal_tag}")
    
    elif args.command == 'create-event':
        create_event(session, args.title, args.start, args.duration, 
                     args.calendar, args.location, args.description, args.all_day)
    else:
        parser.print_help()

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    main()
