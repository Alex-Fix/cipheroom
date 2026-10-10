import { Injectable, inject, signal } from '@angular/core';
import { CONTACT_STORE, ContactStore, MemoryContactStore } from './contact-store';
import { Contact, seen } from './contacts';

/**
 * Everyone this browser has been in a call with, by device key (docs/plans/2026-10-10-contacts-tofu-design.md).
 * Stored in this browser only; without IndexedDB they last for the session (`persistent` false).
 */
@Injectable({ providedIn: 'root' })
export class ContactsService {
  private store: ContactStore = inject(CONTACT_STORE);
  private inMemory = false;
  private readonly loaded: Promise<void>;
  /** Writes happen one at a time, in order. */
  private writes: Promise<unknown> = Promise.resolve();

  readonly contacts = signal<ReadonlyMap<string, Contact>>(new Map());
  readonly persistent = signal(true);

  constructor() {
    this.loaded = this.load();
  }

  /** Someone in the call, by their verified device key: remembered (or updated). */
  async remember(devicePub: string, name: string, call: string, now = Date.now()): Promise<void> {
    await this.loaded;
    const contact = seen(this.contacts().get(devicePub), devicePub, name, call, now);
    await this.save(contact);
  }

  async setVerified(devicePub: string, verified: boolean): Promise<void> {
    await this.loaded;
    const contact = this.contacts().get(devicePub);
    if (contact && contact.verified !== verified) await this.save({ ...contact, verified });
  }

  async forget(devicePub: string): Promise<void> {
    await this.loaded;
    this.contacts.update((all) => {
      const next = new Map(all);
      next.delete(devicePub);
      return next;
    });
    await this.write((s) => s.delete(devicePub));
  }

  async forgetAll(): Promise<void> {
    await this.loaded;
    this.contacts.set(new Map());
    await this.write((s) => s.clear());
  }

  private async load(): Promise<void> {
    try {
      const all = await this.store.getAll();
      this.contacts.set(new Map(all.map((c) => [c.devicePub, c])));
    } catch {
      this.useMemory();
    }
  }

  private async save(contact: Contact): Promise<void> {
    this.contacts.update((all) => new Map(all).set(contact.devicePub, contact));
    await this.write((s) => s.put(contact));
  }

  /** A storage failure (IndexedDB gone mid-session) keeps contacts for the session instead of losing them. */
  private write(run: (store: ContactStore) => Promise<void>): Promise<void> {
    const next = this.writes.then(() => run(this.store)).catch(() => this.useMemory());
    this.writes = next;
    return next;
  }

  private useMemory(): void {
    if (this.inMemory) return;
    this.inMemory = true;
    this.persistent.set(false);
    const memory = new MemoryContactStore();
    this.contacts().forEach((c) => void memory.put(c));
    this.store = memory;
  }
}
