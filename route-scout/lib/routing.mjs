/**
 * ルート取得（ステップ6）。
 *
 * ここが唯一の課金ポイント。幅員判定もストリートビュー提示も無料で完結するので、
 * 呼び出し回数が増えるのはこの 1 箇所だけになるよう閉じ込めてある。
 *
 * API キーはサーバー側にだけ置く。ブラウザからこのモジュールを直接呼ばないこと。
 *
 * 注意: 下のフィールドマスクと routingPreference は、料金 SKU を
 * Compute Routes Essentials（月10,000無料）に留めるための指定。
 * 引き継ぎ仕様の記載に基づくもので、一次ソース（developers.google.com）は
 * このツールを書いたセッションから到達できず再確認していない。
 * 課金が走る前に必ず料金表と請求で裏を取ること。
 */

import * as polyline from './polyline.mjs';

/** 差し替え可能にするためのインタフェース（OSRM 等に移る場合はこれを実装する） */
export class RouteProvider {
  async route() {
    throw new Error('route が未実装');
  }
}

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * 課金を Essentials に留めるための最小フィールドマスク。
 * ここに legs.steps や運行情報を足すと上位 SKU に跳ねるので、安易に増やさない。
 */
const FIELD_MASK = [
  'routes.polyline.encodedPolyline',
  'routes.distanceMeters',
  'routes.duration',
].join(',');

export class GoogleRoutesProvider extends RouteProvider {
  constructor({ key, fetchImpl = globalThis.fetch, endpoint = ROUTES_ENDPOINT } = {}) {
    super();
    if (!key) throw new Error('Routes API のキーが必要');
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.stats = { calls: 0 };
  }

  get attribution() {
    return 'Google Routes API';
  }

  /**
   * @param {[number,number]|string} origin [経度, 緯度] か住所文字列
   * @param {[number,number]|string} destination 同上
   * @returns {{ coords: Array<[number,number]>, distanceMeters: number, duration: string }}
   */
  async route(origin, destination, options = {}) {
    const body = {
      origin: waypoint(origin),
      destination: waypoint(destination),
      travelMode: options.travelMode ?? 'DRIVE',
      // 渋滞考慮は上位 SKU。下見用途では要らないので既定で切る
      routingPreference: options.routingPreference ?? 'TRAFFIC_UNAWARE',
      // 既定の OVERVIEW は頂点が粗く、カーブで実際の道から離れて誤スナップの元になる
      polylineQuality: options.polylineQuality ?? 'HIGH_QUALITY',
      languageCode: options.languageCode ?? 'ja',
      units: 'METRIC',
    };
    if (options.avoidTolls || options.avoidHighways || options.avoidFerries) {
      body.routeModifiers = {
        avoidTolls: Boolean(options.avoidTolls),
        avoidHighways: Boolean(options.avoidHighways),
        avoidFerries: Boolean(options.avoidFerries),
      };
    }

    // ブラウザの fetch はレシーバを見るので、メソッド呼び出しにしない
    const doFetch = this.fetchImpl;
    const res = await doFetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key,
        'X-Goog-FieldMask': options.fieldMask ?? FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    this.stats.calls++;

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Routes API が HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }

    const data = await res.json();
    const route = data.routes?.[0];
    if (!route?.polyline?.encodedPolyline) {
      throw new Error('ルートが返ってこなかった（出発地・目的地を確認）');
    }

    return {
      coords: polyline.decode(route.polyline.encodedPolyline),
      distanceMeters: route.distanceMeters ?? null,
      duration: route.duration ?? null,
      encodedPolyline: route.polyline.encodedPolyline,
    };
  }
}

function waypoint(value) {
  if (typeof value === 'string') return { address: value };
  if (Array.isArray(value) && value.length === 2) {
    return { location: { latLng: { longitude: value[0], latitude: value[1] } } };
  }
  throw new Error('出発地・目的地は [経度, 緯度] か住所文字列で指定する');
}
