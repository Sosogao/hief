"use strict";
/**
 * ReputationClient — HTTP client for the Reputation API service.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReputation = getReputation;
exports.getReputationHistory = getReputationHistory;
exports.getLeaderboard = getLeaderboard;
exports.checkReputationHealth = checkReputationHealth;
const axios_1 = __importDefault(require("axios"));
const REP_URL = process.env.REPUTATION_API_URL || 'http://localhost:3005';
async function getReputation(address, chainId) {
    try {
        const res = await axios_1.default.get(`${REP_URL}/v1/reputation/${chainId}/${address}`, { timeout: 5000 });
        if (res.data?.success)
            return res.data.data;
        return null;
    }
    catch {
        return null;
    }
}
async function getReputationHistory(address, chainId, limit = 20) {
    try {
        const res = await axios_1.default.get(`${REP_URL}/v1/reputation/${chainId}/${address}/history?limit=${limit}`, { timeout: 5000 });
        if (res.data?.success)
            return res.data.data;
        return [];
    }
    catch {
        return [];
    }
}
async function getLeaderboard(chainId, limit = 20) {
    try {
        const res = await axios_1.default.get(`${REP_URL}/v1/reputation/${chainId}/leaderboard?limit=${limit}`, { timeout: 5000 });
        if (res.data?.success)
            return res.data.data;
        return [];
    }
    catch {
        return [];
    }
}
async function checkReputationHealth() {
    try {
        const res = await axios_1.default.get(`${REP_URL}/v1/reputation/health`, { timeout: 3000 });
        return res.data?.status === 'ok';
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=reputationClient.js.map