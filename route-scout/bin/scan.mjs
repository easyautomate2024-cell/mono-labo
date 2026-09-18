#!/usr/bin/env node
/**
 * ステップ2〜5: 固定のルートを入力に、狭隘区間の一覧と
 * 進行方向を向いたストリートビューのリンクを出す。
 *
 *   node route-scout/bin/scan.mjs --coords "43.5551,142.4695 43.5560,142.4700"
 *   node route-scout/bin/scan.mjs --polyline '_p~iF~ps|U...'
 *   node route-scout/bin/scan.mjs --geojson route.json --sv-key $MAPS_KEY
 *
 * ルート取得（ステップ6）はまだ繋いでいない。ここで課金 API には触れない。
 * --sv-key を渡したときだけメタデータを照会する（課金もクォータ消費もしない）。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GsiVectorTileProvider, SEVERITY } from '../lib/width.mjs';
import { FileCache, MemoryCache } from '../lib/cache-node.mjs';
import { scanRoute } from '../lib/scout.mjs';
import { GoogleRoutesProvider } from '../lib/routing.mjs';
import { fetchPanoMetadata, isStale } from '../lib/svlink.mjs';
import * as polyline from '../lib/polyline.mjs';
import { parseArgs, parseLatLng, num } from './args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER_AGENT = 'mono-labo route-scout (https://github.com/easyautomate2024-cell/mono-labo)';

const LABEL = {
  [SEVERITY.AVOID]: '回避推奨',
  [SEVERITY.WARN]: '要確認',
};

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    flags: ['json', 'no-cache', 'help', 'avoid-tolls', 'avoid-highways'],
  });

  if (options.help) {
    console.log(`使い方:
  node route-scout/bin/scan.mjs --coords "<緯度,経度> <緯度,経度> ..."
  node route-scout/bin/scan.mjs --polyline <encoded polyline>
  node route-scout/bin/scan.mjs --geojson <LineString を含むファイル>
  node route-scout/bin/scan.mjs --from "旭川駅" --to "43.5551,142.4695"

ルート取得（--from/--to）だけが課金されうる。キーは環境変数
ROUTE_SCOUT_ROUTES_KEY か --routes-key で渡す。実行後に encoded polyline を
出力するので、閾値を変えて掛け直すときは --polyline で再取得せずに済む。

オプション:
  --step <m>          サンプリング間隔（既定 10）
  --radius <m>        スナップの距離閾値（既定 20。実データで要調整）
  --zoom <14-16>      ズームレベル（既定 16）
  --angle <deg>       ルートとの向きのずれ許容量（既定 45）
  --min-run <m>       これより短い区間を捨てる（既定 0）
  --link-interval <m> 長い区間に追加リンクを出す間隔（既定 200）
  --precision <5|6>   polyline の精度（既定 5）
  --from <地点>       出発地（「緯度,経度」か住所）
  --to <地点>         目的地（同上）
  --routes-key <KEY>  Routes API のキー（既定は環境変数 ROUTE_SCOUT_ROUTES_KEY）
  --avoid-tolls       有料道路を避ける
  --avoid-highways    自動車専用道路を避ける
  --sv-key <KEY>      パノラマの有無と撮影日を照会する
  --json              JSON で出す
  --no-cache          タイルのローカルキャッシュを使わない
  --cache-dir <dir>   キャッシュの置き場所（既定 route-scout/.cache）
  --endpoint <url>    タイルの取得先を差し替える（{z}/{x}/{y} を含む URL）`);
    return;
  }

  const { coords, fetched } = await readRoute(options, positional);
  if (coords.length < 2) throw new Error('ルートの座標が 2 点未満');

  const cacheDir = options['cache-dir'] ?? join(HERE, '..', '.cache');
  const provider = new GsiVectorTileProvider({
    cache: options['no-cache'] ? new MemoryCache() : new FileCache(cacheDir),
    userAgent: USER_AGENT,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });

  const route = fetched ? fetched.coords : coords;
  const result = await scanRoute(route, {
    provider,
    zoom: num(options.zoom, 16),
    stepM: num(options.step, 10),
    snapRadiusM: num(options.radius, 20),
    angleToleranceDeg: num(options.angle, 45),
    minRunM: num(options['min-run'], 0),
    linkIntervalM: num(options['link-interval'], 200),
  });

  if (options['sv-key']) await annotatePanoramas(result, options['sv-key']);

  if (options.json) {
    console.log(JSON.stringify(
      { ...result, samples: undefined, tileStats: provider.stats, route: fetched ?? undefined },
      null,
      2,
    ));
    return;
  }

  report(result, provider, fetched);
}

/** 入力を [経度, 緯度] の折れ線にする */
async function readRoute(options, positional) {
  if (options.from || options.to) {
    if (!options.from || !options.to) throw new Error('--from と --to は両方必要');
    return { coords: null, fetched: await fetchRoute(options) };
  }
  if (options.polyline) {
    return { coords: polyline.decode(options.polyline, num(options.precision, 5)), fetched: null };
  }
  if (options.geojson) {
    return { coords: extractLineString(JSON.parse(await readFile(options.geojson, 'utf8'))), fetched: null };
  }
  const text = options.coords ?? positional.join(' ');
  if (!text.trim()) throw new Error('ルートが指定されていない（--help を参照）');
  return { coords: text.trim().split(/\s+/).map(parseLatLng), fetched: null };
}

