import { TestBed } from '@angular/core/testing';
import { HOST_KEY_STORE, MemoryHostKeyStore } from './host-key-store';
import { HostKeysService } from './host-keys.service';

function setup() {
  TestBed.configureTestingModule({
    providers: [{ provide: HOST_KEY_STORE, useValue: new MemoryHostKeyStore() }],
  });
  return TestBed.inject(HostKeysService);
}

describe('HostKeysService', () => {
  it('creates a meeting, lists it, and backs it up only once', async () => {
    const service = setup();
    const roomId = await service.create();
    expect(service.meetings().map((m) => m.roomId)).toEqual([roomId]);
    expect(service.canBackUp(roomId)).toBe(true);

    const file = await service.backup(roomId, 'correct horse battery staple');
    expect(file.fileName).toMatch(/^cipheroom-host-[a-z2-7]{8}\.key$/);
    expect(JSON.parse(file.contents).roomId).toBe(roomId);
    expect(service.canBackUp(roomId)).toBe(false);
    await expect(service.backup(roomId, 'correct horse battery staple')).rejects.toThrow();
  });

  it('can’t back up after skipping', async () => {
    const service = setup();
    const roomId = await service.create();
    service.discardPendingBackup();
    expect(service.canBackUp(roomId)).toBe(false);
  });

  it('imports a backup and forgets meetings', async () => {
    const service = setup();
    const roomId = await service.create();
    const { contents } = await service.backup(roomId, 'correct horse battery staple');
    await service.delete(roomId);
    expect(service.meetings()).toEqual([]);

    expect(await service.import(contents, 'correct horse battery staple')).toBe(roomId);
    expect(service.meetings().map((m) => m.roomId)).toEqual([roomId]);
  });

  it('reports when this browser can’t keep keys', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_KEY_STORE,
          useValue: { list: () => Promise.reject(new Error('No IndexedDB.')) },
        },
      ],
    });
    const service = TestBed.inject(HostKeysService);
    await service.refresh();
    expect(service.canHost()).toBe(false);
  });
});
