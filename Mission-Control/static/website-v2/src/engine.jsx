// Game engine — state machine + grid logic + scoring.
// Exposes useChimpGame() which returns everything chrome components need.
//
// Phases:
//   idle        -> waiting on intro screen
//   memorize    -> numbers visible, timer counting down (hard mode only after round 1)
//   recall      -> first click has been made, others hidden, must click in order
//   roundDone   -> success; brief pause before next round
//   gameOver    -> miss; show results
//
// Rules (matching original):
//   - Round 1 starts with 4 numbers
//   - Each round adds one number (round N => N+3 numbers)
//   - After first click, non-selected cells blank out
//   - Click in ascending order or game ends
//   - Time limit applies from round 2 onwards
//   - Ayumu benchmark: 9 numbers (reached round 6)

const { useState, useEffect, useRef, useCallback, useMemo } = React;

const GRID_COLS = 7;
const GRID_ROWS = 5;
const TOTAL_CELLS = GRID_COLS * GRID_ROWS;
const AYUMU_SCORE = 9; // Ayumu reached 9 numbers

// Memorize duration in ms per round. First round generous, tightens fast.
function memorizeTime(round, hardMode) {
  if (round === 1 && !hardMode) return 99999; // no pressure, original behavior
  // Round 2: 3000ms, tapers toward Ayumu-level 2000ms
  const base = Math.max(2000, 3400 - (round - 1) * 200);
  return hardMode ? Math.max(1500, base - 500) : base;
}

function numbersForRound(round) {
  // Round 1 = 4 numbers; Round N = N + 3
  return round + 3;
}

function placeNumbers(count) {
  const indices = [];
  while (indices.length < count) {
    const idx = Math.floor(Math.random() * TOTAL_CELLS);
    if (!indices.includes(idx)) indices.push(idx);
  }
  // Map: cellIndex -> number value (1-based)
  const map = {};
  indices.forEach((cellIdx, i) => { map[cellIdx] = i + 1; });
  return map;
}

function bestKey() { return 'chimp.best.v1'; }
function loadBest() {
  try {
    const raw = localStorage.getItem(bestKey());
    return raw ? JSON.parse(raw) : { round: 0, numbers: 0, at: null };
  } catch { return { round: 0, numbers: 0, at: null }; }
}
function saveBest(best) {
  try { localStorage.setItem(bestKey(), JSON.stringify(best)); } catch {}
}

