import {
  FLOAT_MARGIN,
  GAP,
  LayoutInput,
  LayoutTile,
  MIN_GRID_TILE_W,
  PILL,
  Rect,
  callLayout,
  floatRect,
  grid,
  nearestCorner,
} from './call-layout';

const cam = (id: string, isLocal = false): LayoutTile => ({
  key: `${id}:camera`,
  participantId: id,
  isLocal,
  isScreen: false,
});
const screen = (id: string, isLocal = false): LayoutTile => ({
  key: `${id}:screen`,
  participantId: id,
  isLocal,
  isScreen: true,
});

const DESKTOP = { w: 1200, h: 700 };
const PHONE = { w: 375, h: 600 };

function layout(overrides: Partial<LayoutInput>) {
  return callLayout({
    tiles: [cam('me', true), cam('bob'), cam('carol')],
    view: 'grid',
    selfView: 'tile',
    corner: 'bottom-right',
    collapsed: false,
    recent: [],
    box: DESKTOP,
    ...overrides,
  });
}

const roles = (l: ReturnType<typeof callLayout>) =>
  Object.fromEntries([...l.placements].map(([k, p]) => [k, p.role]));
const inside = (r: Rect, box: { w: number; h: number }) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= box.w + 0.5 && r.y + r.h <= box.h + 0.5;
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('callLayout', () => {
  describe('grid', () => {
    it('puts everyone in equal 16:9 tiles inside the box, without overlaps', () => {
      const l = layout({});
      expect(l.mode).toBe('grid');
      const rects = [...l.placements.values()].map((p) => p.rect);
      for (const r of rects) {
        expect(inside(r, DESKTOP)).toBe(true);
        expect(r.w / r.h).toBeCloseTo(16 / 9, 1);
        expect(r.w).toBe(rects[0].w);
      }
      expect(overlap(rects[0], rects[1]) || overlap(rects[1], rects[2])).toBe(false);
    });

    it('picks the column count that makes tiles largest', () => {
      // Two people on a wide screen: side by side, not stacked.
      const { rects } = grid(2, { w: 1200, h: 500 });
      expect(rects[0].y).toBe(rects[1].y);
      // On a tall phone: stacked.
      const phone = grid(2, PHONE);
      expect(phone.rects[0].x).toBe(phone.rects[1].x);
    });

    it('centres an incomplete last row', () => {
      // 2 columns: two tiles on top, the third centred below.
      const { rects } = grid(3, { w: 1000, h: 640 });
      expect(rects[0].y).toBe(rects[1].y);
      expect(rects[2].y).toBeGreaterThan(rects[0].y);
      expect(rects[2].x + rects[2].w / 2).toBeCloseTo(500, 0);
    });

    it('stops shrinking tiles and grows downwards when there are many', () => {
      const { rects, height } = grid(40, PHONE);
      expect(rects[0].w).toBeGreaterThanOrEqual(MIN_GRID_TILE_W);
      expect(height).toBeGreaterThan(PHONE.h);
      expect(rects.at(-1)!.y + rects.at(-1)!.h).toBeLessThanOrEqual(height);
    });
  });

  describe('speaker', () => {
    it('puts the active speaker on the stage and everyone else in the strip', () => {
      const l = layout({ view: 'speaker', speaker: 'carol' });
      expect(roles(l)).toEqual({
        'carol:camera': 'stage',
        'bob:camera': 'strip',
        'me:camera': 'strip',
      });
      const stage = l.placements.get('carol:camera')!.rect;
      expect(stage.w).toBe(DESKTOP.w);
      for (const p of l.placements.values()) {
        expect(inside(p.rect, DESKTOP)).toBe(true);
        if (p.role === 'strip') expect(overlap(p.rect, stage)).toBe(false);
      }
    });

    it('falls back to the first remote camera, never our own while others are here', () => {
      expect(roles(layout({ view: 'speaker' }))['bob:camera']).toBe('stage');
      expect(roles(layout({ view: 'speaker', speaker: 'me' }))['bob:camera']).toBe('stage');
    });

    it('orders the strip by who spoke last, our own tile at the end', () => {
      const l = layout({
        view: 'speaker',
        tiles: [cam('me', true), cam('bob'), cam('carol'), cam('dan')],
        speaker: 'bob',
        recent: ['bob', 'dan', 'carol'],
      });
      const strip = [...l.placements]
        .filter(([, p]) => p.role === 'strip')
        .sort(([, a], [, b]) => a.rect.x - b.rect.x)
        .map(([k]) => k);
      expect(strip).toEqual(['dan:camera', 'carol:camera', 'me:camera']);
    });

    it('hides what doesn’t fit behind a "+N" tile', () => {
      const tiles = [cam('me', true), ...Array.from({ length: 9 }, (_, i) => cam(`p${i}`))];
      const l = layout({ view: 'speaker', tiles, box: PHONE });
      const shown = [...l.placements.values()].filter((p) => p.role === 'strip');
      const hidden = [...l.placements.values()].filter((p) => p.role === 'hidden');
      expect(l.overflow!.count).toBe(hidden.length);
      expect(shown.length + hidden.length).toBe(9);
      expect(inside(l.overflow!.rect, PHONE)).toBe(true);
      for (const p of hidden) expect(p.rect.w).toBe(0);
    });

    it('gives the whole box to the stage when nobody else is there', () => {
      const l = layout({ view: 'speaker', tiles: [cam('me', true)] });
      expect(l.placements.get('me:camera')).toEqual({
        role: 'stage',
        rect: { x: 0, y: 0, w: DESKTOP.w, h: DESKTOP.h },
      });
    });
  });

  describe('pin and screen share', () => {
    it('a pin wins over everything and switches Grid to Speaker', () => {
      const l = layout({
        view: 'grid',
        pin: 'me:camera',
        speaker: 'bob',
        tiles: [cam('me', true), cam('bob'), screen('bob')],
      });
      expect(l.mode).toBe('speaker');
      expect(roles(l)['me:camera']).toBe('stage');
    });

    it('a remote screen share takes the stage, even in Grid', () => {
      const l = layout({ tiles: [cam('me', true), cam('bob'), screen('bob')], speaker: 'bob' });
      expect(l.mode).toBe('speaker');
      expect(roles(l)['bob:screen']).toBe('stage');
      expect(roles(l)['bob:camera']).toBe('strip');
    });

    it('our own screen share doesn’t take our stage (it would show itself)', () => {
      const l = layout({ tiles: [cam('me', true), screen('me', true), cam('bob')] });
      expect(l.mode).toBe('grid');
      const speaker = layout({
        view: 'speaker',
        tiles: [cam('me', true), screen('me', true), cam('bob')],
      });
      expect(roles(speaker)['bob:camera']).toBe('stage');
      expect(roles(speaker)['me:screen']).toBe('strip');
    });

    it('ignores a pin whose tile is gone', () => {
      expect(layout({ pin: 'zed:camera' }).mode).toBe('grid');
    });
  });

  describe('self view', () => {
    it('floats our camera in its corner, out of the grid', () => {
      const l = layout({ selfView: 'float', corner: 'top-left' });
      expect(roles(l)).toEqual({
        'me:camera': 'float',
        'bob:camera': 'grid',
        'carol:camera': 'grid',
      });
      expect(l.placements.get('me:camera')!.rect).toMatchObject({
        x: FLOAT_MARGIN,
        y: FLOAT_MARGIN,
      });
    });

    it('hides it, keeping the element mounted', () => {
      const l = layout({ selfView: 'hidden', view: 'speaker' });
      expect(l.placements.get('me:camera')).toEqual({
        role: 'hidden',
        rect: { x: 0, y: 0, w: 0, h: 0 },
      });
    });

    it('shows it on the stage when we’re alone, and when we pin it', () => {
      expect(
        roles(layout({ selfView: 'float', tiles: [cam('me', true)], view: 'speaker' })),
      ).toEqual({
        'me:camera': 'stage',
      });
      expect(roles(layout({ selfView: 'hidden', pin: 'me:camera' }))['me:camera']).toBe('stage');
    });

    it('sizes the bubble for the screen and collapses it to a pill', () => {
      const phone = floatRect({ box: PHONE, corner: 'bottom-right', collapsed: false });
      expect(phone.h).toBeGreaterThan(phone.w);
      expect(inside(phone, PHONE)).toBe(true);
      expect(phone.x + phone.w).toBe(PHONE.w - FLOAT_MARGIN);
      expect(phone.y + phone.h).toBe(PHONE.h - FLOAT_MARGIN);

      const desktop = floatRect({ box: DESKTOP, corner: 'top-right', collapsed: false });
      expect(desktop.w).toBeGreaterThan(desktop.h);
      expect(desktop.w).toBeLessThanOrEqual(200);

      expect(floatRect({ box: DESKTOP, corner: 'top-left', collapsed: true })).toEqual({
        x: FLOAT_MARGIN,
        y: FLOAT_MARGIN,
        ...PILL,
      });
    });

    it('snaps a dropped bubble to the nearest corner', () => {
      expect(nearestCorner({ x: 10, y: 10 }, DESKTOP)).toBe('top-left');
      expect(nearestCorner({ x: 1100, y: 650 }, DESKTOP)).toBe('bottom-right');
      expect(nearestCorner({ x: 900, y: 100 }, DESKTOP)).toBe('top-right');
    });
  });

  it('hides everything until the box has a size', () => {
    const l = layout({ box: { w: 0, h: 0 } });
    expect(new Set(Object.values(roles(l)))).toEqual(new Set(['hidden']));
  });

  it('keeps the gap between strip thumbnails', () => {
    const l = layout({
      view: 'speaker',
      tiles: [cam('me', true), cam('bob'), cam('carol'), cam('dan')],
    });
    const strip = [...l.placements.values()]
      .filter((p) => p.role === 'strip')
      .map((p) => p.rect)
      .sort((a, b) => a.x - b.x);
    expect(strip[1].x - (strip[0].x + strip[0].w)).toBe(GAP);
  });
});
