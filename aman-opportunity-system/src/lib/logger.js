const COLORS = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m' };
const RESET = '\x1b[0m';

/** לוגר פשוט שגם צובר שורות כדי לשמור אותן ברשומת ההרצה. */
export function createLogger(prefix = '') {
  const lines = [];
  const emit = (level, ...args) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const stamp = new Date().toISOString().slice(11, 19);
    lines.push(`[${stamp}] ${msg}`);
    console.log(`${COLORS[level] ?? ''}${prefix}${msg}${RESET}`);
  };
  return {
    info: (...a) => emit('info', ...a),
    ok: (...a) => emit('ok', '✓', ...a),
    warn: (...a) => emit('warn', '⚠', ...a),
    error: (...a) => emit('err', '✗', ...a),
    dim: (...a) => emit('dim', ...a),
    lines,
    text: () => lines.join('\n'),
  };
}
