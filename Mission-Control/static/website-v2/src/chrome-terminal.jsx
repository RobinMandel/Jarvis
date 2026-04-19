// Variant 2: TERMINAL — pure CRT/diagnostic printout aesthetic.
// All-green-phosphor, scanlines, monospace everywhere, ASCII borders.

const { useState: tS, useEffect: tE, useMemo: tM } = React;
const { pad: tpad, formatMs: tfmt } = window.ChimpFormat;

// Typed-in log effect
function useTypedLog(lines, speed = 18) {
  const [visible, setVisible] = tS(0);
  tE(() => { setVisible(0); }, [lines.join('|')]);
  tE(() => {
    if (visible >= lines.length) return;
    const id = setTimeout(() => setVisible(v => v + 1), speed * lines[visible].length + 80);
    return () => clearTimeout(id);
  }, [visible, lines, speed]);
  return lines.slice(0, visible + 1);
}

function TermPanel({ title, children, minWidth, style }) {
  return (
    <div style={{
      border: '1px solid #2a4a1a',
      background: '#0a120a',
      minWidth,
      ...style,
    }}>
      <div style={{
        borderBottom: '1px solid #2a4a1a',
        padding: '6px 12px',
        fontFamily: 'var(--mono)', fontSize: 10,
        color: '#7dff3a', letterSpacing: '0.2em',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>▸ {title}</span>
        <span style={{ color: '#3a6a2a' }}>◆◆◆</span>
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

function Scanlines() {
  return (
    <div style={{
      position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 999,
      background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.12) 2px, rgba(0,0,0,0.12) 3px)',
      mixBlendMode: 'multiply',
    }} />
  );
}

function TermHeader({ game }) {
  const line = tM(() => {
    const d = new Date();
    return `${d.toISOString().replace('T',' ').slice(0,19)}`;
  }, []);
  return (
    <div style={{
      padding: '14px 28px',
      borderBottom: '1px solid #2a4a1a',
      fontFamily: 'var(--mono)', fontSize: 11,
      color: '#7dff3a', display: 'flex', alignItems: 'center', gap: 24,
      letterSpacing: '0.08em',
    }}>
      <span style={{ color: '#b8ff6a' }}>CHIMP-TEST v2.04</span>
      <span style={{ color: '#3a6a2a' }}>│</span>
      <span>SESSION {line}</span>
      <span style={{ color: '#3a6a2a' }}>│</span>
      <span>BUFFER OK</span>
      <span style={{ color: '#3a6a2a' }}>│</span>
      <span style={{ color: '#b8ff6a' }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, background: '#7dff3a',
          marginRight: 6, animation: 'blink 1s steps(2) infinite',
        }} />
        REC
      </span>
      <style>{`@keyframes blink { 50%{opacity:0} }`}</style>
      <div style={{ flex: 1 }} />
      <span style={{ color: '#3a6a2a' }}>PID 00-AYUMU · KYOTO · 2007</span>
    </div>
  );
}

function TermGrid({ game }) {
  const { cells, phase, revealed, nextExpected, clickCell, GRID_COLS, GRID_ROWS, TOTAL_CELLS } = game;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${GRID_COLS}, 82px)`,
      gridTemplateRows: `repeat(${GRID_ROWS}, 82px)`,
      gap: 0,
      border: '1px solid #3a6a2a',
      padding: 0,
    }}>
      {Array.from({length: TOTAL_CELLS}, (_, i) => {
        const val = cells[i];
        const active = val !== undefined;
        const show = active && (revealed || phase === 'roundDone');
        const col = i % GRID_COLS;
        const row = Math.floor(i / GRID_COLS);
        return (
          <button key={i}
            onClick={() => clickCell(i)}
            style={{
              borderRight: col < GRID_COLS-1 ? '1px solid #1c3a12' : 'none',
              borderBottom: row < GRID_ROWS-1 ? '1px solid #1c3a12' : 'none',
              background: active ? '#0d1a0a' : 'transparent',
              cursor: (phase === 'memorize' || phase === 'recall') ? 'pointer' : 'default',
              fontFamily: 'var(--mono)',
              fontSize: 32, fontWeight: 600,
              color: '#b8ff6a',
              position: 'relative',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (active && phase === 'recall') e.currentTarget.style.background = '#1a2e10'; }}
            onMouseLeave={e => { if (active && phase === 'recall') e.currentTarget.style.background = '#0d1a0a'; }}
          >
            {/* ASCII coord corner */}
            <span style={{
              position: 'absolute', top: 3, left: 4,
              fontSize: 8, color: '#2a4a1a', letterSpacing: '0.1em',
            }}>{String.fromCharCode(65+col)}{pad(row+1)}</span>
            {show && <span style={{ textShadow: '0 0 8px rgba(125,255,58,0.6)' }}>{val}</span>}
            {active && !show && phase === 'recall' && (
              <span style={{ color: '#3a6a2a', fontSize: 28 }}>█</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TermStats({ game }) {
  const timeStr = game.phase === 'memorize' && game.round > 1
    ? tfmt(game.timeLeft)
    : game.phase === 'recall' || game.phase === 'roundDone'
      ? tfmt(game.elapsedRecall)
      : '--.--';
  const barCh = 20;
  const filled = Math.round((game.memorizeProgress) * barCh);
  const bar = '█'.repeat(filled) + '░'.repeat(barCh - filled);
  return (
    <TermPanel title="TELEMETRY">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#7dff3a', lineHeight: 1.8 }}>
        <Row k="runde" v={tpad(game.round)} />
        <Row k="zahlen" v={tpad(game.numbersThisRound)} accent />
        <Row k="t_memo" v={tfmt(game.memorizeWindow || 0)} />
        <Row k="t_lauf" v={timeStr} />
        <Row k="memo_bar" v={bar} mono />
        <Row k="nexpected" v={game.phase === 'recall' ? tpad(game.nextExpected) : '----'} />
        <Row k="phase" v={({
          idle:'ready', memorize:'watching',
          recall:'input', roundDone:'pass', gameOver:'abort'
        })[game.phase]} />
        <Row k="best" v={tpad(game.best.numbers || 0)} />
        <Row k="target" v="09 [ayumu]" accent />
      </div>
    </TermPanel>
  );
}

function Row({ k, v, accent, mono }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: '#3a6a2a', minWidth: 90 }}>{k.padEnd(10, '.')}</span>
      <span style={{ color: accent ? '#b8ff6a' : '#7dff3a', fontFamily: 'var(--mono)' }}>{v}</span>
    </div>
  );
}

function TermLog({ game }) {
  const lines = tM(() => {
    const ls = [
      '> init chimp-memory-test',
      '> loading stimulus set... OK',
      `> round ${tpad(game.round)} | n=${game.numbersThisRound} | grid=7x5`,
    ];
    if (game.phase === 'memorize') ls.push('> awaiting subject response');
    if (game.phase === 'recall') ls.push(`> stimulus masked. expected=${game.nextExpected}`);
    if (game.phase === 'roundDone') ls.push(`> PASS @ ${tfmt(game.elapsedRecall)}s`);
    if (game.phase === 'gameOver') ls.push(`> FAIL @ round ${game.round}`);
    return ls;
  }, [game.phase, game.round, game.nextExpected, game.numbersThisRound]);

  return (
    <TermPanel title="LOG">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#7dff3a', lineHeight: 1.7 }}>
        {lines.map((l, i) => (
          <div key={i} style={{
            color: l.includes('FAIL') ? '#ff6a3a' : l.includes('PASS') ? '#b8ff6a' : '#7dff3a',
          }}>
            <span style={{ color: '#3a6a2a', marginRight: 4 }}>{tpad(i+1, 3)}</span>{l}
            {i === lines.length - 1 && <span style={{ animation: 'blink 1s steps(2) infinite' }}>▊</span>}
          </div>
        ))}
      </div>
    </TermPanel>
  );
}

function TermInstructions({ game }) {
  return (
    <TermPanel title="PROTOCOL">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#7dff3a', lineHeight: 1.7 }}>
        <div style={{ color: '#3a6a2a' }}>// aufgabe</div>
        <div>merken der ziffern 1..{game.numbersThisRound}</div>
        <div>ersten klick auf «1»</div>
        <div>rest folgt aufsteigend</div>
        <div style={{ color: '#3a6a2a', marginTop: 10 }}>// referenz</div>
        <div>ayumu := 9 stk / 2000ms</div>
        <div style={{ color: '#3a6a2a' }}>// regel</div>
        <div>miss = abbruch</div>
      </div>
    </TermPanel>
  );
}

function TermIntro({ game }) {
  const hero = [
    '  ____ _   _ ___ __  __ ____  ',
    ' / ___| | | |_ _|  \\/  |  _ \\ ',
    '| |   | |_| || || |\\/| | |_) |',
    '| |___|  _  || || |  | |  __/ ',
    ' \\____|_| |_|___|_|  |_|_|    ',
  ];
  return (
    <div style={{ maxWidth: 980, margin: '40px auto', padding: '0 28px' }}>
      <pre style={{
        fontFamily: 'var(--mono)', fontSize: 14, color: '#b8ff6a',
        lineHeight: 1.1, marginBottom: 20, textShadow: '0 0 8px rgba(125,255,58,0.3)',
      }}>{hero.join('\n')}</pre>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 13, color: '#7dff3a', lineHeight: 1.7,
        marginBottom: 28,
      }}>
        <div>┌─ README ─────────────────────────────────────────────┐</div>
        <div>│ bist du schlauer als ein schimpanse?                 │</div>
        <div>│                                                      │</div>
        <div>│ der spitzenreiter »ayumu« erreichte 9 zahlen in      │</div>
        <div>│ 2 sekunden — studie univ. kyoto, 2007.               │</div>
        <div>│                                                      │</div>
        <div>│ [1] merken                                           │</div>
        <div>│ [2] erste zahl drücken → rest wird maskiert          │</div>
        <div>│ [3] reihenfolge 1→n eingeben                         │</div>
        <div>└──────────────────────────────────────────────────────┘</div>
      </div>
      <button
        onClick={game.startGame}
        style={{
          padding: '14px 28px',
          background: '#7dff3a',
          color: '#081208',
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
          letterSpacing: '0.2em', textTransform: 'uppercase',
          boxShadow: '0 0 24px rgba(125,255,58,0.4)',
        }}
      >
        ▶ ./start.sh
      </button>
      <span style={{
        marginLeft: 12, fontFamily: 'var(--mono)', fontSize: 11,
        color: '#3a6a2a',
      }}>
        _ drücke RETURN
      </span>
    </div>
  );
}

function TermOverlay({ game }) {
  if (game.phase !== 'gameOver' && game.phase !== 'roundDone') return null;
  const isWin = game.phase === 'roundDone';
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'rgba(8,18,8,0.9)', zIndex: 10,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: 560,
        border: `1px solid ${isWin ? '#7dff3a' : '#ff6a3a'}`,
        background: '#0a120a', padding: 28,
        fontFamily: 'var(--mono)',
        boxShadow: `0 0 40px ${isWin ? 'rgba(125,255,58,0.3)' : 'rgba(255,106,58,0.3)'}`,
      }}>
        <div style={{
          fontSize: 11, color: isWin ? '#7dff3a' : '#ff6a3a',
          letterSpacing: '0.25em', marginBottom: 14,
        }}>
          {isWin ? '// SIGNAL: PASS' : '// SIGNAL: ABORT'}
        </div>
        <div style={{
          fontSize: 28, color: '#b8ff6a', marginBottom: 18,
          textShadow: '0 0 8px rgba(125,255,58,0.4)',
        }}>
          {isWin ? `round.${tpad(game.round)} = ok` : 'test.halt()'}
        </div>
        {!isWin && game.lastResult && (
          <div style={{ fontSize: 12, color: '#7dff3a', lineHeight: 1.8 }}>
            <Row k="erreicht" v={tpad(game.lastResult.numbers)} accent />
            <Row k="runden" v={tpad(game.lastResult.round - 1)} />
            <Row k="ayumu" v="09" />
            <Row k="best" v={tpad(game.best.numbers || 0)} />
          </div>
        )}
        {isWin && (
          <div style={{ fontSize: 12, color: '#7dff3a' }}>
            → loading round.{tpad(game.round+1)} (n={game.numbersThisRound+1})
          </div>
        )}
        {!isWin && (
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button onClick={game.startGame} style={{
              flex: 1, padding: '12px', background: '#7dff3a', color: '#081208',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
              letterSpacing: '0.2em', textTransform: 'uppercase',
            }}>./retry</button>
            <button onClick={game.reset} style={{
              padding: '12px 20px', border: '1px solid #3a6a2a', color: '#7dff3a',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
              letterSpacing: '0.2em', textTransform: 'uppercase',
            }}>./exit</button>
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalChrome({ game }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#081208', color: '#7dff3a',
      position: 'relative',
    }}>
      <Scanlines />
      <TermHeader game={game} />
      {game.phase === 'idle' ? (
        <TermIntro game={game} />
      ) : (
        <div style={{
          padding: 28, display: 'grid',
          gridTemplateColumns: '260px 1fr 260px',
          gap: 20, alignItems: 'start',
          position: 'relative', minHeight: 'calc(100vh - 48px)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <TermStats game={game} />
            <TermInstructions game={game} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12 }}>
            <TermGrid game={game} />
          </div>
          <TermLog game={game} />
          <TermOverlay game={game} />
        </div>
      )}
    </div>
  );
}

window.TerminalChrome = TerminalChrome;
