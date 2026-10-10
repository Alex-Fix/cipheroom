/** Speaking this long without a break takes the stage (a short "mm-hm" doesn't). */
export const TAKE_STAGE_MS = 1500;

/**
 * Who Speaker view puts on the stage, from the set of people speaking now (MediaService, updated every 250 ms):
 * someone takes the stage after TAKE_STAGE_MS of continuous speaking and keeps it through silence, until someone
 * else takes it. Also remembers who spoke last, for the order of the thumbnail strip.
 */
export class StageSpeaker {
  private current?: string;
  /** When each person currently speaking started (continuous). */
  private readonly since = new Map<string, number>();
  /** Most recent speaker first. */
  private order: string[] = [];

  /** Feeds who is speaking now (remote participants only); returns who has the stage. */
  update(speaking: ReadonlySet<string>, now: number): string | undefined {
    for (const id of [...this.since.keys()]) if (!speaking.has(id)) this.since.delete(id);
    for (const id of speaking) {
      if (!this.since.has(id)) this.since.set(id, now);
      this.order = [id, ...this.order.filter((x) => x !== id)];
    }
    // The longest continuous speaker past the threshold takes the stage.
    let best: string | undefined;
    let bestSince = Infinity;
    for (const [id, start] of this.since) {
      if (now - start >= TAKE_STAGE_MS && start < bestSince) {
        best = id;
        bestSince = start;
      }
    }
    // Never interrupt the current speaker while they're still talking.
    const currentTalking = this.current !== undefined && this.since.has(this.current);
    if (best !== undefined && !currentTalking) this.current = best;
    return this.current;
  }

  /** Most recent speaker first (people who never spoke aren't listed). */
  recent(): readonly string[] {
    return this.order;
  }

  /** Someone left: they lose the stage and their place in the order. */
  forget(present: ReadonlySet<string>): void {
    if (this.current !== undefined && !present.has(this.current)) this.current = undefined;
    this.order = this.order.filter((id) => present.has(id));
    for (const id of [...this.since.keys()]) if (!present.has(id)) this.since.delete(id);
  }
}
