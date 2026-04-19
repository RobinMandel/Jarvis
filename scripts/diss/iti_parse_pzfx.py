import xml.etree.ElementTree as ET
import os, glob

base = r'E:\OneDrive\Dokumente\Studium\!!Medizin\03 Doktorarbeit\ITI\Cardiochirurgie'

pzfx_files = glob.glob(os.path.join(base, '**', '*.pzfx'), recursive=True)
print(f"Total .pzfx: {len(pzfx_files)}")

summaries = []
for fp in sorted(pzfx_files):
    fname = os.path.basename(fp)
    try:
        tree = ET.parse(fp)
        root = tree.getroot()
        tables = root.findall('.//Table')
        analyses = root.findall('.//InferentialStat')
        graph_count = len(root.findall('.//Graph'))

        table_info = []
        for t in tables[:5]:
            title = t.get('Title', t.get('title', 'untitled'))
            # Get YColumn titles
            ycols = t.findall('.//YColumn')
            ynames = [y.get('Title', y.get('title','')) for y in ycols[:4]]
            # Try to find p-values
            pvals = []
            for stat in t.findall('.//InferentialStat'):
                p = stat.get('P', '')
                if p: pvals.append(p)
            table_info.append({
                'title': title,
                'ycols': ynames,
                'pvals': pvals[:3]
            })

        summaries.append({
            'file': fname,
            'tables': len(tables),
            'graphs': graph_count,
            'table_info': table_info
        })
    except Exception as e:
        summaries.append({'file': fname, 'error': str(e)})

# Print key files
key_keywords = ['alle', 'NGAL', 'TIMP2', 'MMP9', 'IL18', 'Claudin', 'Legendplex', 'TRAKI', 'CD11b', 'CD66b', 'kidney']
for s in summaries:
    fname = s['file']
    if any(k.lower() in fname.lower() for k in key_keywords):
        print(f"\n=== {fname} ===")
        if 'error' in s:
            print(f"  ERROR: {s['error']}")
            continue
        print(f"  Tables: {s['tables']} | Graphs: {s['graphs']}")
        for ti in s['table_info']:
            print(f"  Table: {ti['title']!r} | YCols: {ti['ycols']} | p-vals: {ti['pvals']}")
