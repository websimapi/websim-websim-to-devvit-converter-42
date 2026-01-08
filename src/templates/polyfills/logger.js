export const simpleLoggerJs = `
// [WebSim] Logger Polyfill - Global Script
(function() {
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;

  function post(level, args) {
    try {
      const msgPreview = args.map(String).join(' ');
      if (msgPreview.includes('AudioContext') || msgPreview.includes('acknowledgeRemotionLicense')) return;

      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']';
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch(e) { return '[Circular]'; }
        }
        return String(a);
      });
      
      if (window.parent) {
          window.parent.postMessage(JSON.stringify({ type: 'console', level, args: serialized }), '*');
      }
    } catch(e) {}
  }

  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught]', e.message]);
  });
})();
`;