// Startseite

const { useState: iS, useEffect: iE } = React;
const { Shell, BERUFE, PORTRAITS } = window.Shared;

// 5 Hero-Varianten via Tweaks: editorial / quicktest / datagrid / magazine / minimal
function HeroEditorial({ onStart }) {
  return (
    <section className="hero">
      <div className="container">
        <div className="hero-grid">
          <div>
            <div className="hero-eyebrow">Seit 2020 · Relaunch 2026</div>
            <h1>
              Welcher Beruf<br/>
              passt <em>wirklich</em><br/>
              zu dir?
            </h1>
            <p className="hero-sub">
              Drei Minuten, fünfzehn Fragen, ein ehrliches Profil. Wir haben 120+ Berufe so aufgeschrieben, wie wir sie uns selbst gewünscht hätten — ohne Floskeln, mit Gehalt, Ausbildungsweg und was einen Tag wirklich ausmacht.
            </p>
            <div className="hero-cta">
              <a href="berufstest.html" className="btn btn-primary">Berufstest starten →</a>
              <a href="berufsprofile.html" className="btn btn-ghost">Profile ansehen</a>
            </div>
          </div>
          <HeroSideCard onStart={onStart} />
        </div>
        <HeroStats />
      </div>
    </section>
  );
}

function HeroSideCard({ onStart }) {
  const [answer, setAnswer] = iS(null);
  const opts = [
    { k: 'A', t: 'Ich will etwas Sichtbares schaffen.' },
    { k: 'B', t: 'Ich will Probleme analysieren und lösen.' },
    { k: 'C', t: 'Ich will mit Menschen direkt arbeiten.' },
    { k: 'D', t: 'Ich will draußen und in Bewegung sein.' },
  ];
  return (
    <div className="hero-aside">
      <div className="hero-aside-card">
        <h3>Warm-up · 1 von 15</h3>
        <div className="quicktest-q">Was ist dir im Arbeitsalltag am wichtigsten?</div>
        <div className="quicktest-opts">
          {opts.map(o => (
            <button key={o.k} className="quicktest-btn"
              onClick={() => { setAnswer(o.k); setTimeout(() => window.location.href='berufstest.html?a='+o.k, 350); }}
              style={answer===o.k?{background:'var(--ink)', color:'var(--paper)', borderColor:'var(--ink)'}:null}
            >
              <span>{o.t}</span>
              <span className="num">{o.k}</span>
            </button>
          ))}
        </div>
        <div style={{
          marginTop: 18, paddingTop: 14, borderTop: '0.5px dashed var(--rule)',
          display: 'flex', justifyContent: 'space-between',
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em',
          textTransform: 'uppercase', color: 'var(--ink-faint)',
        }}>
          <span>Ø 3 Min.</span><span>15 Fragen</span><span>Anonym</span>
        </div>
      </div>
    </div>
  );
}

function HeroStats() {
  return (
    <div className="hero-stats">
      {[
        ['124', 'Berufsprofile'],
        ['15', 'Testfragen'],
        ['6', 'Jahre online'],
        ['0€', 'Kosten'],
      ].map(([n,l]) => (
        <div key={l} className="hero-stat">
          <span className="num">{n}</span>
          <span className="lbl">{l}</span>
        </div>
      ))}
    </div>
  );
}

function HeroMinimal() {
  return (
    <section className="hero" style={{ padding: '140px 0 120px' }}>
      <div className="container" style={{ textAlign: 'center' }}>
        <div className="hero-eyebrow" style={{ justifyContent: 'center' }}>Berufsorientierung · seit 2020</div>
        <h1 style={{ fontSize: 140, lineHeight: 0.9, maxWidth: 1100, margin: '0 auto' }}>
          Was <em>machst</em><br/>du einmal?
        </h1>
        <p className="hero-sub" style={{ margin: '36px auto 0', textAlign: 'center' }}>
          Drei Minuten ehrliche Selbsteinschätzung. Danach {BERUFE.length}+ Berufe, sortiert nach dem, was wirklich zu dir passt.
        </p>
        <div className="hero-cta" style={{ justifyContent: 'center' }}>
          <a href="berufstest.html" className="btn btn-primary">Berufstest starten →</a>
          <a href="berufsprofile.html" className="btn btn-ghost">Profile ansehen</a>
        </div>
      </div>
    </section>
  );
}

