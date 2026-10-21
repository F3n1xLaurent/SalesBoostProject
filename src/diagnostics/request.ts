import type { DiagnosticCaseKind } from './caseBundle';

export type DiagnosticCaseRequest = {
  kind: DiagnosticCaseKind;
  id: string;
  includeAudio: boolean;
  turnNumber?: number;
};

export function validateDiagnosticCaseRequest(args: DiagnosticCaseRequest): void {
  if ((args.kind !== 'trainer' && args.kind !== 'call') || !/^[A-Za-z0-9_-]{1,128}$/.test(args.id)) {
    throw new Error('Invalid diagnostic kind or ID');
  }
  if (args.turnNumber !== undefined && (!Number.isSafeInteger(args.turnNumber) || args.turnNumber < 1 || args.turnNumber > 10_000 || args.kind !== 'trainer' || !args.includeAudio)) {
    throw new Error('Turn number requires trainer audio and must be between 1 and 10000');
  }
}
