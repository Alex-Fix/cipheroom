export type Device = 'microphone' | 'camera' | 'screen';

const LABEL: Record<Device, string> = {
  microphone: 'Microphone',
  camera: 'Camera',
  screen: 'Screen sharing',
};

/**
 * User-facing message for a failed device toggle. Always a constant string: the result is shown with
 * nz-message, which renders strings as HTML — never put browser/server error text or names in it.
 */
export function deviceErrorMessage(device: Device, error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
      return device === 'screen'
        ? 'Screen sharing was cancelled or blocked.'
        : `${LABEL[device]} blocked — allow it in your browser's site settings.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${device} found.`;
    case 'NotReadableError':
    case 'AbortError':
      return `${LABEL[device]} is in use by another app.`;
    default:
      return `Couldn't turn on ${device === 'screen' ? 'screen sharing' : `the ${device}`}.`;
  }
}
