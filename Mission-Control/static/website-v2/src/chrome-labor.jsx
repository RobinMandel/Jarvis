// Variant 1: LABORGERÄT — lab instrument chrome
// Frames the game as a precision memory-testing apparatus.

const { useMemo: uLM } = React;

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${pad(s)}.${pad(cs)}`;
}

// ---------- Small atoms ----------
function Readout({ label, value, mono = true, accent }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      minWidth: 90,
    }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.18em',
        textTransform: 'uppercase', color: 'var(--ink-faint)',
      }}>{label}</div>
      <div style={{
        fontFamily: mono ? 'var(--mono)' : 'var(--display)',
        fontSize: 22, fontWeight: 500,
        color: accent || 'var(--ink)',
        letterSpacing: mono ? '0.02em' : '-0.01em',
        lineHeight: 1,
      }}>{value}</div>
    </div>
  );
}

function CornerTick({ corners = 'tl tr bl br' }) {
  const t = 10;
  const mk = (style) => (
    <span style={{
      position: 'absolute', width: t, height: t,
      borderColor: 'var(--line-2)', ...style,
    }} />
  );
  return (
    <>
      {corners.includes('tl') && mk({ top: 0, left: 0, borderTop: '1px solid', borderLeft: '1px solid' })}
      {corners.includes('tr') && mk({ top: 0, right: 0, borderTop: '1px solid', borderRight: '1px solid' })}
      {corners.includes('bl') && mk({ bottom: 0, left: 0, borderBottom: '1px solid', borderLeft: '1px solid' })}
      {corners.includes('br') && mk({ bottom: 0, right: 0, borderBottom: '1px solid', borderRight: '1px solid' })}
    </>
  );
}

// ---------- Header ----------
function LaborHeader({ game }) {
  const nowStr = uLM(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, []);

  return (
    <header style={{
      borderBottom: '1px solid var(--line)',
      padding: '18px 40px',
      display: 'flex', alignItems: 'center', gap: 28,
      fontFamily: 'var(--mono)', fontSize: 11,
      color: 'var(--ink-dim)',
      letterSpacing: '0.1em',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 10, height: 10, borderRadius: 2,
          background: 'var(--lime)',
          boxShadow: '0 0 8px rgba(212,255,0,0.6)',
          animation: 'labor-pulse 2s ease-in-out infinite',
        }} />
        <span style={{ color: 'var(--ink)', letterSpacing: '0.2em' }}>UNIT 01 — ONLINE</span>
      </div>
      <div style={{ flex: 1, borderTop: '1px dashed var(--line-2)' }} />
      <span>MODEL: CHIMP-AMT/v2</span>
      <span style={{ color: 'var(--line-2)' }}>·</span>
      <span>PROTOKOLL: AYUMU-1</span>
      <span style={{ color: 'var(--line-2)' }}>·</span>
      <span>{nowStr}</span>
      <style>{`@keyframes labor-pulse { 0%,100%{opacity:1}50%{opacity:0.4} }`}</style>
    </header>
  );
}

// ---------- Stats rail ----------
function StatsRail({ game }) {
  const timeStr = game.phase === 'memorize' && game.round > 1
    ? formatMs(game.timeLeft)
    : game.phase === 'recall' || game.phase === 'roundDone'
      ? formatMs(game.elapsedRecall)
      : '--.--';

  return (
    <div style={{
      padding: '22px 40px',
      borderBottom: '1px solid var(--line)',
      display: 'flex', alignItems: 'center', gap: 56,
      background: 'var(--surface)',
    }}>
      <Readout label="RUNDE" value={pad(game.round)} />
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)' }} />
      <Readout label="ZAHLEN" value={pad(game.numbersThisRound)} accent="var(--lime)" />
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)' }} />
      <Readout
        label={game.phase === 'memorize' ? 'T — MEMO' : 'T — EINGABE'}
        value={timeStr}
        accent={game.phase === 'memorize' && game.timeLeft < 1000 ? 'var(--red)' : undefined}
      />
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)' }} />
      <Readout label="REKORD" value={game.best.numbers ? pad(game.best.numbers) : '--'} />
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)' }} />
      <Readout label="AYUMU (REF.)" value={pad(9)} accent="var(--ink-dim)" />

      <div style={{ flex: 1 }} />

      {/* Phase indicator */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px',
        border: '1px solid var(--line-2)',
        borderRadius: 2,
        fontFamily: 'var(--mono)', fontSize: 10,
        letterSpacing: '0.2em', textTransform: 'uppercase',
        color: 'var(--ink)',
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: phaseColor(game.phase),
          boxShadow: `0 0 6px ${phaseColor(game.phase)}`,
        }} />
        {phaseLabel(game.phase)}
      </div>
    </div>
  );
}
function phaseColor(p) {
  if (p === 'memorize') return 'var(--lime)';
  if (p === 'recall') return 'var(--amber)';
  if (p === 'gameOver') return 'var(--red)';
  if (p === 'roundDone') return 'var(--lime)';
  return 'var(--ink-faint)';
}
function phaseLabel(p) {
  return ({
    idle: 'BEREIT',
    memorize: 'MEMORIEREN',
    recall: 'EINGABE',
    roundDone: 'ERFOLG',
    gameOver: 'ABBRUCH',
  })[p] || p;
}

// ---------- Grid ----------
function LaborGrid({ game }) {
  const { cells, phase, clickCell, revealed, GRID_COLS, GRID_ROWS, TOTAL_CELLS } = game;

  const cellIds = uLM(() => Array.from({ length: TOTAL_CELLS }, (_, i) => i), [TOTAL_CELLS]);

  return (
    <div style={{
      position: 'relative',
      padding: 36,
      background: 'var(--surface)',
      border: '1px solid var(--line)',
      borderRadius: 2,
    }}>
      <CornerTick />

      {/* Axis labels */}
      <div style={{
        position: 'absolute', left: 36, right: 36, top: 14,
        display: 'flex', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 9,
        color: 'var(--ink-faint)', letterSpacing: '0.2em',
      }}>
        {Array.from({length: GRID_COLS}, (_, i) => <span key={i}>{String.fromCharCode(65+i)}</span>)}
      </div>
      <div style={{
        position: 'absolute', top: 36, bottom: 36, left: 14,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 9,
        color: 'var(--ink-faint)', letterSpacing: '0.2em',
      }}>
        {Array.from({length: GRID_ROWS}, (_, i) => <span key={i}>{pad(i+1)}</span>)}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${GRID_COLS}, 88px)`,
        gridTemplateRows: `repeat(${GRID_ROWS}, 88px)`,
        gap: 8,
      }}>
        {cellIds.map(i => {
          const val = cells[i];
          const active = val !== undefined;
          const showNumber = active && (revealed || phase === 'roundDone');
          const isNextTarget = phase === 'recall' && val === game.nextExpected;

          return (
            <button
              key={i}
              onClick={() => clickCell(i)}
              style={{
                position: 'relative',
                background: active ? 'var(--bg)' : 'transparent',
                border: `1px solid ${active ? 'var(--line-2)' : 'var(--line)'}`,
                borderRadius: 2,
                cursor: (phase === 'memorize' || phase === 'recall') ? 'pointer' : 'default',
                fontFamily: 'var(--mono)',
                fontSize: 34,
                fontWeight: 500,
                color: 'var(--ink)',
                transition: 'all 0.12s',
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                if (phase === 'recall' && active) e.currentTarget.style.borderColor = 'var(--lime)';
              }}
              onMouseLeave={(e) => {
                if (phase === 'recall' && active) e.currentTarget.style.borderColor = 'var(--line-2)';
              }}
            >
              {/* Cell tick marks in corners when active */}
              {active && (
                <>
                  <span style={{ position: 'absolute', top: 4, left: 4, width: 6, height: 1, background: 'var(--line-2)' }} />
                  <span style={{ position: 'absolute', top: 4, left: 4, width: 1, height: 6, background: 'var(--line-2)' }} />
                  <span style={{ position: 'absolute', bottom: 4, right: 4, width: 6, height: 1, background: 'var(--line-2)' }} />
                  <span style={{ position: 'absolute', bottom: 4, right: 4, width: 1, height: 6, background: 'var(--line-2)' }} />
                </>
              )}
              {showNumber && (
                <span style={{
                  fontFeatureSettings: '"tnum"',
                  color: val === 1 && phase === 'memorize' ? 'var(--lime)' : 'var(--ink)',
                }}>{val}</span>
              )}
              {!showNumber && active && phase === 'recall' && (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-faint)',
                  letterSpacing: '0.1em',
                }}>?</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Memorize timer bar ----------
function MemorizeBar({ game }) {
  if (game.phase !== 'memorize') {
    return <div style={{ height: 4, background: 'var(--line)' }} />;
  }
  const isFirstRound = game.round === 1 && !game.hardMode;
  if (isFirstRound) {
    return (
      <div style={{
        height: 4, background: 'var(--line)', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', inset: 0, background: 'var(--lime)',
          animation: 'labor-scan 2s linear infinite',
          opacity: 0.6,
        }} />
        <style>{`@keyframes labor-scan {
          0% { clip-path: inset(0 100% 0 0); }
          50% { clip-path: inset(0 0 0 0); }
          100% { clip-path: inset(0 0 0 100%); }
        }`}</style>
      </div>
    );
  }
  const pct = game.memorizeProgress * 100;
  const critical = pct < 25;
  return (
    <div style={{ height: 4, background: 'var(--line)', position: 'relative' }}>
      <div style={{
        position: 'absolute', inset: 0, right: `${100-pct}%`,
        background: critical ? 'var(--red)' : 'var(--lime)',
        transition: 'background 0.2s',
      }} />
    </div>
  );
}

// ---------- Side panel ----------
function LaborSidePanel({ game }) {
  return (
    <aside style={{
      width: 320,
      background: 'var(--surface)',
      border: '1px solid var(--line)',
      padding: 28,
      display: 'flex', flexDirection: 'column', gap: 28,
      fontFamily: 'var(--sans)',
      position: 'relative',
    }}>
      <CornerTick />
      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.2em',
          color: 'var(--ink-faint)', marginBottom: 12,
        }}>§ 01 — PROTOKOLL</div>
        <p style={{
          fontSize: 13, lineHeight: 1.55, color: 'var(--ink-dim)',
          fontFamily: 'var(--sans)',
        }}>
          Zahlen <span style={{color:'var(--ink)'}}>1–{game.numbersThisRound}</span> erscheinen kurz auf dem Raster. Nach dem ersten Klick werden die übrigen Zahlen verdeckt. Drücke sie in aufsteigender Reihenfolge.
        </p>
      </div>

      <div style={{ borderTop: '1px dashed var(--line-2)' }} />

      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.2em',
          color: 'var(--ink-faint)', marginBottom: 14,
        }}>§ 02 — REFERENZ</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 48, fontWeight: 500,
            color: 'var(--lime)', letterSpacing: '-0.02em', lineHeight: 1,
          }}>9</div>
          <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Zahlen</div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', lineHeight: 1.5, fontFamily: 'var(--mono)', letterSpacing: '0.04em' }}>
          AYUMU · ♂ · SCHIMPANSE<br/>
          PRIMATE RESEARCH INSTITUTE<br/>
          UNIV. KYOTO · 2007
        </div>
      </div>

      <div style={{ borderTop: '1px dashed var(--line-2)' }} />

      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.2em',
          color: 'var(--ink-faint)', marginBottom: 14,
        }}>§ 03 — DEIN REKORD</div>
        {game.best.numbers > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <div style={{
                fontFamily: 'var(--display)', fontSize: 48, fontWeight: 500,
                color: 'var(--ink)', letterSpacing: '-0.02em', lineHeight: 1,
              }}>{game.best.numbers}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
                Zahlen<br/>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-faint)' }}>
                  Runde {game.best.round}
                </span>
              </div>
            </div>
            {/* Bar comparing to Ayumu */}
            <div style={{ marginTop: 16 }}>
              <div style={{ position: 'relative', height: 4, background: 'var(--line)' }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${Math.min(100, (game.best.numbers/12)*100)}%`,
                  background: 'var(--ink)',
                }} />
                <div style={{
                  position: 'absolute', top: -3, bottom: -3,
                  left: `${(9/12)*100}%`, width: 1,
                  background: 'var(--lime)',
                }} />
              </div>
              <div style={{
                marginTop: 6, display: 'flex', justifyContent: 'space-between',
                fontFamily: 'var(--mono)', fontSize: 9,
                color: 'var(--ink-faint)', letterSpacing: '0.12em',
              }}>
                <span>0</span><span>12</span>
              </div>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--ink-faint)', fontFamily: 'var(--mono)' }}>
            — Kein Rekord —
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------- Intro screen ----------
function LaborIntro({ game }) {
  return (
    <div style={{
      maxWidth: 880, margin: '60px auto', padding: '0 40px',
      display: 'grid', gridTemplateColumns: '1fr auto', gap: 60, alignItems: 'start',
    }}>
      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.3em',
          color: 'var(--lime)', marginBottom: 28,
        }}>
          AYUMU-PROTOKOLL · ARBEITSGEDÄCHTNIS-TEST
        </div>
        <h1 style={{
          fontFamily: 'var(--display)', fontSize: 72, fontWeight: 500,
          letterSpacing: '-0.025em', lineHeight: 0.95,
          marginBottom: 24,
        }}>
          Bist du schlauer<br/>
          als ein <span style={{
            fontStyle: 'italic', color: 'var(--lime)',
          }}>Schimpanse</span>?
        </h1>
        <p style={{
          fontSize: 17, lineHeight: 1.55,
          color: 'var(--ink-dim)',
          maxWidth: 520, marginBottom: 40,
          textWrap: 'pretty',
        }}>
          An der Universität Kyoto wurde nachgewiesen, dass Schimpansen Zahlenfolgen nach einem Bruchteil einer Sekunde korrekt reproduzieren können. Ayumu erreichte <span style={{ color: 'var(--ink)' }}>9 Zahlen in 2 Sekunden</span>. Kannst du mithalten?
        </p>

        <button
          onClick={game.startGame}
          style={{
            padding: '18px 36px',
            background: 'var(--lime)',
            color: 'var(--bg)',
            fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
            letterSpacing: '0.25em', textTransform: 'uppercase',
            borderRadius: 2,
            transition: 'transform 0.1s, box-shadow 0.15s',
          }}
          onMouseEnter={(e)=>{ e.currentTarget.style.boxShadow = '0 0 32px rgba(212,255,0,0.4)'; }}
          onMouseLeave={(e)=>{ e.currentTarget.style.boxShadow = 'none'; }}
        >
          Test starten →
        </button>

        <div style={{ marginTop: 56, display: 'flex', gap: 36 }}>
          <IntroStep n="01" title="Merken" text="Zahlen 1–4 erscheinen auf dem Raster. Präge dir die Positionen ein." />
          <IntroStep n="02" title="Verdecken" text="Mit dem Klick auf die „1“ verschwinden die übrigen Zahlen." />
          <IntroStep n="03" title="Reproduzieren" text="Drücke alle Positionen in aufsteigender Reihenfolge." />
        </div>
      </div>

      <div style={{
        position: 'relative',
        width: 280, height: 280,
        border: '1px solid var(--line-2)',
        padding: 16,
      }}>
        <CornerTick />
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.2em',
          color: 'var(--ink-faint)', marginBottom: 12,
        }}>FIG. A — STIMULI</div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 4,
          width: '100%', height: 'calc(100% - 32px)',
        }}>
          {Array.from({length: 25}, (_, i) => {
            const sample = { 3: 1, 8: 2, 11: 3, 19: 4 };
            const v = sample[i];
            return (
              <div key={i} style={{
                background: v ? 'var(--bg)' : 'transparent',
                border: `1px solid ${v ? 'var(--line-2)' : 'var(--line)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--mono)', fontSize: 18, color: 'var(--ink)',
              }}>{v}</div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