function HeroDatagrid() {
  return (
    <section className="hero">
      <div className="container">
        <div className="hero-eyebrow">Datenbank · {BERUFE.length} Berufe</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 80, alignItems: 'end' }}>
          <h1 style={{ fontSize: 96 }}>
            Ein <em>Katalog</em><br/>
            für die Zeit<br/>
            zwischen Schule<br/>
            und Rest.
          </h1>
          <div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4,
              marginBottom: 24,
            }}>
              {Array.from({length: 24}).map((_,i) => {
                const hit = [2,5,9,11,14,17,20,22].includes(i);
                return <div key={i} style={{
                  aspectRatio: 1,
                  background: hit ? 'var(--accent)' : 'var(--paper-2)',
                  border: '0.5px solid var(--rule)',
                }} />;
              })}
            </div>
            <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
              Jede Kachel ein Beruf. Jeder Beruf mit Gehalt, Ausbildungsweg, typischem Tagesablauf und ehrlicher Einschätzung.
            </p>
            <div className="hero-cta">
              <a href="berufsprofile.html" className="btn btn-primary">Katalog öffnen →</a>
            </div>
          </div>
        </div>
        <HeroStats />
      </div>
    </section>
  );
}

function HeroMagazine() {
  return (
    <section className="hero">
      <div className="container">
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
          border: '0.5px solid var(--rule)',
        }}>
          <div style={{ padding: 56 }}>
            <div className="hero-eyebrow">Ausgabe 01 · 2026</div>
            <h1 style={{ fontSize: 88, marginTop: 20 }}>
              Der<br/>Berufe-<br/><em>Atlas</em>
            </h1>
            <p className="hero-sub" style={{ maxWidth: 360 }}>
              Editorial, Profile und ein ehrlicher Selbsttest. Von zwei Schülern 2020 begonnen, heute weiter gepflegt.
            </p>
            <div className="hero-cta">
              <a href="berufstest.html" className="btn btn-primary">Test →</a>
              <a href="berufsprofile.html" className="btn btn-ghost">Atlas</a>
            </div>
          </div>
          <div style={{
            aspectRatio: 'auto', minHeight: 500,
            backgroundImage: `url(${PORTRAITS['pflegefachkraft']})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            border: '0.5px solid var(--rule)',
            filter: 'saturate(0.9) contrast(1.02)',
          }} />
        </div>
        <HeroStats />
      </div>
    </section>
  );
}

const HERO_VARIANTS = {
  editorial: HeroEditorial,
  minimal: HeroMinimal,
  datagrid: HeroDatagrid,
  magazine: HeroMagazine,
  quicktest: HeroEditorial, // alias, die Seitenkarte ist bereits der Quicktest
};

// ---------- Sections ----------
function BerufeShowcase() {
  const top = BERUFE.slice(0, 6);
  return (
    <section className="section container">
      <div className="section-head">
        <h2>Berufsprofile.<br/>Ohne Marketing-Sprech.</h2>
        <div className="section-head-aside">
          {BERUFE.length} Berufe, sortiert nach Ausbildungsweg, Gehalt und dem was ein Tag wirklich bringt. Unten sechs Einstiegsprofile — der vollständige Katalog ist eine Seite weiter.
        </div>
      </div>
      <div className="beruf-grid">
        {top.map(b => (
          <a key={b.slug} href={`berufsprofile.html?slug=${b.slug}`} className="beruf-card">
            <div className="beruf-arrow">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 17L17 7M17 7H9M17 7V15"/>
              </svg>
            </div>
            <div className="kat">{b.kategorie}</div>
            <h3>{b.titel}</h3>
            <p>{b.kurz}</p>
            <div className="facts">
              <span>💶 {b.gehalt}</span>
              <span style={{ color: 'var(--rule)' }}>·</span>
              <span>⏱ {b.dauer}</span>
            </div>
          </a>
        ))}
      </div>
      <div style={{ marginTop: 40, display: 'flex', justifyContent: 'flex-end' }}>
        <a href="berufsprofile.html" className="btn btn-ghost">Alle {BERUFE.length} Profile →</a>
      </div>
    </section>
  );
}

function TestPromo() {
  // Positions to simulate the chimp test grid
  const positions = { 3: 1, 7: 2, 12: 3, 18: 4, 21: 5 };
  return (
    <section className="section container">
      <div className="test-promo">
        <div>
          <div className="eyebrow" style={{ color: 'var(--accent)', marginBottom: 18 }}>Just4Fun · Bonus</div>
          <h2>Bist du<br/><em>schlauer</em> als ein<br/>Schimpanse?</h2>
          <p>
            Der Schimpanse Ayumu merkt sich 9 Zahlen in 2 Sekunden. Wir haben unseren Arbeitsgedächtnis-Test aus 2020 neu aufgelegt — im Labor-Look. Schaffst du 9?
          </p>
          <div className="cta">
            <a href="Chimpanzee Test.html" className="btn btn-primary">Test starten →</a>
            <a href="just4fun.html" className="btn btn-ghost">Mehr Just4Fun</a>
          </div>
        </div>
        <div className="test-promo-visual">
          <div className="test-promo-visual-grid">
            {Array.from({length: 25}, (_, i) => {
              const v = positions[i];
              return (
                <div key={i} className={`tpv-cell ${v ? 'active' : ''}`}>
                  {v || ''}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function EditorialFeature() {
  return (
    <section className="section container">
      <div className="editorial">
        <div className="editorial-img" style={{
          backgroundImage: `url(${PORTRAITS['pflegefachkraft']})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          border: '0.5px solid var(--rule)',
          filter: 'saturate(0.9) contrast(1.02)',
        }} />
        <div>
          <div className="editorial-meta">
            <span>Feature</span>
            <span>·</span>
            <span>7 Min. Lesen</span>
            <span>·</span>
            <span>Gesundheit & Soziales</span>
          </div>
          <h3>„Ich wollte etwas tun, das am Abend<br/>tatsächlich passiert ist."</h3>
          <p>
            Marie, 23, hat nach dem Abi lang überlegt, ob sie studieren soll. Heute ist sie examinierte Pflegefachkraft in einem Uniklinikum in Köln. Wir haben sie durch eine Frühschicht begleitet — und mit ihr darüber gesprochen, was an ihrem Beruf anstrengt, was trägt, und warum sie trotz allem geblieben ist.
          </p>
          <div className="editorial-quote">
            „Am Anfang dachte ich, ich muss alle retten. Heute reicht es mir, wenn ich eine gute Schicht abliefere."
          </div>
          <p>
            Der vollständige Text erscheint in der Rubrik Berufsprofile. Daneben: harte Fakten, Ausbildungswege, Gehaltsrahmen — und eine ehrliche Einschätzung, für wen dieser Beruf nichts ist.
          </p>
          <div className="hero-cta" style={{ marginTop: 28 }}>
            <a href="berufsprofile.html?slug=pflegefachkraft" className="btn btn-primary">Profil lesen →</a>
          </div>
        </div>
      </div>
    </section>
  );
}

