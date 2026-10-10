import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { SignalingService } from '../signaling/signaling.service';
import { Trust, trustOf } from './contacts';
import { ContactsService } from './contacts.service';

/**
 * Contacts in the current call (provided per room route): remembers everyone whose device key verified inside their
 * key envelope, and says how much we know each participant. Components get trust levels and participant ids only.
 */
@Injectable()
export class CallContactsService {
  private readonly crypto = inject(CryptoService);
  private readonly contacts = inject(ContactsService);
  private readonly signaling = inject(SignalingService);

  /** How much we know each other participant (by participant id). */
  readonly trust = computed<ReadonlyMap<string, Trust>>(() => {
    const call = this.crypto.identityPub() ?? '';
    const devices = this.crypto.devices();
    const contacts = this.contacts.contacts();
    const names = this.crypto.names();
    const trust = new Map<string, Trust>();
    for (const { id } of this.signaling.participants()) {
      // No name yet = no key envelope yet: nothing to say about them.
      const name = names.get(id);
      if (name !== undefined) trust.set(id, trustOf(devices.get(id), name, contacts, call));
    }
    return trust;
  });

  /** Participants with a device key: the ones we can mark as verified. */
  readonly verifiable = computed<ReadonlySet<string>>(() => new Set(this.crypto.devices().keys()));

  constructor() {
    effect(() => {
      const call = this.crypto.identityPub();
      const devices = this.crypto.devices();
      const names = this.crypto.names();
      if (!call) return;
      untracked(() => {
        for (const [id, devicePub] of devices) {
          const name = names.get(id);
          if (name) void this.contacts.remember(devicePub, name, call);
        }
      });
    });
  }

  /** After comparing the safety code with them (or taking it back). False if they have no device key. */
  async setVerified(participantId: string, verified: boolean): Promise<boolean> {
    const devicePub = this.crypto.devices().get(participantId);
    if (!devicePub) return false;
    await this.contacts.setVerified(devicePub, verified);
    return true;
  }
}
