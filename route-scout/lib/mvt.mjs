/**
 * Mapbox Vector Tile (MVT v2) デコーダ。依存パッケージなし。
 * Node と ブラウザの両方でそのまま動く素の ES モジュール。
 *
 * 仕様: https://github.com/mapbox/vector-tile-spec (2.1)
 *
 * ビルド工程を持たないのは意図的。最終的にこのライブラリは
 * GitHub Pages 上の静的ページからも読み込むため。
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const utf8 = new TextDecoder('utf-8');

/** protobuf のワイヤ形式を読むだけの最小リーダ */
class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get eof() {
    return this.pos >= this.end;
  }

  /**
   * varint を読む。
   * 下位 32 ビットと上位 32 ビットを別々に組み立てる。単純に 2^shift を
   * 掛けて足す実装だと、負の int64（-1 は 10 バイトの 0xFF...01）が
   * 2^64 に丸められて符号が復元できない。
   *
   * @param {boolean} isSigned int64（2 の補数）として解釈するなら true
   */
  varint(isSigned = false) {
    if (this.pos >= this.end) throw new Error('varint が途中で終端した');
    const buf = this.buf;
    let b;
    let low;
    let high;

    b = buf[this.pos++]; low  =  b & 0x7f;        if (b < 0x80) return low;
    b = buf[this.pos++]; low |= (b & 0x7f) << 7;  if (b < 0x80) return low;
    b = buf[this.pos++]; low |= (b & 0x7f) << 14; if (b < 0x80) return low;
    b = buf[this.pos++]; low |= (b & 0x7f) << 21; if (b < 0x80) return low;
    b = buf[this.pos];   low |= (b & 0x0f) << 28;

    b = buf[this.pos++]; high  = (b & 0x70) >> 4;  if (b < 0x80) return toNum(low, high, isSigned);
    b = buf[this.pos++]; high |= (b & 0x7f) << 3;  if (b < 0x80) return toNum(low, high, isSigned);
    b = buf[this.pos++]; high |= (b & 0x7f) << 10; if (b < 0x80) return toNum(low, high, isSigned);
    b = buf[this.pos++]; high |= (b & 0x7f) << 17; if (b < 0x80) return toNum(low, high, isSigned);
    b = buf[this.pos++]; high |= (b & 0x7f) << 24; if (b < 0x80) return toNum(low, high, isSigned);
    b = buf[this.pos++]; high |= (b & 0x01) << 31; if (b < 0x80) return toNum(low, high, isSigned);

    throw new Error('varint が 10 バイトを超えた');
  }

  /** sint64（ジグザグ）。64 ビット幅でも壊れないよう算術で戻す */
  svarint() {
    const n = this.varint();
    return n % 2 === 1 ? (n + 1) / -2 : n / 2;
  }

  string() {
    const len = this.varint();
    const s = utf8.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  float() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  double() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** 知らないフィールドを読み飛ばす。前方互換のために必須 */
  skip(wireType) {
    switch (wireType) {
      case WIRE_VARINT: this.varint(); break;
      case WIRE_FIXED64: this.pos += 8; break;
      case WIRE_BYTES: this.pos += this.varint(); break;
      case WIRE_FIXED32: this.pos += 4; break;
      default: throw new Error(`未知のワイヤ型: ${wireType}`);
    }
  }
}

/**
 * 下位 32 ビットと上位 32 ビットから数値を組み立てる。
 * isSigned のとき high は符号付き 32 ビットなので、そのまま掛ければ負値になる。
 */
function toNum(low, high, isSigned) {
  if (isSigned) return high * 0x100000000 + (low >>> 0);
  return (high >>> 0) * 0x100000000 + (low >>> 0);
}

/** ジグザグ符号化の復号（幾何デルタは 32 ビット幅に収まるのでこれで足りる） */
function zigzag(n) {
  return (n >>> 1) ^ -(n & 1);
}

export const GEOM_UNKNOWN = 0;
export const GEOM_POINT = 1;
export const GEOM_LINESTRING = 2;
export const GEOM_POLYGON = 3;

/**
 * レイヤ。フィーチャは遅延デコードする。
 * 地理院タイルは 1 タイルに多数のレイヤを含むが、このツールが読むのは road だけ。
 */
export class Layer {
  constructor({ name, version, extent, keys, values, buf, featureRanges }) {
    this.name = name;
    this.version = version;
    this.extent = extent;
    this.keys = keys;
    this.values = values;
    this._buf = buf;
    this._featureRanges = featureRanges;
  }

  get length() {
    return this._featureRanges.length;
  }

