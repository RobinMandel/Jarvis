// Variant 3: STUDIE — research-paper aesthetic.
// Inverted (light paper surface), serif-less academic feel, margin annotations,
// footnote citations, figure captions. You are the subject in a study.

const { useMemo: sM } = React;
const { pad: spad, formatMs: sfmt } = window.ChimpFormat;

function StudieHeader({ game }) {
  return (
    <header style={{
      padding: '22px 56px 14px',
      borderBottom: '0.5px solid #c8c4b8',
      display: 'flex', alignItems: 'baseline', gap: 24,
      fontFamily: 'var(--sans)',
    }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.2em',
        color: '#8a8578', textTransform: 'uppercase',
      }}>Arbeitspapier Nr. 04/26 · Arbeitsgedächtnis bei Primaten</div>
      <div style={{ flex: 1, borderTop: '0.5px dashed #c8c4b8' }} />
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#8a8578', letterSpacing: '0.15em' }}>
        SUBJEKT: HOMO·SAPIENS · Protokoll {spad(game.round,3)}
      </div>
    </header>
  );
}

function StudieTitle() {
  return (
    <div style={{ padding: '40px 56px 0' }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.3em',
        color: '#8a8578', marginBottom: 14,
      }}>§ 1 · METHODE</div>
      <h1 style={{
        fontFamily: 'var(--display)', fontWeight: 500,
        fontSize: 42, lineHeight: 1.05, letterSpacing: '-0.02em',
        color: '#1a1a18', maxWidth: 780,
        textWrap: 'balance',
      }}>
        Kurzzeitreproduktion einer numerischen Sequenz<br/>
        <span style={{ color: '#8a8578', fontStyle: 'italic' }}>nach dem Protokoll Matsuzawa (2007).</span>
      </h1>
    </div>
  );
}

function StudieGrid({ game }) {
  const { cells, phase, revealed, clickCell, GRID_COLS, GRID_ROWS, TOTAL_CELLS, nextExpected } = game;
  return (
    <figure style={{
      margin: 0,
      border: '0.5px solid #1a1a18',
      padding: 28,
      background: '#faf8f3',
      position: 'relative',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${GRID_COLS}, 88px)`,
        gridTemplateRows: `repeat(${GRID_ROWS}, 88px)`,
        gap: 10,
      }}>
        {Array.from({length: TOTAL_CELLS}, (_, i) => {
          const val = cells[i];
          const active = val !== undefined;
          const show = active && (revealed || phase === 'roundDone');
          return (
            <button key={i}
              onClick={() => clickCell(i)}
              style={{
                border: `0.5px solid ${active ? '#1a1a18' : '#d4d0c4'}`,
                background: active ? '#fff' : 'transparent',
                fontFamily: 'var(--display)',
                fontSize: 36, fontWeight: 500,
                color: '#1a1a18',
                cursor: (phase === 'memorize' || phase === 'recall') ? 'pointer' : 'default',
                transition: 'all 0.12s',
                position: 'relative',
              }}
              onMouseEnter={e => {
                if (active && phase === 'recall') {
                  e.currentTarget.style.background = '#1a1a18';
                  e.currentTarget.style.color = '#faf8f3';
                }
              }}
              onMouseLeave={e => {
                if (active && phase === 'recall') {
                  e.currentTarget.style.background = '#fff';
                  e.currentTarget.style.color = '#1a1a18';
                }
              }}
            >
              {show && val}
              {active && !show && phase === 'recall' && (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 14, color: '#c8c4b8',
                  fontWeight: 400,
                }}>—</span>
              )}
            </button>
          );
        })}
      </div>
      <figcaption style={{
        marginTop: 20,
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
        color: '#8a8578', textTransform: 'uppercase',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Abb. {spad(game.round)} · Stimulusraster n = {game.numbersThisRound}</span>
        <span>
          {phase === 'memorize' && game.round > 1 && `t_rest = ${sfmt(game.timeLeft)}s`}
          {phase === 'recall' && `t_lauf = ${sfmt(game.elapsedRecall)}s`}
          {phase === 'memorize' && game.round === 1 && 'Phase: Enkodierung'}
        </span>
      </figcaption>
    </figure>
  );
}

function MarginNotes({ game }) {
  const notes = [
    {
      n: '¹', title: 'Zur Referenz',
      body: `Ayumu (♂, geb. 2000) erzielte im Rahmen einer Studie des Primate Research Institute (Univ. Kyoto) eine akkurate Reproduktion von 9 Ziffern nach einer Expositionszeit von nur 2 Sekunden.`
    },
    {
      n: '²', title: 'Regel',
      body: `Abbruch bei jeder Fehleingabe. Ein Versuch pro Runde. Ziffernanzahl n = Runde + 3.`
    },
    {
      n: '³', title: 'Aktueller Wert',
      body: game.phase === 'memorize'
        ? `Exposition läuft. Positionen werden nach Eingabe von „1" maskiert.`
        : game.phase === 'recall'
          ? `Maskiert. Erwartet: ${game.nextExpected}.`
          : `Ruhezustand.`
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {notes.map(({n, title, body}, i) => (
        <div key={i} style={{
          paddingLeft: 18, borderLeft: '2px solid #1a1a18',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em',
            color: '#8a8578', marginBottom: 4,
          }}>
            <sup style={{ color: '#1a1a18' }}>{n}</sup>  {title.toUpperCase()}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: '#3a3a36', textWrap: 'pretty' }}>
            {body}
          </div>
        </div>
      ))}
    </div>
  );
}

