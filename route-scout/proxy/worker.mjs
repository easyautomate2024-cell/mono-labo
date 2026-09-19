/**
 * ルート取得の中継。API キーをブラウザに出さないための最小の関数。
 *
 * Cloudflare Workers のダッシュボードにそのまま貼れるよう、単体で完結させてある
 * （ビルド工程もパッケージも不要）。判定内容の正はリポジトリの lib/routing.mjs で、
 * フィールドマスクの食い違いは test/run.mjs が検査する。
 *
 * 必要な設定:
 *   ROUTES_API_KEY  Google Routes API のキー（Secret として登録する）
 *   ALLOW_ORIGIN    呼び出しを許すオリジン。既定は * だが、公開時は
 *                   https://easyautomate2024-cell.github.io に絞ること
 *
 * 呼び出し:
 *   GET /?from=美瑛駅&to=43.5551,142.4695&avoidTolls=1
 *   → { encodedPolyline, distanceMeters, duration }
 */

/** 課金 SKU を Compute Routes Essentials に留めるための最小指定 */
export const FIELD_MASK = 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration';
export const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const MAX_PLACE_LENGTH = 200;

export default {
  async fetch(request, env) {
    const allow = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'GET だけを受け付けます' }, 405, cors);

    // オリジンを絞っている場合は素通しさせない。偽装はできるが、
    // よそのページから素朴に叩かれて請求が伸びるのは防げる
    if (allow !== '*') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== allow) return json({ error: '許可されていないオリジンです' }, 403, cors);
    }

    if (!env.ROUTES_API_KEY) return json({ error: 'ROUTES_API_KEY が設定されていません' }, 500, cors);

    const params = new URL(request.url).searchParams;
    const from = (params.get('from') ?? '').trim();
    const to = (params.get('to') ?? '').trim();
    if (!from || !to) return json({ error: '出発地と目的地の両方が要ります' }, 400, cors);
    if (from.length > MAX_PLACE_LENGTH || to.length > MAX_PLACE_LENGTH) {
      return json({ error: '出発地・目的地の指定が長すぎます' }, 400, cors);
    }

    const body = {
      origin: waypoint(from),
      destination: waypoint(to),
      travelMode: 'DRIVE',
      // 渋滞考慮は上位 SKU。下見用途では要らない
      routingPreference: 'TRAFFIC_UNAWARE',
      // 既定の OVERVIEW は頂点が粗く、カーブで実際の道から離れて誤判定の元になる
      polylineQuality: 'HIGH_QUALITY',
      languageCode: 'ja',
      units: 'METRIC',
    };
    const avoidTolls = params.get('avoidTolls') === '1';
    const avoidHighways = params.get('avoidHighways') === '1';
    if (avoidTolls || avoidHighways) body.routeModifiers = { avoidTolls, avoidHighways };

    let upstream;
    try {
      upstream = await fetch(ROUTES_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': env.ROUTES_API_KEY,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return json({ error: `ルート取得に到達できませんでした: ${err.message}` }, 502, cors);
    }

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return json({ error: data?.error?.message ?? `ルート取得が HTTP ${upstream.status}` }, 502, cors);
    }

    const route = data?.routes?.[0];
    if (!route?.polyline?.encodedPolyline) {
      return json({ error: '経路が見つかりませんでした。地名を変えて試してください' }, 404, cors);
    }

    return json({
      encodedPolyline: route.polyline.encodedPolyline,
      distanceMeters: route.distanceMeters ?? null,
      duration: route.duration ?? null,
    }, 200, cors);
  },
};

/** 「緯度,経度」に見えれば座標、そうでなければ住所・地名として渡す */
export function waypoint(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (m && Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180) {
    return { location: { latLng: { latitude: Number(m[1]), longitude: Number(m[2]) } } };
  }
  return { address: text };
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}
