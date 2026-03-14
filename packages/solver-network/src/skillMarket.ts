/**
 * Skill Market — registry for DeFi skills loaded from upstream SKILL.md manifests.
 *
 * Each skill (protocol adapter) publishes a SKILL.md describing how to integrate it.
 * HIEF loads these manifests and registers the adapter in the DefiSkillRegistry.
 *
 * Usage:
 *   skillMarket.register(manifest, adapter)
 *   skillMarket.list()    → all loaded skill manifests
 *   skillMarket.get(id)   → single manifest by id
 */

import { defiRegistry, type DefiProtocolAdapter } from './defiSkills';

// ─── SkillManifest ────────────────────────────────────────────────────────────

/** What every skill exposes to HIEF (parsed from SKILL.md front matter) */
export interface SkillManifest {
  /** Unique stable ID matching DefiProtocolAdapter.id, e.g. 'fx-protocol' */
  id: string;
  /** Human-readable protocol name, e.g. 'f(x) Protocol' */
  name: string;
  /** Semver version of this skill manifest */
  version: string;
  /** Short description of what the skill provides */
  description: string;
  /** Upstream SKILL.md repository URL */
  skillSourceUrl: string;
  /** Skill types supported: ['DEPOSIT', 'WITHDRAW'] */
  supportedSkills: string[];
  /** Supported token addresses (Ethereum mainnet checksummed) */
  supportedTokens: string[];
  /** Chain IDs this skill supports */
  chainIds: number[];
  /** NPM package name if the skill uses an SDK, e.g. '@aladdindao/fx-sdk' */
  sdk?: string;
  /** Author / maintainer */
  author?: string;
}

// ─── SkillMarket ──────────────────────────────────────────────────────────────

/**
 * Singleton registry of all loaded DeFi skills.
 *
 * Calling register() both stores the SkillManifest metadata AND delegates
 * adapter registration to the underlying DefiSkillRegistry (defiRegistry).
 */
export class SkillMarket {
  private manifests = new Map<string, SkillManifest>();

  /**
   * Register a skill with its manifest and adapter.
   * The adapter is forwarded to defiRegistry so server.ts picks it up automatically.
   */
  register(manifest: SkillManifest, adapter: DefiProtocolAdapter): this {
    this.manifests.set(manifest.id, manifest);
    defiRegistry.register(adapter);
    console.log(
      `[SkillMarket] + ${manifest.name} v${manifest.version}` +
      ` (${manifest.supportedSkills.join(', ')}) from ${manifest.skillSourceUrl}`,
    );
    return this;
  }

  /** Return all registered skill manifests */
  list(): SkillManifest[] {
    return [...this.manifests.values()];
  }

  /** Look up a manifest by id; returns undefined if not found */
  get(id: string): SkillManifest | undefined {
    return this.manifests.get(id);
  }
}

/** Singleton instance — import this everywhere */
export const skillMarket = new SkillMarket();
