// Berufsprofile: Übersicht + Detail

const { useState: bpS, useEffect: bpE, useMemo: bpM } = React;
const { Shell, BERUFE, PORTRAITS } = window.Shared;

const KATEGORIEN = ['Alle', ...Array.from(new Set(BERUFE.map(b => b.kategorie)))];

// --- Detailseite ---
const DETAILS = {
  'pflegefachkraft': {
    lead: 'Examinierte Pflegefachkräfte begleiten Menschen in allen Lebenslagen — vom Frühchen bis zum letzten Atemzug. Seit 2020 gibt es die generalistische Ausbildung: eine Qualifikation, drei mögliche Spezialisierungen.',
    alltag: ['Grund- und Behandlungspflege in Schichten (Früh/Spät/Nacht)','Dokumentation in digitalen Pflegesystemen','Medikamentenstellung und Injektionen nach ärztlicher Anordnung','Angehörigengespräche, Beratung, Anleitung','Fachliche Einschätzung im Behandlungsteam'],
    passtzu: 'Menschen, die Nähe aushalten können, klare Entscheidungen treffen und mit Belastung umgehen. Wer Alltagstrubel liebt und nichts Monotones will.',
    nicht: 'Wer einen planbaren 9-to-5 möchte. Wer Schicht- und Wochenendarbeit nicht leben will. Wer mit Körpern, Geruch und Sterblichkeit nicht umgehen kann.',
  },
  'ux-designer': {
    lead: 'UX-Designer:innen gestalten die Schnittstelle zwischen Mensch und digitalem Produkt. Sie recherchieren, skizzieren, prototypisieren und validieren — bis ein Produkt sich so benutzt, als hätte es sich selbst gebaut.',
    alltag: ['User Research: Interviews, Usability-Tests, Verhaltensanalyse','Wireframes, Mockups und klickbare Prototypen in Figma','Abstimmung mit Product Management und Engineering','Design Systems pflegen, Komponenten dokumentieren','Reviews, Kritikrunden, Iteration'],
    passtzu: 'Menschen, die gerne beobachten, Muster erkennen und mit Unsicherheit umgehen. Wer Lust hat auf Team-Arbeit und ständigen Dialog.',
    nicht: 'Wer sich wünscht, dass Arbeit „fertig" ist. Wer Kritik persönlich nimmt. Wer nicht schreiben/argumentieren mag.',
  },
  'data-analyst': {
    lead: 'Data Analysts machen aus Datenbergen belastbare Antworten. SQL, ein bisschen Python, viel Domänenverständnis — und die Fähigkeit, ein Dashboard so zu bauen, dass Führungskräfte tatsächlich entscheiden.',
    alltag: ['Datenquellen anbinden, Qualität prüfen, Modelle bauen','Ad-hoc-Analysen für Produkt, Marketing oder Finance','Dashboards in Looker, Tableau oder PowerBI','Ergebnisse präsentieren — oft an Nicht-Technikerinnen','A/B-Test-Auswertung und Metrik-Definition'],
    passtzu: 'Menschen, die saubere Logik lieben, geduldig graben und gerne gut erklären. Wer Zahlen als Sprache sieht, nicht als Selbstzweck.',
    nicht: 'Wer Details langweilig findet. Wer ungern Fragen stellt. Wer ohne Kontext „einfach nur rechnen" möchte.',
  },
  'softwareentwickler': {
    lead: 'Softwareentwickler:innen bauen die Welt, in der wir digital leben — vom Online-Banking bis zur Kita-App. Sie lesen mehr Code, als sie schreiben, und diskutieren mehr, als man denkt.',
    alltag: ['Features entwerfen, implementieren, testen, deployen','Code Reviews und Pairing','Bugs reproduzieren, einkreisen, beheben','Architektur-Entscheidungen mit dem Team','Dokumentation und Stand-ups'],
    passtzu: 'Menschen, die Probleme zerlegen wollen, aus Frust lernen und ohne perfekte Infos loslegen können.',
    nicht: 'Wer Routine will. Wer sich nicht gerne in fremden Code einliest. Wer Angst vor englischer Fachsprache hat.',
  },
  'mechatroniker': {
    lead: 'Mechatroniker:innen arbeiten überall dort, wo Mechanik, Elektrik und Steuerung aufeinander treffen — im Maschinenbau, in der Automatisierung, bei Aufzügen, Windkraft oder Robotik.',
    alltag: ['Anlagen installieren, in Betrieb nehmen, warten','Fehler diagnostizieren mit Messgerät und Software','Bauteile austauschen, SPS programmieren','Kunden einweisen, Wartung dokumentieren','Arbeit auf Baustellen und in Werkshallen'],
    passtzu: 'Menschen, die gerne mit den Händen arbeiten und trotzdem technisch denken. Wer reisen darf und im Team zupacken kann.',
    nicht: 'Wer reines Büro sucht. Wer mit Lärm und Dreck nicht klarkommt.',
  },
  'kfz-mechatroniker': {
    lead: 'Kfz-Mechatroniker:innen sind die Allrounder am Fahrzeug — mit starkem Shift Richtung Elektroantriebe, Assistenzsysteme und Software-Diagnose.',
    alltag: ['Inspektionen und Wartung','Diagnose mit OBD und Herstellersoftware','Reparatur von Motor, Getriebe, Bremsen, Elektrik','Kundendialog am Empfang','Hochvolt-Fahrzeuge mit Zusatzqualifikation'],
    passtzu: 'Menschen, die an Autos schrauben und gleichzeitig mit Software umgehen wollen.',
    nicht: 'Wer ölige Hände scheut. Wer nicht gerne hebt und steht.',
  },
  'erzieher': {
    lead: 'Erzieher:innen begleiten Kinder und Jugendliche in der wichtigsten Entwicklungsphase ihres Lebens. Bildung, Bindung, Alltag — und sehr viel Beziehungsarbeit.',
    alltag: ['Morgenkreis, Freispiel, Projektangebote','Beobachten und dokumentieren','Elterngespräche','Ausflüge, Feste, Beschwerden','Team-Besprechungen und Konzeptarbeit'],
    passtzu: 'Menschen, die Kinder ernst nehmen. Wer Geduld, Humor und eine laute Stimme hat.',
    nicht: 'Wer Ruhe braucht. Wer schlecht improvisieren kann.',
  },
  'physiotherapeut': {
    lead: 'Physiotherapeut:innen bringen Menschen nach Verletzung, Operation oder mit chronischen Beschwerden zurück in Bewegung. Praxis, Klinik, Reha — oder mobil.',
    alltag: ['Anamnese und Befund','Manuelle Therapie, Übungen, Geräte','Patient:innen-Schulung','Dokumentation und Verordnungsabrechnung','Fortbildung (Manuelle Therapie, Lymphdrainage, …)'],
    passtzu: 'Wer Menschen mag, körperlich fit ist und gerne beibringt.',
    nicht: 'Wer hohe Gehälter zum Einstieg erwartet. Wer Körperkontakt scheut.',
  },
  'journalist': {
    lead: 'Journalist:innen recherchieren, prüfen, ordnen ein und erzählen. Egal ob Lokalzeitung, Magazin, Podcast oder Newsroom — das Handwerk ist dasselbe.',
    alltag: ['Themenideen und Konferenz','Recherche, Interviews, Quellenprüfung','Schreiben und Redigieren','Produktion (Schnitt, Grafik, Layout)','Ressort-Termine, Veröffentlichungszyklen'],
    passtzu: 'Wer neugierig ist, schnell schreibt und Kritik aushält.',
    nicht: 'Wer planbare Abende braucht. Wer nicht gerne telefoniert.',
  },
  'lehrkraft': {
    lead: 'Lehrkräfte begleiten Klassen über Jahre hinweg — fachlich, pädagogisch und menschlich. Der Beruf ist fordernd, aber er trifft wirklich etwas.',
    alltag: ['Unterricht vorbereiten und halten','Korrekturen, Zeugnisse, Konferenzen','Elterngespräche','Vertretungsstunden, Pausenaufsicht','Projekttage, Klassenfahrten'],
    passtzu: 'Wer Kinder/Jugendliche mag, strukturiert arbeitet und laut sein kann.',
    nicht: 'Wer Konflikten ausweicht. Wer keine Autorität übernehmen will.',
  },
  'steuerberater': {
    lead: 'Steuerberater:innen sind Vertraute ihrer Mandant:innen — zwischen Bilanz, Finanzamt und strategischer Beratung.',
    alltag: ['Jahresabschlüsse, Steuererklärungen','Lohnbuchhaltung','Beratung bei Gründung, Umstrukturierung','Kommunikation mit dem Finanzamt','Fortbildung: Steuerrecht ändert sich jedes Jahr'],
    passtzu: 'Wer sorgfältig arbeitet, Zahlen mag und gerne berät.',
    nicht: 'Wer Deadlines schlecht aushält. Wer keine Details mag.',
  },
  'polizist': {
    lead: 'Polizist:innen arbeiten in sehr verschiedenen Bereichen — Streife, Kripo, Autobahn, Spezialeinheit. Einstieg fast immer über den mittleren oder gehobenen Dienst.',
    alltag: ['Streifendienst, Einsatzfahrten','Anzeigenaufnahme, Vernehmung','Verkehrskontrollen, Unfallaufnahme','Schreibtischarbeit: Berichte, Akten','Fortbildung, Training, Sport'],
    passtzu: 'Wer Verantwortung mag, fit ist und klar kommunizieren kann.',
    nicht: 'Wer Hierarchie grundsätzlich ablehnt. Wer Schichtdienst nicht leben will.',
  },
  'koch': {
    lead: 'Köch:innen planen Karten, bestellen, bereiten vor, kochen auf Station und liefern ab — präzise, unter Druck, im Team.',
    alltag: ['Mise en Place','Service am Abend','Bestellung und Wareneingang','Speisenentwicklung','Reinigung und Hygienestandards'],
    passtzu: 'Wer Hitze, Tempo und klare Ansagen mag.',
    nicht: 'Wer freie Abende braucht. Wer Kritik persönlich nimmt.',
  },
  'tischler': {
    lead: 'Tischler:innen bauen individuelle Möbel, Einrichtungen und Innenausbauten — vom Auftragsgespräch bis zur Montage beim Kunden.',
    alltag: ['Aufmaß vor Ort','Zeichnen, CNC-Programmieren','Zuschnitt, Kantenanleimen, Montage','Oberflächenbehandlung','Lieferung und Aufbau'],
    passtzu: 'Wer mit Holz arbeiten liebt und sauberes Handwerk will.',
    nicht: 'Wer keine Staub-Allergie verträgt.',
  },
  'grafikdesigner': {
    lead: 'Grafikdesigner:innen gestalten visuelle Kommunikation — von Logos und Corporate Design bis zu Plakaten, Editorial, Social und Web.',
    alltag: ['Briefing und Konzept','Layouts in Adobe/Figma','Farben, Typo, Raster','Kundenabstimmung und Reinzeichnung','Druckbetreuung oder Handoff an Dev'],
    passtzu: 'Wer Form liebt und Feedback einbaut.',
    nicht: 'Wer sein Werk nicht verteidigen mag — oder nicht loslassen kann.',
  },
};
const FALLBACK_DETAIL = {
  lead: 'Eine ausführliche Beschreibung ist in Arbeit. Unten findest du die harten Fakten — wir ergänzen laufend.',
  alltag: ['Ein typischer Tag wird hier bald detailliert beschrieben.'],
  passtzu: 'Wird ergänzt.',
  nicht: 'Wird ergänzt.',
};

