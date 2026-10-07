/**
 * Who is speaking, from periodic audio levels (0..1, as WebRTC stats report them). Someone counts as speaking from
 * the first loud sample until `holdMs` after the last one, so the highlight doesn't flicker between words.
 */
export class SpeakingDetector {
  private readonly lastLoud = new Map<string, number>();

  constructor(
    private readonly threshold = 0.04,
    private readonly holdMs = 800,
  ) {}

  update(levels: ReadonlyMap<string, number>, now: number): Set<string> {
    for (const [id, level] of levels) {
      if (level >= this.threshold) this.lastLoud.set(id, now);
    }
    const speaking = new Set<string>();
    for (const [id, at] of this.lastLoud) {
      if (now - at <= this.holdMs) speaking.add(id);
      else this.lastLoud.delete(id);
    }
    return speaking;
  }
}

export function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
