// App shell: routes Tweaks → chrome variant.

const { useState: aS, useEffect: aE } = React;

function TweaksPanel({ tweaks, setTweaks, active }) {
  return (
    <div className={`tweaks-panel ${active ? 'active' : ''}`}>
      <h4>Tweaks</h4>
      <div className="tweak-row">
        <div className="tweak-label">Variante</div>
        <div className="variant-group">
          {[
            ['labor', 'Labor'],
            ['terminal', 'Terminal'],
            ['studie', 'Studie'],
          ].map(([v, l]) => (
            <button key={v}
              className={`variant-btn ${tweaks.variant === v ? 'active' : ''}`}
              onClick={() => setTweaks({ ...tweaks, variant: v })}
            >{l}</button>
          ))}
        </div>
      </div>
      <div className="tweak-row">
        <label className="tweak-check">
          <input type="checkbox" checked={tweaks.hardMode}
            onChange={e => setTweaks({ ...tweaks, hardMode: e.target.checked })} />
          Chimp-Modus (Zeitdruck ab Runde 1)
        </label>
      </div>
    </div>
  );
}

function App() {
  const [tweaks, setTweaks] = aS(window.__TWEAKS);
  const [tweaksActive, setTweaksActive] = aS(false);
  const game = window.useChimpGame();

  // Apply hard-mode tweak to engine
  aE(() => { game.setHardMode(tweaks.hardMode); }, [tweaks.hardMode]);

  // Edit-mode protocol
  aE(() => {
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === '__activate_edit_mode') setTweaksActive(true);
      if (d.type === '__deactivate_edit_mode') setTweaksActive(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Persist tweak changes
  aE(() => {
    window.__TWEAKS = tweaks;
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits: tweaks,
    }, '*');
  }, [tweaks]);

  const Chrome = ({
    labor: window.LaborChrome,
    terminal: window.TerminalChrome,
    studie: window.StudieChrome,
  })[tweaks.variant] || window.LaborChrome;

  return (
    <>
      <Chrome game={game} />
      <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} active={tweaksActive} />
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