  /** i 番目のフィーチャを { id, type, properties, geometry } で返す */
  feature(i) {
    const [start, end] = this._featureRanges[i];
    const r = new Reader(this._buf, start, end);
    let id = null;
    let type = GEOM_UNKNOWN;
    let tags = [];
    let geometry = [];

    while (!r.eof) {
      const tag = r.varint();
      const field = tag >> 3;
      const wire = tag & 7;
      if (field === 1 && wire === WIRE_VARINT) {
        id = r.varint();
      } else if (field === 2 && wire === WIRE_BYTES) {
        const len = r.varint();
        const stop = r.pos + len;
        while (r.pos < stop) tags.push(r.varint());
      } else if (field === 2 && wire === WIRE_VARINT) {
        tags.push(r.varint()); // packed でない実装への保険
      } else if (field === 3 && wire === WIRE_VARINT) {
        type = r.varint();
      } else if (field === 4 && wire === WIRE_BYTES) {
        const len = r.varint();
        geometry = decodeGeometry(r, r.pos + len);
      } else {
        r.skip(wire);
      }
    }

    const properties = {};
    for (let t = 0; t + 1 < tags.length; t += 2) {
      const key = this.keys[tags[t]];
      if (key !== undefined) properties[key] = this.values[tags[t + 1]];
    }

    return { id, type, properties, geometry };
  }

  /** 全フィーチャを順に返すイテレータ */
  *features() {
    for (let i = 0; i < this.length; i++) yield this.feature(i);
  }
}

/**
 * 幾何コマンド列を復号してリング／ラインの配列にする。
 * 座標はタイルローカル（0〜extent、y は下向き）。
 */
function decodeGeometry(r, end) {
  const lines = [];
  let current = null;
  let x = 0;
  let y = 0;

  while (r.pos < end) {
    const cmdInt = r.varint();
    const cmd = cmdInt & 0x7;
    const count = cmdInt >> 3;

    if (cmd === 1) {
      // MoveTo: 新しいライン（点なら 1 要素のライン）を開始
      for (let i = 0; i < count; i++) {
        x += zigzag(r.varint());
        y += zigzag(r.varint());
        current = [[x, y]];
        lines.push(current);
      }
    } else if (cmd === 2) {
      // LineTo
      for (let i = 0; i < count; i++) {
        x += zigzag(r.varint());
        y += zigzag(r.varint());
        if (!current) {
          current = [];
          lines.push(current);
        }
        current.push([x, y]);
      }
    } else if (cmd === 7) {
      // ClosePath: 始点に戻す（道路では出てこないがポリゴン用に対応）
      if (current && current.length) current.push([current[0][0], current[0][1]]);
    } else {
      throw new Error(`未知の幾何コマンド: ${cmd}`);
    }
  }

  return lines;
}

/** Tile.Value を JS の値にする */
function decodeValue(r, end) {
  let value = null;
  while (r.pos < end) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    switch (field) {
      case 1: value = r.string(); break;
      case 2: value = r.float(); break;
      case 3: value = r.double(); break;
      case 4: value = r.varint(true); break;        // int64（負値あり）
      case 5: value = r.varint(); break;            // uint64
      case 6: value = r.svarint(); break;           // sint64
      case 7: value = r.varint() !== 0; break;      // bool
      default: r.skip(wire);
    }
  }
  return value;
}

function decodeLayer(buf, start, end) {
  const r = new Reader(buf, start, end);
  let name = '';
  let version = 1;
  let extent = 4096;
  const keys = [];
  const values = [];
  const featureRanges = [];

  while (!r.eof) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === WIRE_BYTES) {
      name = r.string();
    } else if (field === 2 && wire === WIRE_BYTES) {
      const len = r.varint();
      featureRanges.push([r.pos, r.pos + len]);
      r.pos += len;
    } else if (field === 3 && wire === WIRE_BYTES) {
      keys.push(r.string());
    } else if (field === 4 && wire === WIRE_BYTES) {
      const len = r.varint();
      values.push(decodeValue(r, r.pos + len));
      // decodeValue は end まで読み切る
    } else if (field === 5 && wire === WIRE_VARINT) {
      extent = r.varint();
    } else if (field === 15 && wire === WIRE_VARINT) {
      version = r.varint();
    } else {
      r.skip(wire);
    }
  }

  return new Layer({ name, version, extent, keys, values, buf, featureRanges });
}

/**
 * .pbf のバイト列をデコードして { レイヤ名: Layer } を返す。
 * @param {Uint8Array|ArrayBuffer} bytes
 */
export function decodeTile(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const r = new Reader(buf);
  const layers = {};

  while (!r.eof) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 3 && wire === WIRE_BYTES) {
      const len = r.varint();
      const layer = decodeLayer(buf, r.pos, r.pos + len);
      r.pos += len;
      layers[layer.name] = layer;
    } else {
      r.skip(wire);
    }
  }

  return layers;
}
