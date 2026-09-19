/**
 * キー不要のルート取得。OSRM の公開デモサーバを使う。
 *
 * 動きを試すためのもので、本番用ではない。OSRM 側の案内で公開デモサーバは
 * production use 不可とされている。公開するときは Google Routes API の
 * 中継（proxy/）に切り替えること。
 *
 * 地名から座標を引くのは Nominatim（OpenStreetMap）。こちらにも利用方針があり、
 * 秒あたり 1 リクエストまで。引き直しのたびに地名を引き直さないよう、
 * 解決した座標はプロバイダ内に覚えておく。
 *
 * ※ このコードを書いた環境からは両サービスに到達できず、実接続は未検証。
 */

import * as polyline from './polyline.mjs';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';

export class OsrmRouteProvider {
  constructor({ fetchImpl = globalThis.fetch, base = OSRM_BASE, geocoderBase = NOMINATIM_BASE } = {}) {
    this.fetchImpl = fetchImpl;
    this.base = base;
    this.geocoderBase = geocoderBase;
    this.placeCache = new Map();
    this.stats = { calls: 0, geocodes: 0 };
  }

  get attribution() {
    return 'OSRM 公開デモ / OpenStreetMap';
  }

  /**
   * @param {[number,number]|string} from [経度, 緯度] か地名
   * @param {[number,number]|string} to 同上
   * @param {object} options intermediates に [経度, 緯度] の配列
   */
  async route(from, to, options = {}) {
    const points = [
      await this.resolve(from),
      ...(options.intermediates ?? []),
      await this.resolve(to),
    ];

    const path = points.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
    const url = new URL(`${this.base}/${path}`);
    url.searchParams.set('overview', 'full');
    url.searchParams.set('geometries', 'polyline');
    url.searchParams.set('alternatives', 'false');

    const doFetch = this.fetchImpl;
    const res = await doFetch(url.toString());
    this.stats.calls++;
    if (!res.ok) throw new Error(`ルート取得が HTTP ${res.status}`);

    const data = await res.json();
    if (data.code && data.code !== 'Ok') {
      throw new Error(`ルートが引けませんでした（${data.code}）`);
    }
    const route = data.routes?.[0];
    if (!route?.geometry) throw new Error('経路が見つかりませんでした');

    return {
      coords: polyline.decode(route.geometry),
      distanceMeters: route.distance ?? null,
      duration: route.duration != null ? `${Math.round(route.duration)}s` : null,
      encodedPolyline: route.geometry,
    };
  }

  /** 地名なら座標に直す。同じ地名は引き直さない（利用方針を守るため） */
  async resolve(place) {
    if (Array.isArray(place)) return place;

    const key = String(place).trim();
    if (this.placeCache.has(key)) return this.placeCache.get(key);

    const asCoords = parseLatLng(key);
    if (asCoords) {
      this.placeCache.set(key, asCoords);
      return asCoords;
    }

    const url = new URL(this.geocoderBase);
    url.searchParams.set('q', key);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'jp');

    const doFetch = this.fetchImpl;
    const res = await doFetch(url.toString());
    this.stats.geocodes++;
    if (!res.ok) throw new Error(`地名の検索が HTTP ${res.status}`);

    const hits = await res.json();
    const hit = Array.isArray(hits) ? hits[0] : null;
    if (!hit) throw new Error(`「${key}」が見つかりませんでした。地名を変えるか「緯度,経度」で入れてください`);

    const point = [Number(hit.lon), Number(hit.lat)];
    this.placeCache.set(key, point);
    return point;
  }
}

/** 「緯度,経度」なら [経度, 緯度] にする。そうでなければ null */
export function parseLatLng(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}
