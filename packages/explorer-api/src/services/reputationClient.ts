/**
 * ReputationClient — HTTP client for the Reputation API service.
 */

import axios from 'axios';

const REP_URL = process.env.REPUTATION_API_URL || 'http://localhost:3005';

export interface ReputationSnapshot {
  address: string;
  chainId: number;
  snapshotId: string;
  scores: {
    successScore: number;
    volumeScore: number;
    alphaScore: number;
    diversityScore: number;
    composite: number;
    decayFactor: number;
    final: number;
  };
  metrics: {
    totalIntents: number;
    successRate: number;
    totalVolumeUSD: number;
    avgAlphaScore: number;
    uniqueSkillsUsed: number;
    activeWeeks: number;
  };
  behaviorTags: string[];
  riskTier: string;
  computedAt: number;
  validUntil: number;
}

export interface LeaderboardEntry {
  address: string;
  finalScore: number;
  riskTier: string;
  successRate: number | null;
  totalIntents: number;
}

export async function getReputation(address: string, chainId: number): Promise<ReputationSnapshot | null> {
  try {
    const res = await axios.get(`${REP_URL}/v1/reputation/${chainId}/${address}`, { timeout: 5000 });
    if (res.data?.success) return res.data.data;
    return null;
  } catch {
    return null;
  }
}

export async function getReputationHistory(address: string, chainId: number, limit = 20): Promise<any[]> {
  try {
    const res = await axios.get(`${REP_URL}/v1/reputation/${chainId}/${address}/history?limit=${limit}`, { timeout: 5000 });
    if (res.data?.success) return res.data.data;
    return [];
  } catch {
    return [];
  }
}

export async function getLeaderboard(chainId: number, limit = 20): Promise<LeaderboardEntry[]> {
  try {
    const res = await axios.get(`${REP_URL}/v1/reputation/${chainId}/leaderboard?limit=${limit}`, { timeout: 5000 });
    if (res.data?.success) return res.data.data;
    return [];
  } catch {
    return [];
  }
}

export async function checkReputationHealth(): Promise<boolean> {
  try {
    const res = await axios.get(`${REP_URL}/v1/reputation/health`, { timeout: 3000 });
    return res.data?.status === 'ok';
  } catch {
    return false;
  }
}
