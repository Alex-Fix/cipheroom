export type CameraFacing = 'user' | 'environment';

export interface Camera {
  id: string;
  label: string;
}

const REAR = /\b(back|rear|environment)\b/i;
const FRONT = /\b(front|user|facetime)\b/i;

/** Which way a camera points: the track's own setting if the browser reports it, else a guess from its label. */
export function cameraFacing(
  settingsFacing: string | undefined,
  label = '',
): CameraFacing | undefined {
  if (settingsFacing === 'user' || settingsFacing === 'environment') return settingsFacing;
  if (REAR.test(label)) return 'environment';
  if (FRONT.test(label)) return 'user';
  return undefined;
}

/**
 * Front/rear flipping only makes sense on devices with a rear camera (phones, tablets). Labels are the reliable
 * signal: iOS says "Back Camera", Android "camera2 0, facing back"; desktop webcams say neither.
 */
export function hasRearCamera(cameras: readonly Camera[]): boolean {
  return cameras.some((c) => REAR.test(c.label));
}
