import type { IntentStatus, SolutionStatus } from '@hief/common';
export declare function canTransitionIntent(from: IntentStatus, to: IntentStatus): boolean;
export declare function canTransitionSolution(from: SolutionStatus, to: SolutionStatus): boolean;
export declare function isTerminalIntentStatus(status: IntentStatus): boolean;
//# sourceMappingURL=intentStateMachine.d.ts.map