function JobboersenSection() {
  const boersen = [
    { name: 'Arbeitsagentur', desc: 'Größte öffentliche Stellenbörse Deutschlands', url: 'https://www.arbeitsagentur.de' },
    { name: 'Stepstone', desc: 'Qualifizierte Positionen in Festanstellung', url: 'https://www.stepstone.de' },
    { name: 'Indeed', desc: 'Aggregiert Angebote aus tausenden Quellen', url: 'https://de.indeed.com' },
    { name: 'Xing Jobs', desc: 'DACH-Netzwerk mit eigenem Stellenmarkt', url: 'https://www.xing.com/jobs' },
    { name: 'LinkedIn', desc: 'Internationale Positionen & Empfehlungen', url: 'https://www.linkedin.com/jobs' },
    { name: 'Azubiyo', desc: 'Ausbildungs- und duale Studienplätze', url: 'https://www.azubiyo.de' },
  ];
  return (
    <section className="section container" id="jobboersen">
      <div className="section-head">
        <h2>Jobbörsen,<br/>kuratiert.</h2>
        <div className="section-head-aside">
          Wenn du soweit bist: diese sechs Plattformen decken das meiste ab. Keine Affiliate-Links, keine Werbung — nur was wir selbst nutzen würden.
        </div>
      </div>
      <div className="joblist">
        {boersen.map(b => (
          <a key={b.name} href={b.url} target="_blank" rel="noopener">
            <div>
              <div className="jl-name">{b.name}</div>
              <div className="jl-desc">{b.desc}</div>
            </div>
            <div className="jl-arrow">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 17L17 7M17 7H9M17 7V15"/>
              </svg>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

// ---------- Tweaks panel ----------
function TweaksPanel({ tweaks, setTweaks, active }) {
  return (
    <div className={`tweaks-panel ${active ? 'active' : ''}`}>
      <h4>Tweaks — Startseite</h4>
      <div className="tweak-row">
        <div className="tweak-label">Hero-Variante</div>
        <div className="variant-group">
          {['editorial', 'minimal', 'datagrid', 'magazine'].map(v => (
            <button key={v}
              className={`variant-btn ${tweaks.heroVariant === v ? 'active' : ''}`}
              onClick={() => setTweaks({ ...tweaks, heroVariant: v })}
            >{v}</button>
          ))}
        </div>
      </div>
      <div className="tweak-row">
        <div className="tweak-label">Akzentfarbe</div>
        <div className="variant-group">
          {[
            ['orange', 'oklch(0.68 0.16 45)'],
            ['lime',   'oklch(0.85 0.18 120)'],
            ['blau',   'oklch(0.60 0.16 250)'],
            ['rot',    'oklch(0.58 0.20 25)'],
            ['grün',   'oklch(0.55 0.14 155)'],
          ].map(([k,v]) => (
            <button key={k}
              className={`variant-btn ${tweaks.accent === k ? 'active' : ''}`}
              onClick={() => {
                document.documentElement.style.setProperty('--accent', v);
                setTweaks({ ...tweaks, accent: k });
              }}
            >{k}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [tweaks, setTweaks] = iS(window.__TWEAKS);
  const [tweaksActive, setTweaksActive] = iS(false);

  iE(() => {
    const map = {
      orange: 'oklch(0.68 0.16 45)',
      lime:   'oklch(0.85 0.18 120)',
      blau:   'oklch(0.60 0.16 250)',
      rot:    'oklch(0.58 0.20 25)',
      'grün': 'oklch(0.55 0.14 155)',
    };
    if (map[tweaks.accent]) {
      document.documentElement.style.setProperty('--accent', map[tweaks.accent]);
    }
  }, [tweaks.accent]);

  iE(() => {
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === '__activate_edit_mode') setTweaksActive(true);
      if (d.type === '__deactivate_edit_mode') setTweaksActive(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  iE(() => {
    window.__TWEAKS = tweaks;
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: tweaks }, '*');
  }, [tweaks]);

  const Hero = HERO_VARIANTS[tweaks.heroVariant] || HeroEditorial;

  return (
    <Shell active="start">
      <Hero />
      <BerufeShowcase />
      <TestPromo />
      <EditorialFeature />
      <JobboersenSection />
      <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} active={tweaksActive} />
    </Shell>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
