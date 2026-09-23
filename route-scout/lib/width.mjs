/**
 * 幅員データのプロバイダ。
 *
 * 地理院ベクトルタイルは「提供実験」で終期未定・URL や属性が変わりうるため、
 * インタフェースで切って差し替え可能にしてある（引き継ぎ仕様のリスク節）。
 * 幅員が取れなくなってもツールは固定間隔サンプリングに退化するだけで止まらない。
 */

import { decodeTile } from './mvt.mjs';
import { tileCoordToLngLat } from './geo.mjs';

/** rnkWidth（幅員区分）の意味。出典: 道路中心線データ フィールド定義 */
export const RNK_WIDTH_LABEL = {
  0: '3m未満',
  1: '3m以上5.5m未満',
  2: '5.5m以上13m未満',
  3: '13m以上19.5m未満',
  4: '19.5m以上',
  5: 'その他',
  6: '不明',
};

/** rdCtg（道路種別）の意味。出典: 同上 */
export const RD_CTG_LABEL = {
  0: '国道',
  1: '都道府県道',
  2: '市区町村道',
  3: '高速自動車国道等',
  5: 'その他',
  6: '不明',
};

/** 表示用。数値コードは名前に、すでに文字列ならそのまま */
export function roadCategoryLabel(rdCtg) {
  if (rdCtg === null || rdCtg === undefined) return null;
  if (typeof rdCtg === 'string') return rdCtg;
  return RD_CTG_LABEL[rdCtg] ?? null;
}

/**
 * road レイヤのうち「車が走る道路中心線」だけを通す。
 *
 * 実タイル（ZL16）を読んで分かったこと: road レイヤには道路中心線（ftCode 27xx）のほかに
 * 道路縁（22xx、ZL17 表示用のオーバーズーム分）やトンネル内の道路（24xx）も入っていて、
 * 件数では道路縁のほうが多い。道路縁は中心線と平行に数 m 離れて走り、rnkWidth を持たない。
 * これを候補に含めるとルートの 1 割ほどが道路縁に吸着して「データなし」になった
 * （美瑛駅→白金温泉 20km で 2,030 サンプル中 189）。
 *
 * 27xx のうち 01〜04 が通常部（通常/雪覆い/橋・高架/トンネル）。11〜14 は庭園路、
 * 21〜24 は徒歩道、31〜34 は石段で、いずれも牽引車が走る道ではないので外す。
 * ftCode が無いフィーチャは仕様外なので、落とさずに通す（データを黙って捨てない）。
 * 出典: 地理院地図Vector データ仕様 ZL14〜16（地物）
 */
export function isDrivableCenterline(props) {
  const code = props?.ftCode;
  if (code === undefined || code === null) return true;
  const n = Number(code);
  return n >= 2701 && n <= 2704;
}

export const SEVERITY = {
  AVOID: 'avoid',     // 回避推奨
  WARN: 'warn',       // 要確認
  OK: 'ok',           // 幅員上は問題なし
  UNKNOWN: 'unknown', // データなし（警告を出さない）
};

export const DEFAULT_THRESHOLDS = {
  warnAtOrBelow: 1,  // 5.5m 未満を警告
  avoidAtOrBelow: 0, // 3m 未満は回避推奨
};

/**
 * 幅員区分を重大度に変換する。
 * 5（その他）と 6（不明）は幅員の実測ではないので、OK とは言わずに UNKNOWN 扱い。
 * 「データが無い」ことを「大丈夫」と読ませないため。
 */
export function classify(rnkWidth, thresholds = DEFAULT_THRESHOLDS) {
  if (rnkWidth === null || rnkWidth === undefined) return SEVERITY.UNKNOWN;
  if (rnkWidth === 5 || rnkWidth === 6) return SEVERITY.UNKNOWN;
  if (rnkWidth <= thresholds.avoidAtOrBelow) return SEVERITY.AVOID;
  if (rnkWidth <= thresholds.warnAtOrBelow) return SEVERITY.WARN;
  return SEVERITY.OK;
}

export function widthLabel(rnkWidth) {
  return RNK_WIDTH_LABEL[rnkWidth] ?? '不明';
}

/** 差し替え可能にするためのインタフェース */
export class WidthProvider {
  get attribution() {
    return null;
  }

