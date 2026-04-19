#!/usr/bin/env python3
"""Create AKI dissertation Anki cards in Jarvis style."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
exec(open(os.path.join(os.path.dirname(__file__), 'anki-api.py')).read().split("if __name__")[0])

CSS = '<style>:root{--bg:#111315;--panel:#1b1e22;--panel2:#23272d;--text:#eceff4;--accent:#d8b36a;--red:#ff7b72;--red-dim:#ff7b7244;--green:#7ee787;--blue:#79c0ff;--yellow:#f2cc60;--purple:#d2a8ff;--orange:#ffb86b}.card{margin:0!important;background:var(--bg)!important;color:var(--text)!important;font-family:"Segoe UI",Inter,sans-serif;font-size:19px;line-height:1.55;text-align:left}.wrap{max-width:820px;margin:20px auto;background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid #2a2f36;border-radius:16px;padding:28px 32px;box-shadow:0 8px 32px rgba(0,0,0,.45)}.fach-badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:.5px;margin-bottom:14px}.q{font-size:20px;font-weight:600;margin:0 0 18px}.cloze{color:var(--accent)!important;font-weight:700;border-bottom:2px solid var(--accent);padding-bottom:1px}hr.sep{border:0;border-top:1px solid #2a2f36;margin:18px 0}.extra-box{background:#161819;border:1px solid #2a2f36;border-radius:12px;padding:16px 20px;margin-top:14px;font-size:16px;line-height:1.5}.amboss-box{background:#1a2332;border:1px solid #234;border-radius:10px;padding:12px 16px;margin-top:12px;font-size:14px;color:#79c0ff}img{max-width:100%;border-radius:10px;margin:12px 0}.timer-bar{height:6px;border-radius:3px;margin:10px 0}.osce-label{font-size:13px;color:var(--accent);font-weight:700;letter-spacing:1px;margin-bottom:8px}</style>'

BADGE = '<span class="fach-badge" style="background:#dc2626;color:#fff">\u2764\ufe0f Kardiochirurgie</span>'
DECK = 'Medizin::Doktorarbeit::AKI-Kardiochirurgie'

create_deck(DECK)

# 1. KDIGO
add_cloze_card(deck=DECK, text=CSS + f'''<div class="wrap">
{BADGE}
<div class="q">KDIGO-Klassifikation der Acute Kidney Injury (AKI)</div>

<b>Stadium 1:</b> Kreatinin {{{{c1::>= 0,3 mg/dl Anstieg in 48h}}}} ODER {{{{c1::>= 1,5-1,9x Baseline in 7d}}}} ODER Urin {{{{c1::< 0,5 ml/kg/h fuer 6-12h}}}}<br><br>
<b>Stadium 2:</b> Kreatinin {{{{c2::2,0-2,9x Baseline}}}} ODER Urin {{{{c2::< 0,5 ml/kg/h fuer >= 12h}}}}<br><br>
<b>Stadium 3:</b> Kreatinin {{{{c3::>= 3,0x Baseline}}}} ODER {{{{c3::>= 4,0 mg/dl}}}} ODER {{{{c3::Dialysebeginn}}}} ODER {{{{c3::Anurie >= 12h}}}}

<hr class="sep">
<div class="extra-box">
<b>Kerninfo</b><br>
\u2022 KDIGO = Kidney Disease: Improving Global Outcomes (2012)<br>
\u2022 Kreatinin UND Urinkriterium \u2014 das jeweils schlechtere zaehlt<br>
\u2022 Baseline = niedrigster Wert der letzten 7 Tage
</div>
<div class="amboss-box">
\U0001f4a1 <b>Klinisch:</b> Kreatinin steigt erst 24-48h nach Schaedigung \u2014 bei V.a. AKI fruehe Biomarker (NGAL, Cystatin C) erwaegen!
</div>
</div>''', tags=['aki', 'kdigo', 'doktorarbeit', 'nephrologie', 'osce'])
print('1/5 KDIGO')

# 2. Neutrophile
add_cloze_card(deck=DECK, text=CSS + f'''<div class="wrap">
{BADGE}
<div class="q">Rolle der Neutrophilen bei AKI nach Herzchirurgie</div>

Der kardiopulmonale Bypass fuehrt zur {{{{c1::Aktivierung des Komplementsystems (C3a, C5a)}}}} und einer {{{{c1::systemischen Inflammationsreaktion (SIRS)}}}}.<br><br>

Aktivierte Neutrophile setzen frei:<br>
\u2022 {{{{c2::NETs (Neutrophil Extracellular Traps)}}}}<br>
\u2022 {{{{c2::MPO (Myeloperoxidase)}}}}<br>
\u2022 {{{{c2::ROS (reaktive Sauerstoffspezies)}}}}<br><br>

Dies fuehrt zur {{{{c3::renalen Ischaemie-Reperfusions-Schaedigung}}}} mit tubulaerer Nekrose.

<hr class="sep">
<div class="extra-box">
<b>Kerninfo</b><br>
\u2022 Schluesselmarker: CD11b (Neutrophilen-Aktivierung), NGAL, MPO<br>
\u2022 AG Huber Lang: Multimodal Monitoring of Neutrophil Activity<br>
\u2022 Jovanovski et al. (2025): Referenzarbeit
</div>
</div>''', tags=['aki', 'neutrophile', 'sirs', 'doktorarbeit', 'pathogenese', 'osce'])
print('2/5 Neutrophile')

# 3. Biomarker
add_cloze_card(deck=DECK, text=CSS + f'''<div class="wrap">
{BADGE}
<div class="q">Fruehe AKI-Biomarker nach Herzchirurgie</div>

{{{{c1::NGAL}}}} (Neutrophil Gelatinase-Associated Lipocalin): Anstieg {{{{c1::2-6h}}}} nach Schaden<br><br>
{{{{c2::MPO}}}} (Myeloperoxidase): Marker fuer {{{{c2::Neutrophilen-Aktivierung}}}}<br><br>
{{{{c3::KIM-1}}}} (Kidney Injury Molecule-1): {{{{c3::tubulaerer Schadensmarker}}}}<br><br>
{{{{c4::Cystatin C}}}}: GFR-Marker, steigt {{{{c4::frueher als Kreatinin}}}}<br><br>
{{{{c5::IL-18}}}}: {{{{c5::proinflammatorisches Zytokin}}}}

<hr class="sep">
<div class="extra-box">
<b>Kerninfo</b><br>
\u2022 Kreatinin steigt erst nach 24-48h \u2192 zu spaet fuer fruehe Intervention<br>
\u2022 NGAL: bester Einzelmarker fuer fruehe AKI-Detektion<br>
\u2022 Kombination mehrerer Biomarker erhoeht Sensitivitaet + Spezifitaet
</div>
<div class="amboss-box">
\U0001f4a1 <b>Klinisch:</b> NGAL im Urin: PPV ~80% fuer AKI wenn > 150 ng/ml innerhalb 6h postop
</div>
</div>''', tags=['aki', 'biomarker', 'ngal', 'mpo', 'doktorarbeit', 'osce'])
print('3/5 Biomarker')

# 4. OSCE-Fall
add_cloze_card(deck=DECK, text=CSS + f'''<div class="wrap">
<div class="osce-label">\u23f1 OSCE STATION \u2014 6 MIN</div>
<div class="timer-bar" style="background:linear-gradient(90deg,var(--green) 0%,var(--yellow) 50%,var(--red) 100%)"></div>
{BADGE}
<div class="q">Patient 68J, Z.n. CABG vor 12h. Urin 0,3 ml/kg/h seit 6h. Krea praeop 1,0 \u2192 jetzt 1,4 mg/dl.</div>

<b>Diagnose:</b> {{{{c1::AKI Stadium 1 nach KDIGO}}}} (Krea +0,4 in 48h + Oligurie)<br><br>

<b>Sofortmassnahmen:</b><br>
\u2022 {{{{c2::Volumenstatus pruefen}}}} (ZVD, PICCO, Echo)<br>
\u2022 {{{{c2::MAP > 65 mmHg sicherstellen}}}}<br>
\u2022 {{{{c2::Nephrotoxika stoppen}}}} (NSAR, Aminoglykoside, Vancomycin)<br>
\u2022 Diuretika {{{{c2::nur bei Hypervolaemie}}}}<br><br>

<b>Monitoring:</b> {{{{c3::stuendliche Bilanzierung}}}}, Krea alle {{{{c3::6-12h}}}}, {{{{c3::Elektrolyte (K+, pH)}}}}<br><br>

<b>Eskalation:</b> {{{{c4::Nephrologisches Konsil}}}}, {{{{c4::Nierenersatztherapie}}}} bei refraktaerer Hyperkaliämie/Azidose/Ueberwaesserung

<hr class="sep">
<div class="extra-box">
<b>Kerninfo</b><br>
\u2022 Haeufigste Ursache postop: haemodynamisch (low output) + nephrotoxisch<br>
\u2022 Fruehe Volumengabe verbessert Outcome signifikant<br>
\u2022 Furosemid-Stresstest: 1,0-1,5 mg/kg \u2192 Urin < 200 ml/2h = hohes AKI-Risiko
</div>
</div>''', tags=['aki', 'osce', 'kardiochirurgie', 'doktorarbeit', 'management', 'OSCE-Fall'])
print('4/5 OSCE-Fall')

# 5. Risikofaktoren
add_cloze_card(deck=DECK, text=CSS + f'''<div class="wrap">
{BADGE}
<div class="q">Risikofaktoren fuer AKI nach kardiochirurgischen Eingriffen</div>

<b>Praeoperativ:</b><br>
\u2022 {{{{c1::Diabetes mellitus}}}}<br>
\u2022 {{{{c1::Vorbestehende CKD (eGFR < 60)}}}}<br>
\u2022 {{{{c1::Alter > 70 Jahre}}}}<br>
\u2022 {{{{c1::LVEF < 35%}}}}<br><br>

<b>Intraoperativ:</b><br>
\u2022 {{{{c2::CPB-Zeit > 120 min}}}}<br>
\u2022 {{{{c2::Aortenklemm-Zeit > 60 min}}}}<br>
\u2022 {{{{c2::Hypothermie}}}}<br>
\u2022 {{{{c2::Haemolyse durch HLM}}}}<br><br>

<b>Postoperativ:</b><br>
\u2022 {{{{c3::Low cardiac output}}}}<br>
\u2022 {{{{c3::Nephrotoxische Medikamente}}}}<br>
\u2022 {{{{c3::Sepsis / SIRS}}}}<br>
\u2022 {{{{c3::Kontrastmittelgabe}}}}

<hr class="sep">
<div class="extra-box">
<b>Kerninfo</b><br>
\u2022 Inzidenz AKI nach Herzchirurgie: 20-40%<br>
\u2022 Mortalitaet bei Stadium 3: bis 60%<br>
\u2022 Jedes AKI-Stadium erhoeht Langzeitrisiko fuer CKD
</div>
<div class="amboss-box">
\U0001f4a1 <b>Klinisch:</b> Cleveland Clinic Score und STS Score schaetzen praeoperatives AKI-Risiko ab
</div>
</div>''', tags=['aki', 'kardiochirurgie', 'doktorarbeit', 'risikofaktoren', 'osce'])
print('5/5 Risikofaktoren')

print('\n=== 5 Karten im Jarvis-Design erstellt ===')
