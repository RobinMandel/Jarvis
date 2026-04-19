// Mission Control V3 — Frontend Config
window.MC = window.MC || {};
MC.config = {
  wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat`,
  apiBase: '/api',
  pollInterval: 60000,
};
