/** 素の引数パーサ。--key value と --flag と位置引数だけ扱う */
export function parseArgs(argv, { flags = [] } = {}) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (flags.includes(name)) {
      options[name] = true;
    } else if (eq !== -1) {
      options[name] = arg.slice(eq + 1);
    } else {
      options[name] = argv[++i];
    }
  }
  return { options, positional };
}

/**
 * 「緯度,経度」を [経度, 緯度] にする。
 * Google マップからコピーした座標がそのまま貼れるよう、入力は緯度が先。
 */
export function parseLatLng(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) throw new Error(`座標の書式が不正: ${text}（「緯度,経度」で指定）`);
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90) throw new Error(`緯度が範囲外: ${lat}（緯度,経度 の順）`);
  if (Math.abs(lng) > 180) throw new Error(`経度が範囲外: ${lng}`);
  return [lng, lat];
}

export function num(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`数値が不正: ${value}`);
  return n;
}
