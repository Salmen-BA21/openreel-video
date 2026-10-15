import { afterEach, describe, expect, it } from "vitest";
import {
  generateUUID,
  installCryptoRandomUUID,
  randomUUID,
} from "./crypto-random-uuid";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type MutableCrypto = Crypto & { randomUUID?: () => string };

function withoutNativeRandomUUID(run: () => void): void {
  const cryptoObj = globalThis.crypto as MutableCrypto;
  const original = cryptoObj.randomUUID;
  Object.defineProperty(cryptoObj, "randomUUID", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    Object.defineProperty(cryptoObj, "randomUUID", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

afterEach(() => {
  // Re-assert the native method in case a test left a polyfill installed.
  const cryptoObj = globalThis.crypto as MutableCrypto;
  if (typeof cryptoObj.randomUUID !== "function") {
    installCryptoRandomUUID();
  }
});

describe("crypto-random-uuid", () => {
  it("returns a v4 uuid in a normal (secure) context", () => {
    expect(randomUUID()).toMatch(UUID_V4);
  });

  it("generates a v4 uuid without the secure-context API", () => {
    withoutNativeRandomUUID(() => {
      expect(generateUUID()).toMatch(UUID_V4);
      expect(randomUUID()).toMatch(UUID_V4);
    });
  });

  it("installs crypto.randomUUID so existing call sites stop throwing", () => {
    withoutNativeRandomUUID(() => {
      installCryptoRandomUUID();
      expect(typeof globalThis.crypto.randomUUID).toBe("function");
      expect(globalThis.crypto.randomUUID()).toMatch(UUID_V4);
    });
  });

  it("does not recurse when the installed polyfill is called repeatedly", () => {
    withoutNativeRandomUUID(() => {
      installCryptoRandomUUID();
      const ids = new Set([
        globalThis.crypto.randomUUID(),
        globalThis.crypto.randomUUID(),
        globalThis.crypto.randomUUID(),
      ]);
      expect(ids.size).toBe(3);
    });
  });
});