/** ステップ6。ここだけが課金されうるので、呼ぶ前に一度だけ通る形にしてある */
async function fetchRoute(options) {
  const key = options['routes-key'] ?? process.env.ROUTE_SCOUT_ROUTES_KEY;
  if (!key) throw new Error('Routes API のキーが無い（--routes-key か ROUTE_SCOUT_ROUTES_KEY）');
  const provider = new GoogleRoutesProvider({ key });
  return provider.route(asWaypoint(options.from), asWaypoint(options.to), {
    avoidTolls: options['avoid-tolls'],
    avoidHighways: options['avoid-highways'],
  });
}

/** 「緯度,経度」に見えれば座標、そうでなければ住所として渡す */
function asWaypoint(text) {
  try {
    return parseLatLng(text);
  } catch {
    return text;
  }
}

function extractLineString(geojson) {
  const geometries = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FeatureCollection') node.features?.forEach(walk);
    else if (node.type === 'Feature') walk(node.geometry);
    else if (node.type === 'LineString') geometries.push(node.coordinates);
    else if (node.type === 'MultiLineString') node.coordinates?.forEach((c) => geometries.push(c));
  };
  walk(geojson);
  if (!geometries.length) throw new Error('GeoJSON に LineString が無い');
  return geometries[0].map(([lng, lat]) => [lng, lat]);
}

/** ステップ5: 死にリンクを出さないための照会 */
async function annotatePanoramas(result, key) {
  for (const run of result.runs) {
    for (const link of run.links) {
      try {
        const meta = await fetchPanoMetadata({ lat: link.point[1], lng: link.point[0], key });
        link.pano = { ok: meta.ok, status: meta.status, date: meta.date, stale: isStale(meta.date) };
      } catch (err) {
        link.pano = { ok: null, status: `照会失敗: ${err.message}` };
      }
    }
  }
}

function report(result, provider, fetched) {
  const { stats, runs } = result;
  console.log('');
  if (fetched) {
    console.log(`ルート取得: ${fetched.distanceMeters}m / ${fetched.duration}（Routes API 1 回分）`);
    console.log(`同じルートを掛け直すなら --polyline '${fetched.encodedPolyline}'`);
    console.log('');
  }
  console.log(`ルート全長 ${fmtDistance(stats.routeLengthM)} / サンプル ${stats.sampleCount} 点 / タイル ${stats.tileCount} 枚`);
  console.log(`幅員データとの照合率 ${(stats.matchRate * 100).toFixed(1)}%（残りは「データなし」扱いで警告を出していない）`);
  console.log('');

  if (!runs.length) {
    console.log('幅員区分による警告区間はなし。');
  } else {
    console.log(`警告 ${runs.length} 件（回避推奨 ${stats.avoidCount} / 要確認 ${stats.warnCount}）`);
    console.log('');
    for (const run of runs) {
      const extras = [
        run.roadCategory ? run.roadCategory : null,
        run.actualWidth !== null && run.actualWidth !== undefined ? `実幅員 ${run.actualWidth}` : null,
        run.unknownCount ? `データなし ${run.unknownCount} 点を含む` : null,
        run.alignedFallback ? '※向きの揃った道路が無く最近傍で代用' : null,
      ].filter(Boolean);

      console.log(`[${LABEL[run.severity]}] 起点から ${fmtDistance(run.startM)} / 延長 ${Math.round(run.lengthM)}m / ${run.widthLabel}`);
      if (extras.length) console.log(`  ${extras.join(' / ')}`);
      for (const link of run.links) {
        const note = link.pano
          ? link.pano.ok
            ? `（撮影 ${link.pano.date}${link.pano.stale ? ' — 古い' : ''}）`
            : `（パノラマなし: ${link.pano.status}）`
          : '';
        console.log(`  ${fmtDistance(link.distanceM)} 地点 方位 ${Math.round(link.heading)}°${note ? ' ' + note : ''}`);
        console.log(`    ${link.url}`);
      }
      console.log('');
    }
  }

  console.log('幅員データは候補を絞るためだけのもの。電柱・路上駐車・カーブミラーの張り出し・');
  console.log('内輪差は含まれない。通行可否の最終判断は必ずストリートビューと現地で行うこと。');
  console.log(`出典: ${provider.attribution}`);
  console.log(`タイル: 取得 ${provider.stats.fetched} / キャッシュ ${provider.stats.cached} / 無し ${provider.stats.missing}`);
}

function fmtDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
