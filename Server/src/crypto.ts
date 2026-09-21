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

const PASSWORD_HASH_ALGORITHM = "pbkdf2-sha256";
// Cloudflare Workers Web Crypto rejects PBKDF2 values above 100,000.
// Keep the encoded value explicit so hashes can be verified consistently
// across local workerd and the deployed Worker runtime.
const PASSWORD_HASH_ITERATIONS = 100_000;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function passwordBits(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256"
    },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await passwordBits(password, salt, PASSWORD_HASH_ITERATIONS);
  return [
    PASSWORD_HASH_ALGORITHM,
    String(PASSWORD_HASH_ITERATIONS),
    base64Url(salt),
    base64Url(digest)
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string | null | undefined
): Promise<boolean> {
  try {
    const [algorithm, iterationValue, saltValue, digestValue] = String(encoded || "").split("$");
    const iterations = Number(iterationValue);
    if (
      algorithm !== PASSWORD_HASH_ALGORITHM ||
      !Number.isInteger(iterations) ||
      iterations < 100_000 ||
      iterations > PASSWORD_HASH_ITERATIONS ||
      !saltValue ||
      !digestValue
    ) {
      return false;
    }
    const actual = await passwordBits(password, fromBase64Url(saltValue), iterations);
    return equalBytes(actual, fromBase64Url(digestValue));
  } catch {
    return false;
  }
}
