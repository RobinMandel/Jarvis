// Shared components: Navbar, Footer, theme toggle, shell.
// Exposes window.Shared.* so each page can import.

const { useState: shS, useEffect: shE } = React;

const NAV_ITEMS = [
  { href: 'index.html',        label: 'Start',        key: 'start' },
  { href: 'berufsprofile.html', label: 'Berufsprofile', key: 'berufsprofile' },
  { href: 'berufstest.html',    label: 'Berufe-Test',  key: 'berufstest' },
  { href: 'just4fun.html',      label: 'Just4Fun',     key: 'just4fun' },
  { href: 'videos.html',        label: 'Videos',       key: 'videos' },
  { href: 'impressum.html',     label: 'Impressum',    key: 'impressum' },
];

function useTheme() {
  const [theme, setTheme] = shS(() => {
    try { return localStorage.getItem('rm.theme') || 'light'; } catch { return 'light'; }
  });
  shE(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('rm.theme', theme); } catch {}
  }, [theme]);
  return [theme, setTheme];
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <button className="theme-toggle" onClick={() => setTheme(next)}
      title={`Zu ${next === 'dark' ? 'Dunkel' : 'Hell'} wechseln`} aria-label="Theme toggle">
      {theme === 'light' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
        </svg>
      )}
    </button>
  );
}

