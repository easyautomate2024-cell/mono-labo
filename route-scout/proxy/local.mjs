#!/usr/bin/env node
/**
 * 手元で中継を動かすための版。公開前に画面を通しで試すときに使う。
 * 中身は worker.mjs と同じ契約だが、こちらはリポジトリの lib/routing.mjs を
 * そのまま使う（二重実装を増やさないため）。
 *
 *   ROUTE_SCOUT_ROUTES_KEY=... node route-scout/proxy/local.mjs
 *   → http://127.0.0.1:8787/?from=...&to=...
 */

import { createServer } from 'node:http';
import { GoogleRoutesProvider } from '../lib/routing.mjs';

const port = Number(process.env.PORT ?? 8787);
const key = process.env.ROUTE_SCOUT_ROUTES_KEY;
if (!key) {
  console.error('ROUTE_SCOUT_ROUTES_KEY が設定されていません');
  process.exit(1);
}

const provider = new GoogleRoutesProvider({ key });

createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();

  const params = new URL(req.url, 'http://x').searchParams;
  const from = (params.get('from') ?? '').trim();
  const to = (params.get('to') ?? '').trim();
  if (!from || !to) return res.writeHead(400, cors).end(JSON.stringify({ error: '出発地と目的地の両方が要ります' }));

  try {
    const via = params.getAll('via').map((v) => v.trim()).filter(Boolean);
    const route = await provider.route(asWaypoint(from), asWaypoint(to), {
      intermediates: via.map(asWaypoint),
      avoidTolls: params.get('avoidTolls') === '1',
      avoidHighways: params.get('avoidHighways') === '1',
    });
    console.log(`[route] ${from} → ${to}${via.length ? ` 経由${via.length}` : ''} : ${route.distanceMeters}m（Routes API 1 回）`);
    res.writeHead(200, cors).end(JSON.stringify({
      encodedPolyline: route.encodedPolyline,
      distanceMeters: route.distanceMeters,
      duration: route.duration,
    }));
  } catch (err) {
    console.error('[route] 失敗:', err.message);
    res.writeHead(502, cors).end(JSON.stringify({ error: err.message }));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`ルート取得の中継: http://127.0.0.1:${port}/`);
});

function asWaypoint(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (m && Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180) {
    return [Number(m[2]), Number(m[1])];
  }
  return text;
}
