import { beforeAll, describe, expect, it } from "vitest";
import { decryptSealed, encryptSecretValue, ensureSodiumReady, generateTestKeypair } from "./encrypt.js";

describe("encryptSecretValue", () => {
  beforeAll(async () => { await ensureSodiumReady(); });

  it("round-trips a simple single-line value", async () => {
    const kp = await generateTestKeypair();
    const ct = encryptSecretValue(kp.publicKeyBase64, "hunter2");
    expect(decryptSealed(ct, kp.publicKey, kp.secretKey)).toBe("hunter2");
  });

  it("preserves multi-line values without corruption (defends against upstream #566)", async () => {
    const kp = await generateTestKeypair();
    const key = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAA",
      "AAtzc2gtZWQyNTUxOQAAACBXnJ3hMpKm8a+Ws9hu6Yk9SL8nVl0lLlR+oxJLeR",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const ct = encryptSecretValue(kp.publicKeyBase64, key);
    expect(decryptSealed(ct, kp.publicKey, kp.secretKey)).toBe(key);
  });

  it("normalizes CRLF to LF before encryption (Windows paste safety)", async () => {
    const kp = await generateTestKeypair();
    const ct = encryptSecretValue(kp.publicKeyBase64, "line1\r\nline2\r\nline3");
    expect(decryptSealed(ct, kp.publicKey, kp.secretKey)).toBe("line1\nline2\nline3");
  });

  it("does not trim leading/trailing whitespace", async () => {
    const kp = await generateTestKeypair();
    const value = "  value-with-pad  \n";
    const ct = encryptSecretValue(kp.publicKeyBase64, value);
    expect(decryptSealed(ct, kp.publicKey, kp.secretKey)).toBe(value);
  });

  it("handles unicode values losslessly", async () => {
    const kp = await generateTestKeypair();
    const value = "éèêë 中文 🔐";
    const ct = encryptSecretValue(kp.publicKeyBase64, value);
    expect(decryptSealed(ct, kp.publicKey, kp.secretKey)).toBe(value);
  });

  it("produces distinct ciphertexts for the same plaintext (sealed-box is randomized)", async () => {
    const kp = await generateTestKeypair();
    const a = encryptSecretValue(kp.publicKeyBase64, "same");
    const b = encryptSecretValue(kp.publicKeyBase64, "same");
    expect(a).not.toBe(b);
  });
});
