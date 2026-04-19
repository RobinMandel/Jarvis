// Funktionaler Berufstest
const { useState: btS, useEffect: btE, useMemo: btM } = React;
const { Shell, BERUFE } = window.Shared;

// Dimensionen: kreativ, analytisch, sozial, praktisch, digital
const DIMS = ['kreativ', 'analytisch', 'sozial', 'praktisch', 'digital'];

const QUESTIONS = [
  { q: 'Was ist dir im Arbeitsalltag am wichtigsten?',
    a: [
      { t: 'Ich will etwas Sichtbares schaffen.', w: { kreativ: 2, praktisch: 1 } },
      { t: 'Ich will Probleme analysieren und lösen.', w: { analytisch: 2, digital: 1 } },
      { t: 'Ich will mit Menschen direkt arbeiten.', w: { sozial: 2 } },
      { t: 'Ich will draußen und in Bewegung sein.', w: { praktisch: 2 } },
    ]},
  { q: 'Wie arbeitest du am liebsten?',
    a: [
      { t: 'Alleine, in Ruhe, mit langer Konzentrationsphase.', w: { analytisch: 2, digital: 1 } },
      { t: 'Im Team, mit viel Austausch.', w: { sozial: 2 } },
      { t: 'Mit klarer Aufgabe und direktem Ergebnis.', w: { praktisch: 2 } },
      { t: 'Frei, experimentell, mit offenen Enden.', w: { kreativ: 2 } },
    ]},
  { q: 'Welches Schulfach hattest du am liebsten?',
    a: [
      { t: 'Mathe / Informatik', w: { analytisch: 2, digital: 2 } },
      { t: 'Kunst / Musik / Deutsch', w: { kreativ: 2 } },
      { t: 'Sozialkunde / Pädagogik / Ethik', w: { sozial: 2 } },
      { t: 'Technik / Werken / Sport', w: { praktisch: 2 } },
    ]},
  { q: 'Woran erkennst du einen guten Tag?',
    a: [
      { t: 'Ich habe etwas fertig gebaut, das funktioniert.', w: { praktisch: 2, kreativ: 1 } },
      { t: 'Ich habe eine harte Frage geknackt.', w: { analytisch: 2 } },
      { t: 'Ich habe jemandem wirklich weitergeholfen.', w: { sozial: 2 } },
      { t: 'Ich habe einen schönen, klaren Entwurf hinbekommen.', w: { kreativ: 2 } },
    ]},
  { q: 'Wie gehst du mit Stress um?',
    a: [
      { t: 'Ich brauche Ruhe und ziehe mich kurz zurück.', w: { analytisch: 1 } },
      { t: 'Ich rede mit jemandem darüber.', w: { sozial: 2 } },
      { t: 'Ich arbeite ihn körperlich ab.', w: { praktisch: 2 } },
      { t: 'Ich brauche eine kreative Pause.', w: { kreativ: 1 } },
    ]},
  { q: 'Welches Werkzeug würdest du am liebsten meistern?',
    a: [
      { t: 'Figma oder ein anderes Design-Tool', w: { kreativ: 2, digital: 1 } },
      { t: 'Python, SQL, Excel', w: { analytisch: 2, digital: 2 } },
      { t: 'Eine Stimme, die Menschen beruhigt', w: { sozial: 2 } },
      { t: 'Eine Werkbank mit allem drum und dran', w: { praktisch: 2 } },
    ]},
  { q: 'Was ist dir bei einem Projekt zu Beginn wichtig?',
    a: [
      { t: 'Ein sauber definierter Rahmen', w: { analytisch: 2 } },
      { t: 'Raum für Experimente', w: { kreativ: 2 } },
      { t: 'Ein gutes Team-Gefühl', w: { sozial: 2 } },
      { t: 'Ein klarer Plan Schritt-für-Schritt', w: { praktisch: 2 } },
    ]},
  { q: 'Mit wem würdest du lieber 1 Woche tauschen?',
    a: [
      { t: 'Einer Chirurgin', w: { analytisch: 1, sozial: 1, praktisch: 1 } },
      { t: 'Einem Regisseur', w: { kreativ: 2 } },
      { t: 'Einem Data Scientist', w: { analytisch: 2, digital: 2 } },
      { t: 'Einem Förster', w: { praktisch: 2 } },
    ]},
  { q: 'Was stört dich bei einem Job am meisten?',
    a: [
      { t: 'Monotonie', w: { kreativ: 2 } },
      { t: 'Unklarheit', w: { analytisch: 2 } },
      { t: 'Einsamkeit', w: { sozial: 2 } },
      { t: 'Den ganzen Tag sitzen', w: { praktisch: 2 } },
    ]},
  { q: 'Welcher Feierabend passt zu dir?',
    a: [
      { t: 'Ein gutes Buch oder Podcast', w: { analytisch: 1 } },
      { t: 'Ein Treffen mit Freunden', w: { sozial: 2 } },
      { t: 'Noch eine Runde am eigenen Projekt basteln', w: { kreativ: 1, praktisch: 1 } },
      { t: 'Sport, Lauf, Rad', w: { praktisch: 2 } },
    ]},
  { q: 'Wie wichtig ist dir ein hohes Gehalt?',
    a: [
      { t: 'Sehr wichtig — es soll sich lohnen.', w: { analytisch: 1, digital: 1 } },
      { t: 'Fair, aber nicht das Wichtigste.', w: { sozial: 1, kreativ: 1 } },
      { t: 'Es muss zum Leben reichen, alles darüber ist Bonus.', w: { praktisch: 1 } },
      { t: 'Weiß nicht, noch nie drüber nachgedacht.', w: {} },
    ]},
  { q: 'Wie lange Ausbildung / Studium ist okay?',
    a: [
      { t: 'Kurz und rein in den Job (Ausbildung)', w: { praktisch: 2 } },
      { t: 'Bachelor reicht mir', w: { analytisch: 1, kreativ: 1, digital: 1 } },
      { t: 'Bis zum Master oder länger, wenn es passt', w: { analytisch: 2 } },
      { t: 'Egal, Hauptsache der Inhalt stimmt', w: {} },
    ]},
  { q: 'Was fasziniert dich im Alltag am meisten?',
    a: [
      { t: 'Wie Dinge gebaut sind', w: { praktisch: 2, analytisch: 1 } },
      { t: 'Wie Menschen ticken', w: { sozial: 2 } },
      { t: 'Wie Schönheit entsteht', w: { kreativ: 2 } },
      { t: 'Wie Daten Geschichten erzählen', w: { analytisch: 2, digital: 2 } },
    ]},
  { q: 'Welche Umgebung inspiriert dich?',
    a: [
      { t: 'Eine saubere Werkstatt', w: { praktisch: 2 } },
      { t: 'Ein volles Café', w: { sozial: 1, kreativ: 1 } },
      { t: 'Ein stilles Büro mit viel Licht', w: { analytisch: 2 } },
      { t: 'Eine Bühne oder ein Atelier', w: { kreativ: 2 } },
    ]},
  { q: 'Wie wichtig ist dir, dass deine Arbeit die Welt verbessert?',
    a: [
      { t: 'Sehr wichtig — das ist mein Antrieb.', w: { sozial: 2 } },
      { t: 'Wichtig, aber nicht der Hauptgrund.', w: { sozial: 1, kreativ: 1 } },
      { t: 'Eher zweitrangig.', w: { analytisch: 1, praktisch: 1 } },
      { t: 'Ich würde sagen, jede ehrliche Arbeit verbessert sie.', w: { praktisch: 1 } },
    ]},
];

