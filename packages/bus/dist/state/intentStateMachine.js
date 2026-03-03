"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canTransitionIntent = canTransitionIntent;
exports.canTransitionSolution = canTransitionSolution;
exports.isTerminalIntentStatus = isTerminalIntentStatus;
// Valid transitions for Intent status
const INTENT_TRANSITIONS = {
    CREATED: ['BROADCAST'],
    BROADCAST: ['QUOTING', 'EXPIRED', 'CANCELLED'],
    QUOTING: ['SELECTED', 'EXPIRED', 'CANCELLED'],
    SELECTED: ['VALIDATING', 'BROADCAST', 'CANCELLED'],
    VALIDATING: ['PROPOSING', 'FAILED', 'BROADCAST'],
    PROPOSING: ['EXECUTING', 'FAILED'],
    EXECUTING: ['EXECUTED', 'FAILED'],
    EXECUTED: [],
    FAILED: [],
    EXPIRED: [],
    CANCELLED: [],
};
// Valid transitions for Solution status
const SOLUTION_TRANSITIONS = {
    SUBMITTED: ['RANKED', 'REJECTED', 'EXPIRED'],
    RANKED: ['SELECTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'],
    SELECTED: ['REJECTED'],
    REJECTED: [],
    WITHDRAWN: [],
    EXPIRED: [],
};
function canTransitionIntent(from, to) {
    return INTENT_TRANSITIONS[from]?.includes(to) ?? false;
}
function canTransitionSolution(from, to) {
    return SOLUTION_TRANSITIONS[from]?.includes(to) ?? false;
}
function isTerminalIntentStatus(status) {
    return ['EXECUTED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(status);
}
//# sourceMappingURL=intentStateMachine.js.map