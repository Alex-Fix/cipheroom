import { EnvironmentInjector, createEnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CryptoService } from '../crypto/crypto.service';
import { SignalingService } from '../signaling/signaling.service';
import { CallContactsService } from './call-contacts.service';
import { CONTACT_STORE, MemoryContactStore } from './contact-store';
import { ContactsService } from './contacts.service';

const settle = async () => {
  TestBed.tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
};

describe('CallContactsService', () => {
  function setup(call = 'call-1') {
    const crypto = {
      identityPub: signal<string | undefined>(call),
      devices: signal<ReadonlyMap<string, string>>(new Map()),
      names: signal<ReadonlyMap<string, string>>(new Map([['me', 'Alex']])),
    };
    const participants = signal<{ id: string }[]>([]);
    TestBed.configureTestingModule({
      providers: [{ provide: CONTACT_STORE, useValue: new MemoryContactStore() }],
    });
    const contacts = TestBed.inject(ContactsService);
    const injector = createEnvironmentInjector(
      [
        CallContactsService,
        { provide: CryptoService, useValue: crypto },
        { provide: SignalingService, useValue: { participants } },
      ],
      TestBed.inject(EnvironmentInjector),
    );
    return { service: injector.get(CallContactsService), crypto, participants, contacts };
  }

  /** Bob (with a device key) and Carol (without one) joined and sent their envelopes. */
  function bobAndCarol(ctx: ReturnType<typeof setup>) {
    ctx.participants.set([{ id: 'p-bob' }, { id: 'p-carol' }]);
    ctx.crypto.names.set(
      new Map([
        ['me', 'Alex'],
        ['p-bob', 'Bob'],
        ['p-carol', 'Carol'],
      ]),
    );
    ctx.crypto.devices.set(new Map([['p-bob', 'bob-key']]));
  }

  it('remembers people with a device key; the first call makes nobody known', async () => {
    const ctx = setup();
    bobAndCarol(ctx);
    await settle();

    expect([...ctx.contacts.contacts().keys()]).toEqual(['bob-key']);
    expect(ctx.service.trust()).toEqual(
      new Map([
        ['p-bob', 'new'],
        ['p-carol', 'new'],
      ]),
    );
    expect(ctx.service.verifiable()).toEqual(new Set(['p-bob']));
  });

  it('knows someone from an earlier call, and verifies them', async () => {
    const ctx = setup('call-2');
    await ctx.contacts.remember('bob-key', 'Bob', 'call-1');
    bobAndCarol(ctx);
    await settle();
    expect(ctx.service.trust().get('p-bob')).toBe('known');

    expect(await ctx.service.setVerified('p-bob', true)).toBe(true);
    await settle();
    expect(ctx.service.trust().get('p-bob')).toBe('verified');
    // Carol has no device key: nothing to verify.
    expect(await ctx.service.setVerified('p-carol', true)).toBe(false);
  });

  it('flags someone using a verified contact’s name with another key', async () => {
    const ctx = setup('call-2');
    await ctx.contacts.remember('bob-key', 'Bob', 'call-1');
    await ctx.contacts.setVerified('bob-key', true);
    ctx.participants.set([{ id: 'p-fake' }]);
    ctx.crypto.names.set(new Map([['p-fake', 'Bob']]));
    ctx.crypto.devices.set(new Map([['p-fake', 'mallory-key']]));
    await settle();
    expect(ctx.service.trust().get('p-fake')).toBe('mismatch');
  });
});
