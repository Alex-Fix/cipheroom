/** How this browser shows calls: remembered across calls, in this browser only. Pins are per call, never stored. */
export type CallView = 'grid' | 'speaker';
/** Our own camera: a tile like everyone else's, a floating bubble, or not shown. */
export type SelfView = 'tile' | 'float' | 'hidden';
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface CallViewSettings {
  view: CallView;
  selfView: SelfView;
  corner: Corner;
  /** The floating self-view is collapsed to a small pill. */
  collapsed: boolean;
}

export const CALL_VIEW_KEY = 'cipheroom.callView';

const VIEWS: readonly CallView[] = ['grid', 'speaker'];
const SELF_VIEWS: readonly SelfView[] = ['tile', 'float', 'hidden'];
const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** Phones: follow the speaker, our camera floating (FaceTime-like). Larger screens: everyone in a grid. */
export function defaultCallView(phone: boolean): CallViewSettings {
  return phone
    ? { view: 'speaker', selfView: 'float', corner: 'top-right', collapsed: false }
    : { view: 'grid', selfView: 'tile', corner: 'bottom-right', collapsed: false };
}

/** A touch device with a small screen. */
export function isPhone(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  } catch {
    return false;
  }
}

export function loadCallView(phone = isPhone()): CallViewSettings {
  const defaults = defaultCallView(phone);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CALL_VIEW_KEY) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return defaults;
    const s = stored as Partial<Record<keyof CallViewSettings, unknown>>;
    return {
      view: pick(VIEWS, s.view) ?? defaults.view,
      selfView: pick(SELF_VIEWS, s.selfView) ?? defaults.selfView,
      corner: pick(CORNERS, s.corner) ?? defaults.corner,
      collapsed: typeof s.collapsed === 'boolean' ? s.collapsed : defaults.collapsed,
    };
  } catch {
    return defaults;
  }
}

export function saveCallView(settings: CallViewSettings): void {
  try {
    localStorage.setItem(CALL_VIEW_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode) — the choice just won't be remembered.
  }
}

function pick<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((a) => a === value);
}
