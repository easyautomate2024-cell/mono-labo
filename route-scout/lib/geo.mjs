/**
 * 測地計算とタイル座標変換。
 * 座標は一貫して [経度, 緯度]（GeoJSON と同じ順序）で扱う。
 */

export const EARTH_RADIUS_M = 6371008.8; // IUGG 平均半径

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** 緯度経度 → タイル番号の小数値（Web メルカトル） */
export function lngLatToTileFraction(lng, lat, z) {
  const n = Math.pow(2, z);
  const latRad = lat * D2R;
  const x = ((lng + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y, z };
}

/** 緯度経度 → タイル番号（整数） */
export function lngLatToTile(lng, lat, z) {
  const f = lngLatToTileFraction(lng, lat, z);
  const n = Math.pow(2, z);
  const clamp = (v) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  return { x: clamp(f.x), y: clamp(f.y), z };
}

/**
 * タイルローカル座標 → 緯度経度。
 * MVT のローカル座標は 0〜extent、y は下向き。
 */
export function tileCoordToLngLat(gx, gy, tile, extent) {
  const n = Math.pow(2, tile.z);
  const lng = ((tile.x + gx / extent) / n) * 360 - 180;
  const yy = Math.PI - 2 * Math.PI * ((tile.y + gy / extent) / n);
  const lat = R2D * Math.atan(0.5 * (Math.exp(yy) - Math.exp(-yy)));
  return [lng, lat];
}

/** タイルの地理的な範囲 [西, 南, 東, 北] */
export function tileBounds(tile) {
  const sw = tileCoordToLngLat(0, 4096, tile, 4096);
  const ne = tileCoordToLngLat(4096, 0, tile, 4096);
  return [sw[0], sw[1], ne[0], ne[1]];
}

/** 2 点間の大円距離（メートル） */
export function haversine(a, b) {
  const phi1 = a[1] * D2R;
  const phi2 = b[1] * D2R;
  const dPhi = (b[1] - a[1]) * D2R;
  const dLambda = (b[0] - a[0]) * D2R;
  const s =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * a から b を見た方位角（真北 0 度・時計回り 0〜360）。
 * ストリートビューの heading はこれで決まる。ツールの価値の大半がここ。
 */
export function bearing(a, b) {
  const phi1 = a[1] * D2R;
  const phi2 = b[1] * D2R;
  const dLambda = (b[0] - a[0]) * D2R;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/**
 * その緯度における 1 度あたりのメートル数（WGS84 の近似式）。
 * 数十メートル規模の最近傍探索はこれで平面近似して十分。
 */
export function metersPerDegree(lat) {
  const p = lat * D2R;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lng: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

/**
 * 点 p から線分 ab への最短距離（メートル）と、その足の位置。
 * t は線分上の位置（0=a, 1=b）。
 */
export function pointToSegment(p, a, b) {
  const m = metersPerDegree(p[1]);
  const px = (p[0] - a[0]) * m.lng;
  const py = (p[1] - a[1]) * m.lat;
  const bx = (b[0] - a[0]) * m.lng;
  const by = (b[1] - a[1]) * m.lat;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - bx * t;
  const dy = py - by * t;
  return {
    distance: Math.hypot(dx, dy),
    t,
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
  };
}

/** 折れ線の全長（メートル） */
export function lineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

/**
 * 折れ線を一定間隔で再サンプリングする。
 * 返り値の distance は起点からの累積距離（メートル）。
 */
export function densify(coords, stepM = 10) {
  if (!coords.length) return [];
  const out = [{ point: coords[0], distance: 0 }];
  if (coords.length === 1) return out;

  let travelled = 0;
  let next = stepM;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const segLen = haversine(a, b);
    if (segLen === 0) continue;
    while (next <= travelled + segLen) {
      const t = (next - travelled) / segLen;
      out.push({
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        distance: next,
      });
      next += stepM;
    }
    travelled += segLen;
  }

  const last = out[out.length - 1];
  if (travelled - last.distance > 1e-6) {
    out.push({ point: coords[coords.length - 1], distance: travelled });
  }
  return out;
}

/**
 * サンプル列の中で、指定距離の地点から lookaheadM 先を向く方位角を返す。
 * 経路の終端では手前の区間の方位で代用する。
 */
export function headingAt(samples, index, lookaheadM = 25) {
  const from = samples[index];
  if (!from) return null;
  const target = from.distance + lookaheadM;
  for (let i = index + 1; i < samples.length; i++) {
    if (samples[i].distance >= target || i === samples.length - 1) {
      if (haversine(from.point, samples[i].point) < 1) continue;
      return bearing(from.point, samples[i].point);
    }
  }
  for (let i = index - 1; i >= 0; i--) {
    if (haversine(samples[i].point, from.point) >= 1) {
      return bearing(samples[i].point, from.point);
    }
  }
  return null;
}
