/**
 * ルート上の狭隘区間を抽出する本体。
 *
 *   polyline → 一定間隔サンプリング → 通過タイル算出 → road をスナップ
 *   → 幅員区分で判定 → 連続区間に統合 → 進行方位つきの SV リンク生成
 *
 * 幅員データは候補を絞るためだけに使う。電柱・路上駐車・カーブミラーの張り出し・
 * 内輪差はデータに含まれないので、最終判断は必ず人間がストリートビューで行う。
 */

import {
  densify,
  bearing,
  pointToSegment,
  lngLatToTile,
  metersPerDegree,
  headingAt,
  lineLength,
} from './geo.mjs';
import { classify, widthLabel, SEVERITY, DEFAULT_THRESHOLDS } from './width.mjs';
import { panoUrl } from './svlink.mjs';

export const DEFAULT_OPTIONS = {
  zoom: 16,             // 幅員属性が入る最大ズーム
  stepM: 10,            // サンプリング間隔
  snapRadiusM: 20,      // スナップの距離閾値（暫定値。実データで要調整）
  angleToleranceDeg: 45, // ルートと道路中心線の向きのずれ許容量
  lookaheadM: 20,       // 進行方位を測る先読み距離
  mergeGapM: 30,        // 「不明」がこの長さ以内なら同一区間として繋ぐ
  minRunM: 0,           // これより短い区間を捨てる（既定では捨てない）
  linkIntervalM: 200,   // 長い区間には途中にも SV リンクを足す
  thresholds: DEFAULT_THRESHOLDS,
};

/**
 * ルートを走査して警告一覧を作る。
 *
 * @param {Array<[number, number]>} coords [経度, 緯度] の折れ線
 * @param {object} options provider は必須
 */
export async function scanRoute(coords, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const provider = opts.provider;
  if (!provider) throw new Error('provider が指定されていない');
  if (!coords || coords.length < 2) throw new Error('ルートの座標が 2 点未満');

  const samples = densify(coords, opts.stepM);
  for (let i = 0; i < samples.length; i++) {
    samples[i].heading = headingAt(samples, i, opts.lookaheadM);
  }

  // 通過タイル（スナップ半径ぶん外側も含める。道路がタイル境界の向こうにありうる）
  const tiles = tilesCovering(samples, opts.zoom, opts.snapRadiusM);

  const index = new SegmentIndex();
  let roadFeatures = 0;
  for (const tile of tiles) {
    const roads = await provider.roadsInTile(tile);
    roadFeatures += roads.length;
    for (const road of roads) {
      for (let i = 1; i < road.coords.length; i++) {
        index.insert(road.coords[i - 1], road.coords[i], road.props);
      }
    }
  }

  const snapped = samples.map((sample) => snapSample(sample, index, opts));
  const runs = buildRuns(snapped, opts);

  const matched = snapped.filter((s) => s.rnkWidth !== null).length;
  return {
    runs,
    samples: snapped,
    attribution: provider.attribution,
    stats: {
      routeLengthM: lineLength(coords),
      sampleCount: snapped.length,
      matchedCount: matched,
      matchRate: snapped.length ? matched / snapped.length : 0,
      tileCount: tiles.length,
      roadFeatureCount: roadFeatures,
      warnCount: runs.filter((r) => r.severity === SEVERITY.WARN).length,
      avoidCount: runs.filter((r) => r.severity === SEVERITY.AVOID).length,
    },
  };
}

/**
 * 1 地点だけを調べる（ステップ1 の検証用）。
 * 進行方位が無いので向きによる絞り込みはせず、半径内の候補を近い順に全部返す。
 * 並走する路地を拾っていないかを目で確かめられるようにするため。
 */