// Berufsprofile mit Dimensionsgewichten für Matching
const BERUF_PROFILES = {
  'ux-designer':       { kreativ: 0.9, analytisch: 0.6, sozial: 0.5, praktisch: 0.2, digital: 0.9 },
  'data-analyst':      { kreativ: 0.3, analytisch: 1.0, sozial: 0.2, praktisch: 0.2, digital: 1.0 },
  'mechatroniker':     { kreativ: 0.2, analytisch: 0.6, sozial: 0.2, praktisch: 1.0, digital: 0.5 },
  'pflegefachkraft':   { kreativ: 0.2, analytisch: 0.4, sozial: 1.0, praktisch: 0.7, digital: 0.2 },
  'erzieher':          { kreativ: 0.5, analytisch: 0.2, sozial: 1.0, praktisch: 0.5, digital: 0.1 },
  'kfz-mechatroniker': { kreativ: 0.2, analytisch: 0.4, sozial: 0.2, praktisch: 1.0, digital: 0.4 },
  'steuerberater':     { kreativ: 0.1, analytisch: 1.0, sozial: 0.5, praktisch: 0.2, digital: 0.4 },
  'journalist':        { kreativ: 0.9, analytisch: 0.7, sozial: 0.7, praktisch: 0.2, digital: 0.5 },
  'physiotherapeut':   { kreativ: 0.2, analytisch: 0.4, sozial: 0.9, praktisch: 0.9, digital: 0.1 },
  'tischler':          { kreativ: 0.6, analytisch: 0.2, sozial: 0.1, praktisch: 1.0, digital: 0.2 },
  'landwirt':          { kreativ: 0.2, analytisch: 0.4, sozial: 0.2, praktisch: 1.0, digital: 0.3 },
  'lehrkraft':         { kreativ: 0.6, analytisch: 0.5, sozial: 0.9, praktisch: 0.2, digital: 0.3 },
};

