function base64Url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function buffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function deriveKey(
  secret: string,
  purpose: string,
  usage: "encryption" | "hash"
): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  const material = new TextEncoder().encode(`${purpose}:${secret}`);
  if (usage === "encryption") {
    const digest = await crypto.subtle.digest("SHA-256", material);
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
      "encrypt",
      "decrypt"
    ]);
  }
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

export async function encryptSecret(
  env: Env,
  purpose: string,
  plaintext: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await deriveKey(env.SESSION_SECRET, purpose, "encryption"),
    new TextEncoder().encode(plaintext)
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  env: Env,
  purpose: string,
  sealed: string
): Promise<string> {
  const [ivValue, ciphertextValue] = sealed.split(".");
  if (!ivValue || !ciphertextValue) throw new Error("Invalid encrypted value");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(fromBase64Url(ivValue)) },
    await deriveKey(env.SESSION_SECRET, purpose, "encryption"),
    buffer(fromBase64Url(ciphertextValue))
  );
  return new TextDecoder().decode(plaintext);
}

export async function keyedHash(
  env: Env,
  purpose: string,
  value: string
): Promise<string> {
  const digest = await crypto.subtle.sign(
    "HMAC",
    await deriveKey(env.SESSION_SECRET, purpose, "hash"),
    new TextEncoder().encode(value)
  );
  return base64Url(new Uint8Array(digest));
}
