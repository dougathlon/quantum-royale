export interface RngSnapshot {
  state: number;
  draws: number;
}

export class DeterministicRng {
  private state: number;
  private draws = 0;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    this.draws += 1;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("maxExclusive must be a positive integer.");
    }
    return Math.floor(this.next() * maxExclusive);
  }

  snapshot(): RngSnapshot {
    return { state: this.state >>> 0, draws: this.draws };
  }
}

export function mixSeed(seed: number, domain: number): number {
  let value = (seed ^ Math.imul(domain, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}