function cosineMatch(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const d of DIMS) { dot += a[d]*b[d]; na += a[d]*a[d]; nb += b[d]*b[d]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) || 1);
}

function Intro({ onStart }) {
  return (
    <div className="test-wrap test-intro">
      <div className="eyebrow">Berufstest · 15 Fragen · ~3 Minuten</div>
      <h1 style={{ marginTop: 16 }}>15 Fragen und ein<br/><em>ehrliches</em> Profil.</h1>
      <p>Keine Werbung, keine Datensammlung, kein Login. Am Ende erhältst du ein Profil in fünf Dimensionen und die sechs Berufe, die am besten passen.</p>
      <div className="steps">
        <div className="step"><div className="n">01</div><h4>Fragen beantworten</h4><p>Ein Klick pro Frage. Keine Zeitvorgabe, keine falschen Antworten.</p></div>
        <div className="step"><div className="n">02</div><h4>Profil ansehen</h4><p>Fünf Dimensionen: kreativ · analytisch · sozial · praktisch · digital.</p></div>
        <div className="step"><div className="n">03</div><h4>Berufe vergleichen</h4><p>Top-Matches mit Link ins jeweilige Profil. Alles lokal, nichts wird gespeichert.</p></div>
      </div>
      <button onClick={onStart} className="btn btn-primary">Los geht's →</button>
    </div>
  );
}

