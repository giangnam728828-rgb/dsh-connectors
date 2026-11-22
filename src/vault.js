/**
 * The credential vault.
 *
 * Design constraints, in the order they shaped the code:
 *
 * 1. A token must survive a restart, a new session, and a profile switch, or
 *    the user is back to pasting it. So it lives on disk, not in memory.
 * 2. It must not be readable by another process, a backup sync, or a stray
 *    `cat`. So every record is AES-256-GCM encrypted, the vault file is 0600,
 *    its directory is 0700, and the key is a separate 0600 file.
 * 3. It must not be reachable from the workspace. The agent's sandbox sees the
 *    workspace; this directory sits in the harness state directory instead.
 * 4. A crash mid-write must not leave a half-vault. Every write goes through a
 *    temp file plus rename, and writes are serialized.
 *
 * The vault never hands a token to a caller that only asked for status: the
 * projection used by the UI and the tools drops the secret before it leaves
 * this module's helpers.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const VAULT_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Where this installation keeps connector data.
 *
 * Precedence:
 *   1. `DSH_CONNECTORS_HOME` - explicit override, useful for tests and for a
 *      shared vault across two harness installs.
 *   2. `$DSH_HOME/state/connectors` - shared by every profile of one harness,
 *      which is what a user means by "connect once".
 *   3. `$DSH_PROFILE_DIR/state/connectors` - a profile-only install.
 *   4. `~/.dsh/state/connectors` - the default harness home.
 *
 * @returns the absolute directory holding `vault.json` and `key`.
 */
export function connectorHome() {
  const explicit = process.env.DSH_CONNECTORS_HOME;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim() !== '') {
    return path.join(path.resolve(home.trim()), 'state', 'connectors');
  }
  const profile = process.env.DSH_PROFILE_DIR;
  if (typeof profile === 'string' && profile.trim() !== '') {
    return path.join(path.resolve(profile.trim()), 'state', 'connectors');
  }
  return path.join(homedir(), '.dsh', 'state', 'connectors');
}

/**
 * Ensure a directory exists with owner-only permissions.
 * @param directory - absolute path.
 */
async function ensurePrivateDir(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

/**
 * Write a file atomically with owner-only permissions.
 * @param file - absolute path.
 * @param data - file contents.
 * @param mode - permission bits, defaults to 0600.
 */
async function writePrivateFile(file, data, mode = 0o600) {
  await ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode).catch(() => {});
  await rename(temporary, file);
  await chmod(file, mode).catch(() => {});
}

/**
 * Read the vault encryption key, creating it on first use.
 * @param home - connector home directory.
 * @returns the 32-byte key.
 */
async function readOrCreateKey(home) {
  const file = path.join(home, 'key');
  try {
    const existing = await readFile(file);
    if (existing.length === KEY_BYTES) return existing;
    // A truncated or replaced key cannot decrypt anything; fail loudly rather
    // than silently rotating and losing every stored credential.
    throw new Error('vault-key-corrupt');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const key = randomBytes(KEY_BYTES);
    await writePrivateFile(file, key);
    return key;
  }
}

/**
 * Encrypt one JSON payload.
 * @param key - 32-byte key.
 * @param plaintext - JSON text.
 * @param aad - additional authenticated data binding the record to its id.
 * @returns iv, tag and ciphertext, all base64.
 */
function encrypt(key, plaintext, aad) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  };
}

/**
 * Decrypt one JSON payload.
 * @param key - 32-byte key.
 * @param record - iv, tag and ciphertext.
 * @param aad - the same additional data used when encrypting.
 * @returns the plaintext.
 */
