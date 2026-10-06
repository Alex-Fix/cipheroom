import { deviceErrorMessage } from './device-error';

describe('deviceErrorMessage', () => {
  it('explains blocked permissions', () => {
    expect(deviceErrorMessage('camera', new DOMException('x', 'NotAllowedError'))).toBe(
      "Camera blocked — allow it in your browser's site settings.",
    );
    expect(deviceErrorMessage('screen', new DOMException('x', 'NotAllowedError'))).toBe(
      'Screen sharing was cancelled or blocked.',
    );
  });

  it('explains missing and busy devices', () => {
    expect(deviceErrorMessage('microphone', new DOMException('x', 'NotFoundError'))).toBe(
      'No microphone found.',
    );
    expect(deviceErrorMessage('camera', new DOMException('x', 'NotReadableError'))).toBe(
      'Camera is in use by another app.',
    );
  });

  it('never echoes error text (messages are rendered as HTML)', () => {
    const msg = deviceErrorMessage('camera', new Error('<img src=x onerror=alert(1)>'));
    expect(msg).toBe("Couldn't turn on the camera.");
    expect(deviceErrorMessage('screen', 'weird')).toBe("Couldn't turn on screen sharing.");
  });
});
