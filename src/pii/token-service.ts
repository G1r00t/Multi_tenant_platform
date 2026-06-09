import type { CanonicalTenantId } from '../authz/types.js';
import {
  buildScrubTargets,
  NUMERIC_PII_FIELDS,
  PAN_PLAIN_FIELD,
  PAN_TOKEN_FIELD,
  PLAIN_FIELD_NAMES,
  TOKEN_FIELD_NAMES,
  type BorrowerPlaintextPii,
  type BorrowerTokens,
  type NumericPiiField,
  normalizeNumericPii,
  normalizePan,
  validateNumericPii,
  validatePan,
} from './fields.js';
import { decryptNumericPii, decryptPan, encryptNumericPii, encryptPan } from './ff3.js';
import {
  ensureBorrowerTweak,
  ensureTenantDek,
  getBorrowerTweak,
  getTenantDek,
} from './vault.js';

export interface TokenizedBorrowerResult {
  record: Record<string, unknown>;
  plaintextPii: BorrowerPlaintextPii;
  tokens: BorrowerTokens;
}

export class TokenService {
  private dekCache = new Map<string, string>();
  private tweakCache = new Map<string, string>();

  private tweakCacheKey(clientId: string, borrowerId: string): string {
    return `${clientId}:${borrowerId}`;
  }

  async getDek(clientId: CanonicalTenantId): Promise<string> {
    const cached = this.dekCache.get(clientId);
    if (cached) return cached;
    const dek = await getTenantDek(clientId);
    this.dekCache.set(clientId, dek);
    return dek;
  }

  async getTweak(clientId: string, borrowerId: string): Promise<string> {
    const key = this.tweakCacheKey(clientId, borrowerId);
    const cached = this.tweakCache.get(key);
    if (cached) return cached;
    const tweak = await getBorrowerTweak(clientId, borrowerId);
    this.tweakCache.set(key, tweak);
    return tweak;
  }

  async ensureTenantKeys(clientId: CanonicalTenantId): Promise<string> {
    const cached = this.dekCache.get(clientId);
    if (cached) return cached;
    const dek = await ensureTenantDek(clientId);
    this.dekCache.set(clientId, dek);
    return dek;
  }

  async ensureBorrowerKeys(clientId: string, borrowerId: string): Promise<string> {
    const key = this.tweakCacheKey(clientId, borrowerId);
    const cached = this.tweakCache.get(key);
    if (cached) return cached;
    const tweak = await ensureBorrowerTweak(clientId, borrowerId);
    this.tweakCache.set(key, tweak);
    return tweak;
  }

  async tokenizeField(
    clientId: CanonicalTenantId,
    borrowerId: string,
    field: NumericPiiField,
    plaintext: string,
  ): Promise<string> {
    const dek = await this.getDek(clientId);
    const tweak = await this.ensureBorrowerKeys(clientId, borrowerId);
    return encryptNumericPii(dek, tweak, field, plaintext);
  }

  async detokenizeField(
    clientId: string,
    borrowerId: string,
    field: NumericPiiField,
    token: string,
  ): Promise<string> {
    const dek = await this.getDek(clientId as CanonicalTenantId);
    const tweak = await this.getTweak(clientId, borrowerId);
    return decryptNumericPii(dek, tweak, field, token);
  }

  async tokenizePan(clientId: CanonicalTenantId, borrowerId: string, plaintext: string): Promise<string> {
    const dek = await this.getDek(clientId);
    const tweak = await this.ensureBorrowerKeys(clientId, borrowerId);
    return encryptPan(dek, tweak, plaintext);
  }

  async detokenizePan(clientId: string, borrowerId: string, token: string): Promise<string> {
    const dek = await this.getDek(clientId as CanonicalTenantId);
    const tweak = await this.getTweak(clientId, borrowerId);
    return decryptPan(dek, tweak, token);
  }