  /** @returns {Promise<Array<{coords: Array<[number,number]>, props: object}>>} */
  async roadsInTile() {
    throw new Error('roadsInTile が未実装');
  }
}

const GSI_ENDPOINT = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf';

export class GsiVectorTileProvider extends WidthProvider {
  /** 幅員属性が入るズームレベル。ZL17 は ZL16 のオーバーズーム表示 */
  static MIN_WIDTH_ZOOM = 14;
  static MAX_WIDTH_ZOOM = 16;
  static SOURCE_LAYER = 'road';

  constructor({ cache = null, fetchImpl = globalThis.fetch, endpoint = GSI_ENDPOINT, userAgent = null } = {}) {
    super();
    this.endpoint = endpoint;
    this.cache = cache;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.stats = { fetched: 0, cached: 0, missing: 0 };
  }

  get attribution() {
    return '国土地理院ベクトルタイル提供実験';
  }

  url(tile) {
    return this.endpoint
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));
  }

  /** タイルのバイト列を取る。404 は「データなし」であってエラーではない */
  async fetchTileBytes(tile) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (this.cache) {
      const hit = await this.cache.get(key);
      if (hit) {
        this.stats.cached++;
        return hit.byteLength === 0 ? null : hit;
      }
    }

    const headers = this.userAgent ? { 'User-Agent': this.userAgent } : undefined;
    // ブラウザの fetch はレシーバを見る。this.fetchImpl(...) と呼ぶと
    // this がプロバイダになり Illegal invocation で落ちるので、一度外に出す。
    const doFetch = this.fetchImpl;
    const res = await doFetch(this.url(tile), { headers });
    if (res.status === 404) {
      this.stats.missing++;
      if (this.cache) await this.cache.set(key, new Uint8Array(0));
      return null;
    }
    if (!res.ok) throw new Error(`タイル取得が HTTP ${res.status}: ${this.url(tile)}`);

    const bytes = await maybeGunzip(new Uint8Array(await res.arrayBuffer()));
    this.stats.fetched++;
    if (this.cache) await this.cache.set(key, bytes);
    return bytes;
  }

  async roadsInTile(tile) {
    if (tile.z < GsiVectorTileProvider.MIN_WIDTH_ZOOM || tile.z > GsiVectorTileProvider.MAX_WIDTH_ZOOM) {
      throw new Error(`幅員属性が入るのは ZL${GsiVectorTileProvider.MIN_WIDTH_ZOOM}〜${GsiVectorTileProvider.MAX_WIDTH_ZOOM}。ZL${tile.z} は対象外`);
    }

    const bytes = await this.fetchTileBytes(tile);
    if (!bytes) return [];

    const layers = decodeTile(bytes);
    const layer = layers[GsiVectorTileProvider.SOURCE_LAYER];
    if (!layer) return [];

    const roads = [];
    for (const feature of layer.features()) {
      if (feature.type !== 2) continue; // LINESTRING 以外は道路中心線ではない
      if (!isDrivableCenterline(feature.properties)) continue; // 道路縁・徒歩道などを除く
      for (const line of feature.geometry) {
        if (line.length < 2) continue;
        roads.push({
          coords: line.map(([gx, gy]) => tileCoordToLngLat(gx, gy, tile, layer.extent)),
          props: feature.properties,
        });
      }
    }
    return roads;
  }

  /**
   * 提供実験の仕様変更を即検知するための自己診断。
   * rnkWidth が消えたらここで落ちる（引き継ぎ仕様のリスク対策）。
   */
  async healthCheck(tile) {
    const roads = await this.roadsInTile(tile);
    if (!roads.length) {
      return { ok: false, reason: `ZL${tile.z}/${tile.x}/${tile.y} に road フィーチャが無い`, sampled: 0 };
    }
    const withWidth = roads.filter((r) => r.props.rnkWidth !== undefined);
    return {
      ok: withWidth.length > 0,
      reason: withWidth.length ? null : 'road フィーチャはあるが rnkWidth 属性が無い',
      sampled: roads.length,
      withWidth: withWidth.length,
      keysSeen: [...new Set(roads.flatMap((r) => Object.keys(r.props)))].sort(),
    };
  }
}

/** gzip のまま届いた場合に備える（fetch が展開済みなら素通し） */
async function maybeGunzip(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzipSync } = await import('node:zlib');
  return new Uint8Array(gunzipSync(bytes));
}
