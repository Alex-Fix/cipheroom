import { CallView, Corner, SelfView } from '../../../core/settings/call-view';

/**
 * Where every tile of the call goes (design: docs/plans/2026-10-10-video-layouts-design.md). Pure: the room renders
 * all tiles in one container and positions each from its rect, so a tile's element (and its video) never re-mounts
 * when the view, the pin or the speaker changes.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `hidden` tiles stay mounted (their audio keeps playing) with a zero-size rect. */
export type TileRole = 'stage' | 'strip' | 'grid' | 'float' | 'hidden';

export interface Placement {
  role: TileRole;
  rect: Rect;
}

export interface LayoutTile {
  key: string;
  participantId: string;
  isLocal: boolean;
  isScreen: boolean;
}

export interface LayoutInput {
  /** In the room's order (ours first). */
  tiles: readonly LayoutTile[];
  view: CallView;
  selfView: SelfView;
  corner: Corner;
  /** The floating self-view is collapsed to a pill. */
  collapsed: boolean;
  /** Pinned tile key. */
  pin?: string;
  /** Participant on the stage by speaking (StageSpeaker). */
  speaker?: string;
  /** Participant ids, most recent speaker first. */
  recent: readonly string[];
  /** The area tiles may use (CSS px). */
  box: { w: number; h: number };
}

export interface CallLayout {
  mode: 'grid' | 'speaker';
  placements: ReadonlyMap<string, Placement>;
  /** "+N" tile for strip thumbnails that didn't fit (switches to Grid). */
  overflow?: { count: number; rect: Rect };
  /** Height of the content: more than the box when the grid scrolls. */
  height: number;
}

export const GAP = 10;
/** Grid tiles don't get narrower than this; past it the grid scrolls. */
export const MIN_GRID_TILE_W = 160;
/** Floating self-view margin from the box edges. */
export const FLOAT_MARGIN = 12;
export const PILL = { w: 120, h: 40 } as const;
const RATIO = 16 / 9;
const HIDDEN: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function callLayout(input: LayoutInput): CallLayout {
  const { tiles, box } = input;
  const placements = new Map<string, Placement>();
  if (!tiles.length || box.w <= 0 || box.h <= 0) {
    tiles.forEach((t) => placements.set(t.key, { role: 'hidden', rect: HIDDEN }));
    return { mode: input.view, placements, height: box.h };
  }

  const self = tiles.find((t) => t.isLocal && !t.isScreen);
  const alone = !tiles.some((t) => !t.isLocal);
  const pin = tiles.find((t) => t.key === input.pin);
  const remoteShare = [...tiles].reverse().find((t) => t.isScreen && !t.isLocal);
  const mode = input.view === 'speaker' || pin || remoteShare ? 'speaker' : 'grid';

  // Our own camera leaves the layout when floating or hidden — unless it's pinned, or nobody else is here.
  const selfOut = !!self && !alone && pin !== self && input.selfView !== 'tile';
  if (self && selfOut) {
    placements.set(
      self.key,
      input.selfView === 'float'
        ? { role: 'float', rect: floatRect(input) }
        : { role: 'hidden', rect: HIDDEN },
    );
  }
  const laidOut = tiles.filter((t) => !(selfOut && t === self));

  if (mode === 'grid') {
    const { rects, height } = grid(laidOut.length, box);
    laidOut.forEach((t, i) => placements.set(t.key, { role: 'grid', rect: rects[i] }));
    return { mode, placements, height };
  }

  const stage = pin ?? remoteShare ?? stageBySpeaker(laidOut, input.speaker) ?? laidOut[0];
  const others = stripOrder(
    laidOut.filter((t) => t !== stage),
    input.recent,
  );
  if (!others.length) {
    placements.set(stage.key, { role: 'stage', rect: { x: 0, y: 0, w: box.w, h: box.h } });
    return { mode, placements, height: box.h };
  }

  const thumbH = Math.round(Math.min(Math.max(box.h * 0.18, 72), 140));
  const thumbW = Math.round(thumbH * RATIO);
  const stageH = box.h - thumbH - GAP;
  placements.set(stage.key, { role: 'stage', rect: { x: 0, y: 0, w: box.w, h: stageH } });

  const fit = Math.max(1, Math.floor((box.w + GAP) / (thumbW + GAP)));
  const shown = others.length <= fit ? others : others.slice(0, fit - 1);
  const slots = shown.length + (shown.length < others.length ? 1 : 0);
  const rowW = slots * thumbW + (slots - 1) * GAP;
  const x0 = Math.max(0, (box.w - rowW) / 2);
  const y = stageH + GAP;
  shown.forEach((t, i) =>
    placements.set(t.key, {
      role: 'strip',
      rect: { x: x0 + i * (thumbW + GAP), y, w: thumbW, h: thumbH },
    }),
  );
  others
    .slice(shown.length)
    .forEach((t) => placements.set(t.key, { role: 'hidden', rect: HIDDEN }));
  const overflow =
    shown.length < others.length
      ? {
          count: others.length - shown.length,
          rect: { x: x0 + shown.length * (thumbW + GAP), y, w: thumbW, h: thumbH },
        }
      : undefined;
  return { mode, placements, overflow, height: box.h };
}

