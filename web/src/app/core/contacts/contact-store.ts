import { InjectionToken } from '@angular/core';
import { IdbStore } from '../storage/indexed-db';
import { Contact } from './contacts';

export interface ContactStore {
  getAll(): Promise<Contact[]>;
  put(contact: Contact): Promise<void>;
  delete(devicePub: string): Promise<void>;
  clear(): Promise<void>;
}

/** In memory only (tests, and browsers without IndexedDB — contacts then last for the session). */
export class MemoryContactStore implements ContactStore {
  private readonly contacts = new Map<string, Contact>();

  async getAll(): Promise<Contact[]> {
    return [...this.contacts.values()];
  }

  async put(contact: Contact): Promise<void> {
    this.contacts.set(contact.devicePub, contact);
  }

  async delete(devicePub: string): Promise<void> {
    this.contacts.delete(devicePub);
  }

  async clear(): Promise<void> {
    this.contacts.clear();
  }
}

/** IndexedDB (database "cipheroom-contacts"), in this browser only. */
export const CONTACT_STORE = new InjectionToken<ContactStore>('ContactStore', {
  providedIn: 'root',
  factory: () =>
    new IdbStore<Contact>({ db: 'cipheroom-contacts', store: 'contacts', keyPath: 'devicePub' }),
});
