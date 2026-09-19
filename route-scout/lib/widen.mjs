/**
 * ルートを「広い道寄り」に寄せる。
 *
 * 自前で経路探索はしない。Google に引かせたルートを幅員で採点し、
 * 狭い区間の近くにある太い道の上に経由点を置いて引き直す、を数回繰り返す。
 *
 * ベクトルタイルには道路の接続情報が入っていないので、道を繋ぐ仕事は Google に任せる。
 * 一方通行・進入禁止も Google が守る。こちらは「どこを通ってほしいか」を
 * 経由点で示すだけ。
 *
 * 広い道になる保証はない。良くなったときだけ採用する、という作り。
 */

import { scanRoute, tilesCovering } from './scout.mjs';
import { haversine } from './geo.mjs';

export const DEFAULT_WIDEN_OPTIONS = {
  // 最初の 1 回を除いた引き直しの上限。課金額はここで決まる
  maxRouteCalls: 4,
  // 太い道を探すズーム。低ズームは細い道が間引かれていて、こちらの用途には都合がいい
  candidateZoom: 14,
  // 狭い区間の周りで太い道を探す範囲
  searchRadiusM: 2000,
  // 狭い区間に近すぎる点を経由点にしても迂回にならない
  minClearanceM: 200,
  // これ以上の幅員区分を「太い道」とみなす（5=その他, 6=不明 は除く）
  minWideRnk: 2,
  // 遠回り 1km を、狭い道の何メートル分のつらさと見るか
  detourPenaltyPerKm: 100,
  // 区分 0（3m未満）は区分 1 より重く見る
  severityWeight: { 0: 3, 1: 1 },
  // 1 つの狭い区間に対して試す経由点の数
  maxCandidatesPerRun: 3,
  // 候補をまとめるグリッドの大きさ
  clusterM: 500,
};

/**
 * 狭い区間のつらさと遠回りを足して 1 つの数にする。小さいほど良い。
 * この重みづけが「どこまで遠回りしてでも広い道を選ぶか」を決める。
 */
export function scoreRoute(scan, baselineLengthM, options = DEFAULT_WIDEN_OPTIONS) {
  let narrowScore = 0;
  let narrowMeters = 0;
  for (const run of scan.runs) {
    const weight = options.severityWeight[run.rnkWidth] ?? 1;
    narrowScore += run.lengthM * weight;
    narrowMeters += run.lengthM;
  }
  const extraKm = Math.max(0, scan.stats.routeLengthM - baselineLengthM) / 1000;
  return {
    total: narrowScore + extraKm * options.detourPenaltyPerKm,
    narrowScore,
    narrowMeters,
    extraKm,
    runCount: scan.runs.length,
  };
}

/**
 * 広い道に寄せたルートを返す。
 *
 * @param {object} args
 * @param {object} args.routeProvider route(from, to, {intermediates}) を持つもの
 * @param {object} args.widthProvider roadsInTile(tile) を持つもの
 * @param {function} [args.onProgress] 途中経過の通知（画面で進捗を出すため）
 */
export async function widenRoute({
  from,
  to,
  routeProvider,
  widthProvider,
  routeOptions = {},
  scanOptions = {},
  options = {},
  onProgress = null,
}) {
  const opts = { ...DEFAULT_WIDEN_OPTIONS, ...options };
  const scan = (coords) => scanRoute(coords, { ...scanOptions, provider: widthProvider });

  const first = await routeProvider.route(from, to, routeOptions);
  let routeCalls = 1;
  const firstScan = await scan(first.coords);
  const baselineLengthM = firstScan.stats.routeLengthM;

  let best = {
    route: first,
    scan: firstScan,
    via: [],
    score: scoreRoute(firstScan, baselineLengthM, opts),
  };
  const history = [{ via: [], score: best.score }];
  onProgress?.({ phase: 'first', best, routeCalls });

  const triedCells = new Set();
  const givenUp = new Set();

  while (routeCalls - 1 < opts.maxRouteCalls) {
    const target = worstRun(best.scan, givenUp, opts);
    if (!target) break;

    const candidates = await findWideCandidates(target, best.scan.samples, widthProvider, opts);
    onProgress?.({ phase: 'candidates', target, count: candidates.length });

    let improved = false;
    for (const candidate of candidates) {
      if (routeCalls - 1 >= opts.maxRouteCalls) break;
      const key = cellKey(candidate.point, opts.clusterM);
      if (triedCells.has(key)) continue;
      triedCells.add(key);

      const via = [...best.via, candidate.point];
      let route;
      let result;
      try {
        route = await routeProvider.route(from, to, { ...routeOptions, intermediates: via });
        routeCalls++;
        result = await scan(route.coords);
      } catch (err) {
        history.push({ via, error: err.message });
        continue;
      }

      const score = scoreRoute(result, baselineLengthM, opts);
      history.push({ via, score });
      onProgress?.({ phase: 'tried', candidate, score, best, routeCalls });

      if (score.total < best.score.total) {
        best = { route, scan: result, via, score };
        improved = true;
        break;
      }
    }

    // この区間はどう経由点を置いても良くならなかった。次につらい区間へ移る
    if (!improved) givenUp.add(runKey(target, opts));
  }

  return {
    ...best,
    baselineLengthM,
    routeCalls,
    history,
    improved: best.via.length > 0,
  };
}

