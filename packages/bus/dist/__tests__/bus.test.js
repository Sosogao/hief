"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const ethers_1 = require("ethers");
const server_1 = require("../server");
const database_1 = require("../db/database");
const wallet = new ethers_1.ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
// Use temp dir for tests
process.env.DB_DIR = '/tmp/hief-test-' + Date.now();
function makeIntent(overrides = {}) {
    return {
        intentVersion: '0.1',
        intentId: ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32)),
        smartAccount: wallet.address,
        chainId: 8453,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        input: {
            token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '1000000000',
        },
        outputs: [
            {
                token: '0x4200000000000000000000000000000000000006',
                minAmount: '250000000000000000',
            },
        ],
        constraints: { slippageBps: 50 },
        priorityFee: { token: 'HIEF', amount: '0' },
        policyRef: { policyVersion: 'v0.1' },
        signature: { type: 'EIP712_EOA', signer: wallet.address, sig: '0x1234' },
        ...overrides,
    };
}
function makeSolution(intentId, intentHash) {
    return {
        solutionVersion: '0.1',
        solutionId: ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32)),
        intentId,
        intentHash,
        solverId: wallet.address,
        executionPlan: {
            calls: [
                {
                    to: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
                    value: '0',
                    data: '0xabcdef1234',
                    operation: 'CALL',
                },
            ],
        },
        quote: {
            expectedOut: '260000000000000000',
            fee: '1000000',
            validUntil: Math.floor(Date.now() / 1000) + 300,
        },
        stakeSnapshot: { amount: '0' },
        signature: { type: 'EIP712_EOA', signer: wallet.address, sig: '0x5678' },
    };
}
beforeAll(async () => {
    await (0, database_1.initDb)();
});
afterAll(async () => {
    (0, database_1.closeDb)();
    const srv = (0, server_1.getServer)();
    if (srv)
        srv.close();
});
describe('GET /health', () => {
    it('should return 200 OK', async () => {
        const res = await (0, supertest_1.default)(server_1.app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });
});
describe('POST /v1/intents', () => {
    it('should accept a valid intent and return intentHash', async () => {
        const intent = makeIntent();
        const res = await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('BROADCAST');
        expect(res.body.intentHash).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(res.body.intentId).toBeTruthy();
    });
    it('should reject an intent with expired deadline', async () => {
        const intent = makeIntent({ deadline: Math.floor(Date.now() / 1000) - 1 });
        const res = await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        expect(res.status).toBe(400);
        expect(res.body.errorCode).toBe('INTENT_DEADLINE_TOO_SOON');
    });
    it('should reject duplicate intents', async () => {
        const intent = makeIntent();
        await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        const res2 = await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        expect(res2.status).toBe(409);
        expect(res2.body.errorCode).toBe('INTENT_ALREADY_EXISTS');
    });
});
describe('GET /v1/intents/:intentId', () => {
    it('should return intent details', async () => {
        const intent = makeIntent();
        const postRes = await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        const { intentId } = postRes.body;
        const res = await (0, supertest_1.default)(server_1.app).get(`/v1/intents/${intentId}`);
        expect(res.status).toBe(200);
        expect(res.body._status).toBe('BROADCAST');
    });
    it('should return 404 for unknown intent', async () => {
        const res = await (0, supertest_1.default)(server_1.app).get('/v1/intents/nonexistent-id');
        expect(res.status).toBe(404);
    });
});
describe('POST /v1/solutions', () => {
    it('should accept a valid solution', async () => {
        const intent = makeIntent();
        const postRes = await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        const { intentId, intentHash } = postRes.body;
        const solution = makeSolution(intentId, intentHash);
        const res = await (0, supertest_1.default)(server_1.app).post('/v1/solutions').send(solution);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SUBMITTED');
    });
    it('should reject solution with wrong intentHash', async () => {
        const intent = makeIntent();
        const postRes = await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        const { intentId } = postRes.body;
        const solution = makeSolution(intentId, ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32)));
        const res = await (0, supertest_1.default)(server_1.app).post('/v1/solutions').send(solution);
        expect(res.status).toBe(400);
        expect(res.body.errorCode).toBe('INTENT_HASH_MISMATCH');
    });
});
describe('POST /v1/intents/:intentId/cancel', () => {
    it('should cancel a broadcast intent', async () => {
        const intent = makeIntent();
        const postRes = await (0, supertest_1.default)(server_1.app).post('/v1/intents').send(intent);
        const { intentId } = postRes.body;
        const res = await (0, supertest_1.default)(server_1.app).post(`/v1/intents/${intentId}/cancel`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('CANCELLED');
    });
});
//# sourceMappingURL=bus.test.js.map