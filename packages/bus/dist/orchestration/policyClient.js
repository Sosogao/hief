"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.callPolicyEngine = callPolicyEngine;
exports.callPolicyEngineForIntent = callPolicyEngineForIntent;
const axios_1 = __importDefault(require("axios"));
const POLICY_ENGINE_URL = process.env.POLICY_ENGINE_URL || 'http://localhost:3002';
/**
 * Call the Policy Engine to validate a Solution against an Intent.
 * This is the critical security checkpoint before creating a Safe proposal.
 */
async function callPolicyEngine(intent, solution) {
    const response = await axios_1.default.post(`${POLICY_ENGINE_URL}/v1/policy/validateSolution`, { intent, solution }, { timeout: 30000 } // 30s timeout for fork simulation
    );
    return response.data;
}
/**
 * Call the Policy Engine to pre-validate an Intent (lightweight check).
 */
async function callPolicyEngineForIntent(intent) {
    const response = await axios_1.default.post(`${POLICY_ENGINE_URL}/v1/policy/validateIntent`, { intent }, { timeout: 10000 });
    return response.data;
}
//# sourceMappingURL=policyClient.js.map