import { Contact, nameKey, seen, trustOf } from './contacts';

const bob = (overrides: Partial<Contact> = {}): Contact => ({
  devicePub: 'bob-key',
  name: 'Bob',
  firstSeen: 1,
  lastSeen: 1,
  calls: 1,
  lastCall: 'call-1',
  verified: false,
  ...overrides,
});
const book = (...contacts: Contact[]) => new Map(contacts.map((c) => [c.devicePub, c]));

describe('contacts', () => {
  describe('trustOf', () => {
    it('someone met in an earlier call is known; the first call doesn’t count', () => {
      expect(trustOf('bob-key', 'Bob', book(bob()), 'call-2')).toBe('known');
      expect(trustOf('bob-key', 'Bob', book(bob()), 'call-1')).toBe('new');
      expect(trustOf('bob-key', 'Bob', book(bob({ calls: 2, lastCall: 'call-2' })), 'call-2')).toBe(
        'known',
      );
    });

    it('a verified contact is verified, whatever name they use now', () => {
      expect(trustOf('bob-key', 'Robert', book(bob({ verified: true })), 'call-1')).toBe(
        'verified',
      );
    });

    it('a verified contact’s name with another key (or none) is a mismatch', () => {
      const contacts = book(bob({ verified: true }));
      expect(trustOf('mallory-key', 'Bob', contacts, 'call-2')).toBe('mismatch');
      expect(trustOf(undefined, '  bob ', contacts, 'call-2')).toBe('mismatch');
      expect(trustOf('mallory-key', 'Bobby', contacts, 'call-2')).toBe('new');
    });

    it('stays a mismatch after the impostor was remembered too', () => {
      const impostor = bob({ devicePub: 'mallory-key', lastCall: 'call-2' });
      expect(trustOf('mallory-key', 'Bob', book(bob({ verified: true }), impostor), 'call-2')).toBe(
        'mismatch',
      );
    });

    it('a merely known contact’s name with another key is just new', () => {
      expect(trustOf('mallory-key', 'Bob', book(bob()), 'call-2')).toBe('new');
      expect(trustOf(undefined, 'Carol', book(), 'call-1')).toBe('new');
    });
  });

  describe('seen', () => {
    it('remembers someone new', () => {
      expect(seen(undefined, 'bob-key', 'Bob', 'call-1', 100)).toEqual({
        devicePub: 'bob-key',
        name: 'Bob',
        firstSeen: 100,
        lastSeen: 100,
        calls: 1,
        lastCall: 'call-1',
        verified: false,
      });
    });

    it('counts each call once and keeps the previous name', () => {
      const again = seen(bob(), 'bob-key', 'Bob', 'call-1', 5);
      expect(again.calls).toBe(1);
      const later = seen(again, 'bob-key', 'Robert', 'call-2', 9);
      expect(later).toMatchObject({
        name: 'Robert',
        previousName: 'Bob',
        calls: 2,
        lastSeen: 9,
        firstSeen: 1,
      });
      expect(seen(bob({ verified: true }), 'bob-key', 'Bob', 'call-3', 10).verified).toBe(true);
    });
  });

  it('compares names as people read them', () => {
    expect(nameKey(' Ｂob ')).toBe(nameKey('bob'));
  });
});
