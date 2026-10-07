import { Injectable } from '@angular/core';
import { Identity, IdentityBundle, createIdentity } from './identity';

/**
 * End-to-end encryption for one call: owns our per-call identity (and, from the next step on, sender keys and
 * envelopes). Provided per room route like MediaService, so keys live exactly as long as the call. Components only
 * ever get public data from it.
 */
@Injectable()
export class CryptoService {
  private identity?: Promise<Identity>;
  private identityRoom?: string;

  /**
   * Our public identity for this room, created on first use and kept for the call: a rejoin reuses it, so the
   * safety code doesn't change. Rejects when this browser lacks Ed25519/X25519 — there are no unencrypted calls.
   */
  async identityBundle(roomId: string): Promise<IdentityBundle> {
    if (!this.identity || this.identityRoom !== roomId) {
      this.identityRoom = roomId;
      this.identity = createIdentity(roomId);
    }
    try {
      return (await this.identity).bundle;
    } catch {
      this.identity = undefined;
      throw new Error(UNSUPPORTED);
    }
  }
}

const UNSUPPORTED = "This browser can't encrypt calls.";