function Questionnaire({ onDone }) {
  const [i, setI] = btS(0);
  const [answers, setAnswers] = btS({});
  const total = QUESTIONS.length;
  const q = QUESTIONS[i];

  btE(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [i]);

  const pick = (idx) => {
    setAnswers({ ...answers, [i]: idx });
    setTimeout(() => {
      if (i < total - 1) setI(i + 1);
      else onDone({ ...answers, [i]: idx });
    }, 220);
  };

  return (
    <>
      <div className="test-progress">
        <div className="test-progress-inner">
          <span>Frage {String(i+1).padStart(2,'0')} / {String(total).padStart(2,'0')}</span>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${((i+1)/total)*100}%` }} />
          </div>
          <span>{Math.round(((i+1)/total)*100)}%</span>
        </div>
      </div>
      <div className="test-wrap">
        <div className="question-block">
          <div className="question-num">Frage {String(i+1).padStart(2,'0')}</div>
          <div className="question-text">{q.q}</div>
          <div className="answer-list">
            {q.a.map((opt, k) => (
              <button key={k} className={`answer-btn ${answers[i] === k ? 'selected' : ''}`}
                onClick={() => pick(k)}>
                <span>{opt.t}</span>
                <span className="key">{String.fromCharCode(65+k)}</span>
              </button>
            ))}
          </div>
          <div className="test-controls">
            <button className="btn-nav" onClick={() => setI(Math.max(0, i-1))} disabled={i===0}>← Zurück</button>
            <button className="btn-nav" onClick={() => setI(Math.min(total-1, i+1))}
              disabled={answers[i] === undefined}>Weiter →</button>
          </div>
        </div>
      </div>
    </>
  );
}

function Result({ answers, onRestart }) {
  const scores = btM(() => {
    const s = Object.fromEntries(DIMS.map(d => [d, 0]));
    Object.entries(answers).forEach(([qi, ai]) => {
      const w = QUESTIONS[+qi].a[ai].w;
      Object.entries(w).forEach(([k,v]) => { s[k] += v; });
    });
    const max = Math.max(...Object.values(s), 1);
    const norm = {};
    DIMS.forEach(d => { norm[d] = s[d] / max; });
    return norm;
  }, [answers]);

  const matches = btM(() => {
    return Object.entries(BERUF_PROFILES)
      .map(([slug, prof]) => {
        const b = BERUFE.find(x => x.slug === slug);
        return { slug, match: cosineMatch(scores, prof), beruf: b };
      })
      .filter(m => m.beruf)
      .sort((a,b) => b.match - a.match)
      .slice(0, 6);
  }, [scores]);

  return (
    <div className="test-wrap">
      <div className="result-head">
        <div>
          <div className="eyebrow" style={{ color: 'var(--accent)' }}>Dein Ergebnis</div>
          <h1 style={{ marginTop: 16 }}>Dein Profil ist<br/><em>fertig</em>.</h1>
        </div>
        <p>Dein Ergebnis basiert auf 15 Antworten und fünf Dimensionen. Unten: die Berufe mit der höchsten Übereinstimmung. Klick auf ein Profil für Details.</p>
      </div>

      <div className="profile-chart">
        <div className="eyebrow" style={{ marginBottom: 20 }}>Dimensionen</div>
        {DIMS.map(d => (
          <div key={d} className="profile-bar">
            <div className="lbl">{d}</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${scores[d]*100}%` }} />
            </div>
            <div className="val">{Math.round(scores[d]*100)}</div>
          </div>
        ))}
      </div>

      <div className="eyebrow" style={{ marginBottom: 16 }}>Top 6 Matches</div>
      <div className="match-grid">
        {matches.map((m, i) => (
          <a key={m.slug} href={`berufsprofile.html?slug=${m.slug}`} className="match-card">
            <div>
              <div className="kat">#{String(i+1).padStart(2,'0')} · {m.beruf.kategorie}</div>
              <h3>{m.beruf.titel}</h3>
              <div style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 6, lineHeight: 1.5 }}>{m.beruf.kurz}</div>
            </div>
            <div className="match-score">{Math.round(m.match*100)}<span style={{ fontSize: 14, color: 'var(--ink-faint)' }}>%</span></div>
          </a>
        ))}
      </div>

      <div style={{ marginTop: 48, display: 'flex', gap: 14 }}>
        <button onClick={onRestart} className="btn btn-ghost">Nochmal machen</button>
        <a href="berufsprofile.html" className="btn btn-primary">Alle Profile ansehen →</a>
      </div>
    </div>
  );
}

function App() {
  const [stage, setStage] = btS('intro');
  const [answers, setAnswers] = btS({});

  return (
    <Shell active="berufstest">
      {stage === 'intro' && <Intro onStart={() => setStage('quiz')} />}
      {stage === 'quiz' && <Questionnaire onDone={(a) => { setAnswers(a); setStage('result'); }} />}
      {stage === 'result' && <Result answers={answers} onRestart={() => { setAnswers({}); setStage('quiz'); }} />}
    </Shell>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
