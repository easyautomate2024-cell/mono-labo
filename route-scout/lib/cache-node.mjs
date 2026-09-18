/**
 * タイルのローカルキャッシュ（Node 用）。
 * 地理院タイルの取得は課金対象ではないが、サーバー負荷への配慮として挟む。
 * Google のコンテンツと違いキャッシュの制限はない。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class FileCache {
  /** @param {string} dir キャッシュの置き場所 */
  constructor(dir) {
    this.dir = dir;
  }

  path(key) {
    return join(this.dir, `${key}.pbf`);
  }

  async get(key) {
    try {
      const buf = await readFile(this.path(key));
      return new Uint8Array(buf);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async set(key, bytes) {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

/** キャッシュを使わないときの入れ物 */
export class MemoryCache {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.get(key) ?? null;
  }

  async set(key, bytes) {
    this.map.set(key, bytes);
  }
}