/** まだ手を付けていない中で、いちばんつらい狭い区間 */
function worstRun(scan, givenUp, options) {
  let worst = null;
  let worstWeight = 0;
  for (const run of scan.runs) {
    if (givenUp.has(runKey(run, options))) continue;
    const weight = run.lengthM * (options.severityWeight[run.rnkWidth] ?? 1);
    if (weight > worstWeight) {
      worst = run;
      worstWeight = weight;
    }
  }
  return worst;
}

/**
 * 狭い区間の周りから、経由点にできる太い道の点を探す。
 * 近すぎる点は迂回にならないので外し、近い候補はまとめてから
 * 「太い順・近い順」で返す。
 */
async function findWideCandidates(run, samples, provider, options) {
  const runPoints = samples
    .filter((s) => s.distance >= run.startM && s.distance <= run.endM)
    .map((s) => s.point);
  if (!runPoints.length) return [];

  const center = runPoints[Math.floor(runPoints.length / 2)];
  const tiles = tilesCovering([{ point: center }], options.candidateZoom, options.searchRadiusM);

  const cells = new Map();
  for (const tile of tiles) {
    let roads;
    try {
      roads = await provider.roadsInTile(tile);
    } catch {
      continue; // このズームが読めないなら候補なしとして扱う
    }
    for (const road of roads) {
      const rnkWidth = Number(road.props.rnkWidth);
      // 5=その他, 6=不明 は幅員の実測ではないので太い道として扱わない
      if (!Number.isFinite(rnkWidth) || rnkWidth < options.minWideRnk || rnkWidth > 4) continue;

      for (let i = 1; i < road.coords.length; i++) {
        const point = midpoint(road.coords[i - 1], road.coords[i]);
        const fromCenterM = haversine(center, point);
        if (fromCenterM > options.searchRadiusM) continue;
        if (minDistanceTo(point, runPoints) < options.minClearanceM) continue;

        const key = cellKey(point, options.clusterM);
        const held = cells.get(key);
        if (!held || rnkWidth > held.rnkWidth || (rnkWidth === held.rnkWidth && fromCenterM < held.fromCenterM)) {
          cells.set(key, { point, rnkWidth, fromCenterM, roadCategory: road.props.rdCtg ?? null });
        }
      }
    }
  }

  return [...cells.values()]
    .sort((a, b) => b.rnkWidth - a.rnkWidth || a.fromCenterM - b.fromCenterM)
    .slice(0, options.maxCandidatesPerRun);
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function minDistanceTo(point, points) {
  let min = Infinity;
  for (const other of points) {
    const d = haversine(point, other);
    if (d < min) min = d;
  }
  return min;
}

/** 位置でまとめるための格子キー。緯度によらずおおよそ clusterM 角になる */
function cellKey(point, clusterM) {
  const latStep = clusterM / 111132;
  const lngStep = clusterM / Math.max(1, 111320 * Math.cos((point[1] * Math.PI) / 180));
  return `${Math.round(point[0] / lngStep)}:${Math.round(point[1] / latStep)}`;
}

/**
 * 区間を場所で覚える。引き直すと起点からの距離が変わるので、
 * 距離ではなく地理的な位置で同一性を見る。
 */
function runKey(run, options) {
  const point = run.links?.[0]?.point;
  return point ? cellKey(point, options.clusterM) : `d:${Math.round(run.startM)}`;
}