function StudieMetrics({ game }) {
  // A small "data table" formatted like a research appendix.
  const rows = [
    ['Runde', spad(game.round)],
    ['Stimuli (n)', spad(game.numbersThisRound)],
    ['Expositionsfenster', game.round === 1 && !game.hardMode ? '∞' : `${sfmt(game.memorizeWindow || 0)}s`],
    ['Verbl. Expos.', game.phase === 'memorize' ? sfmt(game.timeLeft) + 's' : '—'],
    ['Eingabezeit', game.phase === 'recall' || game.phase === 'roundDone' ? sfmt(game.elapsedRecall) + 's' : '—'],
    ['Ayumu (Ref.)', '9 / 2.00s'],
    ['Bestwert', game.best.numbers ? `${spad(game.best.numbers)} / R${spad(game.best.round)}` : '—'],
  ];
  return (
    <div style={{
      border: '0.5px solid #1a1a18',
      background: '#fff',
    }}>
      <div style={{
        padding: '10px 16px', borderBottom: '0.5px solid #1a1a18',
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.18em',
        textTransform: 'uppercase', color: '#1a1a18',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Tab. 01 · Messwerte</span>
        <span style={{ color: '#8a8578' }}>Live</span>
      </div>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontFamily: 'var(--mono)', fontSize: 12,
      }}>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} style={{ borderBottom: '0.5px solid #e8e4d8' }}>
              <td style={{ padding: '10px 16px', color: '#8a8578', letterSpacing: '0.04em' }}>{k}</td>
              <td style={{ padding: '10px 16px', textAlign: 'right', color: '#1a1a18', fontFeatureSettings: '"tnum"' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StudieProgressBar({ game }) {
  if (game.phase !== 'memorize' || (game.round === 1 && !game.hardMode)) {
    return null;
  }
  const pct = game.memorizeProgress * 100;
  return (
    <div style={{
      padding: '0 56px', marginTop: 10,
    }}>
      <div style={{
        height: 2, background: '#e8e4d8', position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', inset: 0, right: `${100-pct}%`,
          background: pct < 25 ? '#c23a1e' : '#1a1a18',
          transition: 'background 0.2s',
        }} />
      </div>
      <div style={{
        marginTop: 4, fontFamily: 'var(--mono)', fontSize: 9,
        letterSpacing: '0.2em', color: '#8a8578', textTransform: 'uppercase',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Exposition</span><span>{sfmt(game.timeLeft)}s / {sfmt(game.memorizeWindow)}s</span>
      </div>
    </div>
  );
}

function StudieIntro({ game }) {
  return (
    <div style={{
      padding: '56px 56px 80px',
      maxWidth: 1100, margin: '0 auto',
      display: 'grid', gridTemplateColumns: '1fr 360px', gap: 64,
    }}>
      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.3em',
          color: '#8a8578', marginBottom: 18,
        }}>§ 0 · ABSTRACT</div>
        <h1 style={{
          fontFamily: 'var(--display)', fontSize: 64, fontWeight: 500,
          lineHeight: 0.98, letterSpacing: '-0.025em', color: '#1a1a18',
          marginBottom: 30, textWrap: 'balance',
        }}>
          Bist du schlauer<br/>als ein <span style={{ fontStyle: 'italic' }}>Schimpanse</span>?
        </h1>
        <p style={{
          fontSize: 16, lineHeight: 1.6, color: '#3a3a36',
          maxWidth: 560, marginBottom: 20, textWrap: 'pretty',
        }}>
          Im Rahmen einer Studie am Primate Research Institute der Universität Kyoto (2007) zeigte der Schimpanse <em>Ayumu</em>, dass er sich die Positionen von <b>9 zufällig angeordneten Ziffern</b> innerhalb von nur <b>2 Sekunden</b> einprägen und anschließend fehlerfrei reproduzieren konnte<sup style={{ fontSize: 11 }}>¹</sup>.
        </p>
        <p style={{
          fontSize: 16, lineHeight: 1.6, color: '#3a3a36',
          maxWidth: 560, marginBottom: 40, textWrap: 'pretty',
        }}>
          Dieses Instrument reproduziert das Verfahren. Als Proband:in nimmst du teil an einer freiwilligen, unvergüteten Messung deines visuell-räumlichen Arbeitsgedächtnisses.
        </p>
        <button
          onClick={game.startGame}
          style={{
            padding: '14px 28px',
            background: '#1a1a18', color: '#faf8f3',
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.25em', textTransform: 'uppercase',
          }}
        >
          Versuch beginnen ↗
        </button>
        <div style={{
          marginTop: 14, fontSize: 11, color: '#8a8578',
          fontFamily: 'var(--mono)', letterSpacing: '0.1em',
        }}>
          Durch Klick bestätigst du die Teilnahmeerklärung.
        </div>

        <div style={{
          marginTop: 48, paddingTop: 28, borderTop: '0.5px solid #c8c4b8',
          fontSize: 12, color: '#8a8578', lineHeight: 1.7,
          fontFamily: 'var(--sans)',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.25em',
            textTransform: 'uppercase', color: '#1a1a18', marginBottom: 8,
          }}>Referenzen</div>
          <div><sup>¹</sup> Inoue, S. & Matsuzawa, T. (2007). <em>Working memory of numerals in chimpanzees.</em> Current Biology, 17(23), R1004–R1005.</div>
        </div>
      </div>

      <aside style={{
        borderLeft: '0.5px solid #c8c4b8', paddingLeft: 40,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.25em',
          color: '#8a8578', textTransform: 'uppercase', marginBottom: 16,
        }}>Ablauf</div>
        {[
          ['01', 'Enkodierung', 'Die Ziffern 1 bis n werden für ein definiertes Fenster angezeigt.'],
          ['02', 'Maskierung', 'Der Klick auf „1" verdeckt die übrigen Ziffern.'],
          ['03', 'Reproduktion', 'Die verdeckten Positionen werden in aufsteigender Reihenfolge aktiviert.'],
          ['04', 'Progression', 'Pro Runde erhöht sich n um eins; die Expositionszeit verkürzt sich.'],
        ].map(([n, t, d]) => (
          <div key={n} style={{
            display: 'grid', gridTemplateColumns: '28px 1fr', gap: 14,
            paddingBottom: 18, marginBottom: 18,
            borderBottom: '0.5px dashed #c8c4b8',
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: '#8a8578',
              letterSpacing: '0.1em',
            }}>{n}</div>
            <div>
              <div style={{
                fontFamily: 'var(--display)', fontSize: 15, fontWeight: 500,
                color: '#1a1a18', marginBottom: 4,
              }}>{t}</div>
              <div style={{ fontSize: 12, color: '#3a3a36', lineHeight: 1.5 }}>{d}</div>
            </div>
          </div>
        ))}

        <div style={{
          marginTop: 10, padding: 16, background: '#1a1a18', color: '#faf8f3',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.2em',
            color: '#d4ff00', textTransform: 'uppercase', marginBottom: 6,
          }}>Benchmark</div>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 36, fontWeight: 500,
            lineHeight: 1, marginBottom: 4,
          }}>9 Ziffern</div>
          <div style={{ fontSize: 11, color: '#c8c4b8', fontFamily: 'var(--mono)', letterSpacing: '0.08em' }}>
            AYUMU · 2 SEKUNDEN · KYOTO 2007
          </div>
        </div>
      </aside>
    </div>
  );
}

function StudieOverlay({ game }) {
  if (game.phase !== 'gameOver' && game.phase !== 'roundDone') return null;
  const isWin = game.phase === 'roundDone';
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'rgba(250,248,243,0.92)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10,
    }}>
      <div style={{
        width: 540, background: '#fff', border: '0.5px solid #1a1a18',
        padding: 36,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.3em',
          color: '#8a8578', marginBottom: 12,
        }}>{isWin ? 'ERGEBNIS · RUNDE ABGESCHLOSSEN' : 'ERGEBNIS · VERSUCH BEENDET'}</div>
        <h2 style={{
          fontFamily: 'var(--display)', fontSize: 36, fontWeight: 500,
          letterSpacing: '-0.02em', color: '#1a1a18', marginBottom: 24, lineHeight: 1,
        }}>
          {isWin ? `Runde ${game.round} · ${sfmt(game.elapsedRecall)}s` : 'Abschlussmessung'}
        </h2>
        {!isWin && game.lastResult && (
          <>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 24,
            }}>
              <tbody>
                {[
                  ['Erreichte Ziffernanzahl', spad(game.lastResult.numbers)],
                  ['Abgeschlossene Runden', spad(game.lastResult.round - 1)],
                  ['Ayumu-Referenz', '9'],
                  ['Differenz', (game.lastResult.numbers - 9).toString()],
                  ['Persönl. Bestwert', spad(game.best.numbers || 0)],
                ].map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: '0.5px solid #e8e4d8' }}>
                    <td style={{ padding: '10px 0', color: '#8a8578' }}>{k}</td>
                    <td style={{ padding: '10px 0', textAlign: 'right', color: '#1a1a18' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={game.startGame} style={{
                flex: 1, padding: '14px',
                background: '#1a1a18', color: '#faf8f3',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                letterSpacing: '0.25em', textTransform: 'uppercase',
              }}>Erneut</button>
              <button onClick={game.reset} style={{
                padding: '14px 22px',
                border: '0.5px solid #1a1a18', color: '#1a1a18',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
                letterSpacing: '0.25em', textTransform: 'uppercase',
              }}>Zur Studie</button>
            </div>
          </>
        )}
        {isWin && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#3a3a36' }}>
            → Fortsetzung mit Runde {game.round + 1} (n = {game.numbersThisRound + 1})
          </div>
        )}
      </div>
    </div>
  );
}

function StudieChrome({ game }) {
  if (game.phase === 'idle') {
    return (
      <div style={{ minHeight: '100vh', background: '#faf8f3', color: '#1a1a18' }}>
        <StudieHeader game={game} />
        <StudieIntro game={game} />
      </div>
    );
  }
  return (
    <div style={{
      minHeight: '100vh', background: '#faf8f3', color: '#1a1a18',
      position: 'relative', display: 'flex', flexDirection: 'column',
    }}>
      <StudieHeader game={game} />
      <StudieTitle />
      <StudieProgressBar game={game} />
      <div style={{
        flex: 1,
        padding: '28px 56px 56px',
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 56,
        alignItems: 'start',
      }}>
        <StudieGrid game={game} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32, paddingTop: 6 }}>
          <MarginNotes game={game} />
          <StudieMetrics game={game} />
        </div>
      </div>
      <StudieOverlay game={game} />
    </div>
  );
}

window.StudieChrome = StudieChrome;
