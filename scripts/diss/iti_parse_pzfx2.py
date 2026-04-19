import xml.etree.ElementTree as ET
import os, glob, re

base = r'E:\OneDrive\Dokumente\Studium\!!Medizin\03 Doktorarbeit\ITI\Cardiochirurgie'
NS = 'http://graphpad.com/prism/Prism.htm'

def parse_pzfx(fp):
    try:
        tree = ET.parse(fp)
        root = tree.getroot()
        ns = {'p': NS}
        tables = root.findall('.//p:Table', ns)
        if not tables:
            # try without ns
            tables = root.findall('.//Table')
        results = []
        for t in tables:
            title = t.get('Title', t.get('title', 'untitled'))
            # YColumn with ns
            ycols = t.findall('p:YColumn', ns) or t.findall('YColumn')
            subcs = t.findall('p:Subcolumn', ns) or t.findall('Subcolumn')
            ynames = [y.get('Title', y.get('title','?')) for y in ycols]
            # collect numeric values from d elements
            vals = []
            for sc in subcs[:2]:
                for d in (sc.findall('p:d', ns) or sc.findall('d'))[:5]:
                    if d.text and d.text.strip(): vals.append(d.text.strip())
            results.append({'title': title, 'ycols': ynames, 'sample_vals': vals[:6]})
        return {'tables': len(tables), 'info': results[:4]}
    except Exception as e:
        return {'error': str(e)}

# Focus on key ELISA files
key_files = [
    r'Elisa\NGAL\20240708_ELISA_NGAL_Kardio_alle_n_26.pzfx',
    r'Elisa\TIMP2\20240708_ELISA_TIMP2_Kardio_alle_n_26.pzfx',
    r'Elisa\MMP9\20240708_Kardio_Teil_II_Auswertung_MMP9_alle_n_26.pzfx',
    r'Elisa\IL18\20240627_ELISA_IL18_Kardio_alle_n_26.pzfx',
    r'Elisa\Claudin\20240708_Claudin1_Auswertung_Kardio_KC_alle_n_26.pzfx',
]

for rel in key_files:
    fp = os.path.join(base, rel)
    if not os.path.exists(fp):
        # try glob
        matches = glob.glob(os.path.join(base, '**', os.path.basename(fp)), recursive=True)
        fp = matches[0] if matches else None
    if not fp:
        print(f"MISSING: {rel}")
        continue
    r = parse_pzfx(fp)
    print(f"\n=== {os.path.basename(fp)} ===")
    if 'error' in r:
        print(f"  ERROR: {r['error']}")
    else:
        print(f"  Tables: {r['tables']}")
        for ti in r['info']:
            print(f"  [{ti['title']}] YCols={ti['ycols']} | Vals={ti['sample_vals']}")

# Also check TRAKI .prism files (ZIP)
import zipfile, json
traki_prism = glob.glob(os.path.join(base, '**', '*TRAKI*.prism'), recursive=True)
print(f"\n=== TRAKI .prism files: {len(traki_prism)} ===")
for fp in traki_prism[:3]:
    print(f"  {os.path.basename(fp)}")
    try:
        with zipfile.ZipFile(fp) as z:
            names = z.namelist()
            print(f"    ZIP contents: {names}")
            for n in names[:3]:
                data = z.read(n)
                snippet = data[:300].decode('utf-8','ignore')
                print(f"    {n}: {snippet[:150]}")
    except Exception as e:
        print(f"    ERROR: {e}")
