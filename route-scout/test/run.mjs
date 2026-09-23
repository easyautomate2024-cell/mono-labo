/**
 * オフラインで完結する検証。ネットワークにも npm にも依存しない。
 *   node route-scout/test/run.mjs
 *
 * 地理院タイルへの疎通を含む確認は bin/probe.mjs 側で行う。
 */

import { decodeTile } from '../lib/mvt.mjs';
import {
  haversine, bearing, densify, pointToSegment, headingAt,
  lngLatToTileFraction, lngLatToTile, tileCoordToLngLat, tileBounds, lineLength,
} from '../lib/geo.mjs';
import * as polyline from '../lib/polyline.mjs';
import { classify, widthLabel, SEVERITY, GsiVectorTileProvider, isDrivableCenterline, roadCategoryLabel } from '../lib/width.mjs';
import { panoUrl, isStale, directionsUrl } from '../lib/svlink.mjs';
import { widenRoute, scoreRoute, DEFAULT_WIDEN_OPTIONS } from '../lib/widen.mjs';
import { OsrmRouteProvider, parseLatLng } from '../lib/routing-osrm.mjs';
import { scanRoute, SegmentIndex, tilesCovering } from '../lib/scout.mjs';
import { GoogleRoutesProvider } from '../lib/routing.mjs';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '条件が偽');
}

