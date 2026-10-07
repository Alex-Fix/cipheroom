import { cameraFacing, hasRearCamera } from './cameras';

describe('cameraFacing', () => {
  it('trusts the track setting first', () => {
    expect(cameraFacing('environment', 'Front Camera')).toBe('environment');
    expect(cameraFacing('user')).toBe('user');
  });

  it('falls back to iOS and Android labels', () => {
    expect(cameraFacing(undefined, 'Back Camera')).toBe('environment');
    expect(cameraFacing('', 'camera2 0, facing back')).toBe('environment');
    expect(cameraFacing(undefined, 'Front Camera')).toBe('user');
    expect(cameraFacing(undefined, 'FaceTime HD Camera')).toBe('user');
  });

  it('is unknown for generic webcams', () => {
    expect(cameraFacing(undefined, 'Logitech BRIO')).toBeUndefined();
  });
});

describe('hasRearCamera', () => {
  it('is true for phones, false for desktop webcams', () => {
    expect(
      hasRearCamera([
        { id: '1', label: 'Front Camera' },
        { id: '2', label: 'Back Camera' },
      ]),
    ).toBe(true);
    expect(
      hasRearCamera([
        { id: '1', label: 'FaceTime HD Camera' },
        { id: '2', label: 'Logitech BRIO' },
      ]),
    ).toBe(false);
  });
});
