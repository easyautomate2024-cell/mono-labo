/**
 * ストリートビューへのリンク生成（Maps URLs）と、パノラマ存在確認（メタデータ）。
 *
 * Maps URLs は API キー不要・無料。api=1 が無いと他のパラメータが全て無視される。
 * メタデータ照会はキーが要るが課金もクォータ消費もしない。
 *
 * 出典はいずれも引き継ぎ仕様の記載による（このセッションからは
 * developers.google.com に到達できないため一次ソースの再確認は未実施）。
 */

export const MAPS_URL_MAX_LENGTH = 2048;

/**
 * 進行方向を向いたストリートビューを開く URL。
 * heading を入れないと明後日の方向を向くので、このツールの肝はここ。
 */
export function panoUrl({ lat, lng, heading, pitch = 10, fov = 75 }) {
  const params = new URLSearchParams({
    api: '1',
    map_action: 'pano',
    viewpoint: `${round(lat, 6)},${round(lng, 6)}`,
  });
  if (heading !== null && heading !== undefined) params.set('heading', String(Math.round(heading)));
  if (pitch !== null && pitch !== undefined) params.set('pitch', String(pitch));
  if (fov !== null && fov !== undefined) params.set('fov', String(fov));

  // カンマはクエリ内でそのまま置ける（RFC 3986 の sub-delims）。
  // 仕様に書かれている形をそのまま出したいので %2C には戻さない。
  const url = `https://www.google.com/maps/@?${params.toString().replace(/%2C/g, ',')}`;
  if (url.length > MAPS_URL_MAX_LENGTH) throw new Error('Maps URL が 2048 文字を超えた');
  return url;
}

/** 地図としてその地点を開く URL（パノラマが無かったときの代替） */
export function mapUrl({ lat, lng, zoom = 18 }) {
  const params = new URLSearchParams({
    api: '1',
    map_action: 'map',
    center: `${round(lat, 6)},${round(lng, 6)}`,
    zoom: String(zoom),
    basemap: 'satellite',
  });
  return `https://www.google.com/maps/@?${params.toString().replace(/%2C/g, ',')}`;
}

const METADATA_ENDPOINT = 'https://maps.googleapis.com/maps/api/streetview/metadata';

/**
 * パノラマの有無と撮影日を調べる。死にリンクを出さないため。
 * pano_id は時間とともに変わるので返さない（保存するのは緯度経度だけ）。
 *
 * @returns {{ ok: boolean, status: string, date: string|null, location: {lat:number,lng:number}|null }}
 */
export async function fetchPanoMetadata({ lat, lng, key, radius = 50, fetchImpl = globalThis.fetch }) {
  if (!key) throw new Error('メタデータ照会には API キーが必要');
  const params = new URLSearchParams({
    location: `${round(lat, 6)},${round(lng, 6)}`,
    radius: String(radius),
    key,
  });
  const res = await fetchImpl(`${METADATA_ENDPOINT}?${params.toString()}`);
  if (!res.ok) throw new Error(`メタデータ照会が HTTP ${res.status}`);
  const body = await res.json();
  return {
    ok: body.status === 'OK',
    status: body.status,
    date: body.date ?? null,
    location: body.location ? { lat: body.location.lat, lng: body.location.lng } : null,
  };
}

/** 撮影日が古いかどうか（一覧に注記を出す用） */
export function isStale(dateString, thresholdYears = 5, now = new Date()) {
  if (!dateString) return false;
  const m = /^(\d{4})-(\d{2})$/.exec(dateString);
  if (!m) return false;
  const captured = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const years = (now - captured) / (365.2425 * 24 * 3600 * 1000);
  return years >= thresholdYears;
}

function round(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