export async function probePoint(point, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!opts.provider) throw new Error('provider が指定されていない');

  const tiles = tilesCovering([{ point }], opts.zoom, opts.snapRadiusM);
  const index = new SegmentIndex();
  let roadFeatures = 0;
  for (const tile of tiles) {
    const roads = await opts.provider.roadsInTile(tile);
    roadFeatures += roads.length;
    for (const road of roads) {
      for (let i = 1; i < road.coords.length; i++) {
        index.insert(road.coords[i - 1], road.coords[i], road.props);
      }
    }
  }

  const m = metersPerDegree(point[1]);
  const candidates = index.near(
    point[0],
    point[1],
    opts.snapRadiusM / m.lng,
    opts.snapRadiusM / m.lat,
  );

  const hits = [];
  for (const seg of candidates) {
    const hit = pointToSegment(point, seg.a, seg.b);
    if (hit.distance > opts.snapRadiusM) continue;
    const rnkWidth = normalizeRnk(seg.props.rnkWidth);
    hits.push({
      distanceM: hit.distance,
      foot: hit.point,
      bearing: bearing(seg.a, seg.b),
      rnkWidth,
      widthLabel: widthLabel(rnkWidth),
      severity: classify(rnkWidth, opts.thresholds),
      props: seg.props,
    });
  }
  hits.sort((a, b) => a.distanceM - b.distanceM);

  return { point, tiles, roadFeatureCount: roadFeatures, hits };
}

/** サンプル列が通るタイルの集合。padM ぶん外側のタイルも含める */
export function tilesCovering(samples, zoom, padM = 0) {
  const seen = new Map();
  for (const s of samples) {
    const [lng, lat] = s.point ?? s;
    const m = metersPerDegree(lat);
    const dLng = padM / m.lng;
    const dLat = padM / m.lat;
    for (const [ox, oy] of [[0, 0], [-dLng, -dLat], [dLng, -dLat], [-dLng, dLat], [dLng, dLat]]) {
      const tile = lngLatToTile(lng + ox, lat + oy, zoom);
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      if (!seen.has(key)) seen.set(key, tile);
    }
  }
  return [...seen.values()];
}

/**
 * 1 サンプルを最寄りの道路中心線にスナップする。
 *
 * 単純な最近傍だと、並走する細い路地を拾って誤警告になる。
 * ルートの進行方位と向きが揃っている線分を優先し、揃ったものが無いときだけ
 * 最近傍にフォールバックして、その旨を印として残す。
 */
function snapSample(sample, index, opts) {
  const [lng, lat] = sample.point;
  const m = metersPerDegree(lat);
  const candidates = index.near(lng, lat, opts.snapRadiusM / m.lng, opts.snapRadiusM / m.lat);

  let nearest = null;
  let aligned = null;
  for (const seg of candidates) {
    const hit = pointToSegment(sample.point, seg.a, seg.b);
    if (hit.distance > opts.snapRadiusM) continue;
    const angleDiff = sample.heading === null
      ? 0
      : undirectedAngleDiff(bearing(seg.a, seg.b), sample.heading);
    const cand = { seg, distance: hit.distance, foot: hit.point, angleDiff };
    if (!nearest || cand.distance < nearest.distance) nearest = cand;
    if (angleDiff <= opts.angleToleranceDeg && (!aligned || cand.distance < aligned.distance)) {
      aligned = cand;
    }
  }

  const chosen = aligned ?? nearest;
  const rnkWidth = chosen ? normalizeRnk(chosen.seg.props.rnkWidth) : null;

  return {
    ...sample,
    rnkWidth,
    severity: classify(rnkWidth, opts.thresholds),
    snapDistanceM: chosen ? chosen.distance : null,
    angleDiff: chosen ? chosen.angleDiff : null,
    alignedFallback: Boolean(chosen && !aligned),
    props: chosen ? chosen.seg.props : null,
  };
}

