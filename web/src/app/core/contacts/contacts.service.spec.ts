import { TestBed } from '@angular/core/testing';
import { CONTACT_STORE, MemoryContactStore } from './contact-store';
import { ContactsService } from './contacts.service';

describe('ContactsService', () => {
  function setup(store = new MemoryContactStore()) {
    TestBed.configureTestingModule({ providers: [{ provide: CONTACT_STORE, useValue: store }] });
    return { service: TestBed.inject(ContactsService), store };
  }

  it('remembers people, counts calls, and stores them', async () => {
    const { service, store } = setup();
    await service.remember('bob-key', 'Bob', 'call-1', 10);
    await service.remember('bob-key', 'Bob', 'call-1', 11);
    await service.remember('bob-key', 'Robert', 'call-2', 20);

    expect(service.contacts().get('bob-key')).toMatchObject({
      name: 'Robert',
      previousName: 'Bob',
      calls: 2,
      firstSeen: 10,
      lastSeen: 20,
    });
    expect(await store.getAll()).toEqual([service.contacts().get('bob-key')]);
  });

  it('loads what was stored before', async () => {
    const store = new MemoryContactStore();
    await store.put({
      devicePub: 'carol-key',
      name: 'Carol',
      firstSeen: 1,
      lastSeen: 1,
      calls: 3,
      lastCall: 'x',
      verified: true,
    });
    const { service } = setup(store);
    await service.remember('bob-key', 'Bob', 'call-1');
    expect([...service.contacts().keys()].sort()).toEqual(['bob-key', 'carol-key']);
  });

  it('marks verified, forgets one, forgets everyone', async () => {
    const { service, store } = setup();
    await service.remember('bob-key', 'Bob', 'call-1');
    await service.remember('carol-key', 'Carol', 'call-1');
    await service.setVerified('bob-key', true);
    expect(service.contacts().get('bob-key')!.verified).toBe(true);
    await service.setVerified('zed-key', true); // not a contact: nothing happens
    expect(service.contacts().has('zed-key')).toBe(false);

    await service.forget('bob-key');
    expect([...service.contacts().keys()]).toEqual(['carol-key']);
    await service.forgetAll();
    expect(service.contacts().size).toBe(0);
    expect(await store.getAll()).toEqual([]);
  });

  it('keeps contacts for the session when the browser can’t store them', async () => {
    const broken = new MemoryContactStore();
    vi.spyOn(broken, 'getAll').mockRejectedValue(new Error('No IndexedDB.'));
    const { service } = setup(broken);
    await service.remember('bob-key', 'Bob', 'call-1');
    expect(service.persistent()).toBe(false);
    expect(service.contacts().has('bob-key')).toBe(true);
  });
});