/** The camera of whoever has the stage by speaking; else the first remote camera; else ours. */
function stageBySpeaker(tiles: readonly LayoutTile[], speaker?: string): LayoutTile | undefined {
  const cameras = tiles.filter((t) => !t.isScreen);
  return (
    cameras.find((t) => t.participantId === speaker && !t.isLocal) ??
    cameras.find((t) => !t.isLocal) ??
    cameras[0]
  );
}

/** Screen shares first, then by who spoke last, then the rest in room order; our own tiles last. */
function stripOrder(tiles: readonly LayoutTile[], recent: readonly string[]): LayoutTile[] {
  const rank = (t: LayoutTile) => {
    const spoke = recent.indexOf(t.participantId);
    return [t.isLocal ? 1 : 0, t.isScreen ? 0 : 1, spoke === -1 ? recent.length : spoke];
  };
  return tiles
    .map((t, i) => ({ t, i, r: rank(t) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Equal 16:9 tiles: the column count that makes them largest in the box, centred, the last row centred too. Below
 * MIN_GRID_TILE_W the tiles stop shrinking and the grid grows downwards (the container scrolls).
 */
export function grid(n: number, box: { w: number; h: number }): { rects: Rect[]; height: number } {
  let best = { cols: 1, w: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min(
      (box.w - (cols - 1) * GAP) / cols,
      ((box.h - (rows - 1) * GAP) / rows) * RATIO,
    );
    if (w > best.w) best = { cols, w };
  }
  let { cols, w } = best;
  if (w < MIN_GRID_TILE_W) {
    cols = Math.max(1, Math.min(n, Math.floor((box.w + GAP) / (MIN_GRID_TILE_W + GAP))));
    w = (box.w - (cols - 1) * GAP) / cols;
  }
  w = Math.floor(w);
  const h = Math.floor(w / RATIO);
  const rows = Math.ceil(n / cols);
  const height = rows * h + (rows - 1) * GAP;
  const y0 = Math.max(0, (box.h - height) / 2);
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    const rowW = inRow * w + (inRow - 1) * GAP;
    const x0 = (box.w - rowW) / 2;
    rects.push({ x: x0 + (i % cols) * (w + GAP), y: y0 + row * (h + GAP), w, h });
  }
  return { rects, height: Math.max(height, box.h) };
}

/** The floating self-view in its corner: portrait on portrait screens, landscape otherwise; or the pill. */
export function floatRect(input: Pick<LayoutInput, 'box' | 'corner' | 'collapsed'>): Rect {
  const { box, corner, collapsed } = input;
  const portrait = box.h > box.w;
  const w = collapsed
    ? PILL.w
    : Math.round(Math.min(Math.max(box.w * (portrait ? 0.3 : 0.2), 96), 200));
  const h = collapsed ? PILL.h : Math.round(portrait ? (w * 4) / 3 : w / RATIO);
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');
  return {
    x: right ? box.w - w - FLOAT_MARGIN : FLOAT_MARGIN,
    y: bottom ? box.h - h - FLOAT_MARGIN : FLOAT_MARGIN,
    w,
    h,
  };
}

/** The corner nearest to where the floating self-view was dropped (its centre). */
export function nearestCorner(
  center: { x: number; y: number },
  box: { w: number; h: number },
): Corner {
  const vertical = center.y > box.h / 2 ? 'bottom' : 'top';
  const horizontal = center.x > box.w / 2 ? 'right' : 'left';
  return `${vertical}-${horizontal}`;
}
