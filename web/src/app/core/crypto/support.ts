import { frameTransformApi } from './frame-transforms';
import { supportsIdentityKeys } from './identity';

/**
 * Whether this browser can take part in end-to-end encrypted calls: encoded transforms (to encrypt frames) and
 * Ed25519/X25519 in WebCrypto (identity and envelopes). Without both it can't join — calls are never unencrypted.
 */
export async function e2eeSupported(): Promise<boolean> {
  return frameTransformApi() !== undefined && (await supportsIdentityKeys());
}

export const E2EE_UNSUPPORTED = "This browser can't join encrypted calls.";
