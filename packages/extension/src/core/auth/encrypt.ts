import sodium from "libsodium-wrappers";

/**
 * GitHub's repo/env public-key endpoints return base64-encoded Curve25519
 * public keys. We seal secret values to that key using libsodium's crypto_box
 * seal primitive — the same construction the REST API documents and the
 * official extension uses.
 *
 * The library is WASM-backed and needs an async init before any call. Calling
 * `ensureSodiumReady()` is idempotent; downstream code awaits it once per
 * write operation and moves on.
 */
export async function ensureSodiumReady(): Promise<void> {
  await sodium.ready;
}

/**
 * Seal a secret value with a GitHub-issued Curve25519 public key.
 *
 * @param publicKeyBase64  base64-encoded key returned by GitHub (the `key`
 *                         field of `/actions/secrets/public-key`)
 * @param value            the plaintext to encrypt; must round-trip as UTF-8
 *                         (multi-line safe — we normalize CRLF to LF so the
 *                         ciphertext doesn't carry Windows paste artefacts
 *                         that would break shell usage)
 * @returns base64 ciphertext ready to POST as `encrypted_value`
 */
export function encryptSecretValue(publicKeyBase64: string, value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const plaintext = sodium.from_string(normalized);
  const sealed = sodium.crypto_box_seal(plaintext, key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/** Test helper: generate a keypair and return `{ publicKeyBase64, secretKey }`. */
export async function generateTestKeypair(): Promise<{ publicKeyBase64: string; secretKey: Uint8Array; publicKey: Uint8Array }> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: kp.publicKey,
    secretKey: kp.privateKey,
    publicKeyBase64: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
  };
}

/** Test helper: open a sealed box using a keypair. */
export function decryptSealed(ciphertextBase64: string, publicKey: Uint8Array, secretKey: Uint8Array): string {
  const sealed = sodium.from_base64(ciphertextBase64, sodium.base64_variants.ORIGINAL);
  const opened = sodium.crypto_box_seal_open(sealed, publicKey, secretKey);
  return sodium.to_string(opened);
}