function near(actual, expected, tolerance, msg) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${msg || ''} 期待 ${expected}±${tolerance} / 実際 ${actual}`);
  }
}

// ---------------------------------------------------------------- MVT

/**
 * 仕様 (vector-tile-spec 2.1) から手で組んだタイル。
 * road レイヤ / LINESTRING 1 本 / rnkWidth=1（int64）, layer=-1（負の int64）。
 * 負の int64 は 10 バイトの varint になり、上位ビットを別扱いしないと復号できない。
 */
const HAND_BUILT_TILE = new Uint8Array([
  0x1a, 0x43,                                      // Tile.layers, 長さ 67
    0x0a, 0x04, 0x72, 0x6f, 0x61, 0x64,            //  name = "road"
    0x12, 0x14,                                    //  features[0], 長さ 20
      0x08, 0x01,                                  //   id = 1
      0x12, 0x04, 0x00, 0x00, 0x01, 0x01,          //   tags = [0,0, 1,1]
      0x18, 0x02,                                  //   type = LINESTRING
      0x22, 0x08,                                  //   geometry, 長さ 8
        0x09, 0x14, 0x28,                          //    MoveTo(1) (10,20)
        0x12, 0x0a, 0x05, 0x00, 0x0e,              //    LineTo(2) (+5,-3) (+0,+7)
    0x1a, 0x08, 0x72, 0x6e, 0x6b, 0x57, 0x69, 0x64, 0x74, 0x68, // keys[0]="rnkWidth"
    0x1a, 0x05, 0x6c, 0x61, 0x79, 0x65, 0x72,      //  keys[1] = "layer"
    0x22, 0x02, 0x20, 0x01,                        //  values[0] = int64 1
    0x22, 0x0b, 0x20,                              //  values[1] = int64 -1
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    0x28, 0x80, 0x20,                              //  extent = 4096
    0x78, 0x02,                                    //  version = 2
]);

check('MVT: レイヤ構造', () => {
  const layers = decodeTile(HAND_BUILT_TILE);
  assert(Object.keys(layers).join() === 'road', 'レイヤ名');
  assert(layers.road.version === 2, 'version');
  assert(layers.road.extent === 4096, 'extent');
  assert(layers.road.length === 1, 'フィーチャ数');
});

check('MVT: 幾何のデルタ復号', () => {
  const f = decodeTile(HAND_BUILT_TILE).road.feature(0);
  assert(f.type === 2, 'type');
  assert(f.geometry.length === 1, 'ライン数');
  assert(
    JSON.stringify(f.geometry[0]) === JSON.stringify([[10, 20], [15, 17], [15, 24]]),
    `座標 ${JSON.stringify(f.geometry[0])}`,
  );
});

check('MVT: 負の int64 プロパティ', () => {
  const f = decodeTile(HAND_BUILT_TILE).road.feature(0);
  assert(f.properties.rnkWidth === 1, `rnkWidth = ${f.properties.rnkWidth}`);
  assert(f.properties.layer === -1, `layer = ${f.properties.layer}（10 バイト varint の符号処理）`);
});

// ---------------------------------------------------------------- 測地

check('geo: 緯度 1 度の距離', () => {
  near(haversine([0, 0], [0, 1]), 111194.93, 1, '赤道での緯度 1 度');
  near(haversine([0, 0], [1, 0]), 111194.93, 1, '赤道での経度 1 度');
});

check('geo: 高緯度では経度 1 度が縮む', () => {
  near(haversine([0, 60], [1, 60]), 111194.93 * Math.cos(60 * Math.PI / 180), 30, '緯度 60 度');
});

check('geo: 方位角', () => {
  near(bearing([0, 0], [0, 1]), 0, 0.01, '北');
  near(bearing([0, 0], [1, 0]), 90, 0.01, '東');
  near(bearing([0, 0], [0, -1]), 180, 0.01, '南');
  near(bearing([0, 0], [-1, 0]), 270, 0.01, '西');
});

check('geo: タイル座標の往復', () => {
  const z = 16;
  for (const [lng, lat] of [[139.7671, 35.6812], [142.4695, 43.5551], [-122.4, 37.8]]) {
    const frac = lngLatToTileFraction(lng, lat, z);
    const tile = lngLatToTile(lng, lat, z);
    const extent = 4096;
    const gx = (frac.x - tile.x) * extent;
    const gy = (frac.y - tile.y) * extent;
    const back = tileCoordToLngLat(gx, gy, tile, extent);
    near(back[0], lng, 1e-9, '経度の往復');
    near(back[1], lat, 1e-9, '緯度の往復');
  }
});

check('geo: ZL0 は全世界', () => {
  const [w, s, e, n] = tileBounds({ x: 0, y: 0, z: 0 });
  near(w, -180, 1e-9, '西端');
  near(e, 180, 1e-9, '東端');
  near(n, 85.0511, 1e-3, '北端（メルカトルの上限）');
  near(s, -85.0511, 1e-3, '南端');
});

check('geo: ZL16 タイルの実寸', () => {
  const tile = lngLatToTile(142.4695, 43.5551, 16);
  const [w, s, e, n] = tileBounds(tile);
  const width = haversine([w, (s + n) / 2], [e, (s + n) / 2]);
  assert(width > 350 && width < 500, `ZL16 のタイル幅が ${Math.round(width)}m`);
});

check('geo: 点と線分の距離', () => {
  // 東西の線分に対して真北へずらした点
  const a = [142.0, 43.0];
  const b = [142.01, 43.0];
  const offsetLat = 43.0 + 50 / 111132.95; // 約 50m 北
  const hit = pointToSegment([142.005, offsetLat], a, b);
  near(hit.distance, 50, 1, '垂線の長さ');
  near(hit.t, 0.5, 0.01, '足の位置');
  // 線分の外側は端点までの距離になる
  const outside = pointToSegment([141.99, 43.0], a, b);
  near(outside.t, 0, 1e-9, '端点にクランプ');
});

check('geo: 再サンプリング', () => {
  const coords = [[142.0, 43.0], [142.01, 43.0]];
  const total = lineLength(coords);
  const samples = densify(coords, 10);
  near(samples[0].distance, 0, 1e-9, '起点');
  near(samples[samples.length - 1].distance, total, 1e-6, '終点の累積距離');
  for (let i = 1; i < samples.length; i++) {
    assert(samples[i].distance > samples[i - 1].distance, '距離が単調増加');
  }
  const gaps = samples.slice(1, -1).map((s, i) => s.distance - samples[i].distance);
  for (const g of gaps) near(g, 10, 1e-6, '間隔');
  near(haversine(samples[samples.length - 1].point, coords[1]), 0, 0.01, '終点が一致');
});

check('geo: 先読み方位', () => {
  const samples = densify([[142.0, 43.0], [142.0, 43.01]], 10); // 北へ
  near(headingAt(samples, 0, 20), 0, 0.1, '北向き');
  assert(headingAt(samples, samples.length - 1, 20) !== null, '終端でも方位が出る');
  near(headingAt(samples, samples.length - 1, 20), 0, 0.1, '終端も北向き');
});

// ---------------------------------------------------------------- polyline

check('polyline: 仕様の例', () => {
  const coords = polyline.decode('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert(coords.length === 3, `点数 ${coords.length}`);
  near(coords[0][1], 38.5, 1e-9, '1点目の緯度');
  near(coords[0][0], -120.2, 1e-9, '1点目の経度');
  near(coords[1][1], 40.7, 1e-9, '2点目の緯度');
  near(coords[1][0], -120.95, 1e-9, '2点目の経度');
  near(coords[2][1], 43.252, 1e-9, '3点目の緯度');
  near(coords[2][0], -126.453, 1e-9, '3点目の経度');
});

check('polyline: 往復', () => {
  const coords = [[142.4695, 43.5551], [142.47, 43.556], [142.4, 43.5]];
  const back = polyline.decode(polyline.encode(coords));
  for (let i = 0; i < coords.length; i++) {
    near(back[i][0], coords[i][0], 1e-5, '経度');
    near(back[i][1], coords[i][1], 1e-5, '緯度');
  }
});

// ---------------------------------------------------------------- 判定

check('width: 幅員区分の重大度', () => {
  assert(classify(0) === SEVERITY.AVOID, '0 は回避推奨');
  assert(classify(1) === SEVERITY.WARN, '1 は警告');
  assert(classify(2) === SEVERITY.OK, '2 は問題なし');
  assert(classify(4) === SEVERITY.OK, '4 は問題なし');
  assert(classify(5) === SEVERITY.UNKNOWN, '5（その他）は OK と言わない');
  assert(classify(6) === SEVERITY.UNKNOWN, '6（不明）は警告を出さない');
  assert(classify(null) === SEVERITY.UNKNOWN, '未マッチ');
  assert(widthLabel(1) === '3m以上5.5m未満', 'ラベル');
});

// ---------------------------------------------------------------- SV リンク

check('width: 道路縁・徒歩道は候補にしない（実タイルで道路縁への吸着があった）', () => {
  assert(isDrivableCenterline({ ftCode: 2701 }), '通常部');
  assert(isDrivableCenterline({ ftCode: 2703 }), '橋・高架');
  assert(isDrivableCenterline({ ftCode: 2704 }), 'トンネル');
  assert(!isDrivableCenterline({ ftCode: 2201 }), '道路縁（ZL17 用のオーバーズーム分）');
  assert(!isDrivableCenterline({ ftCode: 2221 }), '庭園路の縁');
  assert(!isDrivableCenterline({ ftCode: 2411 }), 'トンネル内の道路');
  assert(!isDrivableCenterline({ ftCode: 2711 }), '庭園路');
  assert(!isDrivableCenterline({ ftCode: 2721 }), '徒歩道');
  assert(!isDrivableCenterline({ ftCode: 2731 }), '石段');
  assert(isDrivableCenterline({}), 'ftCode が無ければ捨てない');
});

check('width: 道路種別の表示名', () => {
  assert(roadCategoryLabel(0) === '国道', '0');
  assert(roadCategoryLabel(2) === '市区町村道', '2');
  assert(roadCategoryLabel('市区町村道') === '市区町村道', '文字列はそのまま');
  assert(roadCategoryLabel(null) === null, 'null');
  assert(roadCategoryLabel(42) === null, '未知のコードは出さない');
});

check('svlink: パノラマ URL', () => {
  const url = panoUrl({ lat: 43.5551, lng: 142.4695, heading: 91.4 });
  assert(url.startsWith('https://www.google.com/maps/@?'), 'ホスト');
  const q = new URL(url).searchParams;
  assert(q.get('api') === '1', 'api=1 が無いと他が全て無視される');
  assert(q.get('map_action') === 'pano', 'map_action');
  assert(q.get('viewpoint') === '43.5551,142.4695', `viewpoint = ${q.get('viewpoint')}`);
  assert(url.includes('viewpoint=43.5551,142.4695'), 'カンマはそのまま置く（%2C にしない）');
  assert(q.get('heading') === '91', '方位は整数に丸める');
  assert(url.length <= 2048, 'URL 長');
});

check('svlink: 撮影日の鮮度', () => {
  const now = new Date('2026-09-18');
  assert(isStale('2015-06', 5, now) === true, '11 年前は古い');
  assert(isStale('2024-06', 5, now) === false, '2 年前は古くない');
  assert(isStale(null, 5, now) === false, '日付なし');
});

// ---------------------------------------------------------------- 索引

check('SegmentIndex: 近傍の取り出し', () => {
  const index = new SegmentIndex();
  index.insert([142.0, 43.0], [142.01, 43.0], { rnkWidth: 1 });
  index.insert([150.0, 43.0], [150.01, 43.0], { rnkWidth: 0 });
  const hits = index.near(142.005, 43.0, 0.001, 0.001);
  assert(hits.size === 1, `近傍 ${hits.size} 件`);
  assert([...hits][0].props.rnkWidth === 1, '取れた線分');
});

check('SegmentIndex: タイル境界の重複線分を潰す', () => {
  const index = new SegmentIndex();
  index.insert([142.0, 43.0], [142.01, 43.0], { rnkWidth: 1 });
  index.insert([142.0, 43.0], [142.01, 43.0], { rnkWidth: 1 }); // 隣タイルから同じ線分
  const hits = index.near(142.005, 43.0, 0.001, 0.001);
  assert(hits.size === 1, `重複後 ${hits.size} 件`);
});

check('tilesCovering: 端の隣タイルも含む', () => {
  const samples = [{ point: [142.4695, 43.5551] }];
  const one = tilesCovering(samples, 16, 0);
  const padded = tilesCovering(samples, 16, 20);
  assert(one.length === 1, `pad なしで ${one.length} 枚`);
  assert(padded.length >= 1, 'pad ありでタイルが増えうる');
});

// ---------------------------------------------------------------- パイプライン

/** 与えた道路をそのまま返す偽プロバイダ（同じ線分を重複投入しないよう一度だけ返す） */
function fakeProvider(roads) {
  let served = false;
  return {
    attribution: 'テスト',
    async roadsInTile() {
      if (served) return [];
      served = true;
      return roads;
    },
  };
}

/** 東西に伸びる直線道路を区分ごとに切って作る */
function eastWestRoad(lat, fromLng, toLng, rnkWidth) {
  return { coords: [[fromLng, lat], [toLng, lat]], props: { rnkWidth, rdCtg: '市区町村道' } };
}

await checkAsync('scanRoute: 区分ごとに警告が出る', async () => {
  const lat = 43.0;
  const route = [[142.0, lat], [142.01, lat]]; // 東へ約 810m
  const provider = fakeProvider([
    eastWestRoad(lat, 141.999, 142.004, 2), // 広い
    eastWestRoad(lat, 142.004, 142.007, 1), // 警告
    eastWestRoad(lat, 142.007, 142.011, 0), // 回避推奨
  ]);

  const result = await scanRoute(route, { provider, stepM: 10 });
  assert(result.stats.matchRate > 0.98, `マッチ率 ${result.stats.matchRate}`);
  assert(result.runs.length === 2, `区間数 ${result.runs.length}`);

  const [warn, avoid] = result.runs;
  assert(warn.severity === SEVERITY.WARN, '1 件目は警告');
  assert(avoid.severity === SEVERITY.AVOID, '2 件目は回避推奨');
  assert(warn.startM < avoid.startM, '起点からの順に並ぶ');

  const total = result.stats.routeLengthM;
  near(warn.startM / total, 0.4, 0.03, '警告の開始位置が全長の 4 割');
  near(avoid.startM / total, 0.7, 0.03, '回避区間の開始位置が全長の 7 割');
  assert(warn.rnkWidth === 1 && avoid.rnkWidth === 0, '幅員区分');
  assert(warn.roadCategory === '市区町村道', '道路分類が引き継がれる');
});

await checkAsync('scanRoute: 分割された同一区間を統合する', async () => {
  const lat = 43.0;
  const route = [[142.0, lat], [142.01, lat]];
  // 狭い区間を 4 フィーチャに刻んでも 1 件にまとまること
  const provider = fakeProvider([
    eastWestRoad(lat, 141.999, 142.004, 2),
    eastWestRoad(lat, 142.004, 142.005, 1),
    eastWestRoad(lat, 142.005, 142.006, 1),
    eastWestRoad(lat, 142.006, 142.0065, 1),
    eastWestRoad(lat, 142.0065, 142.007, 1),
    eastWestRoad(lat, 142.007, 142.011, 2),
  ]);
  const result = await scanRoute(route, { provider, stepM: 10 });
  assert(result.runs.length === 1, `統合後の区間数 ${result.runs.length}`);
  near(result.runs[0].lengthM, 245, 25, '延長');
});

await checkAsync('scanRoute: 直交する細道を拾わない', async () => {
  const lat = 43.0;
  const route = [[142.0, lat], [142.01, lat]];
  // ルートに交差する南北の細道。最近傍だけで選ぶとここで誤警告になる
  const provider = fakeProvider([
    eastWestRoad(lat, 141.999, 142.011, 2),
    { coords: [[142.005, lat - 0.001], [142.005, lat + 0.001]], props: { rnkWidth: 0 } },
  ]);
  const result = await scanRoute(route, { provider, stepM: 10 });
  assert(result.runs.length === 0, `誤警告 ${result.runs.length} 件`);
});

await checkAsync('scanRoute: 進行方向を向いたリンクが出る', async () => {
  const lat = 43.0;
  const route = [[142.0, lat], [142.01, lat]]; // 東へ
  const provider = fakeProvider([eastWestRoad(lat, 141.999, 142.011, 1)]);
  const result = await scanRoute(route, { provider, stepM: 10, linkIntervalM: 300 });
  assert(result.runs.length === 1, '区間数');
  const links = result.runs[0].links;
  assert(links.length >= 2, `長い区間に複数リンク（${links.length} 本）`);
  for (const link of links) {
    near(link.heading, 90, 1, '東向き');
    assert(link.url.includes('map_action=pano'), 'パノラマ URL');
  }
});

await checkAsync('scanRoute: 未マッチは警告にしない', async () => {
  const lat = 43.0;
  const route = [[142.0, lat], [142.01, lat]];
  // ルートから 200m 離れたところにしか道路が無い
  const provider = fakeProvider([eastWestRoad(lat + 0.002, 141.999, 142.011, 0)]);
  const result = await scanRoute(route, { provider, stepM: 10 });
  assert(result.runs.length === 0, '警告は出ない');
  assert(result.stats.matchRate === 0, `マッチ率 ${result.stats.matchRate}`);
});

// ---------------------------------------------------------------- ルート取得

await checkAsync('routing: 課金 SKU を上げない要求を出す', async () => {
  const encoded = polyline.encode([[142.4695, 43.5551], [142.4795, 43.5551]]);
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      async json() {
        return {
          routes: [{
            distanceMeters: 806,
            duration: '120s',
            polyline: { encodedPolyline: encoded },
          }],
        };
      },
    };
  };

  const provider = new GoogleRoutesProvider({ key: 'TESTKEY', fetchImpl });
  const result = await provider.route([142.4695, 43.5551], '旭川駅');

  assert(captured.init.headers['X-Goog-Api-Key'] === 'TESTKEY', 'キーはヘッダで送る');
  assert(!captured.url.includes('TESTKEY'), 'キーを URL に載せない');

  const mask = captured.init.headers['X-Goog-FieldMask'];
  assert(mask === 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration', `フィールドマスク: ${mask}`);
  assert(!mask.includes('legs'), 'legs を足すと上位 SKU に跳ねる');

  const body = JSON.parse(captured.init.body);
  assert(body.routingPreference === 'TRAFFIC_UNAWARE', '渋滞考慮は既定で切る');
  assert(body.polylineQuality === 'HIGH_QUALITY', 'カーブで誤スナップしないよう高精度');
  assert(body.origin.location.latLng.latitude === 43.5551, '座標の出発地');
  assert(body.origin.location.latLng.longitude === 142.4695, '座標の出発地（経度）');
  assert(body.destination.address === '旭川駅', '住所の目的地');

  assert(result.coords.length === 2, '復号した頂点数');
  near(result.coords[0][1], 43.5551, 1e-5, '復号した緯度');
  assert(result.distanceMeters === 806, '距離');
  assert(result.encodedPolyline === encoded, '再実行用に polyline を返す');
  assert(provider.stats.calls === 1, '呼び出し回数を数える');
});

await checkAsync('fetch をメソッドとして呼ばない（ブラウザの Illegal invocation 対策）', async () => {
  const receivers = [];
  // アロー関数にすると this を観測できないので、あえて普通の関数で受ける
  const fetchImpl = function (url) {
    receivers.push(this);
    if (String(url).includes('computeRoutes')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ routes: [{ polyline: { encodedPolyline: 'a', }, distanceMeters: 1, duration: '1s' }] }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
  };

  const tiles = new GsiVectorTileProvider({ fetchImpl });
  await tiles.roadsInTile({ z: 16, x: 58703, y: 23942 });
  await new GoogleRoutesProvider({ key: 'K', fetchImpl }).route([142, 43], [142.1, 43]);

  assert(receivers.length === 2, `呼び出し回数 ${receivers.length}`);
  for (const receiver of receivers) {
    assert(receiver === undefined, `fetch の this が ${receiver && receiver.constructor.name} になっている`);
  }
});

check('routing: キーが無ければ作れない', () => {
  let threw = false;
  try {
    new GoogleRoutesProvider({});
  } catch {
    threw = true;
  }
  assert(threw, 'キー無しで例外');
});

// ---------------------------------------------------------------- 経路の受け渡し

check('svlink: 経路を Google マップに渡す URL', () => {
  const url = directionsUrl({
    origin: [142.462, 43.5551],
    destination: '○○キャンプ場',
    via: [[142.475, 43.56], [142.48, 43.561]],
  });
  assert(url.startsWith('https://www.google.com/maps/dir/?'), 'ホスト');
  assert(url.includes('api=1'), 'api=1');
  assert(url.includes('origin=43.5551,142.462'), `origin: ${url}`);
  assert(url.includes('waypoints=43.56,142.475|43.561,142.48'), `waypoints: ${url}`);
  assert(url.includes('travelmode=driving'), 'travelmode');
});

// ---------------------------------------------------------------- 広い道へ寄せる

/**
 * 検証用の世界。
 *   細い直通路（区分1）を挟んで、少し北に太い迂回路（区分3）があり、
 *   両端が太い連絡路でつながっている。
 */
const NARROW_LAT = 43.5551;
const WIDE_LAT = 43.5600;
const WEST = 142.462;
const EAST = 142.488;

const WORLD_ROADS = [
  { coords: [[142.460, NARROW_LAT], [142.490, NARROW_LAT]], props: { rnkWidth: 1, rdCtg: '市区町村道' } },
  { coords: [[142.460, WIDE_LAT], [142.490, WIDE_LAT]], props: { rnkWidth: 3, rdCtg: '一般国道' } },
  { coords: [[WEST, NARROW_LAT], [WEST, WIDE_LAT]], props: { rnkWidth: 3, rdCtg: '一般国道' } },
  { coords: [[EAST, NARROW_LAT], [EAST, WIDE_LAT]], props: { rnkWidth: 3, rdCtg: '一般国道' } },
];

/** どのタイルでも同じ道路を返す。重複は SegmentIndex と候補のまとめが潰す */
function worldWidthProvider(roads = WORLD_ROADS) {
  return { attribution: 'テスト', async roadsInTile() { return roads; } };
}

/**
 * Google の代わり。経由点が北の太い道の上にあれば、そこを通る経路を返す。
 * 「経由点を置けば Google が道なりに繋いでくれる」という前提を模している。
 */
function worldRouteProvider() {
  const provider = {
    calls: 0,
    async route(from, to, options = {}) {
      provider.calls++;
      const via = options.intermediates ?? [];
      const useWide = via.some(([, lat]) => lat >= WIDE_LAT - 0.001);
      const coords = useWide
        ? [from, [from[0], WIDE_LAT], [to[0], WIDE_LAT], to]
        : [from, to];
      return { coords, distanceMeters: null, duration: '0s', encodedPolyline: '' };
    },
  };
  return provider;
}

await checkAsync('widen: 狭い直通路を避けて太い道に寄せる', async () => {
  const routeProvider = worldRouteProvider();
  const result = await widenRoute({
    from: [WEST, NARROW_LAT],
    to: [EAST, NARROW_LAT],
    routeProvider,
    widthProvider: worldWidthProvider(),
    scanOptions: { stepM: 10 },
  });

  assert(result.improved, '寄せられなかった');
  assert(result.via.length === 1, `経由点 ${result.via.length} 個`);
  assert(result.scan.runs.length === 0, `残った警告 ${result.scan.runs.length} 件`);
  assert(result.score.total < result.history[0].score.total, '採点が改善していない');
  assert(result.history[0].score.runCount === 1, '最初のルートには警告があるはず');
  assert(routeProvider.calls === result.routeCalls, '呼び出し回数の記録が合わない');
  assert(result.routeCalls <= 1 + DEFAULT_WIDEN_OPTIONS.maxRouteCalls, `呼び出し ${result.routeCalls} 回`);

  // 経由点は太い道の上で、狭い区間からは離れていること
  const [, viaLat] = result.via[0];
  assert(viaLat >= WIDE_LAT - 0.001, `経由点が北の太い道に乗っていない: ${viaLat}`);
});

await checkAsync('widen: 太い道が無ければ引き直さない', async () => {
  const onlyNarrow = [WORLD_ROADS[0]];
  const routeProvider = worldRouteProvider();
  const result = await widenRoute({
    from: [WEST, NARROW_LAT],
    to: [EAST, NARROW_LAT],
    routeProvider,
    widthProvider: worldWidthProvider(onlyNarrow),
    scanOptions: { stepM: 10 },
  });

  assert(result.routeCalls === 1, `無駄な呼び出しをしている: ${result.routeCalls} 回`);
  assert(result.improved === false, '寄せたことになっている');
  assert(result.scan.runs.length === 1, '警告はそのまま残るはず');
});

check('widen: 遠回りが過ぎれば採用しない採点になっている', () => {
  const fake = (runs, lengthM) => ({ runs, stats: { routeLengthM: lengthM } });
  const base = 10000;

  // 3m未満が 200m（重み3で 600）
  const narrow = scoreRoute(fake([{ lengthM: 200, rnkWidth: 0 }], base), base);
  near(narrow.total, 600, 1e-9, '狭い区間の採点');

  // 5km の遠回りで狭い区間ゼロ → 500。こちらが良い
  const shortDetour = scoreRoute(fake([], base + 5000), base);
  near(shortDetour.total, 500, 1e-9, '短い迂回');
  assert(shortDetour.total < narrow.total, '5km の迂回なら避けるべき');

  // 10km の遠回り → 1000。狭いままのほうがまし
  const longDetour = scoreRoute(fake([], base + 10000), base);
  near(longDetour.total, 1000, 1e-9, '長い迂回');
  assert(longDetour.total > narrow.total, '10km も遠回りするほどではない');
});

// ---------------------------------------------------------------- キー不要のルート取得

await checkAsync('osrm: 座標と経由点を経路に載せる', async () => {
  const encoded = polyline.encode([[142.462, 43.5551], [142.488, 43.5551]]);
  const seen = [];
  const fetchImpl = function (url) {
    seen.push(String(url));
    return Promise.resolve({
      ok: true,
      json: async () => ({ code: 'Ok', routes: [{ geometry: encoded, distance: 2100, duration: 180 }] }),
    });
  };

  const provider = new OsrmRouteProvider({ fetchImpl });
  const result = await provider.route([142.462, 43.5551], [142.488, 43.5551], {
    intermediates: [[142.475, 43.56]],
  });

  assert(seen.length === 1, `呼び出し ${seen.length} 回（座標なら地名検索は不要）`);
  assert(seen[0].includes('142.462000,43.555100;142.475000,43.560000;142.488000,43.555100'),
    `経由点が経路に載っていない: ${seen[0]}`);
  assert(seen[0].includes('overview=full'), '粗い形状だとカーブで誤判定するので full');
  assert(result.coords.length === 2, '復号した頂点数');
  assert(result.distanceMeters === 2100, '距離');
  assert(result.duration === '180s', '所要時間');
});

await checkAsync('osrm: 地名は一度だけ引く', async () => {
  const encoded = polyline.encode([[142.462, 43.5551], [142.488, 43.5551]]);
  let geocodes = 0;
  const fetchImpl = function (url) {
    const text = String(url);
    if (text.includes('nominatim')) {
      geocodes++;
      return Promise.resolve({ ok: true, json: async () => [{ lon: '142.462', lat: '43.5551' }] });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ code: 'Ok', routes: [{ geometry: encoded, distance: 1, duration: 1 }] }),
    });
  };

  const provider = new OsrmRouteProvider({ fetchImpl });
  await provider.route('美瑛駅', [142.488, 43.5551]);
  await provider.route('美瑛駅', [142.488, 43.5551]);
  await provider.route('美瑛駅', [142.488, 43.5551], { intermediates: [[142.47, 43.56]] });

  assert(geocodes === 1, `地名を ${geocodes} 回引いている（利用方針に触れる）`);
  assert(provider.stats.calls === 3, 'ルート取得の回数');
});

await checkAsync('osrm: 見つからなければ理由がわかる', async () => {
  const fetchImpl = () => Promise.resolve({ ok: true, json: async () => [] });
  const provider = new OsrmRouteProvider({ fetchImpl });
  let message = '';
  try {
    await provider.route('ありえない地名', [142.488, 43.5551]);
  } catch (err) {
    message = err.message;
  }
  assert(message.includes('ありえない地名'), `案内が不親切: ${message}`);
  assert(message.includes('緯度,経度'), '代わりの入れ方を案内していない');
});

check('osrm: 緯度経度の読み取り', () => {
  assert(JSON.stringify(parseLatLng('43.5551,142.462')) === '[142.462,43.5551]', '緯度が先');
  assert(parseLatLng('美瑛駅') === null, '地名は座標ではない');
  assert(parseLatLng('200,300') === null, '範囲外');
});

// ---------------------------------------------------------------- 結果

console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log('  NG ' + f);
  process.exit(1);
}
console.log('すべて通過');
