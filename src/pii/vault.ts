import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Db } from 'mongodb';
import { loadEnv } from '../config/env.js';
import { getVaultDb } from '../db/router.js';
import type { CanonicalTenantId } from '../authz/types.js';

const DEK_BYTES = 16;
const TWEAK_BYTES = 7;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function getMasterKey(): Buffer {
  const env = loadEnv();
  return Buffer.from(env.MASTER_KEY, 'hex');
}

function wrapDek(dek: Buffer): string {
  const masterKey = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-128-gcm', masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function unwrapDek(wrapped: string): Buffer {
  const masterKey = getMasterKey();
  const data = Buffer.from(wrapped, 'base64');
  const iv = data.subarray(0, IV_BYTES);
  const authTag = data.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const encrypted = data.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-128-gcm', masterKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function generateDekHex(): string {
  return randomBytes(DEK_BYTES).toString('hex');
}

export function generateTweakHex(): string {
  return randomBytes(TWEAK_BYTES).toString('hex');
}

export async function ensureTenantDek(clientId: CanonicalTenantId, vault?: Db): Promise<string> {
  const db = vault ?? getVaultDb();
  const existing = await db.collection('tenant_deks').findOne({ clientId });
  if (existing) {
    return unwrapDek(String(existing.wrappedDek)).toString('hex');
  }

  const dekHex = generateDekHex();
  await db.collection('tenant_deks').insertOne({
    clientId,
    wrappedDek: wrapDek(Buffer.from(dekHex, 'hex')),
    createdAt: new Date(),
  });
  return dekHex;
}

export async function getTenantDek(clientId: string, vault?: Db): Promise<string> {
  const db = vault ?? getVaultDb();
  const doc = await db.collection('tenant_deks').findOne({ clientId });
  if (!doc) {
    throw new Error(`tenant_dek_not_found:${clientId}`);
  }
  return unwrapDek(String(doc.wrappedDek)).toString('hex');
}

export async function ensureBorrowerTweak(
  clientId: string,
  borrowerId: string,
  vault?: Db,
): Promise<string> {
  const db = vault ?? getVaultDb();
  const existing = await db.collection('borrower_tweaks').findOne({ borrowerId, clientId });
  if (existing) {
    return String(existing.tweak);
  }

  const tweak = generateTweakHex();
  await db.collection('borrower_tweaks').insertOne({
    borrowerId,
    clientId,
    tweak,
    createdAt: new Date(),
  });
  return tweak;
}

export async function getBorrowerTweak(clientId: string, borrowerId: string, vault?: Db): Promise<string> {
  const db = vault ?? getVaultDb();
  const doc = await db.collection('borrower_tweaks').findOne({ borrowerId, clientId });
  if (!doc) {
    throw new Error(`borrower_tweak_not_found:${borrowerId}`);
  }
  return String(doc.tweak);
}

export async function destroyBorrowerTweak(clientId: string, borrowerId: string, vault?: Db): Promise<void> {
  const db = vault ?? getVaultDb();
  await db.collection('borrower_tweaks').deleteOne({ borrowerId, clientId });
}
