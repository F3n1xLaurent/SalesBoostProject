import { describe, it, expect } from 'vitest';
import {
  computeDeterministicScore,
  buildChecklistFromLLMClassification,
  detectIssuesFromChecklist,
  enforceManagerChecklistEvidence,
  CHECKLIST_WEIGHTS,
  type ChecklistItem,
  type ChecklistStatus,
  type ScoringOptions,
} from '../logic/diagnosticScoring';

function makeChecklist(overrides: Partial<Record<string, ChecklistStatus>> = {}): ChecklistItem[] {
  return buildChecklistFromLLMClassification(
    Object.entries(CHECKLIST_WEIGHTS).map(([code]) => ({
      code,
      status: (overrides[code] ?? 'YES') as ChecklistStatus,
      evidence: [],
      comment: '',
    }))
  );
}

const defaultOptions: ScoringOptions = {
  earlyFail: false,
  misinformationDetected: false,
  noNextStep: false,
  passiveStyle: false,
  passiveSeverity: 'mild',
};

describe('diagnosticScoring', () => {
  describe('computeDeterministicScore', () => {
    it('returns 100 for all YES', () => {
      const checklist = makeChecklist();
      const { score } = computeDeterministicScore(checklist, defaultOptions);
      expect(score).toBe(100);
    });

    it('returns 0 for all NO', () => {
      const checklist = makeChecklist(
        Object.fromEntries(
          Object.keys(CHECKLIST_WEIGHTS).map((k) => [k, 'NO' as const])
        )
      );
      const { score } = computeDeterministicScore(checklist, defaultOptions);
      expect(score).toBe(0);
    });

    it('returns ~50 for all PARTIAL', () => {
      const checklist = makeChecklist(
        Object.fromEntries(
          Object.keys(CHECKLIST_WEIGHTS).map((k) => [k, 'PARTIAL' as const])
        )
      );
      const { score } = computeDeterministicScore(checklist, defaultOptions);
      expect(score).toBe(50);
    });

    it('handles NA items by excluding them', () => {
      const checklist = makeChecklist({
        CREDIT_EXPLANATION: 'NA',
        TRADEIN_OFFER: 'NA',
        OBJECTION_HANDLING: 'NA',
      });
      const { score } = computeDeterministicScore(checklist, defaultOptions);
      expect(score).toBe(100);
    });

    it('caps score at 40 for earlyFail', () => {
      const checklist = makeChecklist();
      const { score } = computeDeterministicScore(checklist, {
        ...defaultOptions,
        earlyFail: true,
      });
      expect(score).toBe(40);
    });

    it('deducts 15 for misinformation', () => {
      const checklist = makeChecklist();
      const { score } = computeDeterministicScore(checklist, {
        ...defaultOptions,
        misinformationDetected: true,
      });
      expect(score).toBe(85);
    });

    it('deducts 10 for noNextStep', () => {
      const checklist = makeChecklist();
      const { score } = computeDeterministicScore(checklist, {
        ...defaultOptions,
        noNextStep: true,
      });
      expect(score).toBe(90);
    });

    it('deducts 5 for mild passive style', () => {
      const checklist = makeChecklist();
      const { score } = computeDeterministicScore(checklist, {
        ...defaultOptions,
        passiveStyle: true,
        passiveSeverity: 'mild',
      });
      expect(score).toBe(95);
    });

    it('deducts 10 for strong passive style', () => {
      const checklist = makeChecklist();
      const { score } = computeDeterministicScore(checklist, {
        ...defaultOptions,
        passiveStyle: true,
        passiveSeverity: 'strong',
      });
      expect(score).toBe(90);
    });

    it('compounds penalties correctly', () => {
      const checklist = makeChecklist({ INTRODUCTION: 'NO' });
      const { score } = computeDeterministicScore(checklist, {
        ...defaultOptions,
        misinformationDetected: true,
        noNextStep: true,
      });
      // base: (100-8)/100*100 = 92, minus 15 = 77, minus 10 = 67
      expect(score).toBe(67);
    });

    it('never goes below 0', () => {
      const checklist = makeChecklist(
        Object.fromEntries(
          Object.keys(CHECKLIST_WEIGHTS).map((k) => [k, 'NO' as const])
        )
      );
      const { score } = computeDeterministicScore(checklist, {
        earlyFail: true,
        misinformationDetected: true,
        noNextStep: true,
        passiveStyle: true,
        passiveSeverity: 'strong',
      });
      expect(score).toBe(0);
    });
  });

  describe('dimension scores', () => {
    it('computes per-dimension scores', () => {
      const checklist = makeChecklist({
        INTRODUCTION: 'YES',
        SALON_NAME: 'NO',
        CAR_IDENTIFICATION: 'YES',
        INITIATIVE: 'PARTIAL',
        COMMUNICATION_TONE: 'YES',
      });
      const { dimensions } = computeDeterministicScore(checklist, defaultOptions);
      expect(dimensions.first_contact).toBeGreaterThan(0);
      expect(dimensions.first_contact).toBeLessThan(100);
      expect(dimensions.communication).toBe(100);
    });
  });

  describe('buildChecklistFromLLMClassification', () => {
    it('returns all 13 items', () => {
      const checklist = buildChecklistFromLLMClassification([]);
      expect(checklist).toHaveLength(13);
    });

    it('defaults to NA for missing codes', () => {
      const checklist = buildChecklistFromLLMClassification([]);
      expect(checklist[0].status).toBe('NA');
    });

    it('maps valid statuses', () => {
      const checklist = buildChecklistFromLLMClassification([
        { code: 'INTRODUCTION', status: 'YES', evidence: ['Менеджер: Здравствуйте, меня зовут...'], comment: 'OK' },
      ]);
      const intro = checklist.find((c) => c.code === 'INTRODUCTION');
      expect(intro?.status).toBe('YES');
      expect(intro?.evidence).toHaveLength(1);
    });

    it('normalizes code, status and string evidence returned in a non-canonical form', () => {
      const checklist = buildChecklistFromLLMClassification([
        {
          code: ' introduction ',
          status: ' yes ',
          evidence: 'Здравствуйте, меня зовут Иван',
          comment: '  Менеджер представился  ',
        },
      ]);
      const intro = checklist.find((item) => item.code === 'INTRODUCTION');
      expect(intro).toMatchObject({
        status: 'YES',
        evidence: ['Здравствуйте, меня зовут Иван'],
        comment: 'Менеджер представился',
      });
    });

    it('normalizes invalid status to NO', () => {
      const checklist = buildChecklistFromLLMClassification([
        { code: 'SALON_NAME', status: 'MAYBE' as any, evidence: [], comment: '' },
      ]);
      const salon = checklist.find((c) => c.code === 'SALON_NAME');
      expect(salon?.status).toBe('NO');
    });

    it('rejects a positive status supported only by a client quote', () => {
      const checklist = buildChecklistFromLLMClassification([
        {
          code: 'CAR_IDENTIFICATION',
          status: 'YES',
          evidence: ['Клиент: Я звоню насчёт Toyota Corolla Cross'],
          comment: 'Менеджер уточнил автомобиль.',
        },
      ]);

      const validated = enforceManagerChecklistEvidence(checklist, [
        { role: 'manager', content: 'Алло!' },
        { role: 'client', content: 'Я звоню насчёт Toyota Corolla Cross' },
      ]);

      expect(validated.find((item) => item.code === 'CAR_IDENTIFICATION')).toMatchObject({
        status: 'NO',
        evidence: [],
        comment: 'В стенограмме нет подтверждающей реплики менеджера.',
      });
    });

    it('keeps a positive status backed by a real manager quote', () => {
      const checklist = buildChecklistFromLLMClassification([
        {
          code: 'CAR_IDENTIFICATION',
          status: 'YES',
          evidence: ['Менеджер: Какая модель вас интересует?'],
          comment: 'Менеджер уточнил автомобиль.',
        },
      ]);

      const validated = enforceManagerChecklistEvidence(checklist, [
        { role: 'manager', content: 'Какая модель вас интересует?' },
      ]);

      expect(validated.find((item) => item.code === 'CAR_IDENTIFICATION')?.status).toBe('YES');
    });
  });

  describe('detectIssuesFromChecklist', () => {
    it('detects NO_INTRO', () => {
      const checklist = makeChecklist({ INTRODUCTION: 'NO' });
      const issues = detectIssuesFromChecklist(checklist, {
        profanity: false,
        misinformation: false,
        passiveStyle: false,
        lowEngagement: false,
        redirectToWebsite: false,
        badTone: false,
      });
      expect(issues.some((i) => i.issue_type === 'NO_INTRO')).toBe(true);
    });

    it('detects profanity signal', () => {
      const checklist = makeChecklist();
      const issues = detectIssuesFromChecklist(checklist, {
        profanity: true,
        misinformation: false,
        passiveStyle: false,
        lowEngagement: false,
        redirectToWebsite: false,
        badTone: false,
      });
      expect(issues.some((i) => i.issue_type === 'PROFANITY')).toBe(true);
      expect(issues.find((i) => i.issue_type === 'PROFANITY')?.severity).toBe('HIGH');
    });

    it('detects multiple issues', () => {
      const checklist = makeChecklist({
        INTRODUCTION: 'NO',
        NEXT_STEP_PROPOSAL: 'NO',
        NEEDS_DISCOVERY: 'NO',
      });
      const issues = detectIssuesFromChecklist(checklist, {
        profanity: false,
        misinformation: true,
        passiveStyle: true,
        lowEngagement: false,
        redirectToWebsite: false,
        badTone: false,
      });
      expect(issues.length).toBeGreaterThanOrEqual(4);
      expect(issues.some((i) => i.issue_type === 'NO_INTRO')).toBe(true);
      expect(issues.some((i) => i.issue_type === 'NO_NEXT_STEP')).toBe(true);
      expect(issues.some((i) => i.issue_type === 'NO_NEEDS_DISCOVERY')).toBe(true);
      expect(issues.some((i) => i.issue_type === 'MISINFORMATION')).toBe(true);
    });
  });
});
