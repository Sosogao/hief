"use strict";
/**
 * @hief/simulation — HIEF L4 Policy Layer
 *
 * Exports:
 *  - SimulationEngine: main orchestrator
 *  - TenderlyClient + buildTenderlyClientFromEnv: API client
 *  - DiffEngine + helpers: execution diff parsing
 *  - All types
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findUnlimitedApprovals = exports.calcNetOutflowUsd = exports.DiffEngine = exports.buildTenderlyClientFromEnv = exports.TenderlyClient = exports.SimulationEngine = void 0;
var simulationEngine_1 = require("./engine/simulationEngine");
Object.defineProperty(exports, "SimulationEngine", { enumerable: true, get: function () { return simulationEngine_1.SimulationEngine; } });
var tenderlyClient_1 = require("./tenderly/tenderlyClient");
Object.defineProperty(exports, "TenderlyClient", { enumerable: true, get: function () { return tenderlyClient_1.TenderlyClient; } });
Object.defineProperty(exports, "buildTenderlyClientFromEnv", { enumerable: true, get: function () { return tenderlyClient_1.buildTenderlyClientFromEnv; } });
var diffEngine_1 = require("./diff/diffEngine");
Object.defineProperty(exports, "DiffEngine", { enumerable: true, get: function () { return diffEngine_1.DiffEngine; } });
Object.defineProperty(exports, "calcNetOutflowUsd", { enumerable: true, get: function () { return diffEngine_1.calcNetOutflowUsd; } });
Object.defineProperty(exports, "findUnlimitedApprovals", { enumerable: true, get: function () { return diffEngine_1.findUnlimitedApprovals; } });
__exportStar(require("./types"), exports);
//# sourceMappingURL=index.js.map