function useUrlParams() {
  const [params, setParams] = bpS(() => new URLSearchParams(window.location.search));
  bpE(() => {
    const onPop = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return params;
}

// ---------- Übersicht ----------
function Uebersicht() {
  const [kat, setKat] = bpS('Alle');
  const [search, setSearch] = bpS('');
  const [sort, setSort] = bpS('match');

  const filtered = bpM(() => {
    let list = BERUFE.filter(b =>
      (kat === 'Alle' || b.kategorie === kat) &&
      (search === '' || b.titel.toLowerCase().includes(search.toLowerCase()))
    );
    if (sort === 'match') list = [...list].sort((a,b) => b.match - a.match);
    if (sort === 'titel') list = [...list].sort((a,b) => a.titel.localeCompare(b.titel));
    if (sort === 'gehalt') list = [...list].sort((a,b) => parseInt(b.gehalt) - parseInt(a.gehalt));
    return list;
  }, [kat, search, sort]);

  return (
    <div className="container">
      <div className="page-head">
        <div className="eyebrow">Berufsprofile · {BERUFE.length} Profile</div>
        <h1>Alles, was zwischen<br/>dir und deinem <em>Beruf</em> steht.</h1>
        <p>Eine durchsuchbare Datenbank. Jeder Beruf mit Einstieg, Gehalt, Ausbildungsweg, Tagesablauf und ehrlicher Einschätzung für wen er nichts ist.</p>
      </div>

      <div className="filters">
        <div className="filter-group">
          {KATEGORIEN.map(k => (
            <button key={k}
              className={`filter-chip ${kat === k ? 'active' : ''}`}
              onClick={() => setKat(k)}>{k}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <input className="search-input" placeholder="suchen…" value={search}
          onChange={e => setSearch(e.target.value)} />
        <select className="search-input" value={sort} onChange={e => setSort(e.target.value)}
          style={{ minWidth: 140 }}>
          <option value="match">Sort: Match</option>
          <option value="titel">Sort: A–Z</option>
          <option value="gehalt">Sort: Gehalt</option>
        </select>
      </div>

      <div className="results-head">
        <span>{String(filtered.length).padStart(3, '0')} Ergebnisse</span>
        <span>Nr · Titel · Kategorie · Gehalt · Dauer</span>
      </div>

      <div>
        {filtered.map((b, i) => (
          <a key={b.slug} href={`berufsprofile.html?slug=${b.slug}`} className="list-row" style={{ textDecoration: 'none' }}>
            <div className="num">{String(i+1).padStart(3,'0')}</div>
            <div>
              <h3>{b.titel}</h3>
              <div className="desc">{b.kurz}</div>
            </div>
            <div><span className="pill">{b.kategorie}</span></div>
            <div className="data">€ {b.gehalt}</div>
            <div className="data">{b.dauer}</div>
            <div className="arr">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 17L17 7M17 7H9M17 7V15"/>
              </svg>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------- Detail ----------
function Detail({ slug }) {
  const b = BERUFE.find(x => x.slug === slug);
  if (!b) return <div className="container" style={{ padding: 80 }}>Beruf nicht gefunden. <a href="berufsprofile.html" style={{color: 'var(--accent)'}}>← Zurück</a></div>;
  const d = DETAILS[slug] || FALLBACK_DETAIL;

  return (
    <div className="container">
      <div style={{ padding: '40px 0 16px' }}>
        <a href="berufsprofile.html" style={{
          fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.15em',
          textTransform: 'uppercase', color: 'var(--ink-dim)',
        }}>← Alle Berufsprofile</a>
      </div>

      <div className="detail-grid">
        <div>
          <div className="eyebrow" style={{ color: 'var(--accent)' }}>{b.kategorie}</div>
          <h1 className="detail-title">{b.titel}</h1>
          <p className="detail-lead">{d.lead}</p>

          <div className="detail-body">
            <h4>Ein typischer Tag</h4>
            <ul>{d.alltag.map((a, i) => <li key={i}>{a}</li>)}</ul>

            <h4>Passt zu dir, wenn…</h4>
            <p>{d.passtzu}</p>

            <h4>Passt nicht, wenn…</h4>
            <p>{d.nicht}</p>

            <h4>Nächste Schritte</h4>
            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              <a href="berufstest.html" className="btn btn-primary">Berufstest machen →</a>
              <a href="#jobboersen" className="btn btn-ghost">Jobbörsen ansehen</a>
            </div>
          </div>
        </div>

        <aside>
          {PORTRAITS[slug] ? (
            <div className="detail-img" style={{
              aspectRatio: '3/4',
              backgroundImage: `url(${PORTRAITS[slug]})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              border: '0.5px solid var(--rule)',
              filter: 'saturate(0.9) contrast(1.02)',
            }} />
          ) : (
            <div className="placeholder-img detail-img">Cover · {b.titel}</div>
          )}
          <table className="detail-fact-table" style={{ marginTop: 28 }}>
            <tbody>
              <tr><td>Kategorie</td><td>{b.kategorie}</td></tr>
              <tr><td>Gehalt (brutto)</td><td>{b.gehalt} / Monat</td></tr>
              <tr><td>Ausbildungsweg</td><td>{b.dauer}</td></tr>
              <tr><td>Einstiegsalter</td><td>ab 16 Jahren</td></tr>
              <tr><td>Nachfrage</td><td>Hoch</td></tr>
              <tr><td>Digitalisierung</td><td>Mittel</td></tr>
              <tr><td>Dein Match</td><td style={{ color: 'var(--accent)' }}>{Math.round(b.match * 100)}%</td></tr>
            </tbody>
          </table>
        </aside>
      </div>
    </div>
  );
}

// ---------- App ----------
function App() {
  const params = useUrlParams();
  const slug = params.get('slug');

  return (
    <Shell active="berufsprofile">
      {slug ? <Detail slug={slug} /> : <Uebersicht />}
    </Shell>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
