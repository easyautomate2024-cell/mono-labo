#!/usr/bin/env node
/**
 * ステップ1: 既知の緯度経度を与えて幅員区分を返すだけのツール。
 *
 * 実走で知っている狭い道・広い道を 10 か所ほど投入し、
 * 値が実感と合うかを確認する。ここが合わなければ以降のステップは無意味。
 *
 *   node route-scout/bin/probe.mjs 43.5551,142.4695 43.5560,142.4700
 *   node route-scout/bin/probe.mjs --file points.txt
 *   node route-scout/bin/probe.mjs --health 43.5551,142.4695
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GsiVectorTileProvider, SEVERITY } from '../lib/width.mjs';
import { FileCache, MemoryCache } from '../lib/cache-node.mjs';
import { probePoint } from '../lib/scout.mjs';
import { lngLatToTile } from '../lib/geo.mjs';
import { panoUrl } from '../lib/svlink.mjs';
import { parseArgs, parseLatLng, num } from './args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER_AGENT = 'mono-labo route-scout (https://github.com/easyautomate2024-cell/mono-labo)';

const MARK = {
  [SEVERITY.AVOID]: '回避推奨',
  [SEVERITY.WARN]: '要確認  ',
  [SEVERITY.OK]: '問題なし',
  [SEVERITY.UNKNOWN]: 'データなし',
};

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    flags: ['json', 'health', 'no-cache', 'help'],
  });

  if (options.help || (!positional.length && !options.file)) {
    console.log(`使い方:
  node route-scout/bin/probe.mjs <緯度,経度> [<緯度,経度> ...]
  node route-scout/bin/probe.mjs --file <1 行 1 地点のファイル>

オプション:
  --zoom <14-16>    幅員属性が入るズームレベル（既定 16）
  --radius <m>      スナップの距離閾値（既定 20）
  --health          rnkWidth 属性が生きているかの自己診断も出す
  --json            JSON で出す
  --no-cache        タイルのローカルキャッシュを使わない
  --cache-dir <dir> キャッシュの置き場所（既定 route-scout/.cache）
  --endpoint <url>  タイルの取得先を差し替える（{z}/{x}/{y} を含む URL）`);
    return;
  }

  const texts = [...positional];
  if (options.file) {
    const body = await readFile(options.file, 'utf8');
    for (const line of body.split('\n')) {
      const trimmed = line.split('#')[0].trim();
      if (trimmed) texts.push(trimmed);
    }
  }
  const points = texts.map(parseLatLng);

  const zoom = num(options.zoom, 16);
  const snapRadiusM = num(options.radius, 20);
  const cacheDir = options['cache-dir'] ?? join(HERE, '..', '.cache');
  const provider = new GsiVectorTileProvider({
    cache: options['no-cache'] ? new MemoryCache() : new FileCache(cacheDir),
    userAgent: USER_AGENT,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });

  if (options.health) {
    const tile = lngLatToTile(points[0][0], points[0][1], zoom);
    const health = await provider.healthCheck(tile);
    if (options.json) {
      console.log(JSON.stringify({ tile, health }, null, 2));
    } else {
      console.log(`自己診断 ZL${tile.z}/${tile.x}/${tile.y}`);
      console.log(`  road フィーチャ: ${health.sampled}`);
      console.log(`  rnkWidth あり  : ${health.withWidth ?? 0}`);
      console.log(`  判定           : ${health.ok ? 'OK' : 'NG — ' + health.reason}`);
      if (health.keysSeen) console.log(`  属性一覧       : ${health.keysSeen.join(', ')}`);
      console.log('');
    }
    if (!health.ok) process.exitCode = 1;
  }

  const results = [];
  for (const point of points) {
    results.push(await probePoint(point, { provider, zoom, snapRadiusM }));
  }

  if (options.json) {
    console.log(JSON.stringify({ results, tileStats: provider.stats }, null, 2));
    return;
  }

  for (const result of results) {
    const [lng, lat] = result.point;
    console.log(`■ ${lat}, ${lng}`);
    if (!result.hits.length) {
      console.log(`  半径 ${snapRadiusM}m 以内に道路中心線なし（road フィーチャ ${result.roadFeatureCount} 件）`);
      console.log('');
      continue;
    }
    result.hits.slice(0, 5).forEach((hit, i) => {
      const head = i === 0 ? '→' : ' ';
      const extras = [
        hit.props.rdCtg ? `分類 ${hit.props.rdCtg}` : null,
        hit.props.Width !== undefined ? `実幅員 ${hit.props.Width}` : null,
        hit.props.motorway ? '自動車専用' : null,
      ].filter(Boolean);
      console.log(
        `  ${head} ${String(Math.round(hit.distanceM)).padStart(3)}m  rnkWidth=${hit.rnkWidth ?? '-'} ` +
        `${hit.widthLabel}  [${MARK[hit.severity]}]${extras.length ? '  ' + extras.join(' / ') : ''}`,
      );
    });
    if (result.hits.length > 5) console.log(`    （ほか ${result.hits.length - 5} 本）`);
    console.log(`    ${panoUrl({ lat, lng, heading: result.hits[0].bearing })}`);
    console.log('');
  }

  console.log(`タイル: 取得 ${provider.stats.fetched} / キャッシュ ${provider.stats.cached} / 無し ${provider.stats.missing}`);
  console.log(`出典: ${provider.attribution}`);
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
