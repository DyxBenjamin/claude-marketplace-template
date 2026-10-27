/**
 * @file Exports Random, an MT19937 generator seeded like Python's random.seed(int) with randbelow and shuffle.
 * @tags skill-creator, description-optimization
 * @related plugins/base-plugin/scripts/run_loop.ts
 */
export class Random {
  mt: Uint32Array;
  index: number;

  constructor(seed: number) {
    this.mt = new Uint32Array(624);
    this.index = 624;
    this.mt[0] = 19650218;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    const key: number[] = [];
    for (let n = Math.abs(seed); ; n = Math.floor(n / 2 ** 32)) {
      key.push(n % 2 ** 32);
      if (n < 2 ** 32) break;
    }
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev, 1664525)) >>> 0) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= 624) {
        this.mt[0] = this.mt[623];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev, 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= 624) {
        this.mt[0] = this.mt[623];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  next32(): number {
    if (this.index >= 624) {
      const mt = this.mt;
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  randbelow(n: number): number {
    const k = 32 - Math.clz32(n);
    let r = this.next32() >>> (32 - k);
    while (r >= n) r = this.next32() >>> (32 - k);
    return r;
  }

  shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i >= 1; i--) {
      const j = this.randbelow(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}
