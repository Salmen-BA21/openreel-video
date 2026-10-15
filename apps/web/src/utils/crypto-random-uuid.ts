/**
 * `crypto.randomUUID()` is only exposed in a *secure context*. The editor is
 * routinely opened over plain HTTP on a LAN address while testing on a phone
 * (e.g. http://192.168.1.3:5173), where the method does not exist and any code
 * that mints an id throws `TypeError: crypto.randomUUID is not a function`.
 *
 * That failure is easy to miss because it only hits the id-generating half of a
 * flow: adding media to the timeline, for example, creates the track first and
 * then throws while creating the clip, leaving an empty "Audio 1" track and no
 * clip. `crypto.getRandomValues()` *is* available in insecure contexts, so use
 * it to back a spec-compliant v4 UUID when the native helper is missing.
 */

/** Generate a v4 UUID from the sources available in an insecure context. */
export function generateUUID(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort: only reachable if even getRandomValues is unavailable.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** The native v4 UUID when available, otherwise {@link generateUUID}. */
export function randomUUID(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return generateUUID();
}

/**
 * Restore `crypto.randomUUID` when the host does not provide it, so existing
 * `crypto.randomUUID()` call sites keep working. No-op in secure contexts.
 * `generateUUID` is installed directly so it can never recurse back into the
 * native-probe in {@link randomUUID}.
 */
export function installCryptoRandomUUID(): void {
  const cryptoObj = globalThis.crypto as
    | (Crypto & { randomUUID?: () => string })
    | undefined;
  if (!cryptoObj || typeof cryptoObj.randomUUID === "function") return;

  try {
    Object.defineProperty(cryptoObj, "randomUUID", {
      value: generateUUID,
      writable: true,
      configurable: true,
    });
  } catch {
    try {
      cryptoObj.randomUUID = generateUUID as unknown as Crypto["randomUUID"];
    } catch {
      // Some hosts freeze the crypto object; leave native behaviour untouched.
    }
  }
}

// Install as a side effect of importing so the polyfill is in place before any
// other module runs.
installCryptoRandomUUID();
