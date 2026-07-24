// End-to-end sealing (push-notifications.md §6). Mantle seals each notification
// payload to a device's X25519 public key with libsodium `crypto_box_seal`
// (anonymous-sender sealed box): only that device's secret key can open it. The
// relay and APNs/FCM only ever see ciphertext.
//
// Interop contract with the app (flutter_sodium / sodium_libs): public keys and
// ciphertext are STANDARD base64 (with padding). crypto_box_seal output is
// `ephemeral_pk(32) || box`, which crypto_box_seal_open reverses on-device.

import _sodium from 'libsodium-wrappers';

let readyPromise: Promise<typeof _sodium> | null = null;

async function sodium(): Promise<typeof _sodium> {
  if (!readyPromise) readyPromise = _sodium.ready.then(() => _sodium);
  return readyPromise;
}

/** Seal `plaintext` to a device public key. Returns base64 ciphertext. */
export async function sealToDevice(publicKeyB64: string, plaintext: string): Promise<string> {
  const s = await sodium();
  const pk = s.from_base64(publicKeyB64, s.base64_variants.ORIGINAL);
  const sealed = s.crypto_box_seal(s.from_string(plaintext), pk);
  return s.to_base64(sealed, s.base64_variants.ORIGINAL);
}

/** For tests/verification: generate a device keypair (base64 pk + sk). */
export async function generateDeviceKeypair(): Promise<{ publicKey: string; secretKey: string }> {
  const s = await sodium();
  const kp = s.crypto_box_keypair();
  return {
    publicKey: s.to_base64(kp.publicKey, s.base64_variants.ORIGINAL),
    secretKey: s.to_base64(kp.privateKey, s.base64_variants.ORIGINAL),
  };
}

/** For tests/verification: open a sealed box with a device keypair. */
export async function openSealed(
  ciphertextB64: string,
  publicKeyB64: string,
  secretKeyB64: string,
): Promise<string> {
  const s = await sodium();
  const opened = s.crypto_box_seal_open(
    s.from_base64(ciphertextB64, s.base64_variants.ORIGINAL),
    s.from_base64(publicKeyB64, s.base64_variants.ORIGINAL),
    s.from_base64(secretKeyB64, s.base64_variants.ORIGINAL),
  );
  return s.to_string(opened);
}