function IntroStep({ n, title, text }) {
  return (
    <div style={{ flex: 1, maxWidth: 160 }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--lime)',
        letterSpacing: '0.2em', marginBottom: 8,
      }}>{n}</div>
      <div style={{ fontFamily: 'var(--display)', fontSize: 16, fontWeight: 500, marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-dim)', lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

// ---------- Game over / round done overlay ----------
function LaborOverlay({ game }) {
  if (game.phase !== 'gameOver' && game.phase !== 'roundDone') return null;
  const isWin = game.phase === 'roundDone';

  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'rgba(10,10,10,0.88)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10,
      animation: 'fadein 0.2s',
    }}>
      <style>{`@keyframes fadein { from{opacity:0}to{opacity:1} }`}</style>
      <div style={{
        width: 520, background: 'var(--surface)',
        border: `1px solid ${isWin ? 'var(--lime)' : 'var(--red)'}`,
        padding: 36, position: 'relative',
      }}>
        <CornerTick />
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.3em',
          color: isWin ? 'var(--lime)' : 'var(--red)',
          marginBottom: 20,
        }}>
          {isWin ? '✓ RUNDE BESTANDEN' : '✗ TEST BEENDET'}
        </div>
        <h2 style={{
          fontFamily: 'var(--display)', fontSize: 40, fontWeight: 500,
          letterSpacing: '-0.02em', marginBottom: 20, lineHeight: 1,
        }}>
          {isWin ? `Runde ${game.round} in ${formatMs(game.elapsedRecall)}s` : 'Ergebnis'}
        </h2>
        {!isWin && game.lastResult && (
          <>
            <div style={{ display: 'flex', gap: 36, marginBottom: 28 }}>
              <Readout label="ERREICHT" value={pad(game.lastResult.numbers)} accent="var(--ink)" />
              <Readout label="RUNDEN" value={pad(game.lastResult.round - 1)} />
              <Readout label="AYUMU" value={pad(9)} accent="var(--lime)" />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={game.startGame}
                style={{
                  flex: 1, padding: '14px 24px',
                  background: 'var(--lime)', color: 'var(--bg)',
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                  letterSpacing: '0.2em', textTransform: 'uppercase',
                }}
              >
                Nochmal
              </button>
              <button
                onClick={game.reset}
                style={{
                  padding: '14px 24px',
                  border: '1px solid var(--line-2)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
                  letterSpacing: '0.2em', textTransform: 'uppercase',
                }}
              >
                Zum Start
              </button>
            </div>
          </>
        )}
        {isWin && (
          <div style={{ fontSize: 13, color: 'var(--ink-dim)', fontFamily: 'var(--mono)' }}>
            Nächste Runde: {game.numbersThisRound + 1} Zahlen →
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Full layout ----------
function LaborChrome({ game }) {
  if (game.phase === 'idle') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <LaborHeader game={game} />
        <LaborIntro game={game} />
      </div>
    );
  }
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <LaborHeader game={game} />
      <StatsRail game={game} />
      <MemorizeBar game={game} />
      <div style={{
        flex: 1, display: 'grid',
        gridTemplateColumns: '1fr 320px',
        gap: 24, padding: 40,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <LaborGrid game={game} />
        </div>
        <LaborSidePanel game={game} />
      </div>
      <LaborOverlay game={game} />
    </div>
  );
}

window.LaborChrome = LaborChrome;
window.ChimpFormat = { pad, formatMs };