function decrypt(key, record, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * A vault over one directory.
 * @param home - connector home directory, defaults to @see connectorHome.
 * @returns read/write operations, all async, all serialized on write.
 */
export function createVault(home = connectorHome()) {
  const vaultFile = path.join(home, 'vault.json');
  const settingsFile = path.join(home, 'settings.json');

  /** @type {Promise<unknown>} tail of the write chain */
  let writes = Promise.resolve();

  /**
   * Read the raw vault envelope.
   * @returns `{ version, records }`, or an empty vault when the file is absent.
   */
  async function readEnvelope() {
    try {
      const parsed = JSON.parse(await readFile(vaultFile, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: VAULT_VERSION, records: {} };
      const records = parsed.records !== null && typeof parsed.records === 'object' && !Array.isArray(parsed.records) ? parsed.records : {};
      return { version: VAULT_VERSION, records };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: VAULT_VERSION, records: {} };
      // A damaged vault is not silently replaced: that would erase credentials
      // the user cannot recover without re-authorizing every platform.
      throw new Error('vault-unreadable');
    }
  }

  /**
   * Persist the whole envelope atomically.
   * @param envelope - version plus records.
   */
  async function writeEnvelope(envelope) {
    await writePrivateFile(vaultFile, JSON.stringify({ version: VAULT_VERSION, records: envelope.records }, null, 2));
  }

  /**
   * Serialize one async mutation so two concurrent saves cannot interleave.
   * @param operation - the mutation.
   * @returns its result.
   */
  function serialized(operation) {
    const run = writes.then(operation, operation);
    writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Store or replace one provider credential.
   * @param providerId - vault key.
   * @param credential - at least `token`; `username` is kept for basic auth.
   * @returns the stored record's public projection.
   */
  async function put(providerId, credential) {
    const id = String(providerId ?? '').trim();
    if (id === '') throw new Error('provider-required');
    if (typeof credential?.token !== 'string' || credential.token.trim() === '') throw new Error('token-required');
    return serialized(async () => {
      const key = await readOrCreateKey(home);
      const envelope = await readEnvelope();
      const record = {
        token: credential.token.trim(),
        kind: typeof credential.kind === 'string' ? credential.kind : 'token',
        username: typeof credential.username === 'string' && credential.username.trim() !== '' ? credential.username.trim() : undefined,
        login: typeof credential.login === 'string' ? credential.login : undefined,
        name: typeof credential.name === 'string' ? credential.name : undefined,
        avatarUrl: typeof credential.avatarUrl === 'string' ? credential.avatarUrl : undefined,
        scopes: Array.isArray(credential.scopes) ? credential.scopes.filter((scope) => typeof scope === 'string') : undefined,
        note: typeof credential.note === 'string' ? credential.note : undefined,
        connectedAt: Number(credential.connectedAt) || Date.now(),
        updatedAt: Date.now(),
      };
      envelope.records[id] = encrypt(key, JSON.stringify(record), `connectors:v${VAULT_VERSION}:${id}`);
      await writeEnvelope(envelope);
      return project(id, record);
    });
  }

  /**
   * Read one credential, including the secret.
   * @param providerId - vault key.
   * @returns the credential, or null when absent or undecryptable.
   */
  async function get(providerId) {
    const id = String(providerId ?? '').trim();
    if (id === '') return null;
    const envelope = await readEnvelope();
    const record = envelope.records[id];
    if (!record) return null;
    try {
      const key = await readOrCreateKey(home);
      const parsed = JSON.parse(decrypt(key, record, `connectors:v${VAULT_VERSION}:${id}`));
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Remove one credential.
   * @param providerId - vault key.
   * @returns whether a record was removed.
   */
  async function remove(providerId) {
    const id = String(providerId ?? '').trim();
    if (id === '') return false;
    return serialized(async () => {
      const envelope = await readEnvelope();
      if (!(id in envelope.records)) return false;
      delete envelope.records[id];
      await writeEnvelope(envelope);
      return true;
    });
  }

  /**
   * List stored providers without decrypting them.
   * @returns the ids present in the vault.
   */
  async function ids() {
    const envelope = await readEnvelope();
    return Object.keys(envelope.records);
  }

  /**
   * Read non-secret settings (for example a GitHub OAuth client id).
   * @returns the parsed settings, or an empty object.
   */
  async function readSettings() {
    try {
      const parsed = JSON.parse(await readFile(settingsFile, 'utf8'));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Merge a patch into the non-secret settings file.
   * @param patch - keys to set; `undefined` deletes a key.
   * @returns the merged settings.
   */
  async function patchSettings(patch) {
    return serialized(async () => {
      const current = await readSettings();
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete current[key];
        else current[key] = value;
      }
      await writePrivateFile(settingsFile, JSON.stringify(current, null, 2));
      return current;
    });
  }

  return { home, vaultFile, put, get, remove, ids, readSettings, patchSettings };
}

/**
 * The public shape of a stored credential: enough to render a row, no secret.
 * @param providerId - vault key.
 * @param record - the decrypted record.
 * @returns a projection safe for the page, the logs and the model.
 */
export function project(providerId, record) {
  const token = typeof record?.token === 'string' ? record.token : '';
  const tail = token.length >= 4 ? token.slice(-4) : '';
  return {
    provider: providerId,
    connected: token !== '',
    hint: token === '' ? '' : `••••${tail}`,
    kind: record?.kind ?? 'token',
    username: record?.username ?? null,
    login: record?.login ?? null,
    name: record?.name ?? null,
    avatarUrl: record?.avatarUrl ?? null,
    scopes: Array.isArray(record?.scopes) ? record.scopes : [],
    note: record?.note ?? null,
    connectedAt: Number(record?.connectedAt) || null,
    updatedAt: Number(record?.updatedAt) || null,
  };
}

/**
 * Whether a path is a regular file, used by the CLI to report vault presence.
 * @param file - absolute path.
 * @returns true when it exists.
 */
export async function exists(file) {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Delete a file if present; used by tests and by `reset` on the CLI.
 * @param file - absolute path.
 */
export async function removeFile(file) {
  await unlink(file).catch(() => {});
}
