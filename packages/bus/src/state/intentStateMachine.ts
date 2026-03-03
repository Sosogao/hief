import type { IntentStatus, SolutionStatus } from '@hief/common';

// Valid transitions for Intent status
const INTENT_TRANSITIONS: Record<IntentStatus, IntentStatus[]> = {
  CREATED:    ['BROADCAST'],
  BROADCAST:  ['QUOTING', 'EXPIRED', 'CANCELLED'],
  QUOTING:    ['SELECTED', 'EXPIRED', 'CANCELLED'],
  SELECTED:   ['VALIDATING', 'BROADCAST', 'CANCELLED'],
  VALIDATING: ['PROPOSING', 'FAILED', 'BROADCAST'],
  PROPOSING:  ['EXECUTING', 'FAILED'],
  EXECUTING:  ['EXECUTED', 'FAILED'],
  EXECUTED:   [],
  FAILED:     [],
  EXPIRED:    [],
  CANCELLED:  [],
};

// Valid transitions for Solution status
const SOLUTION_TRANSITIONS: Record<SolutionStatus, SolutionStatus[]> = {
  SUBMITTED: ['RANKED', 'REJECTED', 'EXPIRED'],
  RANKED:    ['SELECTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'],
  SELECTED:  ['REJECTED'],
  REJECTED:  [],
  WITHDRAWN: [],
  EXPIRED:   [],
};

export function canTransitionIntent(
  from: IntentStatus,
  to: IntentStatus
): boolean {
  return INTENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionSolution(
  from: SolutionStatus,
  to: SolutionStatus
): boolean {
  return SOLUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalIntentStatus(status: IntentStatus): boolean {
  return ['EXECUTED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(status);
}
