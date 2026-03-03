"use strict";
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateIntent = validateIntent;
exports.validateSolution = validateSolution;
exports.validatePolicyResult = validatePolicyResult;
const _2020_1 = __importDefault(require("ajv/dist/2020"));
const ajv_formats_1 = __importDefault(require("ajv-formats"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const ajv = new _2020_1.default({ allErrors: true, strict: false });
(0, ajv_formats_1.default)(ajv);
function loadSchema(name) {
    const schemaPath = path.resolve(__dirname, '../../../../schemas', `${name}.schema.json`);
    const raw = fs.readFileSync(schemaPath, 'utf-8');
    return JSON.parse(raw);
}
let intentValidator = null;
let solutionValidator = null;
let policyResultValidator = null;
function validateIntent(data) {
    if (!intentValidator) {
        intentValidator = ajv.compile(loadSchema('intent'));
    }
    const valid = intentValidator(data);
    return {
        valid,
        errors: intentValidator.errors?.map((e) => `${e.instancePath} ${e.message}`) ?? [],
    };
}
function validateSolution(data) {
    if (!solutionValidator) {
        solutionValidator = ajv.compile(loadSchema('solution'));
    }
    const valid = solutionValidator(data);
    return {
        valid,
        errors: solutionValidator.errors?.map((e) => `${e.instancePath} ${e.message}`) ?? [],
    };
}
function validatePolicyResult(data) {
    if (!policyResultValidator) {
        policyResultValidator = ajv.compile(loadSchema('policy-result'));
    }
    const valid = policyResultValidator(data);
    return {
        valid,
        errors: policyResultValidator.errors?.map((e) => `${e.instancePath} ${e.message}`) ?? [],
    };
}
//# sourceMappingURL=validate.js.map