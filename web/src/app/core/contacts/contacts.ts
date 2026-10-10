import { cleanName } from '../crypto/names';

/**
 * Someone this browser has been in a call with, by their device key (docs/plans/2026-10-10-contacts-tofu-design.md).
 * Kept in this browser only.
 */
export interface Contact {
  /** Their device key (base64url): who they are, as far as we can tell. */
  devicePub: string;
  /** The name they used last, and the one before if it changed. */
  name: string;
  previousName?: string;
  firstSeen: number;
  lastSeen: number;
  /** In how many calls we've seen them, and the last one (our per-call identity as the call's id). */
  calls: number;
  lastCall: string;
  /** We compared the safety code with them and said so. */
  verified: boolean;
}

/**
 * - `verified`: a contact we verified; `known`: met in an earlier call; `new`: first time (or no device key);
 * - `mismatch`: no matching device key, but the name of a contact we verified — a new device, or someone else.
 */
export type Trust = 'verified' | 'known' | 'new' | 'mismatch';

export function trustOf(
  devicePub: string | undefined,
  name: string,
  contacts: ReadonlyMap<string, Contact>,
  currentCall: string,
): Trust {
  const contact = devicePub ? contacts.get(devicePub) : undefined;
  if (contact?.verified) return 'verified';
  // Before known / new: an impostor is remembered as soon as their envelope arrives, too.
  const key = nameKey(name);
  for (const c of contacts.values()) {
    if (c.verified && c.devicePub !== devicePub && nameKey(c.name) === key) return 'mismatch';
  }
  if (contact) return contact.calls > 1 || contact.lastCall !== currentCall ? 'known' : 'new';
  return 'new';
}

/** The contact after seeing them (again) in `call` under `name`. */
export function seen(
  contact: Contact | undefined,
  devicePub: string,
  name: string,
  call: string,
  now: number,
): Contact {
  if (!contact) {
    return {
      devicePub,
      name,
      firstSeen: now,
      lastSeen: now,
      calls: 1,
      lastCall: call,
      verified: false,
    };
  }
  const renamed = contact.name !== name;
  return {
    ...contact,
    name,
    previousName: renamed ? contact.name : contact.previousName,
    lastSeen: now,
    calls: contact.lastCall === call ? contact.calls : contact.calls + 1,
    lastCall: call,
  };
}

/** Names compare as people read them: trimmed, case and Unicode form ignored. */
export const nameKey = (name: string): string =>
  cleanName(name).normalize('NFKC').toLocaleLowerCase();
