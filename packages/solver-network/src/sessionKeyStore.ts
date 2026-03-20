/**
 * Session Key Store — HIEF-SK-01
 *
 * Manages HIEFSessionGrant lifecycle:
 *   - Generates a fresh hot key per grant (held server-side)
 *   - Stores grants in memory (+ optional JSON file for persistence)
 *   - Tracks cumulative spend per grant
 *   - Provides lookup by grantId, by userAccount, and validity check
 *
 * Phase 1: in-memory + file persistence (no on-chain module yet).
 * Phase 2: EIP-7702 / Safe Module on-chain registration (v0.3).
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { HIEFSessionGrant, SessionKeyConstraints } from '@hief/common';

// ─── Persistence ──────────────────────────────────────────────────────────────

const STORE_PATH = process.env.SESSION_KEY_STORE_PATH
  || path.join(process.cwd(), 'data', 'session-grants.json');

// Stored grant includes the encrypted session private key
interface StoredGrant extends HIEFSessionGrant {
  _encryptedPrivKey: string; // AES-256-GCM encrypted hex private key
}

// ─── Encryption helpers ───────────────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    // Dev fallback — deterministic but not secure; log a warning
    console.warn('[SESSION-STORE] SESSION_KEY_ENCRYPTION_SECRET not set — using insecure dev key');
    return crypto.createHash('sha256').update('hief-dev-key').digest();
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const key = getEncryptionKey();
  const iv  = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}

// ─── Store ────────────────────────────────────────────────────────────────────

class SessionKeyStore {
  private grants = new Map<string, StoredGrant>(); // grantId → StoredGrant

  constructor() {
    this._load();
  }

  // ── Create a new session grant ────────────────────────────────────────────

  create(params: {
    userAccount: string;
    accountType: HIEFSessionGrant['accountType'];
    chainId: number;
    constraints: SessionKeyConstraints;
    userSignature: string;
    ttlSeconds?: number; // default 7 days
  }): HIEFSessionGrant {
    const wallet = ethers.Wallet.createRandom();
    const grantId = ethers.hexlify(ethers.randomBytes(32));
    const now = Math.floor(Date.now() / 1000);
    const ttl = params.ttlSeconds ?? 7 * 24 * 3600;

    const grant: StoredGrant = {
      grantId,
      sessionKeyAddress: wallet.address,
      userAccount: params.userAccount,
      accountType: params.accountType,
      chainId: params.chainId,
      grantedAt: now,
      expiresAt: now + ttl,
      constraints: params.constraints,
      spentUSD: 0,
      userSignature: params.userSignature,
      _encryptedPrivKey: encrypt(wallet.privateKey),
    };

    this.grants.set(grantId, grant);
    this._save();
    console.log(`[SESSION-STORE] Created grant ${grantId.slice(0, 16)}... for ${params.userAccount} (expires in ${ttl / 3600}h)`);
    return this._toPublic(grant);
  }

  // ── Revoke ────────────────────────────────────────────────────────────────

  revoke(grantId: string, userAccount: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    if (grant.userAccount.toLowerCase() !== userAccount.toLowerCase()) return false;
    grant.revokedAt = Math.floor(Date.now() / 1000);
    this._save();
    console.log(`[SESSION-STORE] Revoked grant ${grantId.slice(0, 16)}...`);
    return true;
  }

  // ── Record spend ──────────────────────────────────────────────────────────

  recordSpend(grantId: string, usdAmount: number): void {
    const grant = this.grants.get(grantId);
    if (grant) {
      grant.spentUSD += usdAmount;
      this._save();
    }
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  getById(grantId: string): HIEFSessionGrant | undefined {
    const g = this.grants.get(grantId);
    return g ? this._toPublic(g) : undefined;
  }

  getActiveByAccount(userAccount: string, chainId: number): HIEFSessionGrant[] {
    const now = Math.floor(Date.now() / 1000);
    return Array.from(this.grants.values())
      .filter((g) =>
        g.userAccount.toLowerCase() === userAccount.toLowerCase() &&
        g.chainId === chainId &&
        !g.revokedAt &&
        g.expiresAt > now
      )
      .map((g) => this._toPublic(g));
  }

  /** Get the decrypted signing wallet for a grant (server-side only). */
  getSignerWallet(grantId: string): ethers.Wallet | undefined {
    const grant = this.grants.get(grantId);
    if (!grant || grant.revokedAt) return undefined;
    const now = Math.floor(Date.now() / 1000);
    if (grant.expiresAt <= now) return undefined;
    try {
      const privKey = decrypt(grant._encryptedPrivKey);
      return new ethers.Wallet(privKey);
    } catch {
      return undefined;
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private _load(): void {
    try {
      if (!fs.existsSync(STORE_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoredGrant[];
      for (const g of raw) this.grants.set(g.grantId, g);
      console.log(`[SESSION-STORE] Loaded ${this.grants.size} grant(s) from ${STORE_PATH}`);
    } catch (e: any) {
      console.warn(`[SESSION-STORE] Could not load grants: ${e.message}`);
    }
  }

  private _save(): void {
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      fs.writeFileSync(STORE_PATH, JSON.stringify(Array.from(this.grants.values()), null, 2));
    } catch (e: any) {
      console.warn(`[SESSION-STORE] Could not persist grants: ${e.message}`);
    }
  }

  private _toPublic(g: StoredGrant): HIEFSessionGrant {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _encryptedPrivKey, ...pub } = g;
    return pub;
  }
}

export const sessionKeyStore = new SessionKeyStore();