function normalizeRnk(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 0〜180 度で見た向きのずれ（逆向きの一方通行も同じ道として扱う） */
function undirectedAngleDiff(a, b) {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

/**
 * 連続するサンプルを 1 件の警告に統合する。
 * 同じ狭隘路が複数フィーチャに分割されているため、まとめないと一覧が読めない。
 * 「不明」が短く挟まる場合は、データの穴とみなして前後を繋ぐ。
 */
function buildRuns(snapped, opts) {
  const groups = [];
  for (const s of snapped) {
    const last = groups[groups.length - 1];
    if (last && last.severity === s.severity) last.items.push(s);
    else groups.push({ severity: s.severity, items: [s] });
  }

  // 短い UNKNOWN の穴を前後の同一重大度で埋める
  for (let i = 1; i < groups.length - 1; i++) {
    const g = groups[i];
    if (g.severity !== SEVERITY.UNKNOWN) continue;
    const span = g.items[g.items.length - 1].distance - g.items[0].distance + opts.stepM;
    const prev = groups[i - 1];
    const next = groups[i + 1];
    if (span <= opts.mergeGapM && prev.severity === next.severity && isWarnable(prev.severity)) {
      prev.items.push(...g.items, ...next.items);
      groups.splice(i, 2);
      i--;
    }
  }

  const runs = [];
  for (const g of groups) {
    if (!isWarnable(g.severity)) continue;
    const startM = g.items[0].distance;
    const endM = g.items[g.items.length - 1].distance;
    const lengthM = Math.max(endM - startM, opts.stepM);
    if (lengthM < opts.minRunM) continue;

    const classified = g.items.filter((s) => s.rnkWidth !== null);
    const worst = classified.reduce(
      (acc, s) => (acc === null || s.rnkWidth < acc.rnkWidth ? s : acc),
      null,
    );

    runs.push({
      severity: g.severity,
      rnkWidth: worst ? worst.rnkWidth : null,
      widthLabel: widthLabel(worst ? worst.rnkWidth : null),
      startM,
      endM,
      lengthM,
      sampleCount: g.items.length,
      unknownCount: g.items.length - classified.length,
      alignedFallback: g.items.some((s) => s.alignedFallback),
      roadCategory: worst?.props?.rdCtg ?? null,
      actualWidth: worst?.props?.Width ?? null,
      links: buildLinks(g.items, opts),
    });
  }

  return runs;
}

function isWarnable(severity) {
  return severity === SEVERITY.WARN || severity === SEVERITY.AVOID;
}

/**
 * 区間を見るためのストリートビューリンク。
 * 必ず入口の 1 本は出し、長い区間には linkIntervalM ごとに追加する。
 */
function buildLinks(items, opts) {
  const links = [];
  let nextAt = items[0].distance;
  for (const s of items) {
    if (s.distance + 1e-6 < nextAt) continue;
    links.push({
      distanceM: s.distance,
      point: s.point,
      heading: s.heading,
      rnkWidth: s.rnkWidth,
      url: panoUrl({ lat: s.point[1], lng: s.point[0], heading: s.heading }),
    });
    nextAt = s.distance + opts.linkIntervalM;
  }
  return links;
}

/**
 * 線分の簡易グリッド索引。
 * タイル数十枚ぶんの道路中心線に対して、サンプルごとの最近傍探索を回すため。
 */
export class SegmentIndex {
  constructor(cellDeg = 0.002) {
    this.cellDeg = cellDeg;
    this.cells = new Map();
    this.seen = new Set();
  }

  insert(a, b, props) {
    // 隣接タイルは縁を重ねて配信されるので、同じ線分が何度も入ってくる。
    // 候補一覧が同じ道で埋まると、並走路地の有無が読めなくなる。
    const key = `${a[0].toFixed(7)},${a[1].toFixed(7)},${b[0].toFixed(7)},${b[1].toFixed(7)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    const seg = { a, b, props };
    const x0 = Math.floor(Math.min(a[0], b[0]) / this.cellDeg);
    const x1 = Math.floor(Math.max(a[0], b[0]) / this.cellDeg);
    const y0 = Math.floor(Math.min(a[1], b[1]) / this.cellDeg);
    const y1 = Math.floor(Math.max(a[1], b[1]) / this.cellDeg);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx}:${cy}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(seg);
        else this.cells.set(key, [seg]);
      }
    }
  }

  near(lng, lat, radiusLngDeg, radiusLatDeg) {
    const x0 = Math.floor((lng - radiusLngDeg) / this.cellDeg);
    const x1 = Math.floor((lng + radiusLngDeg) / this.cellDeg);
    const y0 = Math.floor((lat - radiusLatDeg) / this.cellDeg);
    const y1 = Math.floor((lat + radiusLatDeg) / this.cellDeg);
    const out = new Set();
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(`${cx}:${cy}`);
        if (bucket) for (const seg of bucket) out.add(seg);
      }
    }
    return out;
  }
}