function useChimpGame() {
  const [phase, setPhase] = useState('idle');
  const [round, setRound] = useState(1);
  const [cells, setCells] = useState({});        // {cellIdx: number}
  const [nextExpected, setNextExpected] = useState(1);
  const [revealed, setRevealed] = useState(true); // numbers visible?
  const [timeLeft, setTimeLeft] = useState(0);    // ms remaining in memorize
  const [memorizeWindow, setMemorizeWindow] = useState(0); // full memorize duration
  const [elapsedRecall, setElapsedRecall] = useState(0); // ms in recall phase
  const [hardMode, setHardMode] = useState(false);
  const [best, setBest] = useState(loadBest());
  const [lastResult, setLastResult] = useState(null); // {round, numbers, recallMs}

  const tickRef = useRef(null);
  const recallStartRef = useRef(0);
  const memorizeStartRef = useRef(0);

  const clearTick = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  };

  // Start a given round from scratch.
  const startRound = useCallback((r) => {
    clearTick();
    const count = numbersForRound(r);
    const map = placeNumbers(count);
    const window = memorizeTime(r, hardMode);
    setRound(r);
    setCells(map);
    setNextExpected(1);
    setRevealed(true);
    setMemorizeWindow(window);
    setTimeLeft(window);
    setElapsedRecall(0);
    setPhase('memorize');
    memorizeStartRef.current = performance.now();

    // Round 1 has no timer (matches original). All other rounds count down.
    if (r > 1 || hardMode) {
      tickRef.current = setInterval(() => {
        const remain = window - (performance.now() - memorizeStartRef.current);
        if (remain <= 0) {
          clearTick();
          setTimeLeft(0);
          // Timeout during memorize = fail
          handleFail();
        } else {
          setTimeLeft(remain);
        }
      }, 50);
    }
  }, [hardMode]);

  const startGame = useCallback(() => {
    setLastResult(null);
    startRound(1);
  }, [startRound]);

  const handleFail = useCallback(() => {
    clearTick();
    const numbers = numbersForRound(round);
    const reached = { round, numbers: numbers - 1, recallMs: performance.now() - recallStartRef.current };
    // Personal best: highest round completed fully (not the failing one)
    const achieved = Math.max(0, round - 1);
    const achievedNumbers = achieved > 0 ? numbersForRound(achieved) : 0;
    if (achievedNumbers > best.numbers) {
      const newBest = { round: achieved, numbers: achievedNumbers, at: Date.now() };
      setBest(newBest);
      saveBest(newBest);
    }
    setLastResult(reached);
    setPhase('gameOver');
  }, [round, best.numbers]);

  const clickCell = useCallback((cellIdx) => {
    const value = cells[cellIdx];
    if (phase === 'memorize') {
      // First click starts recall
      if (value === 1) {
        clearTick();
        setRevealed(false);
        setPhase('recall');
        setNextExpected(2);
        recallStartRef.current = performance.now();
        // Mark this cell cleared
        setCells(prev => {
          const nxt = { ...prev };
          delete nxt[cellIdx];
          return nxt;
        });
        // Check if game is already done (only 1 number case shouldn't happen but be safe)
        if (Object.keys(cells).length === 1) {
          completeRound();
        }
      } else if (value !== undefined) {
        // Clicked wrong first number
        handleFail();
      }
      // Clicking empty cell during memorize: ignore
      return;
    }

    if (phase === 'recall') {
      if (value === nextExpected) {
        setCells(prev => {
          const nxt = { ...prev };
          delete nxt[cellIdx];
          return nxt;
        });
        const remaining = Object.keys(cells).length - 1;
        if (remaining === 0) {
          completeRound();
        } else {
          setNextExpected(n => n + 1);
        }
      } else if (value !== undefined) {
        handleFail();
      }
      // Click on empty cell: no-op (can't verify since numbers are hidden)
    }
  }, [cells, nextExpected, phase]);

  const completeRound = useCallback(() => {
    clearTick();
    const recallMs = performance.now() - recallStartRef.current;
    setElapsedRecall(recallMs);
    const numbers = numbersForRound(round);
    if (numbers > best.numbers) {
      const newBest = { round, numbers, at: Date.now() };
      setBest(newBest);
      saveBest(newBest);
    }
    setPhase('roundDone');
    // Auto-advance after a brief pause
    setTimeout(() => {
      startRound(round + 1);
    }, 1400);
  }, [round, best.numbers, startRound]);

  const reset = useCallback(() => {
    clearTick();
    setPhase('idle');
    setRound(1);
    setCells({});
    setNextExpected(1);
    setLastResult(null);
  }, []);

  // Recall elapsed tracker (display only)
  useEffect(() => {
    if (phase !== 'recall') return;
    const id = setInterval(() => {
      setElapsedRecall(performance.now() - recallStartRef.current);
    }, 50);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => () => clearTick(), []);

  const numbersThisRound = useMemo(() => numbersForRound(round), [round]);
  const memorizeProgress = memorizeWindow > 0 ? Math.max(0, Math.min(1, timeLeft / memorizeWindow)) : 1;

  return {
    phase, round, cells, nextExpected, revealed,
    timeLeft, memorizeWindow, memorizeProgress, elapsedRecall,
    numbersThisRound, hardMode, setHardMode,
    best, lastResult,
    GRID_COLS, GRID_ROWS, TOTAL_CELLS, AYUMU_SCORE,
    startGame, startRound, clickCell, reset,
  };
}

window.useChimpGame = useChimpGame;
window.CHIMP_CONSTANTS = { GRID_COLS, GRID_ROWS, TOTAL_CELLS, AYUMU_SCORE };