  async tokenizeBorrowerRecord(
    clientId: CanonicalTenantId,
    borrower: Record<string, unknown>,
  ): Promise<TokenizedBorrowerResult> {
    const borrowerId = String(borrower.borrowerId);
    await this.ensureTenantKeys(clientId);
    await this.ensureBorrowerKeys(clientId, borrowerId);

    const record = { ...borrower };
    const plaintextPii: BorrowerPlaintextPii = {};
    const tokens: BorrowerTokens = {};

    for (const field of NUMERIC_PII_FIELDS) {
      const plainKey = PLAIN_FIELD_NAMES[field];
      const tokenKey = TOKEN_FIELD_NAMES[field];
      const raw = record[plainKey];
      if (raw == null || raw === '') {
        delete record[plainKey];
        continue;
      }

      const plaintext = String(raw);
      if (!validateNumericPii(plaintext, field)) {
        delete record[plainKey];
        continue;
      }

      const token = await this.tokenizeField(clientId, borrowerId, field, plaintext);
      plaintextPii[field] = normalizeNumericPii(plaintext, field);
      tokens[tokenKey as keyof BorrowerTokens] = token;
      record[tokenKey] = token;
      delete record[plainKey];
    }

    const rawPan = record[PAN_PLAIN_FIELD];
    if (rawPan != null && rawPan !== '') {
      const pan = String(rawPan);
      if (validatePan(pan)) {
        const panToken = await this.tokenizePan(clientId, borrowerId, pan);
        plaintextPii.pan = normalizePan(pan);
        tokens[PAN_TOKEN_FIELD] = panToken;
        record[PAN_TOKEN_FIELD] = panToken;
      }
      delete record[PAN_PLAIN_FIELD];
    }

    return { record, plaintextPii, tokens };
  }

  scrubConversationText(
    text: string,
    plaintextPii: BorrowerPlaintextPii,
    tokens: BorrowerTokens,
  ): string {
    let result = text;
    const targets = buildScrubTargets(plaintextPii, tokens);
    for (const { search, replace } of targets) {
      if (!search) continue;
      result = result.split(search).join(replace);
    }
    return result;
  }

  maskConversationText(text: string, tokens: BorrowerTokens): string {
    let result = text;
    for (const tokenKey of Object.values(TOKEN_FIELD_NAMES)) {
      const token = tokens[tokenKey as keyof BorrowerTokens];
      if (!token || !result.includes(token)) continue;
      result = result.split(token).join(this.maskToken(token));
    }
    return result;
  }

  async detokenizeConversationText(
    clientId: CanonicalTenantId,
    borrowerId: string,
    text: string,
    tokens: BorrowerTokens,
  ): Promise<string> {
    let result = text;
    for (const field of NUMERIC_PII_FIELDS) {
      const tokenKey = TOKEN_FIELD_NAMES[field];
      const token = tokens[tokenKey as keyof BorrowerTokens];
      if (!token || !result.includes(token)) continue;
      const plain = await this.detokenizeField(clientId, borrowerId, field, token);
      result = result.split(token).join(plain);
    }
    return result;
  }

  async shapeConversationText(
    clientId: CanonicalTenantId,
    borrowerId: string,
    role: import('../authz/types.js').Role,
    text: string,
    tokens: BorrowerTokens,
  ): Promise<string> {
    switch (role) {
      case 'admin':
      case 'debt-counselor':
        return this.detokenizeConversationText(clientId, borrowerId, text, tokens);
      case 'engineer':
        return this.maskConversationText(text, tokens);
      default:
        return text;
    }
  }

  maskToken(token: string): string {
    if (token.length <= 4) return 'X'.repeat(token.length);
    return 'X'.repeat(token.length - 4) + token.slice(-4);
  }
}

let defaultService: TokenService | null = null;

export function getTokenService(): TokenService {
  if (!defaultService) {
    defaultService = new TokenService();
  }
  return defaultService;
}

export function resetTokenService(): void {
  defaultService = null;
}
