/**
 * MVT デコーダを参照実装と全件照合する。任意実行。
 *
 * test/run.mjs と違って npm の依存が要るので、リポジトリ外の作業ディレクトリで:
 *
 *   npm install @mapbox/vector-tile pbf
 *   curl -o tile.pbf https://raw.githubusercontent.com/mapbox/vector-tile-js/master/test/fixtures/14-8801-5371.vector.pbf
 *   node <このファイルへのパス> tile.pbf
 *
 * 地理院のタイルを直接与えてもよい（そちらのほうが本番に近い）。
 *
 * 唯一の既知の差は、参照実装がフィーチャ 0 件のレイヤを捨てるのに対し
 * こちらは残すこと。意図的な差なので、空レイヤは照合から除いて別に検査する。
 */

import { readFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { decodeTile } from '../lib/mvt.mjs';

const file = process.argv[2];
if (!file) {
  console.error('使い方: node test/crosscheck.mjs <タイルの .pbf>');
  process.exit(2);
}

const bytes = readFileSync(file);
const ref = new VectorTile(new PbfReader(bytes));
const mine = decodeTile(bytes);

let problems = 0;
const fail = (msg) => {
  console.log('NG ' + msg);
  problems++;
};

const refNames = Object.keys(ref.layers).sort();
const myNonEmpty = Object.keys(mine).filter((n) => mine[n].length > 0).sort();
if (refNames.join() !== myNonEmpty.join()) {
  fail(`レイヤ名不一致\n  参照 = ${refNames}\n  自作 = ${myNonEmpty}`);
}
for (const name of Object.keys(mine)) {
  if (!ref.layers[name] && mine[name].length > 0) fail(`参照に無いのにフィーチャがある: ${name}`);
}

let features = 0;
let props = 0;
let points = 0;

for (const name of refNames) {
  const rl = ref.layers[name];
  const ml = mine[name];
  if (!ml) {
    fail(`レイヤ欠落 ${name}`);
    continue;
  }
  if (rl.length !== ml.length) fail(`${name}: フィーチャ数 ${rl.length} vs ${ml.length}`);
  if (rl.extent !== ml.extent) fail(`${name}: extent ${rl.extent} vs ${ml.extent}`);
  if (rl.version !== ml.version) fail(`${name}: version ${rl.version} vs ${ml.version}`);

  for (let i = 0; i < Math.min(rl.length, ml.length); i++) {
    const rf = rl.feature(i);
    const mf = ml.feature(i);
    features++;
    if (rf.type !== mf.type) fail(`${name}#${i}: type ${rf.type} vs ${mf.type}`);

    const rk = Object.keys(rf.properties).sort();
    const mk = Object.keys(mf.properties).sort();
    if (rk.join('|') !== mk.join('|')) fail(`${name}#${i}: プロパティキー ${rk} vs ${mk}`);
    for (const k of rk) {
      props++;
      const a = rf.properties[k];
      const b = mf.properties[k];
      const same = typeof a === 'number' && typeof b === 'number'
        ? a === b || Math.abs(a - b) <= Math.abs(a) * 1e-12
        : a === b;
      if (!same) fail(`${name}#${i}.${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }

    const rg = rf.loadGeometry();
    if (rg.length !== mf.geometry.length) {
      fail(`${name}#${i}: リング数 ${rg.length} vs ${mf.geometry.length}`);
      continue;
    }
    for (let r = 0; r < rg.length; r++) {
      if (rg[r].length !== mf.geometry[r].length) {
        fail(`${name}#${i}[${r}]: 点数 ${rg[r].length} vs ${mf.geometry[r].length}`);
        continue;
      }
      for (let p = 0; p < rg[r].length; p++) {
        points++;
        if (rg[r][p].x !== mf.geometry[r][p][0] || rg[r][p].y !== mf.geometry[r][p][1]) {
          fail(`${name}#${i}[${r}][${p}]: (${rg[r][p].x},${rg[r][p].y}) vs (${mf.geometry[r][p]})`);
        }
      }
    }
  }
}

console.log(`レイヤ ${refNames.length} / フィーチャ ${features} / プロパティ値 ${props} / 座標 ${points} を照合`);
console.log(problems === 0 ? '参照実装と完全一致' : `不一致 ${problems} 件`);
process.exit(problems === 0 ? 0 : 1);
