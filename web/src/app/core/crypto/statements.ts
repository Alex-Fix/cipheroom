import { isWeakEd25519Key } from './weak-keys';
import { AuthorityDto, IdentityDto, TicketDto } from '../signaling/signaling.types';
import { fields, fromBase64Url, toBase64Url } from './encoding';
import { deriveRoomId, hostAttestationMessage } from './host-key';
import { Identity } from './identity';

/**
 * Signed admission statements (design: docs/plans/2026-10-08-lobby-admission-design.md). Every one is an Ed25519
 * signature over fields(label, roomId, …) — byte-identical to the api's AdmissionMessages, pinned by shared vectors
 * (tests/fixtures/admission-vectors.json). Identities are per-call, so nothing can be replayed into a later call.
 */
const LABELS = {
  coHost: 'cipheroom/cohost/v1',
  ticket: 'cipheroom/ticket/v1',
  revoke: 'cipheroom/revoke/v1',
  settings: 'cipheroom/settings/v1',
  end: 'cipheroom/end/v1',
  mute: 'cipheroom/mute/v1',
} as const;

export const ticketMessage = (roomId: string, issuer: string, subject: string) =>
  fields(LABELS.ticket, roomId, key(issuer), key(subject));
export const coHostMessage = (roomId: string, issuer: string, subject: string) =>
  fields(LABELS.coHost, roomId, key(issuer), key(subject));
export const revokeMessage = (roomId: string, issuer: string, subject: string) =>
  fields(LABELS.revoke, roomId, key(issuer), key(subject));
export const settingsMessage = (roomId: string, issuer: string, seq: number, autoAdmit: boolean) =>
  fields(LABELS.settings, roomId, key(issuer), seq, autoAdmit ? 1 : 0);
export const endMessage = (roomId: string, issuer: string) =>
  fields(LABELS.end, roomId, key(issuer));
export const muteMessage = (roomId: string, issuer: string, subject: string, seq: number) =>
  fields(LABELS.mute, roomId, key(issuer), key(subject), seq);

/** Signs with our per-call identity; returns the signature (base64url). */
export async function sign(identity: Identity, message: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign('Ed25519', identity.signing.privateKey, message)),
  );
}

/** False for a wrong signature and for anything malformed. */
export async function verify(
  publicKey: string,
  message: Uint8Array<ArrayBuffer>,
  sig: string,
): Promise<boolean> {
  try {
    const pub = key(publicKey);
    const signature = fromBase64Url(sig);
    if (pub.byteLength !== 32 || signature.byteLength !== 64) return false;
    // A small-order "key" can verify trivial signatures without anyone holding a private key.
    if (await isWeakEd25519Key(pub)) return false;
    const k = await crypto.subtle.importKey('raw', pub, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', k, signature, message);
  } catch {
    return false;
  }
}

/**
 * What we know for sure about a room's authority, checked from the host keys down (identities are Ed25519, base64url).
 * Statements that don't verify are ignored: a lying server can hide things, never add them.
 */
export interface Authority {
  /** The host keys derive the room id. Without that nobody is host. */
  hostKeysValid: boolean;
  /** Identities the host key attested. */
  hosts: ReadonlySet<string>;
  /** Identities a host granted co-host. */
  coHosts: ReadonlySet<string>;
  /** Identities removed by a host or co-host: no keys, no authority. */
  revoked: ReadonlySet<string>;
  autoAdmit: boolean;
  /** Newest settings sequence (0 = none yet); the next one we sign must be higher. */
  settingsSeq: number;
}

export const NO_AUTHORITY: Authority = {
  hostKeysValid: false,
  hosts: new Set(),
  coHosts: new Set(),
  revoked: new Set(),
  autoAdmit: false,
  settingsSeq: 0,
};

export async function verifyAuthority(roomId: string, dto: AuthorityDto): Promise<Authority> {
  if (!dto.hostEd25519Pub || !dto.hostX25519Pub) return NO_AUTHORITY;
  let derived: string;
  try {
    derived = await deriveRoomId(key(dto.hostEd25519Pub), key(dto.hostX25519Pub));
  } catch {
    return NO_AUTHORITY;
  }
  if (derived !== roomId) return NO_AUTHORITY;

  const hostKey = dto.hostEd25519Pub;
  const hosts = new Set<string>();
  for (const h of dto.hosts) {
    if (await verify(hostKey, hostAttestationMessage(roomId, h.identity), h.sig))
      hosts.add(h.identity);
  }
  const coHosts = new Set<string>();
  for (const g of dto.coHosts) {
    if (
      hosts.has(g.issuer) &&
      (await verify(g.issuer, coHostMessage(roomId, g.issuer, g.subject), g.sig))
    ) {
      coHosts.add(g.subject);
    }
  }
  const revoked = new Set<string>();
  for (const r of dto.revoked) {
    const allowed =
      hosts.has(r.issuer) ||
      (coHosts.has(r.issuer) && !hosts.has(r.subject) && !coHosts.has(r.subject));
    if (allowed && (await verify(r.issuer, revokeMessage(roomId, r.issuer, r.subject), r.sig))) {
      revoked.add(r.subject);
    }
  }
  const s = dto.settings;
  const settingsOk =
    !!s &&
    hosts.has(s.issuer) &&
    (await verify(s.issuer, settingsMessage(roomId, s.issuer, s.seq, s.autoAdmit), s.sig));
  return {
    hostKeysValid: true,
    hosts,
    coHosts,
    revoked,
    autoAdmit: settingsOk ? s.autoAdmit : false,
    settingsSeq: settingsOk ? s.seq : 0,
  };
}

/** May act as host or co-host right now (attested or granted, not removed). */
export const isAdmitter = (authority: Authority, identity: string): boolean =>
  (authority.hosts.has(identity) || authority.coHosts.has(identity)) &&
  !authority.revoked.has(identity);

export const isHost = (authority: Authority, identity: string): boolean =>
  authority.hosts.has(identity) && !authority.revoked.has(identity);

/**
 * Whether a participant may be in the call: attested host, or a ticket from someone who was host or co-host (a ticket
 * stays valid after its issuer leaves), and not removed.
 */
export async function isAdmitted(
  roomId: string,
  authority: Authority,
  identity: IdentityDto,
  ticket: TicketDto | null,
): Promise<boolean> {
  const pub = identity.ed25519Pub;
  if (authority.revoked.has(pub)) return false;
  if (authority.hosts.has(pub)) return true;
  if (!ticket || !(authority.hosts.has(ticket.issuer) || authority.coHosts.has(ticket.issuer)))
    return false;
  return verify(ticket.issuer, ticketMessage(roomId, ticket.issuer, pub), ticket.sig);
}

const key = (base64Url: string) => fromBase64Url(base64Url);
