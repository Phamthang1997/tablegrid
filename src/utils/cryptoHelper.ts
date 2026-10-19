import i18n from '../i18n';

/**
 * WebCrypto Helper for Export/Import Connections with optional AES-GCM 256-bit password protection.
 */

/**
 * The extension TableGrid writes, and the `format` tag it stamps into the file.
 *
 * Reading ignores both: `decryptConnectionExport` branches on `encrypted`/`data` only, never on
 * `format` or on the file name. That is what makes renaming them safe in both directions — files
 * written as `.tableplusconnection` by earlier builds still import, and only the `accept` list
 * below has to keep naming them.
 */
export const CONNECTION_FILE_EXT = 'tablegridconnection';
export const CONNECTION_FILE_FORMAT = 'tablegridconnection';
/** What the import file picker offers: the current extension plus every one earlier builds wrote. */
export const CONNECTION_FILE_ACCEPT = '.tablegridconnection,.tableplusconnection,.tableforgeconnection,.json';

// Helper to convert Uint8Array to Hex string
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper to convert Hex string to Uint8Array
function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive AES-GCM key from password and salt using PBKDF2
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 100000,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt connection payload. If password is provided, uses AES-GCM 256-bit PBKDF2 encryption.
 */
export async function encryptConnectionExport(payload: any, password?: string): Promise<string> {
  const jsonText = JSON.stringify(payload);

  if (!password || !password.trim()) {
    return JSON.stringify({
      encrypted: false,
      version: 1,
      format: CONNECTION_FILE_FORMAT,
      data: payload
    }, null, 2);
  }

  const encoder = new TextEncoder();
  const dataBuf = encoder.encode(jsonText);
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(password.trim(), salt);
  const encryptedBuf = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    dataBuf
  );

  return JSON.stringify({
    encrypted: true,
    version: 1,
    format: CONNECTION_FILE_FORMAT,
    salt: bufToHex(salt.buffer),
    iv: bufToHex(iv.buffer),
    ciphertext: bufToHex(encryptedBuf)
  }, null, 2);
}

/**
 * Decrypt connection payload string. Prompts with error if password is required.
 */
export async function decryptConnectionExport(fileContent: string, password?: string): Promise<any> {
  let parsed: any;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    throw new Error(i18n.t('errors.invalidConnFileFormat'));
  }

  // Handle plain unencrypted connection array or wrapped unencrypted format
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed.encrypted === false && parsed.data) {
    return parsed.data;
  }

  if (parsed.encrypted === true) {
    if (!password || !password.trim()) {
      const err: any = new Error(i18n.t('errors.connFilePasswordProtected'));
      err.requiresPassword = true;
      throw err;
    }

    try {
      const salt = hexToBuf(parsed.salt);
      const iv = hexToBuf(parsed.iv);
      const ciphertext = hexToBuf(parsed.ciphertext);

      const key = await deriveKey(password.trim(), salt);
      const decryptedBuf = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as any },
        key,
        ciphertext as any
      );

      const decoder = new TextDecoder();
      const jsonText = decoder.decode(decryptedBuf);
      return JSON.parse(jsonText);
    } catch {
      const err: any = new Error(i18n.t('errors.wrongPasswordOrCorrupt'));
      err.requiresPassword = true;
      throw err;
    }
  }

  // Fallback for standard JSON structure
  return parsed;
}
