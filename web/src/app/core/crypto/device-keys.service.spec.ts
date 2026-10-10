import { TestBed } from '@angular/core/testing';
import { DEVICE_KEY_STORE, MemoryDeviceKeyStore } from './device-key-store';
import { DeviceKeysService } from './device-keys.service';

const PASS = 'correct horse battery staple';

describe('DeviceKeysService', () => {
  let store: MemoryDeviceKeyStore;
  let service: DeviceKeysService;

  beforeEach(() => {
    store = new MemoryDeviceKeyStore();
    TestBed.configureTestingModule({ providers: [{ provide: DEVICE_KEY_STORE, useValue: store }] });
    service = TestBed.inject(DeviceKeysService);
  });

  it('starts without an identity, sets one up and offers the backup once', async () => {
    await service.refresh();
    expect(service.status()).toBe('none');

    await service.setUp();
    expect(service.status()).toBe('ready');
    expect(service.pub()).toBe((await store.get())!.pub);
    expect(service.canBackUp()).toBe(true);

    const file = await service.backup(PASS);
    expect(file.fileName).toMatch(/^cipheroom-identity-.{8}\.key$/);
    expect(service.canBackUp()).toBe(false);
    await expect(service.backup(PASS)).rejects.toThrow('can no longer be backed up');
  });

  it('restores an identity from its backup (e.g. on another device)', async () => {
    await service.setUp();
    const { contents } = await service.backup(PASS);
    const pub = service.pub();

    await service.remove();
    expect(service.status()).toBe('none');
    await service.restore(contents, PASS);
    expect(service.pub()).toBe(pub);
  });

  it('says when this browser can’t keep keys', async () => {
    vi.spyOn(store, 'get').mockRejectedValue(new Error('No IndexedDB.'));
    await service.refresh();
    expect(service.status()).toBe('unavailable');
  });
});