function Navbar({ active }) {
  const [mobileOpen, setMobileOpen] = shS(false);
  shE(() => {
    document.body.classList.toggle('mobile-open', mobileOpen);
    return () => document.body.classList.remove('mobile-open');
  }, [mobileOpen]);
  return (
    <>
    <nav className="site-nav">
      <div className="site-nav-inner">
        <a href="index.html" className="site-brand">
          <span className="site-brand-dot" />
          robinmandel<span style={{color:'var(--ink-faint)'}}>.de</span>
        </a>
        <div className="site-nav-links">
          {NAV_ITEMS.map(item => (
            <a key={item.key} href={item.href}
              className={item.key === active ? 'active' : ''}>
              {item.label}
            </a>
          ))}
        </div>
        <div className="site-nav-right">
          <ThemeToggle />
          <a href="berufstest.html" className="btn btn-accent" style={{ padding: '10px 18px', fontSize: 10 }}>
            Test starten
          </a>
          <button className="site-nav-burger" aria-label="Menü öffnen" onClick={() => setMobileOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 7h16M4 12h16M4 17h16"/>
            </svg>
          </button>
        </div>
      </div>
    </nav>
    {mobileOpen && (
    <div className="mobile-menu" role="dialog" aria-modal="true"
         style={{position:'fixed',inset:0,zIndex:100,background:'var(--paper)',display:'flex',flexDirection:'column',padding:'80px 28px 40px'}}>
      <button className="mobile-menu-close" aria-label="Menü schließen" onClick={() => setMobileOpen(false)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M6 6l12 12M6 18L18 6"/>
        </svg>
      </button>
      {NAV_ITEMS.map((item, i) => (
        <a key={item.key} href={item.href}
           className={item.key === active ? 'active' : ''}
           onClick={() => setMobileOpen(false)}>
          {item.label}
          <span>{String(i+1).padStart(2,'0')}</span>
        </a>
      ))}
      <a href="berufstest.html" className="btn btn-accent" style={{ marginTop: 32, justifyContent: 'center' }}>
        Test starten →
      </a>
    </div>
    )}
    </>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="footer-brand">
          <h3>Finde deinen<br/>Beruf.</h3>
          <p>Ein Orientierungs-Werkzeug, gebaut 2020 von Robin & Dennis als Schulprojekt — {new Date().getFullYear()} neu aufgelegt.</p>
        </div>
        <div className="footer-col">
          <h4>Navigation</h4>
          <ul>
            {NAV_ITEMS.map(i => <li key={i.key}><a href={i.href}>{i.label}</a></li>)}
          </ul>
        </div>
        <div className="footer-col">
          <h4>Jobbörsen</h4>
          <ul>
            <li><a href="#" target="_blank" rel="noopener">stepstone.de ↗</a></li>
            <li><a href="#" target="_blank" rel="noopener">indeed.de ↗</a></li>
            <li><a href="#" target="_blank" rel="noopener">xing.com ↗</a></li>
            <li><a href="#" target="_blank" rel="noopener">arbeitsagentur.de ↗</a></li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>Sozial</h4>
          <ul>
            <li><a href="http://www.facebook.de" target="_blank" rel="noopener">Facebook ↗</a></li>
            <li><a href="http://www.pinterest.com" target="_blank" rel="noopener">Pinterest ↗</a></li>
            <li><a href="https://twitter.com/elonmusk" target="_blank" rel="noopener">Twitter ↗</a></li>
            <li><a href="mailto:robinmandel@outlook.de">E-Mail</a></li>
          </ul>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© 2020–{new Date().getFullYear()} · Robin &amp; Dennis · <span style={{color:'var(--ink-faint)'}}>Das ist unsere erste Website</span></span>
        <span>v2.0 · Relaunch</span>
      </div>
    </footer>
  );
}

function Shell({ active, children }) {
  return (
    <>
      <Navbar active={active} />
      <main>{children}</main>
      <Footer />
    </>
  );
}

// Portraits: Unsplash-URLs (frei nutzbar), gemappt per slug
const PORTRAITS = {
  'ux-designer': 'https://images.unsplash.com/photo-1580894732444-8ecded7900cd?w=800&q=80',
  'mechatroniker': 'https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=800&q=80',
  'pflegefachkraft': 'https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=800&q=80',
  'data-analyst': 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
  'erzieher': 'https://images.unsplash.com/photo-1587653263995-422546a7a569?w=800&q=80',
  'kfz-mechatroniker': 'https://images.unsplash.com/photo-1632823471406-4c5c7d6bf9a0?w=800&q=80',
  'steuerberater': 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800&q=80',
  'journalist': 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800&q=80',
  'physiotherapeut': 'https://images.unsplash.com/photo-1599458252573-56ae36120de1?w=800&q=80',
  'tischler': 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=800&q=80',
  'landwirt': 'https://images.unsplash.com/photo-1500595046743-cd271d694d30?w=800&q=80',
  'lehrkraft': 'https://images.unsplash.com/photo-1580582932707-520aed937b7b?w=800&q=80',
  'softwareentwickler': 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&q=80',
  'elektroniker': 'https://images.unsplash.com/photo-1565043666747-69f6646db940?w=800&q=80',
  'mfa': 'https://images.unsplash.com/photo-1584515933487-779824d29309?w=800&q=80',
  'zerspanungsmechaniker': 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=800&q=80',
  'bankkaufmann': 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80',
  'industriekaufmann': 'https://images.unsplash.com/photo-1573164713714-d95e436ab8d6?w=800&q=80',
  'architekt': 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800&q=80',
  'psychologe': 'https://images.unsplash.com/photo-1573495627361-d9b87960b12d?w=800&q=80',
  'polizist': 'https://images.unsplash.com/photo-1594736797933-d0401ba2fe65?w=800&q=80',
  'koch': 'https://images.unsplash.com/photo-1577219491135-ce391730fb2c?w=800&q=80',
  'friseur': 'https://images.unsplash.com/photo-1562322140-8baeececf3df?w=800&q=80',
  'baecker': 'https://images.unsplash.com/photo-1568254183919-78a4f43a2877?w=800&q=80',
  'verkaeufer': 'https://images.unsplash.com/photo-1607082349566-187342175e2f?w=800&q=80',
  'fotograf': 'https://images.unsplash.com/photo-1554080353-a576cf803bda?w=800&q=80',
  'anwalt': 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=800&q=80',
  'notfallsanitaeter': 'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?w=800&q=80',
  'chemielaborant': 'https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=800&q=80',
  'grafikdesigner': 'https://images.unsplash.com/photo-1558655146-d09347e92766?w=800&q=80',
};

// Shared data: Berufsprofile
const BERUFE = [
  { slug: 'ux-designer', titel: 'UX Designer:in', kategorie: 'Design & Tech', gehalt: '3.200–5.400€', dauer: 'Studium 3–4 J.', match: 0.92, kurz: 'Gestaltet digitale Produkte so, dass sie Menschen intuitiv benutzen können.' },
  { slug: 'data-analyst', titel: 'Data Analyst:in', kategorie: 'Design & Tech', gehalt: '3.800–6.200€', dauer: 'Studium 3 J.', match: 0.88, kurz: 'Findet Muster in Daten und übersetzt sie in Entscheidungen für Unternehmen.' },
  { slug: 'softwareentwickler', titel: 'Softwareentwickler:in', kategorie: 'Design & Tech', gehalt: '3.600–6.800€', dauer: 'Ausbildung 3 J. / Studium', match: 0.84, kurz: 'Schreibt Programme und Systeme — Web, Mobile, Backend oder Eingebettet.' },
  { slug: 'grafikdesigner', titel: 'Grafikdesigner:in', kategorie: 'Design & Tech', gehalt: '2.600–4.200€', dauer: 'Studium 3 J. / Ausbildung', match: 0.82, kurz: 'Gestaltet visuelle Kommunikation — Print, Branding, Editorial, Web.' },
  { slug: 'journalist', titel: 'Journalist:in', kategorie: 'Medien & Kultur', gehalt: '2.800–4.800€', dauer: 'Volontariat + Studium', match: 0.77, kurz: 'Recherchiert, ordnet ein und erzählt — print, online, audio oder bewegt.' },
  { slug: 'fotograf', titel: 'Fotograf:in', kategorie: 'Medien & Kultur', gehalt: '2.000–4.000€', dauer: 'Ausbildung 3 J.', match: 0.74, kurz: 'Fängt Momente ein — Reportage, Porträt, Produkt, Mode oder Architektur.' },
  { slug: 'architekt', titel: 'Architekt:in', kategorie: 'Medien & Kultur', gehalt: '3.500–6.000€', dauer: 'Studium 5 J.', match: 0.72, kurz: 'Entwirft Gebäude und Räume — Idee, Planung, Baustelle, Übergabe.' },
  { slug: 'mechatroniker', titel: 'Mechatroniker:in', kategorie: 'Handwerk & Technik', gehalt: '2.700–4.200€', dauer: 'Ausbildung 3,5 J.', match: 0.71, kurz: 'Installiert und wartet Systeme an der Schnittstelle von Mechanik und Elektronik.' },
  { slug: 'lehrkraft', titel: 'Lehrkraft', kategorie: 'Bildung', gehalt: '3.800–5.500€', dauer: 'Studium + Ref.', match: 0.69, kurz: 'Unterrichtet und begleitet Schüler:innen durch ihre Schulzeit.' },
  { slug: 'pflegefachkraft', titel: 'Pflegefachkraft', kategorie: 'Gesundheit & Soziales', gehalt: '2.900–4.000€', dauer: 'Ausbildung 3 J.', match: 0.65, kurz: 'Begleitet und versorgt Menschen in allen Lebenslagen — generalistisch ausgebildet.' },
  { slug: 'physiotherapeut', titel: 'Physiotherapeut:in', kategorie: 'Gesundheit & Soziales', gehalt: '2.500–3.600€', dauer: 'Ausbildung 3 J.', match: 0.63, kurz: 'Hilft Menschen nach Verletzung und Krankheit zurück in Bewegung.' },
  { slug: 'psychologe', titel: 'Psycholog:in', kategorie: 'Gesundheit & Soziales', gehalt: '3.400–5.500€', dauer: 'Studium 5 J.', match: 0.66, kurz: 'Untersucht Erleben und Verhalten — Klinik, Forschung, Personal oder Beratung.' },
  { slug: 'notfallsanitaeter', titel: 'Notfallsanitäter:in', kategorie: 'Gesundheit & Soziales', gehalt: '2.800–3.900€', dauer: 'Ausbildung 3 J.', match: 0.61, kurz: 'Erstversorgung im Rettungsdienst — stabilisieren, entscheiden, transportieren.' },
  { slug: 'mfa', titel: 'Medizinische Fachangestellte', kategorie: 'Gesundheit & Soziales', gehalt: '2.200–3.100€', dauer: 'Ausbildung 3 J.', match: 0.60, kurz: 'Praxisorganisation, Patient:innen-Kontakt und medizinische Assistenz.' },
  { slug: 'erzieher', titel: 'Erzieher:in', kategorie: 'Gesundheit & Soziales', gehalt: '2.800–3.900€', dauer: 'Ausbildung 3 J.', match: 0.58, kurz: 'Begleitet Kinder und Jugendliche in Kitas, Heimen und Ganztagsangeboten.' },
  { slug: 'anwalt', titel: 'Rechtsanwält:in', kategorie: 'Wirtschaft & Recht', gehalt: '3.800–9.500€', dauer: 'Studium + Ref.', match: 0.56, kurz: 'Vertritt Mandant:innen — Strafrecht, Zivilrecht, Arbeitsrecht oder Wirtschaft.' },
  { slug: 'steuerberater', titel: 'Steuerberater:in', kategorie: 'Wirtschaft & Recht', gehalt: '4.500–8.000€', dauer: 'Studium + Examen', match: 0.54, kurz: 'Berät Unternehmen und Privatleute in steuerlichen und wirtschaftlichen Fragen.' },
  { slug: 'bankkaufmann', titel: 'Bankkaufmann:frau', kategorie: 'Wirtschaft & Recht', gehalt: '2.700–4.500€', dauer: 'Ausbildung 3 J.', match: 0.52, kurz: 'Berät Kund:innen bei Finanzprodukten, Krediten und Geldanlagen.' },
  { slug: 'industriekaufmann', titel: 'Industriekaufmann:frau', kategorie: 'Wirtschaft & Recht', gehalt: '2.800–4.400€', dauer: 'Ausbildung 3 J.', match: 0.50, kurz: 'Kaufmännische Prozesse in Industriebetrieben — Einkauf, Vertrieb, Controlling.' },
  { slug: 'polizist', titel: 'Polizist:in', kategorie: 'Öffentlicher Dienst', gehalt: '2.800–4.500€', dauer: 'Ausbildung 2,5–3 J.', match: 0.55, kurz: 'Gefahrenabwehr, Strafverfolgung, Verkehr — je nach Dienstzweig und Laufbahn.' },
  { slug: 'kfz-mechatroniker', titel: 'Kfz-Mechatroniker:in', kategorie: 'Handwerk & Technik', gehalt: '2.600–3.800€', dauer: 'Ausbildung 3,5 J.', match: 0.49, kurz: 'Repariert und wartet Fahrzeuge — zunehmend auch Elektroantriebe.' },
  { slug: 'elektroniker', titel: 'Elektroniker:in', kategorie: 'Handwerk & Technik', gehalt: '2.500–3.900€', dauer: 'Ausbildung 3,5 J.', match: 0.48, kurz: 'Installiert und prüft elektrische Anlagen in Gebäuden und Anlagen.' },
  { slug: 'zerspanungsmechaniker', titel: 'Zerspanungsmechaniker:in', kategorie: 'Handwerk & Technik', gehalt: '2.600–3.900€', dauer: 'Ausbildung 3,5 J.', match: 0.45, kurz: 'Fertigt Präzisionsteile an CNC-Maschinen — für Industrie, Luft- und Raumfahrt.' },
  { slug: 'chemielaborant', titel: 'Chemielaborant:in', kategorie: 'Natur & Umwelt', gehalt: '2.700–3.900€', dauer: 'Ausbildung 3,5 J.', match: 0.44, kurz: 'Führt Analysen und Synthesen durch — in Forschung, QS und Produktion.' },
  { slug: 'tischler', titel: 'Tischler:in', kategorie: 'Handwerk & Technik', gehalt: '2.400–3.600€', dauer: 'Ausbildung 3 J.', match: 0.42, kurz: 'Entwirft und baut Möbel und Einrichtungen aus Holz und Holzwerkstoffen.' },
  { slug: 'koch', titel: 'Koch:Köchin', kategorie: 'Handwerk & Technik', gehalt: '2.300–3.600€', dauer: 'Ausbildung 3 J.', match: 0.40, kurz: 'Plant Karten, bereitet vor, kocht auf Station — in Restaurants, Hotels, Kantinen.' },
  { slug: 'baecker', titel: 'Bäcker:in', kategorie: 'Handwerk & Technik', gehalt: '2.100–3.300€', dauer: 'Ausbildung 3 J.', match: 0.39, kurz: 'Bereitet Teige, backt Brot und Gebäck — nachts, sehr früh, handwerklich.' },
  { slug: 'friseur', titel: 'Friseur:in', kategorie: 'Handwerk & Technik', gehalt: '1.900–2.800€', dauer: 'Ausbildung 3 J.', match: 0.39, kurz: 'Schneidet, färbt, stylt — Beratung und Handwerk im direkten Kundenkontakt.' },
  { slug: 'landwirt', titel: 'Landwirt:in', kategorie: 'Natur & Umwelt', gehalt: '2.300–3.500€', dauer: 'Ausbildung 3 J.', match: 0.38, kurz: 'Bewirtschaftet Flächen und hält Tiere — zunehmend digital und nachhaltig.' },
  { slug: 'verkaeufer', titel: 'Verkäufer:in', kategorie: 'Wirtschaft & Recht', gehalt: '2.000–2.900€', dauer: 'Ausbildung 2–3 J.', match: 0.36, kurz: 'Beratung, Kasse, Warenpflege — im Einzelhandel, Fach- oder Lebensmittelgeschäft.' },
];

window.Shared = { Shell, Navbar, Footer, ThemeToggle, NAV_ITEMS, BERUFE, PORTRAITS, useTheme };
