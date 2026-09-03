import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import type { Telegraf } from 'telegraf';
import type { Prisma } from '@prisma/client';
import { WebSocketServer } from 'ws';
import { prisma } from './db';
import { config } from './config';
import { openai } from './lib/openaiClient';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleVoiceDialog } from './voice/voiceDialog';
import { handleVoiceStreamMessage } from './voice/voiceStream';
import { addCall, getCallHistory, getTestNumbers, setVoxSessionId } from './voice/callHistory';
import { resolveVoiceCallUrls, startVoiceCall } from './voice/startVoiceCall';
import { finalizeVoiceCallSession, recordVoiceCallConnected } from './voice/voiceCallSession';
import { evaluateDemoExampleFromTranscript } from './voice/demoExampleEvaluation';
import { computeUiDimensionScoresFromChecklist } from './voice/uiDimensionScores';
import { DEMO_CALL_CRITERIA, DEMO_CALL_PROMPT } from './voice/demoCallPrompt';
import { normalizeCallPhone } from './voice/phoneNumberStats';
import { generateUnifiedCallReport, generateUnifiedTrainerReport, normalizeUnifiedCallReport } from './voice/unifiedCallReport';
import {
  DEFAULT_CALL_REPORT_PROBLEMS,
  getCallReportProblemCatalog,
  seedCallReportProblemCatalog,
  type ProblemCatalogItem,
} from './voice/problemCatalog';
import {
  cancelCallBatch,
  createCallBatch,
  getCallBatch,
  getCallBatchJobs,
  listCallBatches,
  onVoxBatchWebhook,
  pauseCallBatch,
  resumeCallBatch,
  startCallBatchOrchestrator,
} from './voice/callBatchOrchestrator';
import { getDefaultState } from './state/defaultState';
import { buildDealershipFromCar } from './llm/virtualClient';
import { loadCar } from './data/carLoader';
import { getVirtualClientReply, type Strictness } from './llm/virtualClient';
import { evaluateSessionV2 } from './llm/evaluatorV2';
import { generateSpeechBuffer, generateSpeechElevenLabsVoice } from './voice/tts';
import { buildCustomerScenarioPromptCore } from './voice/customerScenarioPrompt';
import {
  closeElevenLabsAgentConversation,
  hasElevenLabsAgentConversation,
  isElevenLabsAgentEnabled,
  runElevenLabsAgentAudioTurn,
  runElevenLabsAgentTurn,
} from './voice/elevenLabsAgent';
import {
  handleCreateCallCustomerProfile,
  handleCreateCallCustomerVoice,
  handleCreateCallPlan,
  handleCreateCallScript,
  handleDeleteCallCustomerProfile,
  handleDeleteCallCustomerVoice,
  handleDeleteCallPlan,
  handleDeleteCallScript,
  handleGetCallPlanOptions,
  handleGetCallPlanSchedule,
  handleInitiateCallPlan,
  handleListCallPlanCalls,
  handleListCallCustomerProfiles,
  handleListCallCustomerVoices,
  handleListCallPlans,
  handleListCallScripts,
  handlePreviewCallPlanPrompt,
  handleRecreateCallPlanScheduleCall,
  handleUpdateCallCustomerProfile,
  handleUpdateCallCustomerVoice,
  handleUpdateCallPlan,
  handleUpdateCallScript,
  startCallPlanScheduler,
} from './voice/callSettingsManagement';
import type { TtsVoice } from './state/userPreferences';
import { transcribeVoice, transcribeVoiceFast } from './voice/stt';
import { classifyBehavior, type BehaviorSignal } from './logic/behaviorClassifier';
import { getDealershipDirectory } from './super-admin/dealershipDirectory';
import { adminApiAuthMiddleware, handleAuthLogin, handleAuthMe } from './auth/http';
import {
  handleAnalyzeImportSource,
  handleCancelImport,
  handleCreateImport,
  handleDeleteImport,
  handleGenerateImportTagRule,
  handleGenerateImportTagRules,
  handleGetImport,
  handleListImportedItems,
  handleListImportedTags,
  handleListImports,
  handlePreviewImportConfig,
  handleRunImport,
  startImportScheduler,
  handleTestImportTagRules,
  handleUpdateImport,
} from './imports/importManagement';
import {
  handleCreateDealership,
  handleCreateDealershipDirection,
  handleCreateDealershipPhoneNumber,
  handleCreateHolding,
  handleCreatePhoneNumberType,
  handleDeleteDealership,
  handleDeleteDealershipDirection,
  handleDeleteDealershipPhoneNumber,
  handleDeleteHolding,
  handleDeletePhoneNumberType,
  handleListDealerships,
  handleListCities,
  handleListDealershipDirections,
  handleListDealershipPhoneNumbers,
  handleListHoldings,
  handleListPhoneNumberTypes,
  handleSyncMockOrganization,
  handleUpdateDealership,
  handleUpdateDealershipDirection,
  handleUpdateDealershipPhoneNumber,
  handleUpdateHolding,
  handleUpdatePhoneNumberType,
} from './auth/organizationManagement';

import {
  handleCreatePermissionTemplate,
  handleCreateUser,
  handleChangeOwnPassword,
  handleChangeUserPassword,
  handleDeletePermissionTemplate,
  handleDeleteUser,
  handleDeleteUserPhoneNumber,
  handleCreateUserPhoneNumber,
  handleListPermissionTemplates,
  handleListUserPhoneNumbers,
  handleListUsers,
  handleRbacMeta,
  handleUpdatePermissionTemplate,
  handleUpdateUserPhoneNumber,
  handleUpdateUser,
} from './auth/userManagement';
import {
  handleDealershipRecommendations,
  handleHoldingRecommendations,
  handleUserRecommendations,
} from './analytics/recommendations/api';
import {
  advanceTopic,
  checkCriticalEvasions,
  recordEvasion,
  type TopicCode,
} from './logic/topicStateMachine';

type AnalyticsInsight = {
  fact: string;
  interpretation: string;
  action: string;
  stable?: boolean;
};

type AnalyticsAISummary = {
  summary: string;
  recommendations: string[];
  source: 'llm' | 'generated' | 'fallback';
};

type AnalyticsSession = {
  id: number;
  startedAt: Date;
  outcome: string | null;
  totalScore: number | null;
  evaluationJson: string | null;
  dimensionsJson: string | null;
  checklistResultsJson: string | null;
  dealershipId: string | null;
  managerId: string | null;
  answerTimeSec?: number | null;
  durationSec?: number | null;
  talkDurationSec?: number | null;
  manager?: { id: string; fullName: string } | null;
  plan?: { scriptId?: string | null; name?: string | null } | null;
  dealership?: { type?: string | null; holding?: { type?: string | null } | null } | null;
};

type ActiveAdminRole = 'super' | 'company' | 'dealer' | 'staff';

function getActiveAdminRole(req: express.Request): ActiveAdminRole | null {
  const value = String(req.get('x-admin-role') || '').trim();
  return value === 'super' || value === 'company' || value === 'dealer' || value === 'staff' ? value : null;
}

function buildVoiceCallSessionScopeWhere(
  account: express.Request['authAccount'],
  activeRole?: ActiveAdminRole | null,
): Prisma.VoiceCallSessionWhereInput {
  if (!account) return {};
  if (activeRole === 'super') {
    return account.memberships.some((membership) => membership.role === 'platform_superadmin') ? {} : { id: -1 };
  }

  if (activeRole === 'dealer') {
    const dealershipIds = [
      ...new Set(account.memberships
        .filter((membership) => membership.role === 'dealership_admin')
        .map((membership) => membership.dealershipId)
        .filter((id): id is string => Boolean(id))),
    ];
    return dealershipIds.length > 0 ? { dealershipId: { in: dealershipIds } } : { id: -1 };
  }

  if (activeRole === 'company') {
    const holdingIds = [
      ...new Set(account.memberships
        .filter((membership) => membership.role === 'holding_admin')
        .map((membership) => membership.holdingId)
        .filter((id): id is string => Boolean(id))),
    ];
    return holdingIds.length > 0 ? { dealership: { holdingId: { in: holdingIds } } } : { id: -1 };
  }

  if (account.memberships.some((membership) => membership.role === 'platform_superadmin')) return {};

  const holdingIds = [
    ...new Set(account.memberships
      .filter((membership) => membership.role === 'holding_admin')
      .map((membership) => membership.holdingId)
      .filter((id): id is string => Boolean(id))),
  ];
  const dealershipIds = [
    ...new Set(account.memberships
      .filter((membership) => membership.role === 'dealership_admin')
      .map((membership) => membership.dealershipId)
      .filter((id): id is string => Boolean(id))),
  ];
  const or: Prisma.VoiceCallSessionWhereInput[] = [];
  if (holdingIds.length > 0) {
    or.push({ dealership: { holdingId: { in: holdingIds } } });
  }
  if (dealershipIds.length > 0) {
    or.push({ dealershipId: { in: dealershipIds } });
  }

  return or.length > 0 ? { OR: or } : { id: -1 };
}

function buildTrainerSessionScopeWhere(
  account: express.Request['authAccount'],
  activeRole?: ActiveAdminRole | null,
): Prisma.TrainerSessionWhereInput {
  if (!account) return {};
  const noAccess: Prisma.TrainerSessionWhereInput = { id: '__no_access__' };

  if (activeRole === 'super') {
    return account.memberships.some((membership) => membership.role === 'platform_superadmin') ? {} : noAccess;
  }

  if (activeRole === 'dealer') {
    const dealershipIds = [
      ...new Set(account.memberships
        .filter((membership) => membership.role === 'dealership_admin')
        .map((membership) => membership.dealershipId)
        .filter((id): id is string => Boolean(id))),
    ];
    return dealershipIds.length > 0
      ? { OR: [{ branchId: { in: dealershipIds } }, { employee: { dealershipId: { in: dealershipIds } } }] }
      : noAccess;
  }

  if (activeRole === 'company') {
    const holdingIds = [
      ...new Set(account.memberships
        .filter((membership) => membership.role === 'holding_admin')
        .map((membership) => membership.holdingId)
        .filter((id): id is string => Boolean(id))),
    ];
    return holdingIds.length > 0
      ? {
        OR: [
          { companyId: { in: holdingIds } },
          { branch: { holdingId: { in: holdingIds } } },
          { employee: { dealership: { holdingId: { in: holdingIds } } } },
        ],
      }
      : noAccess;
  }

  if (account.memberships.some((membership) => membership.role === 'platform_superadmin')) return {};

  const holdingIds = [
    ...new Set(account.memberships
      .filter((membership) => membership.role === 'holding_admin')
      .map((membership) => membership.holdingId)
      .filter((id): id is string => Boolean(id))),
  ];
  const dealershipIds = [
    ...new Set(account.memberships
      .filter((membership) => membership.role === 'dealership_admin')
      .map((membership) => membership.dealershipId)
      .filter((id): id is string => Boolean(id))),
  ];
  const or: Prisma.TrainerSessionWhereInput[] = [];
  if (holdingIds.length > 0) {
    or.push(
      { companyId: { in: holdingIds } },
      { branch: { holdingId: { in: holdingIds } } },
      { employee: { dealership: { holdingId: { in: holdingIds } } } },
    );
  }
  if (dealershipIds.length > 0) {
    or.push({ branchId: { in: dealershipIds } }, { employee: { dealershipId: { in: dealershipIds } } });
  }

  return or.length > 0 ? { OR: or } : noAccess;
}

function canAccessDealershipForActiveRole(
  req: express.Request,
  dealership: { id: string; holdingId?: string | null },
): boolean {
  const account = req.authAccount;
  if (!account) return false;
  const activeRole = getActiveAdminRole(req);

  if (activeRole === 'super') {
    return account.memberships.some((membership) => membership.role === 'platform_superadmin');
  }
  if (activeRole === 'dealer') {
    return account.memberships.some((membership) => membership.role === 'dealership_admin' && membership.dealershipId === dealership.id);
  }
  if (activeRole === 'company') {
    return !!dealership.holdingId && account.memberships.some((membership) => membership.role === 'holding_admin' && membership.holdingId === dealership.holdingId);
  }

  if (account.memberships.some((membership) => membership.role === 'platform_superadmin')) return true;
  if (account.memberships.some((membership) => membership.role === 'dealership_admin' && membership.dealershipId === dealership.id)) return true;
  return !!dealership.holdingId && account.memberships.some((membership) => membership.role === 'holding_admin' && membership.holdingId === dealership.holdingId);
}

async function resolveAccessibleAnalyticsManager(req: express.Request, identifier: string) {
  const account = req.authAccount;
  if (!account) return null;

  const include = { dealership: true } as const;
  const managerById = await prisma.managerProfile.findUnique({ where: { id: identifier }, include });
  const manager = managerById ?? await prisma.managerProfile.findFirst({
    where: { accountId: identifier, status: 'active' },
    include,
    orderBy: { createdAt: 'asc' },
  });
  if (!manager) return null;

  const activeRole = getActiveAdminRole(req);
  if (activeRole === 'staff') {
    return manager.accountId === account.id ? manager : null;
  }
  return canAccessDealershipForActiveRole(req, manager.dealership) ? manager : null;
}

function safeJsonParseLocal<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function extractDimensionsFromSession(session: { dimensionsJson: string | null; evaluationJson: string | null }): Record<string, number> {
  const direct = safeJsonParseLocal<Record<string, unknown> | null>(session.dimensionsJson, null);
  const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
  const source = direct ?? (evaluation?.dimension_scores as Record<string, unknown> | undefined);
  if (!source || typeof source !== 'object') return {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, value]) => [key, typeof value === 'number' ? value : Number(value)])
      .filter(([, value]) => Number.isFinite(value as number))
  ) as Record<string, number>;
}

function extractChecklistFromSession(session: { checklistResultsJson: string | null; evaluationJson: string | null }): Array<{ code?: string; status?: string; comment?: string }> {
  const direct = safeJsonParseLocal<unknown>(session.checklistResultsJson, null);
  if (Array.isArray(direct)) return direct as Array<{ code?: string; status?: string; comment?: string }>;
  const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
  return Array.isArray(evaluation?.checklist) ? evaluation.checklist as Array<{ code?: string; status?: string; comment?: string }> : [];
}

type PlanCriterionEvaluation = {
  expectedAnswer: string;
  maxScore: number;
  score: number;
  evidence: string;
};

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractPlanCriteriaEvaluation(evaluation: Record<string, unknown> | null | undefined): {
  items: PlanCriterionEvaluation[];
  totalScore: number;
  maxScore: number;
  percent: number;
} | null {
  const raw = evaluation?.plan_criteria;
  if (!raw || typeof raw !== 'object') return null;

  const source = raw as Record<string, unknown>;
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items = rawItems.map((rawItem) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as Record<string, unknown> : {};
    const maxScore = Math.max(0, numberOrNull(item.maxScore) ?? 0);
    const score = Math.max(0, Math.min(maxScore, numberOrNull(item.score) ?? 0));
    return {
      expectedAnswer: String(item.expectedAnswer || item.title || item.name || item.question || '').trim(),
      maxScore,
      score,
      evidence: String(item.evidence || item.comment || item.reason || '').trim(),
    };
  }).filter((item) => item.expectedAnswer || item.evidence || item.maxScore > 0);

  if (items.length === 0) return null;

  const maxScore = numberOrNull(source.maxScore) ?? items.reduce((sum, item) => sum + item.maxScore, 0);
  const totalScore = numberOrNull(source.totalScore) ?? items.reduce((sum, item) => sum + item.score, 0);
  const explicitPercent = numberOrNull(source.percent);
  const percentScore = explicitPercent ?? (maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0);

  return {
    items,
    totalScore,
    maxScore,
    percent: Math.max(0, Math.min(100, round1(percentScore))),
  };
}

function scoreFromUnifiedReport(evaluation: Record<string, unknown> | null | undefined): number | null {
  const report = evaluation?.unified_call_report;
  if (!report || typeof report !== 'object') return null;
  const score = numberOrNull((report as Record<string, unknown>).totalScore);
  return score === null ? null : Math.max(0, Math.min(100, round1(score)));
}

async function evaluateScriptCriteria(criteriaInput: unknown, transcript: TrainerTranscriptTurn[]): Promise<unknown | null> {
  const criteria = Array.isArray(criteriaInput) ? criteriaInput as Array<{ expectedAnswer?: string; score?: number }> : [];
  const meaningfulCriteria = criteria.filter((item) => String(item.expectedAnswer || '').trim());
  if (meaningfulCriteria.length === 0) return null;
  const prompt = [
    'Ты оцениваешь разговор сотрудника с виртуальным клиентом по условиям успеха скрипта.',
    'Для каждого условия сравни ответ сотрудника с эталоном.',
    'Правила: если ответил также или почти также — полный балл; если близко — половина; если не ответил — 0.',
    'Критично: score по каждому пункту НЕ МОЖЕТ быть больше maxScore этого пункта. Если maxScore=80, максимум score=80.',
    'totalScore должен быть суммой score, maxScore должен быть суммой maxScore, percent = totalScore / maxScore * 100.',
    'Верни только JSON: {"items":[{"expectedAnswer":"...","maxScore":100,"score":0,"evidence":"цитата или причина"}],"totalScore":0,"maxScore":0,"percent":0}.',
    '',
    `Условия:\n${JSON.stringify(meaningfulCriteria, null, 2)}`,
    '',
    `Диалог:\n${transcript.map((turn) => `${turn.role === 'manager' ? 'Сотрудник' : 'Клиент'}: ${turn.text}`).join('\n')}`,
  ].join('\n');
  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Ты строгий оценщик продаж. Отвечай только валидным JSON.' },
        { role: 'user', content: prompt },
      ],
    });
    const content = response.choices[0]?.message?.content || '';
    const jsonText = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const raw = JSON.parse(jsonText) as Record<string, unknown>;
    const sourceItems = Array.isArray(raw.items) ? raw.items : [];
    const items = sourceItems.map((itemRaw) => {
      const item = itemRaw && typeof itemRaw === 'object' ? itemRaw as Record<string, unknown> : {};
      const maxScore = Math.max(0, Math.min(100, numberOrNull(item.maxScore) ?? 0));
      const score = Math.max(0, Math.min(maxScore, numberOrNull(item.score) ?? 0));
      return { ...item, maxScore, score };
    });
    const maxScore = items.reduce((sum, item) => sum + item.maxScore, 0);
    const totalScore = items.reduce((sum, item) => sum + item.score, 0);
    const percentValue = numberOrNull(raw.percent) ?? (maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0);
    return {
      ...raw,
      items,
      totalScore,
      maxScore,
      percent: Math.max(0, Math.min(100, round1(percentValue))),
    };
  } catch (error) {
    console.warn('[trainer] script criteria evaluation failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

function scoreFromEvaluation(evaluation: Record<string, unknown> | null | undefined, directScore: number | null | undefined): number {
  const unifiedScore = scoreFromUnifiedReport(evaluation);
  const planCriteria = extractPlanCriteriaEvaluation(evaluation);
  const genericScore = numberOrNull(evaluation?.overall_score_0_100);
  return round1(unifiedScore ?? directScore ?? genericScore ?? planCriteria?.percent ?? 0);
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

function safeArray<T = unknown>(value: string | null | undefined): T[] {
  const parsed = safeJsonParseLocal<unknown>(value, []);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function trainerPlanDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function trainerPlanItemId(): string {
  return `plan_item_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pickTrainerClientAge(ageFrom: number | null | undefined, ageTo: number | null | undefined, fallback = 35): number {
  const from = Number.isFinite(Number(ageFrom)) ? Math.round(Number(ageFrom)) : fallback;
  const to = Number.isFinite(Number(ageTo)) ? Math.round(Number(ageTo)) : from;
  const min = Math.max(18, Math.min(65, Math.min(from, to)));
  const max = Math.max(18, Math.min(65, Math.max(from, to)));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function ttsVoiceName(voice: TtsVoice | null | undefined): string {
  return voice === 'female' ? 'женский голос' : 'мужской голос';
}

async function pickTrainerImportedSampleForScript(script: Prisma.CallScriptGetPayload<{}>) {
  const dataCondition = safeJsonParseLocal<{ tags?: string[] }>(script.dataConditionJson, { tags: [] });
  const tags = Array.isArray(dataCondition.tags) ? dataCondition.tags.map(String).filter(Boolean) : [];
  const candidates = await prisma.importedItem.findMany({
    where: { importSource: { holdingId: script.holdingId } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  if (candidates.length === 0) return null;
  const pool = tags.length
    ? candidates.filter((item) => {
      const itemTags = safeJsonParseLocal<string[]>(item.tagsJson, []);
      return tags.every((tag) => itemTags.includes(tag));
    })
    : candidates;
  const source = pool.length ? pool : candidates;
  return source[Math.floor(Math.random() * source.length)] ?? null;
}

function buildTrainerCaseContext(params: {
  sessionType: 'plan' | 'free';
  scenario: { id: string; name: string; context: string; objectionsJson: string; questionsJson: string; successCriteriaJson: string } | null;
  importedItem?: { id: string; title: string; description: string | null } | null;
  manager: { id: string; fullName: string; dealership?: { id: string; name: string; city: string | null; holdingId: string | null } | null };
  difficulty: string;
  clientType: string;
  seed?: string | null;
  customerProfile?: {
    id: string;
    name: string;
    voiceId: string;
    voiceName?: string | null;
    elevenLabsVoiceId?: string | null;
    age: number;
    ageFrom: number;
    ageTo: number;
    character: string;
    temperament: string;
    patience: string;
    replyLength: string;
    communicationStyle: string;
  } | null;
}) {
  const objections = safeArray(params.scenario?.objectionsJson);
  const questions = safeArray(params.scenario?.questionsJson);
  const successCriteria = safeArray(params.scenario?.successCriteriaJson);
  const city = params.manager.dealership?.city || 'город клиента';
  const clientAge = params.customerProfile
    ? pickTrainerClientAge(params.customerProfile.ageFrom, params.customerProfile.ageTo, params.customerProfile.age)
    : null;
  return {
    seed: params.seed || trainerPlanItemId(),
    mode: params.sessionType,
    difficulty: params.difficulty,
    clientType: params.clientType,
    clientProfile: {
      id: params.customerProfile?.id ?? null,
      name: params.customerProfile?.name || 'AI-клиент',
      city,
      type: params.customerProfile?.name ? 'script_profile' : params.clientType === 'random' ? 'random' : params.clientType,
      voiceId: params.customerProfile?.voiceId ?? null,
      voiceName: params.customerProfile?.voiceName ?? null,
      elevenLabsVoiceId: params.customerProfile?.elevenLabsVoiceId ?? null,
      age: clientAge,
      ageFrom: params.customerProfile?.ageFrom ?? params.customerProfile?.age ?? null,
      ageTo: params.customerProfile?.ageTo ?? params.customerProfile?.age ?? null,
      character: params.customerProfile?.character ?? '',
      temperament: params.customerProfile?.temperament ?? '',
      patience: params.customerProfile?.patience ?? '',
      replyLength: params.customerProfile?.replyLength ?? '',
      communicationStyle: params.customerProfile?.communicationStyle ?? '',
    },
    company: {
      id: params.manager.dealership?.holdingId ?? null,
      branchId: params.manager.dealership?.id ?? null,
      branchName: params.manager.dealership?.name ?? null,
      city,
    },
    scenario: params.scenario ? {
      id: params.scenario.id,
      name: params.scenario.name,
      context: params.scenario.context,
      objections,
      questions,
      successCriteria,
    } : null,
    importedItem: params.importedItem ? {
      id: params.importedItem.id,
      title: params.importedItem.title,
      description: params.importedItem.description,
    } : null,
  };
}

function trainerElevenLabsVoiceId(caseContext: Record<string, unknown>): string | null {
  const clientProfile = caseContext.clientProfile && typeof caseContext.clientProfile === 'object'
    ? caseContext.clientProfile as Record<string, unknown>
    : null;
  const voiceId = String(clientProfile?.elevenLabsVoiceId || '').trim();
  return voiceId || null;
}

const ANALYTICS_CATEGORIES = ['Контакт', 'Диагностика', 'Продукт', 'Закрытие', 'Коммуникация'] as const;
type AnalyticsCategory = typeof ANALYTICS_CATEGORIES[number];

function dimensionLabel(key: string): AnalyticsCategory {
  const normalized = String(key || '').trim().toLowerCase();
  const labels: Record<string, AnalyticsCategory> = {
    contact: 'Контакт',
    first_contact: 'Контакт',
    intro: 'Контакт',
    opening: 'Контакт',
    diagnosis: 'Диагностика',
    diagnostics: 'Диагностика',
    needs: 'Диагностика',
    needs_discovery: 'Диагностика',
    product: 'Продукт',
    product_and_sales: 'Продукт',
    presentation: 'Продукт',
    product_presentation: 'Продукт',
    closing: 'Закрытие',
    closing_commitment: 'Закрытие',
    objections: 'Закрытие',
    objection_handling: 'Закрытие',
    next_step: 'Закрытие',
    communication: 'Коммуникация',
    comm: 'Коммуникация',
    tone: 'Коммуникация',
  };
  if (labels[normalized]) return labels[normalized];
  if (normalized.includes('контакт') || normalized.includes('contact') || normalized.includes('intro')) return 'Контакт';
  if (normalized.includes('диагност') || normalized.includes('needs')) return 'Диагностика';
  if (normalized.includes('продукт') || normalized.includes('product') || normalized.includes('presentation')) return 'Продукт';
  if (normalized.includes('закрыт') || normalized.includes('closing') || normalized.includes('objection') || normalized.includes('next')) return 'Закрытие';
  return 'Коммуникация';
}

function analyticsStatus(score: number, answerRate: number | null, calls: number): 'norm' | 'risk' | 'critical' | 'no-data' {
  if (calls === 0) return 'no-data';
  if (score < 50 || (answerRate !== null && answerRate < 60)) return 'critical';
  if (score < 70) return 'risk';
  return 'norm';
}

function scoreFromSessions(sessions: AnalyticsSession[]): number {
  const scored = sessions
    .map(scoreFromAnalyticsSession)
    .filter((score): score is number => typeof score === 'number');
  return scored.length ? round1(scored.reduce((sum, score) => sum + score, 0) / scored.length) : 0;
}

function scoreFromAnalyticsSession(session: Pick<AnalyticsSession, 'totalScore' | 'evaluationJson'>): number | null {
  const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
  const unifiedScore = scoreFromUnifiedReport(evaluation);
  if (unifiedScore !== null) return unifiedScore;
  if (typeof session.totalScore === 'number') return session.totalScore;
  const planCriteria = extractPlanCriteriaEvaluation(evaluation);
  const genericScore = numberOrNull(evaluation?.overall_score_0_100);
  return genericScore ?? planCriteria?.percent ?? null;
}

function isFranchisedSession(session: Pick<AnalyticsSession, 'dealership'>): boolean {
  return session.dealership?.type === 'franchised' || session.dealership?.holding?.type === 'franchised';
}

function answerRateFromSessions(sessions: AnalyticsSession[]): number | null {
  if (!sessions.length) return null;
  const missed = sessions.filter((session) => session.outcome === 'no_answer' || session.outcome === 'busy' || session.outcome === 'failed').length;
  return percent(sessions.length - missed, sessions.length);
}

function averagePositiveMetric<T>(items: T[], pick: (item: T) => number | null | undefined): number | null {
  const values = items
    .map(pick)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function deltaFromSessions(sessions: AnalyticsSession[]): number | null {
  const now = new Date();
  const currentStart = new Date(now);
  currentStart.setDate(currentStart.getDate() - 30);
  const previousStart = new Date(now);
  previousStart.setDate(previousStart.getDate() - 60);
  const current = sessions.filter((session) => typeof scoreFromAnalyticsSession(session) === 'number' && session.startedAt >= currentStart);
  const previous = sessions.filter((session) => typeof scoreFromAnalyticsSession(session) === 'number' && session.startedAt >= previousStart && session.startedAt < currentStart);
  // Need both windows — otherwise "delta" collapses to absolute score (looks random).
  if (!current.length || !previous.length) return null;
  return Math.round(scoreFromSessions(current) - scoreFromSessions(previous));
}

const CHECKLIST_PROBLEM_CODE_MAP: Record<string, string> = {
  INTRODUCTION: 'NO_INTRO_COMPANY',
  SALON_NAME: 'NO_INTRO_COMPANY',
  CAR_IDENTIFICATION: 'NO_KEY_PARAMS',
  NEEDS_DISCOVERY: 'NO_NEEDS_DISCOVERY',
  INITIATIVE: 'PASSIVE_STYLE',
  PRODUCT_PRESENTATION: 'WEAK_BENEFIT_PRESENTATION',
  CREDIT_EXPLANATION: 'WEAK_BENEFIT_PRESENTATION',
  TRADEIN_OFFER: 'WEAK_BENEFIT_PRESENTATION',
  OBJECTION_HANDLING: 'WEAK_OBJECTION_HANDLING',
  NEXT_STEP_PROPOSAL: 'NO_NEXT_STEP',
  DATE_FIXATION: 'NO_CONCRETE_NEXT_STEP',
  FOLLOW_UP_AGREEMENT: 'NO_CONCRETE_NEXT_STEP',
  COMMUNICATION_TONE: 'BAD_TONE',
};

const ISSUE_PROBLEM_CODE_MAP: Record<string, string> = {
  NO_INTRO: 'NO_INTRO_COMPANY',
  NO_SALON_NAME: 'NO_INTRO_COMPANY',
  NO_NEEDS_DISCOVERY: 'NO_NEEDS_DISCOVERY',
  WEAK_PRESENTATION: 'WEAK_BENEFIT_PRESENTATION',
  NO_NEXT_STEP: 'NO_NEXT_STEP',
  NO_DATE_FIX: 'NO_CONCRETE_NEXT_STEP',
  WEAK_TRADEIN: 'WEAK_BENEFIT_PRESENTATION',
  WEAK_CREDIT: 'WEAK_BENEFIT_PRESENTATION',
  BAD_TONE: 'BAD_TONE',
  PASSIVE_STYLE: 'PASSIVE_STYLE',
  MISINFORMATION: 'PRODUCT_MISINFORMATION',
  REDIRECT_TO_WEBSITE: 'CRITICAL_VIOLATION',
  LOW_ENGAGEMENT: 'PASSIVE_STYLE',
  PROFANITY: 'CRITICAL_VIOLATION',
};

function problemTitleByCode(catalog: ProblemCatalogItem[], code: string | undefined, fallback: string): string {
  const problemCode = code ? CHECKLIST_PROBLEM_CODE_MAP[code] ?? ISSUE_PROBLEM_CODE_MAP[code] : undefined;
  return catalog.find((problem) => problem.code === problemCode)?.title || fallback;
}

function topIssuesFromSessions(
  sessions: AnalyticsSession[],
  limit = 5,
  catalog: ProblemCatalogItem[] = DEFAULT_CALL_REPORT_PROBLEMS,
): { issue: string; percent: number; count: number }[] {
  const counts = new Map<string, { no: number; total: number }>();
  for (const session of sessions) {
    for (const item of extractChecklistFromSession(session)) {
      const fallback = item.comment || item.code || 'Неизвестный блок';
      const key = problemTitleByCode(catalog, item.code, fallback);
      const current = counts.get(key) ?? { no: 0, total: 0 };
      current.total += 1;
      if (String(item.status).toUpperCase() === 'NO') current.no += 1;
      counts.set(key, current);
    }
  }
  return [...counts.entries()]
    .filter(([, value]) => value.no > 0)
    .sort((a, b) => b[1].no - a[1].no)
    .slice(0, limit)
    .map(([issue, value]) => ({ issue, count: value.no, percent: percent(value.no, value.total) }));
}

type ScriptQuestionSource = {
  id: string;
  label: string;
  expectedAnswer: string;
};

function scriptQuestionSources(script: {
  questionsJson: string;
  objectionsJson: string;
  successCriteriaJson: string;
}): ScriptQuestionSource[] {
  const questions = safeJsonParseLocal<Array<{ id?: string; text?: string }>>(script.questionsJson, []);
  const objections = safeJsonParseLocal<Array<{ id?: string; phrase?: string }>>(script.objectionsJson, []);
  const criteria = safeJsonParseLocal<Array<{ sourceType?: string; sourceId?: string; expectedAnswer?: string }>>(script.successCriteriaJson, []);
  return criteria
    .map((criterion) => {
      const sourceId = String(criterion.sourceId || '').trim();
      const sourceType = String(criterion.sourceType || '').trim();
      const question = sourceType === 'question' ? questions.find((item) => item.id === sourceId) : null;
      const objection = sourceType === 'objection' ? objections.find((item) => item.id === sourceId) : null;
      const label = sourceType === 'question'
        ? String(question?.text || criterion.expectedAnswer || '').trim()
        : String(objection?.phrase || criterion.expectedAnswer || '').trim();
      if (!sourceId || !label) return null;
      return {
        id: `${sourceType}:${sourceId}`,
        label,
        expectedAnswer: String(criterion.expectedAnswer || '').trim(),
      };
    })
    .filter((item): item is ScriptQuestionSource => Boolean(item));
}

function topScriptQuestionsFromSessions(
  sessions: AnalyticsSession[],
  scriptsById: Map<string, { questionsJson: string; objectionsJson: string; successCriteriaJson: string }>,
  limit = 5,
): { question: string; percent: number; count: number }[] {
  const counts = new Map<string, { label: string; fails: number; total: number }>();
  for (const session of sessions) {
    const scriptId = session.plan?.scriptId || null;
    const script = scriptId ? scriptsById.get(scriptId) : null;
    if (!script) continue;
    const sources = scriptQuestionSources(script);
    if (!sources.length) continue;
    const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
    const planCriteria = extractPlanCriteriaEvaluation(evaluation);
    const criteriaItems = planCriteria?.items ?? [];
    for (const source of sources) {
      const current = counts.get(source.id) ?? { label: source.label, fails: 0, total: 0 };
      const matchingCriterion = criteriaItems.find((item) => {
        const expected = item.expectedAnswer.toLowerCase();
        const sourceExpected = source.expectedAnswer.toLowerCase();
        const label = source.label.toLowerCase();
        return (sourceExpected && expected.includes(sourceExpected))
          || (sourceExpected && sourceExpected.includes(expected))
          || (label && expected.includes(label))
          || (label && label.includes(expected));
      });
      current.total += 1;
      const failed = matchingCriterion
        ? matchingCriterion.maxScore > 0 && matchingCriterion.score < matchingCriterion.maxScore * 0.6
        : typeof scoreFromAnalyticsSession(session) === 'number' && (scoreFromAnalyticsSession(session) ?? 0) < 60;
      if (failed) current.fails += 1;
      counts.set(source.id, current);
    }
  }
  return [...counts.values()]
    .filter((item) => item.fails > 0)
    .sort((a, b) => b.fails - a.fails || b.total - a.total)
    .slice(0, limit)
    .map((item) => ({ question: item.label, count: item.fails, percent: percent(item.fails, item.total) }));
}

function categoryComparisonFromSessions(ownSessions: AnalyticsSession[], franchiseSessions: AnalyticsSession[]) {
  const own = new Map(dimensionBreakdownFromSessions(ownSessions).map((item) => [item.block, item.score]));
  const franchise = new Map(dimensionBreakdownFromSessions(franchiseSessions).map((item) => [item.block, item.score]));
  return ANALYTICS_CATEGORIES.map((category) => ({
    category,
    ownScore: own.get(category) ?? 0,
    franchiseScore: franchise.get(category) ?? 0,
  }));
}

function categoryCommentFromEvaluation(evaluation: Record<string, unknown> | null, category: AnalyticsCategory): string | null {
  const report = evaluation?.unified_call_report && typeof evaluation.unified_call_report === 'object'
    ? evaluation.unified_call_report as Record<string, unknown>
    : null;
  if (!report) return null;
  const categories = Array.isArray(report.categories) ? report.categories : [];
  const match = categories.find((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).name || '') === category) as Record<string, unknown> | undefined;
  const comment = String(match?.comment || '').trim();
  return comment || null;
}

function categoryFindingTitlesFromEvaluation(evaluation: Record<string, unknown> | null, category: AnalyticsCategory): string[] {
  const report = evaluation?.unified_call_report && typeof evaluation.unified_call_report === 'object'
    ? evaluation.unified_call_report as Record<string, unknown>
    : null;
  if (!report) return [];
  const findings = Array.isArray(report.keyFindings) ? report.keyFindings : [];
  return findings
    .filter((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).category || '') === category)
    .map((item) => String((item as Record<string, unknown>).problemTitle || '').trim())
    .filter(Boolean);
}

function pickMostFrequentText(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.trim().replace(/\s+/g, ' ');
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [text, count] of counts) {
    if (count > bestCount) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

function trainerCategoryInsightsFromSessions(sessions: Array<{
  score: number | null;
  dimensionsJson: string | null;
  evaluationJson: string | null;
}>): Array<{ name: AnalyticsCategory; score: number; comment: string; hint: string }> {
  const buckets = new Map<AnalyticsCategory, { sum: number; count: number; comments: string[]; findings: string[] }>();
  for (const category of ANALYTICS_CATEGORIES) {
    buckets.set(category, { sum: 0, count: 0, comments: [], findings: [] });
  }

  for (const session of sessions) {
    const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
    const dimensions = extractDimensionsFromSession(session);
    const reportCats = evaluation?.unified_call_report && typeof evaluation.unified_call_report === 'object'
      ? (evaluation.unified_call_report as Record<string, unknown>).categories
      : null;
    const reportScores = new Map<AnalyticsCategory, number>();
    if (Array.isArray(reportCats)) {
      for (const raw of reportCats) {
        if (!raw || typeof raw !== 'object') continue;
        const name = String((raw as Record<string, unknown>).name || '') as AnalyticsCategory;
        if (!ANALYTICS_CATEGORIES.includes(name)) continue;
        const score = numberOrNull((raw as Record<string, unknown>).score);
        if (score != null) reportScores.set(name, score);
      }
    }

    for (const category of ANALYTICS_CATEGORIES) {
      const bucket = buckets.get(category)!;
      let score = reportScores.get(category);
      if (score == null) {
        const dimEntries = Object.entries(dimensions).filter(([key]) => dimensionLabel(key) === category);
        if (dimEntries.length) {
          score = Math.round(dimEntries.reduce((sum, [, value]) => sum + value, 0) / dimEntries.length);
        }
      }
      if (score != null) {
        bucket.sum += score;
        bucket.count += 1;
      }
      const comment = categoryCommentFromEvaluation(evaluation, category);
      if (comment) bucket.comments.push(comment);
      bucket.findings.push(...categoryFindingTitlesFromEvaluation(evaluation, category));
    }
  }

  return ANALYTICS_CATEGORIES.map((category) => {
    const bucket = buckets.get(category)!;
    const score = bucket.count ? Math.round(bucket.sum / bucket.count) : 0;
    const topFinding = pickMostFrequentText(bucket.findings);
    const topComment = pickMostFrequentText(bucket.comments);
    let comment = 'Пока мало данных по этой категории.';
    if (bucket.count === 0) {
      comment = 'Нет данных из тренажёра.';
    } else if (score >= 76) {
      comment = topComment && score < 90
        ? topComment
        : 'Стабильно хорошо — системных проблем не видно.';
    } else if (topFinding) {
      comment = topFinding;
    } else if (topComment) {
      comment = topComment;
    } else {
      comment = 'Есть просадки — разберите отчёты по этой категории.';
    }
    if (comment.length > 110) comment = `${comment.slice(0, 107).trim()}…`;
    return {
      name: category,
      score,
      comment,
      hint: bucket.count
        ? `Средний балл по ${bucket.count} тренировкам`
        : `Нет данных по категории «${category}»`,
    };
  });
}

function dimensionBreakdownFromSessions(sessions: AnalyticsSession[]): { block: AnalyticsCategory; score: number; hint: string }[] {
  const sums = new Map<AnalyticsCategory, { sum: number; count: number }>();
  for (const session of sessions) {
    const dimensions = extractDimensionsFromSession(session);
    for (const [key, value] of Object.entries(dimensions)) {
      const category = dimensionLabel(key);
      const current = sums.get(category) ?? { sum: 0, count: 0 };
      current.sum += value;
      current.count += 1;
      sums.set(category, current);
    }
  }
  return ANALYTICS_CATEGORIES.map((category) => {
    const value = sums.get(category) ?? { sum: 0, count: 0 };
    return {
    block: category,
    score: value.count ? Math.round(value.sum / value.count) : 0,
    hint: value.count ? `Средний балл категории «${category}»` : `Нет данных по категории «${category}»`,
    };
  });
}

function timeSeriesFromSessions(sessions: AnalyticsSession[], days = 14): { date: string; avgScore: number; count: number }[] {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  const buckets: Record<string, { sum: number; count: number }> = {};
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    buckets[localDateKey(date)] = { sum: 0, count: 0 };
  }
  for (const session of sessions) {
    const score = scoreFromAnalyticsSession(session);
    if (typeof score !== 'number') continue;
    const key = localDateKey(session.startedAt);
    if (!buckets[key]) continue;
    buckets[key].sum += score;
    buckets[key].count += 1;
  }
  return Object.entries(buckets).map(([date, value]) => ({
    date,
    avgScore: value.count ? Math.round(value.sum / value.count) : 0,
    count: value.count,
  }));
}

const MONTH_SHORT_LABELS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

function isMissedCallOutcome(outcome: string | null | undefined): boolean {
  return outcome === 'no_answer';
}

function callActivitySeriesFromSessions(
  sessions: AnalyticsSession[],
  buckets: Array<{ key: string; label: string; match: (date: Date) => boolean }>,
): { key: string; label: string; totalCalls: number; missedCalls: number; avgScore: number | null }[] {
  const stats = buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    totalCalls: 0,
    missedCalls: 0,
    scoreSum: 0,
    scoreCount: 0,
  }));

  for (const session of sessions) {
    const bucketIndex = buckets.findIndex((bucket) => bucket.match(session.startedAt));
    if (bucketIndex < 0) continue;
    stats[bucketIndex].totalCalls += 1;
    if (isMissedCallOutcome(session.outcome)) stats[bucketIndex].missedCalls += 1;
    const score = scoreFromAnalyticsSession(session);
    if (typeof score === 'number') {
      stats[bucketIndex].scoreSum += score;
      stats[bucketIndex].scoreCount += 1;
    }
  }

  return stats.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    totalCalls: bucket.totalCalls,
    missedCalls: bucket.missedCalls,
    avgScore: bucket.scoreCount ? round1(bucket.scoreSum / bucket.scoreCount) : null,
  }));
}

function callActivitySeriesMonth(sessions: AnalyticsSession[], days = 30) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = localDateKey(date);
    return {
      key,
      label: `${date.getDate()}.${String(date.getMonth() + 1).padStart(2, '0')}`,
      match: (startedAt: Date) => localDateKey(startedAt) === key,
    };
  });
  return callActivitySeriesFromSessions(sessions, buckets);
}

function callActivitySeriesAllTime(sessions: AnalyticsSession[]) {
  if (!sessions.length) return [];

  let minTime = sessions[0].startedAt.getTime();
  let maxTime = sessions[0].startedAt.getTime();
  for (const session of sessions) {
    const time = session.startedAt.getTime();
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
  }
  maxTime = Math.max(maxTime, Date.now());

  const start = new Date(minTime);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(maxTime);
  end.setDate(1);

  const multiYear = start.getFullYear() !== end.getFullYear();
  const buckets: Array<{ key: string; label: string; match: (date: Date) => boolean }> = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    const monthLabel = MONTH_SHORT_LABELS[month] ?? `${month + 1}`;
    buckets.push({
      key,
      label: multiYear ? `${monthLabel} ${String(year).slice(-2)}` : monthLabel,
      match: (startedAt: Date) => startedAt.getFullYear() === year && startedAt.getMonth() === month,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return callActivitySeriesFromSessions(sessions, buckets);
}

function parseDealershipDirectionsJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function dealershipMatchesDashboardFilters(
  dealership: { type: string; directionsJson: string },
  filters: { dealershipType?: string; direction?: { id: string; code: string | null } | null },
): boolean {
  if (filters.dealershipType && dealership.type !== filters.dealershipType) return false;
  if (filters.direction) {
    const dirs = parseDealershipDirectionsJson(dealership.directionsJson);
    const { id, code } = filters.direction;
    const has = dirs.includes(id) || (code ? dirs.includes(code) : false);
    if (!has) return false;
  }
  return true;
}

function typeTimeSeriesFromSessions(sessions: AnalyticsSession[], days = 7): {
  date: string;
  avgScore: number;
  count: number;
  ownScore: number;
  franchiseScore: number;
  ownCount: number;
  franchiseCount: number;
}[] {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  const buckets: Record<string, { ownSum: number; ownCount: number; franchiseSum: number; franchiseCount: number }> = {};
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    buckets[localDateKey(date)] = { ownSum: 0, ownCount: 0, franchiseSum: 0, franchiseCount: 0 };
  }
  for (const session of sessions) {
    const score = scoreFromAnalyticsSession(session);
    if (typeof score !== 'number') continue;
    const key = localDateKey(session.startedAt);
    const bucket = buckets[key];
    if (!bucket) continue;
    if (isFranchisedSession(session)) {
      bucket.franchiseSum += score;
      bucket.franchiseCount += 1;
    } else {
      bucket.ownSum += score;
      bucket.ownCount += 1;
    }
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => {
      const sum = value.ownSum + value.franchiseSum;
      const count = value.ownCount + value.franchiseCount;
      return {
        date,
        avgScore: count ? round1(sum / count) : 0,
        count,
        ownScore: value.ownCount ? round1(value.ownSum / value.ownCount) : 0,
        franchiseScore: value.franchiseCount ? round1(value.franchiseSum / value.franchiseCount) : 0,
        ownCount: value.ownCount,
        franchiseCount: value.franchiseCount,
      };
    });
}

function weeklyTypeTrendFromSessions(sessions: Array<AnalyticsSession & { dealership?: { type?: string | null } | null }>, weeks = 12): { week: string; ownScore: number; franchiseScore: number; ownCount: number; franchiseCount: number }[] {
  const now = new Date();
  const weekStarts: Date[] = [];
  const currentWeekStart = new Date(now);
  currentWeekStart.setHours(0, 0, 0, 0);
  currentWeekStart.setDate(currentWeekStart.getDate() - ((currentWeekStart.getDay() + 6) % 7));
  for (let i = weeks - 1; i >= 0; i--) {
    const date = new Date(currentWeekStart);
    date.setDate(currentWeekStart.getDate() - i * 7);
    weekStarts.push(date);
  }

  return weekStarts.map((start, index) => {
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    const bucket = sessions.filter((session) => (
      typeof session.totalScore === 'number'
      && session.startedAt >= start
      && (index === weekStarts.length - 1 ? session.startedAt <= now : session.startedAt < end)
    ));
    const own = bucket.filter((session) => session.dealership?.type !== 'franchised');
    const franchise = bucket.filter((session) => session.dealership?.type === 'franchised');
    return {
      week: start.toISOString().slice(0, 10),
      ownScore: scoreFromSessions(own),
      franchiseScore: scoreFromSessions(franchise),
      ownCount: own.length,
      franchiseCount: franchise.length,
    };
  });
}

function communicationFlagFromSessions(sessions: AnalyticsSession[]): 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement' {
  const values = sessions
    .map((session) => extractDimensionsFromSession(session).communication)
    .filter((value): value is number => typeof value === 'number');
  if (!values.length) return 'ok';
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (avg < 35) return 'aggression';
  if (avg < 50) return 'low-engagement';
  if (avg < 70) return 'fillers';
  return 'ok';
}

const AUDIT_CHECKLIST_LABELS: Record<string, string> = {
  INTRODUCTION: 'Приветствие',
  SALON_NAME: 'Представление компании / точки',
  CAR_IDENTIFICATION: 'Уточнение интересующего автомобиля',
  NEEDS_DISCOVERY: 'Выявление потребностей',
  INITIATIVE: 'Инициатива менеджера',
  PRODUCT_PRESENTATION: 'Презентация продукта',
  CREDIT_EXPLANATION: 'Объяснение кредита / условий',
  TRADEIN_OFFER: 'Предложение trade-in',
  OBJECTION_HANDLING: 'Работа с возражениями',
  NEXT_STEP_PROPOSAL: 'Предложение следующего шага',
  DATE_FIXATION: 'Фиксация даты / времени',
  FOLLOW_UP_AGREEMENT: 'Договорённость о контакте',
  COMMUNICATION_TONE: 'Тон и качество коммуникации',
};

const AUDIT_ISSUE_LABELS: Record<string, string> = {
  NO_INTRO: 'Нет корректного приветствия',
  NO_SALON_NAME: 'Не названа компания / точка',
  NO_NEEDS_DISCOVERY: 'Не выявлены потребности',
  WEAK_PRESENTATION: 'Слабая презентация продукта',
  NO_NEXT_STEP: 'Не предложен следующий шаг',
  NO_DATE_FIX: 'Не зафиксирована дата / время',
  WEAK_TRADEIN: 'Слабо раскрыт trade-in',
  WEAK_CREDIT: 'Слабо объяснены кредитные условия',
  BAD_TONE: 'Проблема с тоном общения',
  PASSIVE_STYLE: 'Пассивный стиль ведения диалога',
  MISINFORMATION: 'Риск неверной информации',
  REDIRECT_TO_WEBSITE: 'Перевод клиента на сайт вместо помощи',
  LOW_ENGAGEMENT: 'Низкая вовлечённость',
  PROFANITY: 'Недопустимая лексика',
};

const AUDIT_COMM_ISSUE_LABELS: Record<string, string> = {
  fillers: 'Паразиты',
  aggression: 'Агрессия',
  profanity: 'Недопустимая лексика',
  'low-engagement': 'Низкая вовлечённость',
};

function extractReportIssuesFromSession(
  session: { checklistResultsJson: string | null; evaluationJson: string | null },
  catalog: ProblemCatalogItem[] = DEFAULT_CALL_REPORT_PROBLEMS,
): string[] {
  const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
  const planCriteria = extractPlanCriteriaEvaluation(evaluation);
  const rawChecklist = extractChecklistFromSession(session);
  const issues: string[] = [];

  if (planCriteria) {
    for (const item of planCriteria.items) {
      const ratio = item.maxScore > 0 ? item.score / item.maxScore : 0;
      if (ratio < 0.8) {
        const label = item.expectedAnswer || 'Провал по критерию скрипта';
        issues.push(label);
      }
    }
  } else {
    for (const item of rawChecklist) {
      const status = String(item.status || '').toUpperCase();
      if (!['NO', 'PARTIAL'].includes(status)) continue;
      const fallback = AUDIT_CHECKLIST_LABELS[item.code || ''] || item.comment || item.code || 'Провальный пункт чек-листа';
      const label = problemTitleByCode(catalog, item.code, fallback);
      issues.push(label);
    }
  }

  const evalIssues = Array.isArray(evaluation?.issues) ? evaluation.issues as Array<Record<string, unknown>> : [];
  for (const item of evalIssues) {
    const issueType = String(item.issue_type || '');
    const fallback = AUDIT_ISSUE_LABELS[issueType]
      || String(item.recommendation || item.comment || item.issue_type || '').trim();
    const label = problemTitleByCode(catalog, issueType, fallback);
    if (label && label !== 'Ошибка') issues.push(label);
  }

  const commFlag = communicationFlagFromSessions([session as AnalyticsSession]);
  if (commFlag !== 'ok' && AUDIT_COMM_ISSUE_LABELS[commFlag]) {
    issues.push(AUDIT_COMM_ISSUE_LABELS[commFlag]);
  }

  return [...new Set(issues)];
}

function buildAnalyticsAISummary(input: {
  level: 'network' | 'holding' | 'dealership' | 'manager' | 'comparison';
  name?: string;
  score: number;
  calls: number;
  noAnswers: number;
  topIssue?: string | null;
  topIssuePercent?: number | null;
  worstDimension?: string | null;
  trend?: number | null;
  lowDealerships?: number;
  failsCount?: number;
}): AnalyticsAISummary {
  if (input.calls === 0) {
    return {
      summary: input.name
        ? `По объекту «${input.name}» пока нет привязанных звонков для устойчивой аналитики. После плановых или размеченных звонков здесь появится оценка, проблемы и рекомендации.`
        : 'Пока нет привязанных звонков для устойчивой аналитики. Звонки без салона, менеджера или плана не учитываются в управленческих выводах.',
      recommendations: [
        'Проверить, что новые звонки создаются с привязкой к салону, менеджеру или плану.',
        'Запустить плановый обзвон или добавить привязку к уже существующим релевантным звонкам.',
      ],
      source: 'fallback',
    };
  }

  const trendText = typeof input.trend === 'number'
    ? input.trend > 0
      ? `тренд +${input.trend} пунктов`
      : input.trend < 0
      ? `тренд ${input.trend} пунктов`
      : 'тренд без изменений'
    : 'тренд пока не рассчитан';
  const noAnswerText = input.noAnswers > 0
    ? `${input.noAnswers} недозвонов из ${input.calls}`
    : 'недозвонов в текущей выборке нет';
  const issueText = input.topIssue
    ? `Главная повторяющаяся проблема — «${input.topIssue}»${input.topIssuePercent ? ` (${input.topIssuePercent}% NO)` : ''}.`
    : 'Явная повторяющаяся проблема по чеклисту пока не выделяется.';

  const subject = input.level === 'network'
    ? 'Сеть'
    : input.level === 'manager'
    ? `Менеджер «${input.name ?? 'без имени'}»`
    : input.level === 'dealership'
    ? `Салон «${input.name ?? 'без названия'}»`
    : input.level === 'holding'
    ? `Дилер «${input.name ?? 'без названия'}»`
    : 'Сравнение';

  const summary = `${subject}: средний балл ${input.score} по ${input.calls} привязанным звонкам, ${trendText}. ${noAnswerText}. ${issueText}`;
  const recommendations: string[] = [];
  if (input.score < 50) {
    recommendations.push('Разобрать звонки с низкой оценкой и назначить точечную тренировку по провальным блокам.');
  } else if (input.score < 76) {
    recommendations.push('Усилить контроль слабых этапов скрипта, чтобы вывести результат выше 76 баллов.');
  } else {
    recommendations.push('Сохранить текущий уровень и продолжать накопление выборки для устойчивых трендов.');
  }
  if (input.noAnswers > 0) {
    recommendations.push('Проверить рабочие часы, доступность номеров и расписание прозвона, чтобы снизить недозвоны.');
  }
  if (input.topIssue) {
    recommendations.push(`Отработать блок «${input.topIssue}» на примерах реальных звонков.`);
  } else if (input.worstDimension) {
    recommendations.push(`Отдельно проверить измерение «${input.worstDimension}» и добавить его в ближайший разбор.`);
  }
  if (typeof input.lowDealerships === 'number' && input.lowDealerships > 0) {
    recommendations.push(`Взять в работу ${input.lowDealerships} точек с баллом ниже 50.`);
  }
  if (typeof input.failsCount === 'number' && input.failsCount > 0) {
    recommendations.push(`Разобрать ${input.failsCount} провальных звонков менеджера как повторяющиеся кейсы.`);
  }

  return {
    summary,
    recommendations: recommendations.slice(0, 3),
    source: 'generated',
  };
}

async function generateAnalyticsAISummary(input: Parameters<typeof buildAnalyticsAISummary>[0]): Promise<AnalyticsAISummary> {
  const fallback = buildAnalyticsAISummary(input);
  if (!config.anthropicApiKey) return fallback;
  try {
    const prompt = [
      'Верни ТОЛЬКО JSON без текста до и после.',
      'Формат: {"summary":"2-3 предложения","recommendations":["рекомендация 1","рекомендация 2","рекомендация 3"]}.',
      'Пиши на русском. Рекомендации должны быть конкретными управленческими действиями.',
      'Данные уровня аналитики:',
      JSON.stringify(input),
    ].join('\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.analyticsAiModel,
        max_tokens: 400,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic status ${response.status}`);
    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = data.content?.map((part) => part.text || '').join('').trim() || '';
    const parsed = JSON.parse(text) as Partial<AnalyticsAISummary>;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const recommendations = Array.isArray(parsed.recommendations)
      ? parsed.recommendations.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : [];
    if (!summary || recommendations.length === 0) throw new Error('Invalid analytics AI summary JSON');
    return { summary, recommendations, source: 'llm' };
  } catch (error) {
    console.warn('[analytics] AI summary fallback:', error instanceof Error ? error.message : error);
    return fallback;
  }
}

function buildComparisonAISummary(input: {
  level: string;
  items: Array<Record<string, unknown>>;
}): AnalyticsAISummary {
  const items = input.items.slice(0, 6);
  const getName = (item: Record<string, unknown>, index: number) => String(item.name ?? item.fullName ?? `Объект ${index + 1}`);
  const getScore = (item: Record<string, unknown>) => Number(item.score ?? item.aiRating ?? item.avgScore ?? 0);
  const getCalls = (item: Record<string, unknown>) => Number(item.calls ?? item.auditsCount ?? item.directCalls ?? 0);
  const getNoAnswers = (item: Record<string, unknown>) => Number(item.noAnswers ?? 0);
  if (items.length < 2) {
    return {
      summary: 'Для анализа различий выберите минимум два объекта.',
      recommendations: ['Отметьте от 2 до 6 объектов в текущей таблице.'],
      source: 'fallback',
    };
  }
  const ranked = items
    .map((item, index) => ({ name: getName(item, index), score: getScore(item), calls: getCalls(item), noAnswers: getNoAnswers(item) }))
    .sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const lagger = ranked[ranked.length - 1];
  const maxNoAnswers = [...ranked].sort((a, b) => b.noAnswers - a.noAnswers)[0];
  return {
    summary: `Лидер сравнения — «${leader.name}» с баллом ${leader.score}. Самый слабый результат у «${lagger.name}» (${lagger.score}); разрыв ${Math.round(leader.score - lagger.score)} пунктов. ${maxNoAnswers.noAnswers > 0 ? `Больше всего недозвонов у «${maxNoAnswers.name}»: ${maxNoAnswers.noAnswers}.` : 'Недозвоны не выделяются как главный фактор различий.'}`,
    recommendations: [
      `Разобрать звонки объекта «${lagger.name}» и найти повторяющиеся NO-блоки.`,
      maxNoAnswers.noAnswers > 0 ? `Проверить расписание и доступность номеров у «${maxNoAnswers.name}».` : 'Сравнить сильные скриптовые блоки лидера со слабым объектом.',
      'Использовать лучшие формулировки лидера как пример для точечной тренировки.',
    ],
    source: 'generated',
  };
}

async function generateComparisonAISummary(input: Parameters<typeof buildComparisonAISummary>[0]): Promise<AnalyticsAISummary> {
  const fallback = buildComparisonAISummary(input);
  if (!config.anthropicApiKey) return fallback;
  try {
    const prompt = [
      'Верни ТОЛЬКО JSON без текста до и после.',
      'Формат: {"summary":"3-4 предложения с анализом различий","recommendations":["рекомендация 1","рекомендация 2","рекомендация 3"]}.',
      'Ты анализируешь сравнение объектов в аналитике звонков. Объясни, почему результаты различаются, и дай конкретные рекомендации слабым объектам.',
      `Данные сравнения: ${JSON.stringify({ level: input.level, items: input.items.slice(0, 6) })}`,
    ].join('\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.analyticsAiModel,
        max_tokens: 400,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic status ${response.status}`);
    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = data.content?.map((part) => part.text || '').join('').trim() || '';
    const parsed = JSON.parse(text) as Partial<AnalyticsAISummary>;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const recommendations = Array.isArray(parsed.recommendations)
      ? parsed.recommendations.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : [];
    if (!summary || recommendations.length === 0) throw new Error('Invalid comparison AI summary JSON');
    return { summary, recommendations, source: 'llm' };
  } catch (error) {
    console.warn('[analytics] comparison AI summary fallback:', error instanceof Error ? error.message : error);
    return fallback;
  }
}

// ---- In-memory cache for admin analytics (Team / Voice dashboard) ----
type TeamSummaryCache = {
  totalAttempts: number;
  avgScore: number;
  levelCounts: { Junior: number; Middle: number; Senior: number };
  topWeaknesses: { weakness: string; count: number }[];
  topStrengths: { strength: string; count: number }[];
  expertSummary: unknown;
};

type VoiceDashboardCache = {
  totalCalls: number;
  answeredPercent: number;
  missedPercent: number;
  avgDurationSec: number;
  outcomeBreakdown: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
};

const ANALYTICS_TTL_MS = 5 * 60 * 1000; // 5 minutes

let teamSummaryCache: { data: TeamSummaryCache | null; expiresAt: number } = {
  data: null,
  expiresAt: 0,
};

let voiceDashboardCache: { data: VoiceDashboardCache | null; expiresAt: number } = {
  data: null,
  expiresAt: 0,
};
import { getTunnelUrl } from './tunnel';
import { getCallSourceInfo } from './voice/dealershipCallSource';

const app = express();

/** Path for Telegram webhook (production). Call registerTelegramWebhook(bot) before startServer(). */
export const WEBHOOK_PATH = '/telegram-webhook';

export function registerTelegramWebhook(bot: Telegraf): void {
  app.post(WEBHOOK_PATH, async (req, res) => {
    try {
      if (!req.body) {
        console.error('[WEBHOOK] No body');
        return res.status(400).end();
      }
      await bot.handleUpdate(req.body, res);
    } catch (err) {
      console.error('[WEBHOOK] Error:', err);
      res.status(500).end();
    }
  });
}
app.use(express.json({ limit: '12mb' }));

// ── In‑memory web training sessions (independent от Telegram) ──
type WebTrainingProfile = 'normal' | 'thorough' | 'pressure';

type WebTrainingSession = {
  id: string;
  strictness: Strictness;
  profile: WebTrainingProfile;
  state: any;
  car: ReturnType<typeof loadCar>;
  dialogHistory: { role: 'client' | 'manager'; content: string }[];
  behaviorSignals: BehaviorSignal[];
};

type WebTrainingResult = {
  verdict: 'pass' | 'fail';
  totalScore: number;
  qualityTag: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  reasonCode: string | null;
};

const webTrainingSessions = new Map<string, WebTrainingSession>();

function createWebSessionId(): string {
  return `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRu(text: string): string {
  return text.toLowerCase().replace(/[ё]/g, 'е').replace(/\s+/g, ' ').trim();
}

const HARD_RUDE_PATTERNS = [
  'пошел на',
  'пошел ты',
  'пошла ты',
  'да пошел ты',
  'иди на',
  'заткнись',
  'отвали',
  'мне насрать',
  'мне плевать',
  'сами разбирайтесь',
  'закрой рот',
  'не твое дело',
  'достал',
  'задолбал',
];

function isHardRude(text: string): boolean {
  const n = normalizeRu(text);
  return HARD_RUDE_PATTERNS.some((p) => n.includes(p));
}

function shouldForceConversationEnd(clientMessage: string): boolean {
  const n = normalizeRu(clientMessage);
  return (
    n.includes('не готов продолжать разговор') ||
    n.includes('на этом, пожалуй, закончим') ||
    n.includes('видимо, сейчас не лучшее время') ||
    n.includes('пожалуй, обращусь в другой салон') ||
    n.includes('всего доброго') ||
    n.includes('до свидания')
  );
}

async function runWebTrainingTurn(params: {
  sessionId: string;
  message: string;
  replyMode: 'text' | 'text+voice';
  ttsVoice: TtsVoice;
}): Promise<{ clientMessage: string; endConversation: boolean; audioBase64: string | null; result: WebTrainingResult | null }> {
  const { sessionId, message, replyMode, ttsVoice } = params;
  const sess = webTrainingSessions.get(sessionId);
  if (!sess) {
    throw new Error('SESSION_NOT_FOUND');
  }

  const { car, strictness } = sess;
  const state = { ...sess.state };
  const historyBefore = [...sess.dialogHistory];
  const history = [...historyBefore, { role: 'manager' as const, content: message }];
  const max_client_turns = (state.strictnessState?.max_client_turns as number) ?? 12;
  const behavior = classifyBehavior(message, {
    lastClientQuestion: [...historyBefore].reverse().find((m) => m.role === 'client')?.content,
    isClientWaitingAnswer: true,
  });
  const hardRude = isHardRude(message);
  const behaviorSignals = [...sess.behaviorSignals, behavior];

  if (behavior.toxic || hardRude || behavior.disengaging) {
    const toxicReply =
      behavior.disengaging
        ? 'Понимаю. Не буду больше отвлекать. Спасибо за время, всего доброго.'
        : behavior.severity === 'HIGH' || hardRude
        ? 'Извините, но я не готов продолжать разговор в таком тоне. Всего доброго.'
        : 'Мне бы хотелось более уважительного общения. На этом, пожалуй, закончим.';
    const newHistory = [...history, { role: 'client' as const, content: toxicReply }];
    const result = buildWebTrainingResult(
      state,
      newHistory,
      behaviorSignals,
      true,
      behavior.disengaging ? 'DISENGAGEMENT' : 'BAD_TONE',
    );
    webTrainingSessions.delete(sessionId);
    return { clientMessage: toxicReply, endConversation: true, audioBase64: null, result };
  }

  if (behavior.low_effort) state.low_effort_streak = (state.low_effort_streak ?? 0) + 1;
  else state.low_effort_streak = 0;

  const lowQualityStreak = behaviorSignals.reduce((acc, s) => (s.low_quality ? acc + 1 : 0), 0);
  if ((state.low_effort_streak ?? 0) >= 3 || lowQualityStreak >= 2) {
    const failReply =
      'Я задаю конкретные вопросы и хотел бы получать развёрнутые ответы. Видимо, сейчас не лучшее время. До свидания.';
    const newHistory = [...history, { role: 'client' as const, content: failReply }];
    const result = buildWebTrainingResult(
      state,
      newHistory,
      behaviorSignals,
      true,
      lowQualityStreak >= 2 ? 'REPEATED_LOW_QUALITY' : 'REPEATED_LOW_EFFORT',
    );
    webTrainingSessions.delete(sessionId);
    return { clientMessage: failReply, endConversation: true, audioBase64: null, result };
  }

  const out = await getVirtualClientReply({
    car,
    dealership: buildDealershipFromCar(car),
    state,
    manager_last_message: message,
    dialog_history: history,
    strictness,
    max_client_turns,
    behaviorSignal: behavior,
    maxResponseTokens: 220,
  });

  state.phase = out.diagnostics.current_phase;
  let topicMap = { ...state.topics };
  for (const code of out.diagnostics.topics_addressed as TopicCode[]) {
    if (!topicMap[code]) continue;
    const currentStatus = topicMap[code].status;
    const next = currentStatus === 'none' ? 'asked' : currentStatus === 'asked' ? 'answered' : currentStatus;
    const result = advanceTopic(topicMap, code, next as any);
    if (result.valid) topicMap = result.map;
  }
  for (const code of out.diagnostics.topics_evaded as TopicCode[]) {
    if (!topicMap[code]) continue;
    topicMap = recordEvasion(topicMap, code);
  }
  state.topics = topicMap;

  const nextState = {
    ...state,
    stage: out.update_state.stage,
    checklist: { ...state.checklist, ...out.update_state.checklist },
    notes: out.update_state.notes,
    client_turns: out.update_state.client_turns,
  };

  const newHistory = [...history, { role: 'client' as const, content: out.client_message }];
  const evasionCheck = checkCriticalEvasions(topicMap);
  if (evasionCheck.shouldFail) {
    const evasionReply =
      'Я дважды задал важный вопрос и не получил ответа. Пожалуй, обращусь в другой салон.';
    const failHistory = [...history, { role: 'client' as const, content: evasionReply }];
    const result = buildWebTrainingResult(nextState, failHistory, behaviorSignals, true, `CRITICAL_EVASION:${evasionCheck.failedTopic}`);
    webTrainingSessions.delete(sessionId);
    return { clientMessage: evasionReply, endConversation: true, audioBase64: null, result };
  }

  const endConversation = Boolean(out.end_conversation) || shouldForceConversationEnd(out.client_message);
  const result = endConversation
    ? buildWebTrainingResult(nextState, newHistory, behaviorSignals, false, null)
    : null;
  if (endConversation) {
    webTrainingSessions.delete(sessionId);
  } else {
    webTrainingSessions.set(sessionId, {
      ...sess,
      state: nextState,
      dialogHistory: newHistory,
      behaviorSignals,
    });
  }

  let audioBase64: string | null = null;
  if (replyMode === 'text+voice' && out.client_message.trim()) {
    try {
      const buf = await generateSpeechBuffer(out.client_message, ttsVoice);
      if (buf.length) audioBase64 = buf.toString('base64');
    } catch (e) {
      console.error('[web-training] TTS turn error:', e);
    }
  }

  return {
    clientMessage: out.client_message,
    endConversation,
    audioBase64,
    result,
  };
}

function buildWebTrainingResult(
  state: any,
  history: { role: 'client' | 'manager'; content: string }[],
  behaviorSignals: BehaviorSignal[],
  forcedFail: boolean,
  reasonCode: string | null,
): WebTrainingResult {
  const toxicCount = behaviorSignals.filter((s) => s.toxic).length;
  const lowEffortCount = behaviorSignals.filter((s) => s.low_effort).length;
  const evasionCount = behaviorSignals.filter((s) => s.evasion).length;
  const highSeverityCount = behaviorSignals.filter((s) => s.severity === 'HIGH').length;
  const prohibitedUnique = new Set(behaviorSignals.flatMap((s) => s.prohibited_phrase_hits)).size;
  const turns = history.filter((m) => m.role === 'manager').length;
  const criticalEvasion = behaviorSignals.some((s) => s.evasion) && String(reasonCode || '').startsWith('CRITICAL_EVASION');

  let score = 82;
  score -= toxicCount * 28;
  score -= lowEffortCount * 12;
  score -= evasionCount * 10;
  score -= highSeverityCount * 10;
  score -= prohibitedUnique * 6;
  if (turns >= 4) score += 5;
  if (turns >= 7) score += 3;
  if (forcedFail) score = Math.min(score, toxicCount > 0 ? 18 : criticalEvasion ? 28 : 35);
  score = Math.max(0, Math.min(100, Math.round(score)));

  const verdict: 'pass' | 'fail' = forcedFail || score < 60 ? 'fail' : 'pass';
  const qualityTag =
    score >= 80 ? 'Хорошо' : score >= 60 ? 'Средне' : 'Нужно улучшить';

  const strengths: string[] = [];
  if (toxicCount === 0) strengths.push('Корректный тон общения');
  if (lowEffortCount <= 1) strengths.push('Ответы в основном содержательные');
  if (evasionCount === 0) strengths.push('Не уходили от ключевых вопросов клиента');
  if (!strengths.length) strengths.push('Диалог состоялся, можно улучшать качество обработки возражений');

  const weaknesses: string[] = [];
  if (lowEffortCount > 0) weaknesses.push(`Короткие/слабые ответы: ${lowEffortCount}`);
  if (evasionCount > 0) weaknesses.push(`Уход от вопросов клиента: ${evasionCount}`);
  if (prohibitedUnique > 0) weaknesses.push('Использовались нежелательные формулировки');
  if (toxicCount > 0) weaknesses.push('Нарушен тон коммуникации');
  if (!weaknesses.length) weaknesses.push('Существенных провалов в коммуникации не обнаружено');

  const recommendations: string[] = [];
  if (lowEffortCount > 0) recommendations.push('Давать развёрнутый ответ на каждый вопрос клиента');
  if (evasionCount > 0) recommendations.push('Не уходить от прямых вопросов, сначала закрывать их');
  if (prohibitedUnique > 0) recommendations.push('Убрать фразы вроде "посмотрите на сайте"/"я не знаю"');
  if (toxicCount > 0) recommendations.push('Сохранять вежливый и уважительный тон в любых ситуациях');
  if (!recommendations.length) recommendations.push('Поддерживать текущий уровень и фокусироваться на закрытии на следующий шаг');

  const summary =
    verdict === 'pass'
      ? 'Тестирование завершено успешно. Менеджер удержал диалог и дал приемлемые ответы.'
      : 'Тестирование завершено с отрицательным результатом. Качество ответов и ведения диалога требует улучшения.';

  return {
    verdict,
    totalScore: score,
    qualityTag,
    summary,
    strengths,
    weaknesses,
    recommendations,
    reasonCode,
  };
}

type TrainerTranscriptTurn = {
  role: 'client' | 'manager';
  text: string;
  durationSec?: number | null;
  createdAt?: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
};

function wavBase64FromPcm16Base64(audioBase64: string, sampleRate = 16000): string {
  const pcm = Buffer.from(audioBase64, 'base64');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

function trainerScenarioPrompt(caseContext: Record<string, unknown>, transcript: TrainerTranscriptTurn[] = [], ttsVoice?: TtsVoice): string {
  const scenario = caseContext.scenario && typeof caseContext.scenario === 'object'
    ? caseContext.scenario as Record<string, unknown>
    : {};
  const company = caseContext.company && typeof caseContext.company === 'object'
    ? caseContext.company as Record<string, unknown>
    : {};
  const clientProfile = caseContext.clientProfile && typeof caseContext.clientProfile === 'object'
    ? caseContext.clientProfile as Record<string, unknown>
    : {};
  const importedItem = caseContext.importedItem && typeof caseContext.importedItem === 'object'
    ? caseContext.importedItem as Record<string, unknown>
    : {};
  const age = Number(clientProfile.age);
  const ageLabel = Number.isFinite(age) ? String(Math.round(age)) : '';
  const voiceName = String(clientProfile.voiceName || '').trim() || ttsVoiceName(ttsVoice);
  const scenarioQuestions = Array.isArray(scenario.questions)
    ? scenario.questions as Array<{ text?: string; question?: string; required?: boolean }>
    : [];
  const scenarioObjections = Array.isArray(scenario.objections)
    ? scenario.objections as Array<{ phrase?: string; whenAppropriate?: string }>
    : [];
  const scenarioCriteria = Array.isArray(scenario.successCriteria)
    ? scenario.successCriteria as Array<{ expectedAnswer?: string; score?: number }>
    : [];
  const scenarioCore = buildCustomerScenarioPromptCore({
    age: ageLabel,
    temperament: String(clientProfile.temperament || ''),
    patience: String(clientProfile.patience || ''),
    replyLength: String(clientProfile.replyLength || ''),
    communicationStyle: String(clientProfile.communicationStyle || ''),
    context: String(scenario.context || ''),
    itemTitle: String(importedItem.title || scenario.name || ''),
    itemDescription: String(importedItem.description || company.branchName || company.name || ''),
    voiceName,
    questions: scenarioQuestions,
    objections: scenarioObjections,
    criteria: scenarioCriteria,
  });
  const previous = transcript.length
    ? transcript.map((turn) => `${turn.role === 'manager' ? 'Менеджер' : 'Клиент'}: ${turn.text}`).join('\n')
    : 'Диалог только начинается.';
  const companyName = String(company.name || company.branchName || 'Компания').trim();
  const companyDescription = String(company.description || company.branchDescription || '').trim() || 'Описание не указано.';

  return [
    '=== РОЛЬ (КРИТИЧНО) ===',
    'Ты — ПОКУПАТЕЛЬ (клиент), который САМ ЗВОНИТ сотруднику компании по конкретному предложению/данным из выборки. На другом конце провода — СОТРУДНИК/МЕНЕДЖЕР. Ты тестируешь: насколько хорошо он общается, даёт информацию, отвечает на вопросы, отрабатывает возражения и доводит до следующего шага.',
    'Ты НИКОГДА не сотрудник и не менеджер. Запрещено говорить фразы менеджера: «Слушаю вас», «Для чего вам нужно?», «Какой у вас бюджет?», «Понял, вам важно…». Ты — клиент: отвечаешь на вопросы о себе и задаёшь вопросы по предложению, условиям, деталям и следующему шагу.',
    'Формируй ответы не как письменный текст, а как текст, предназначенный для озвучивания. Если слово может быть неправильно произнесено TTS - напиши его в фонетически более удобной форме для сохранения естественного звучания (например, ударение пишется большой буквой, скажем "перспектИва"). Задавая вопросы формулируй их по разному, чтобы звучало как реальный диалог, а не как анкета.',
    '',
    '=== ГОЛОСОВОЙ ПОМОЩНИК / АВТООТВЕТЧИК (КРИТИЧНО) ===',
    'Если в начале разговора или в любой момент становится понятно, что на другом конце не живой сотрудник, а голосовой помощник, автоответчик, виртуальный ассистент или сервис записи сообщений, НЕ продолжай обычный сценарий диалога.',
    '',
    'К признакам относятся, например:',
    '- собеседник сообщает, что абонент занят или недоступен;',
    '- предлагает оставить сообщение;',
    '- говорит, что может записать информацию;',
    '- представляется голосовым помощником, виртуальным ассистентом или секретарём;',
    '- просит говорить после сигнала или обещает передать сообщение владельцу.',
    '',
    'В этом случае:',
    '',
    '1. Один раз произнеси ровно:',
    '   "Прошу прощения, до свидания."',
    '',
    '2. Сразу после этого вызови:',
    '   end_call({ "reason": "voicemail" })',
    '',
    'После обнаружения голосового помощника запрещено:',
    '- продолжать разговор;',
    '- задавать вопросы;',
    '- повторять первую реплику;',
    '- пытаться пройти сценарий продажи;',
    '- вызывать end_call с любой другой причиной.',
    '',
    'Исключение: если обнаружен голосовой помощник или автоответчик, не выполняй обычный сценарий завершения разговора. Вместо этого используй только сценарий "ГОЛОСОВОЙ ПОМОЩНИК / АВТООТВЕТЧИК".',
    '',
    '=== ИНФОРМАЦИЯ О КОМПАНИИ ===',
    `Название компании: ${companyName}`,
    `Описание компании: ${companyDescription}`,
    '',
    scenarioCore,
    '',
    '=== ЗАВЕРШЕНИЕ ДИАЛОГА ===',
    'Завершай разговор, когда договорились о следующем шаге, разговор естественно исчерпан, или сотрудник ведёт себя грубо/неадекватно. В конце чётко скажи прощание: «До свидания», «Хорошо, тогда на этом закончим», «Спасибо, до свидания».',
    'После завершения диалога вызови функцию end_call.',
    '',
    '=== ТЕХНИЧЕСКИЙ СИГНАЛ ДЛЯ ЗАВЕРШЕНИЯ ЗВОНКА ===',
    'После своей последней фразы прощания обязательно один раз вызови функцию end_call с краткой причиной: { "reason": "next_step_scheduled" }, { "reason": "will_think" }, { "reason": "bad_tone" } или другой короткой причиной. Не вызывай end_call раньше последней реплики и не вызывай дважды. Вызови только в конце реплики завершения разговора.',
    '',
    '=== ЯЗЫК И СТИЛЬ ===',
    'Язык: только русский. Тон: реалистичный клиент, не поддакивающий. Длина: 1–3 предложения на реплику. Без эмодзи, без мета-комментариев. Не выходи из роли.',
    '',
    `=== ИСТОРИЯ ДИАЛОГА ===\n${previous}`,
  ].filter(Boolean).join('\n\n');
}

function trainerInitialClientMessage(caseContext: Record<string, unknown>): string {
  const scenario = caseContext.scenario && typeof caseContext.scenario === 'object'
    ? caseContext.scenario as Record<string, unknown>
    : {};
  const company = caseContext.company && typeof caseContext.company === 'object'
    ? caseContext.company as Record<string, unknown>
    : {};
  const clientProfile = caseContext.clientProfile && typeof caseContext.clientProfile === 'object'
    ? caseContext.clientProfile as Record<string, unknown>
    : {};
  const importedItem = caseContext.importedItem && typeof caseContext.importedItem === 'object'
    ? caseContext.importedItem as Record<string, unknown>
    : {};
  const itemTitle = String(importedItem.title || '').trim();
  const scenarioName = String(scenario.name || '').trim();
  const city = String(company.city || clientProfile.city || '').trim();
  if (itemTitle) {
    return `Да, здравствуйте. Я звоню по поводу ${itemTitle}. Скажите, он еще в наличии и предложение актуально?`;
  }
  if (scenarioName) {
    return `Да, здравствуйте. Я звоню по поводу ${scenarioName.toLowerCase()}${city ? ` в городе ${city}` : ''}. Скажите, предложение еще актуально?`;
  }
  return `Здравствуйте. Я выбираю автомобиль${city ? ` в городе ${city}` : ''} и хочу уточнить несколько моментов.`;
}

type TrainerRuntimeContext = {
  strictness: Strictness;
  profile: WebTrainingProfile;
  state: any;
  car: ReturnType<typeof loadCar>;
  behaviorSignals: BehaviorSignal[];
  elevenLabsConversationId?: string | null;
};

const USE_ELEVENLABS_AGENT_FOR_WEB_TRAINER = false;

function getTrainerRuntime(caseContext: Record<string, unknown>): TrainerRuntimeContext {
  const runtime = caseContext.runtime && typeof caseContext.runtime === 'object'
    ? caseContext.runtime as Partial<TrainerRuntimeContext>
    : {};
  const profile = runtime.profile === 'thorough' || runtime.profile === 'pressure' || runtime.profile === 'normal'
    ? runtime.profile
    : 'normal';
  const strictness = runtime.strictness === 'low' || runtime.strictness === 'high' || runtime.strictness === 'medium'
    ? runtime.strictness
    : 'medium';
  return {
    strictness,
    profile,
    state: runtime.state && typeof runtime.state === 'object' ? runtime.state : getDefaultState(profile),
    car: runtime.car && typeof runtime.car === 'object' ? runtime.car as ReturnType<typeof loadCar> : loadCar(),
    behaviorSignals: Array.isArray(runtime.behaviorSignals) ? runtime.behaviorSignals as BehaviorSignal[] : [],
    elevenLabsConversationId: typeof runtime.elevenLabsConversationId === 'string' ? runtime.elevenLabsConversationId : null,
  };
}

function withTrainerRuntime(caseContext: Record<string, unknown>, runtime: TrainerRuntimeContext): Record<string, unknown> {
  return {
    ...caseContext,
    runtime,
  };
}

async function ttsBase64(
  text: string,
  replyMode: 'text' | 'text+voice',
  ttsVoice: TtsVoice,
  elevenLabsVoiceId?: string | null,
): Promise<string | null> {
  if (replyMode !== 'text+voice' || !text.trim()) return null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const buf = elevenLabsVoiceId?.trim()
        ? await generateSpeechElevenLabsVoice(text, elevenLabsVoiceId.trim())
        : await generateSpeechBuffer(text, ttsVoice);
      return buf.length ? buf.toString('base64') : null;
    } catch (error) {
      console.error(`[trainer] TTS error attempt=${attempt}:`, error);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }
  }
  return null;
}

/** Prefer voice bubbles, but keep the trainer flow alive if TTS is temporarily unavailable. */
async function ensureTrainerClientAudio(params: {
  text: string;
  ttsVoice: TtsVoice;
  elevenLabsVoiceId?: string | null;
  audioBase64?: string | null;
  audioMimeType?: string | null;
}): Promise<{ audioBase64: string | null; audioMimeType: string | null }> {
  if (params.audioBase64) {
    return {
      audioBase64: params.audioBase64,
      audioMimeType: params.audioMimeType ?? null,
    };
  }
  const audioBase64 = await ttsBase64(params.text, 'text+voice', params.ttsVoice, params.elevenLabsVoiceId);
  if (!audioBase64) {
    console.warn('[trainer] TTS unavailable, returning text-only client message');
    return { audioBase64: null, audioMimeType: null };
  }
  return { audioBase64, audioMimeType: 'audio/mpeg' };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function fallbackTrainerDialogTitle(transcript: TrainerTranscriptTurn[]): string | null {
  const firstClient = transcript.find((turn) => turn.role === 'client' && String(turn.text || '').trim());
  if (!firstClient) return null;
  let text = String(firstClient.text || '').trim();
  text = text
    .replace(/^(здравствуйте|добрый день|добрый вечер|доброе утро)[!,.]?\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 8) return null;
  const clause = text.split(/[.!?]/)[0]?.trim() || text;
  if (clause.length < 8) return null;
  return clause.length > 56 ? `${clause.slice(0, 53).trim()}…` : clause;
}

async function generateTrainerDialogTitle(transcript: TrainerTranscriptTurn[]): Promise<string | null> {
  const fallback = fallbackTrainerDialogTitle(transcript);
  const clientLines = transcript
    .filter((turn) => turn.role === 'client' && String(turn.text || '').trim())
    .slice(0, 4)
    .map((turn) => String(turn.text).trim());
  if (!clientLines.length) return fallback;
  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      temperature: 0.4,
      max_tokens: 48,
      messages: [
        {
          role: 'system',
          content: 'Сформулируй короткое название тренировки по запросу клиента (что хочет купить/узнать). Только название на русском, 3–7 слов, без кавычек, без точки, без слова «тренировка».',
        },
        {
          role: 'user',
          content: `Реплики клиента:\n${clientLines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`,
        },
      ],
    });
    const raw = String(response.choices[0]?.message?.content || '')
      .trim()
      .replace(/^["«»']+|["«»']+$/g, '')
      .replace(/[.!?]+$/g, '')
      .trim();
    if (raw.length >= 4 && raw.length <= 80) return raw;
  } catch (error) {
    console.warn('[trainer] dialog title generation failed:', error instanceof Error ? error.message : error);
  }
  return fallback;
}

async function finalizeTrainerSessionEvaluation(params: {
  sessionId: string;
  caseContext: Record<string, unknown>;
  runtime: TrainerRuntimeContext;
  transcript: TrainerTranscriptTurn[];
  forcedFail: boolean;
  failureReason: string | null;
  multiplier: number;
}): Promise<void> {
  const audit = await buildTrainerAuditEvaluation({
    caseContext: params.caseContext,
    runtime: params.runtime,
    transcript: params.transcript,
    forcedFail: params.forcedFail,
    failureReason: params.failureReason,
  });
  const title = await generateTrainerDialogTitle(params.transcript);
  const finalPoints = params.forcedFail ? 0 : Math.round(audit.score * params.multiplier);
  const nextCaseContext = {
    ...params.caseContext,
    ...(title ? { dialogTitle: title } : {}),
  };
  await prisma.trainerSession.update({
    where: { id: params.sessionId },
    data: {
      score: audit.score,
      baseScore: audit.score,
      finalPoints,
      evaluationJson: jsonStringify(audit.evaluation),
      dimensionsJson: jsonStringify(audit.dimensions),
      checklistResultsJson: jsonStringify(audit.checklist),
      objectionsAnalysisJson: jsonStringify(audit.issues),
      topRecommendationsJson: jsonStringify(audit.recommendations),
      caseContextJson: jsonStringify(nextCaseContext),
    },
  });
  if (title) {
    try {
      await prisma.trainerSession.update({
        where: { id: params.sessionId },
        data: { title },
      });
    } catch (error) {
      console.warn('[trainer] failed to persist session title column:', error instanceof Error ? error.message : error);
    }
  }
  await finalizeTrainerSessionSideEffects(params.sessionId);
}

async function buildTrainerAuditEvaluation(params: {
  caseContext: Record<string, unknown>;
  runtime: TrainerRuntimeContext;
  transcript: TrainerTranscriptTurn[];
  forcedFail: boolean;
  failureReason: string | null;
}) {
  const evaluated = await evaluateSessionV2({
    dialogHistory: params.transcript
      .filter((turn) => turn.text?.trim())
      .map((turn) => ({ role: turn.role, content: turn.text })),
    car: params.runtime.car,
    state: params.runtime.state,
    earlyFail: params.forcedFail,
    failureReason: params.failureReason ?? undefined,
    behaviorSignals: params.runtime.behaviorSignals,
  });
  const evaluation = evaluated.evaluation;
  const scenario = params.caseContext.scenario && typeof params.caseContext.scenario === 'object'
    ? params.caseContext.scenario as Record<string, unknown>
    : {};
  const planCriteria = await evaluateScriptCriteria(scenario.successCriteria, params.transcript);
  const planCriteriaScore = extractPlanCriteriaEvaluation(planCriteria && typeof planCriteria === 'object' ? { plan_criteria: planCriteria } : null)?.percent ?? null;
  let finalEvaluation: Record<string, unknown> = {
    ...evaluation,
    plan_criteria: planCriteria,
  };
  try {
    const unifiedTrainerReport = await generateUnifiedTrainerReport({
      transcript: params.transcript
        .filter((turn) => turn.text?.trim())
        .map((turn) => ({ role: turn.role, text: turn.text })),
      totalScore: planCriteriaScore ?? evaluation.overall_score_0_100,
      evaluation: finalEvaluation,
      scenarioName: String(scenario.name || 'Тренировка'),
    });
    finalEvaluation = {
      ...finalEvaluation,
      unified_call_report: unifiedTrainerReport,
    };
  } catch (error) {
    console.warn('[trainer] unified report generation failed:', error instanceof Error ? error.message : error);
  }
  const checklist = evaluation.checklist.map((item) => ({
    code: item.code,
    status: item.status,
    comment: item.comment,
    evidence: item.evidence,
  }));
  const issues = evaluation.issues.map((issue) => ({
    issue_type: issue.issue_type,
    severity: issue.severity,
    evidence: issue.evidence,
    recommendation: issue.recommendation,
  }));
  return {
    evaluation: finalEvaluation,
    checklist,
    issues,
    recommendations: evaluation.recommendations.map((text) => ({
      title: text,
      description: 'Отработать в следующей тренировке',
    })),
    score: planCriteriaScore ?? evaluation.overall_score_0_100,
    dimensions: evaluation.dimension_scores,
  };
}

async function persistTrainerDialogTitle(sessionId: string, caseContext: Record<string, unknown>, title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const nextCaseContext = {
    ...caseContext,
    dialogTitle: trimmed,
  };
  await prisma.trainerSession.update({
    where: { id: sessionId },
    data: { caseContextJson: jsonStringify(nextCaseContext) },
  });
  try {
    await prisma.trainerSession.update({
      where: { id: sessionId },
      data: { title: trimmed },
    });
  } catch (error) {
    console.warn('[trainer] failed to persist session title column:', error instanceof Error ? error.message : error);
  }
}

async function assignTrainerDialogTitle(sessionId: string, caseContext: Record<string, unknown>, transcript: TrainerTranscriptTurn[]) {
  const quickTitle = fallbackTrainerDialogTitle(transcript);
  if (quickTitle) {
    await persistTrainerDialogTitle(sessionId, caseContext, quickTitle);
  }
  void generateTrainerDialogTitle(transcript).then(async (llmTitle) => {
    if (!llmTitle || llmTitle === quickTitle) return;
    const fresh = await prisma.trainerSession.findUnique({
      where: { id: sessionId },
      select: { caseContextJson: true },
    });
    const latestContext = fresh
      ? safeJsonParseLocal<Record<string, unknown>>(fresh.caseContextJson, caseContext)
      : caseContext;
    await persistTrainerDialogTitle(sessionId, latestContext, llmTitle);
  }).catch((error) => {
    console.warn('[trainer] async dialog title failed:', error instanceof Error ? error.message : error);
  });
}

async function initializeTrainerDialog(params: {
  sessionId: string;
  replyMode: 'text' | 'text+voice';
  ttsVoice: TtsVoice;
}) {
  const session = await prisma.trainerSession.findUnique({ where: { id: params.sessionId } });
  if (!session) throw new Error('TRAINER_SESSION_NOT_FOUND');

  const existingTranscript = safeArray<TrainerTranscriptTurn>(session.transcriptJson);
  if (existingTranscript.length > 0) {
    const lastClient = [...existingTranscript].reverse().find((turn) => turn.role === 'client');
    return {
      clientMessage: lastClient?.text ?? '',
      audioBase64: lastClient?.audioBase64 ?? null,
      audioMimeType: lastClient?.audioMimeType ?? null,
      transcript: existingTranscript,
    };
  }

  const caseContext = safeJsonParseLocal<Record<string, unknown>>(session.caseContextJson, {});
  const elevenLabsVoiceId = trainerElevenLabsVoiceId(caseContext);

  const finalizeFirstTurn = async (input: {
    clientMessage: string;
    audioBase64: string | null;
    audioMimeType?: string | null;
    caseContext: Record<string, unknown>;
    extraSessionData?: Record<string, unknown>;
  }) => {
    let audioBase64 = input.audioBase64;
    let audioMimeType = input.audioMimeType ?? null;
    const ensured = await ensureTrainerClientAudio({
      text: input.clientMessage,
      ttsVoice: params.ttsVoice,
      elevenLabsVoiceId,
      audioBase64,
      audioMimeType,
    });
    audioBase64 = ensured.audioBase64;
    audioMimeType = ensured.audioMimeType;
    const transcript: TrainerTranscriptTurn[] = [{
      role: 'client',
      text: input.clientMessage,
      createdAt: new Date().toISOString(),
      audioBase64,
      audioMimeType,
    }];
    const quickTitle = fallbackTrainerDialogTitle(transcript);
    const caseContextWithTitle = quickTitle
      ? { ...input.caseContext, dialogTitle: quickTitle }
      : input.caseContext;
    await prisma.trainerSession.update({
      where: { id: session.id },
      data: {
        transcriptJson: jsonStringify(transcript),
        caseContextJson: jsonStringify(caseContextWithTitle),
        ...(input.extraSessionData || {}),
      },
    });
    if (quickTitle) {
      try {
        await prisma.trainerSession.update({
          where: { id: session.id },
          data: { title: quickTitle },
        });
      } catch (error) {
        console.warn('[trainer] failed to persist session title column:', error instanceof Error ? error.message : error);
      }
      void generateTrainerDialogTitle(transcript).then(async (llmTitle) => {
        if (!llmTitle || llmTitle === quickTitle) return;
        const fresh = await prisma.trainerSession.findUnique({
          where: { id: session.id },
          select: { caseContextJson: true },
        });
        const latestContext = fresh
          ? safeJsonParseLocal<Record<string, unknown>>(fresh.caseContextJson, caseContextWithTitle)
          : caseContextWithTitle;
        await persistTrainerDialogTitle(session.id, latestContext, llmTitle);
      }).catch((error) => {
        console.warn('[trainer] async dialog title failed:', error instanceof Error ? error.message : error);
      });
    } else {
      await assignTrainerDialogTitle(session.id, caseContextWithTitle, transcript);
    }
    return {
      clientMessage: input.clientMessage,
      audioBase64,
      audioMimeType,
      transcript,
    };
  };

  if (USE_ELEVENLABS_AGENT_FOR_WEB_TRAINER && isElevenLabsAgentEnabled()) {
    try {
      const firstMessage = trainerInitialClientMessage(caseContext);
      const agentOut = await runElevenLabsAgentTurn({
        sessionId: session.id,
        prompt: trainerScenarioPrompt(caseContext, existingTranscript, params.ttsVoice),
        firstMessage,
        elevenLabsVoiceId,
      });
      const clientMessage = agentOut.clientMessage || firstMessage;
      const runtime = getTrainerRuntime(caseContext);
      const nextRuntime = {
        ...runtime,
        elevenLabsConversationId: agentOut.conversationId,
      };
      return await finalizeFirstTurn({
        clientMessage,
        audioBase64: agentOut.audioBase64,
        audioMimeType: agentOut.audioMimeType,
        caseContext: withTrainerRuntime(caseContext, nextRuntime),
        extraSessionData: { elevenLabsConversationId: agentOut.conversationId },
      });
    } catch (error) {
      console.error('[trainer] ElevenLabs agent init error:', error);
    }
  }

  const runtime = getTrainerRuntime(caseContext);
  const maxClientTurns = runtime.strictness === 'low' ? 8 : runtime.strictness === 'high' ? 14 : 12;
  const state = {
    ...runtime.state,
    strictnessState: { strictness: runtime.strictness, max_client_turns: maxClientTurns },
  };
  const nextState = {
    ...state,
    client_turns: 1,
  };
  const nextRuntime = { ...runtime, state: nextState };
  return finalizeFirstTurn({
    clientMessage: trainerInitialClientMessage(caseContext),
    audioBase64: null,
    caseContext: withTrainerRuntime(caseContext, nextRuntime),
  });
}

async function runTrainerSessionTurn(params: {
  sessionId: string;
  managerText: string;
  durationSec: number | null;
  replyMode: 'text' | 'text+voice';
  ttsVoice: TtsVoice;
  managerAudioBase64?: string | null;
  managerAudioMimeType?: string | null;
}) {
  const session = await prisma.trainerSession.findUnique({ where: { id: params.sessionId } });
  if (!session) throw new Error('TRAINER_SESSION_NOT_FOUND');
  if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
    throw new Error('TRAINER_SESSION_CLOSED');
  }

  const caseContext = safeJsonParseLocal<Record<string, unknown>>(session.caseContextJson, {});
  const elevenLabsVoiceId = trainerElevenLabsVoiceId(caseContext);
  const runtime = getTrainerRuntime(caseContext);
  const transcriptBefore = safeArray<TrainerTranscriptTurn>(session.transcriptJson);
  const phoneScenarioPrompt = trainerScenarioPrompt(caseContext, transcriptBefore, params.ttsVoice);
  const historyBefore = transcriptBefore.map((turn) => ({ role: turn.role, content: turn.text }));
  const history = [...historyBefore, { role: 'manager' as const, content: params.managerText }];
  const state = { ...runtime.state };
  const maxClientTurns = (state.strictnessState?.max_client_turns as number) ?? 12;
  const behavior = classifyBehavior(params.managerText, {
    lastClientQuestion: [...historyBefore].reverse().find((turn) => turn.role === 'client')?.content,
    isClientWaitingAnswer: true,
  });
  const hardRude = isHardRude(params.managerText);
  const behaviorSignals = [...runtime.behaviorSignals, behavior];

  let clientMessage = '';
  let clientAudioBase64: string | null = null;
  let clientAudioMimeType: string | null = null;
  let nextState = state;
  let nextHistory: { role: 'client' | 'manager'; content: string }[] = [];
  let endConversation = false;
  let result: WebTrainingResult | null = null;
  let nextElevenLabsConversationId = runtime.elevenLabsConversationId ?? null;

  if (behavior.toxic || hardRude || behavior.disengaging) {
    clientMessage = behavior.disengaging
      ? 'Понимаю. Не буду больше отвлекать. Спасибо за время, всего доброго.'
      : behavior.severity === 'HIGH' || hardRude
      ? 'Извините, но я не готов продолжать разговор в таком тоне. Всего доброго.'
      : 'Мне бы хотелось более уважительного общения. На этом, пожалуй, закончим.';
    nextHistory = [...history, { role: 'client', content: clientMessage }];
    result = buildWebTrainingResult(state, nextHistory, behaviorSignals, true, behavior.disengaging ? 'DISENGAGEMENT' : 'BAD_TONE');
    endConversation = true;
  } else {
    if (behavior.low_effort) state.low_effort_streak = (state.low_effort_streak ?? 0) + 1;
    else state.low_effort_streak = 0;
    const lowQualityStreak = behaviorSignals.reduce((acc, signal) => (signal.low_quality ? acc + 1 : 0), 0);
    if ((state.low_effort_streak ?? 0) >= 3 || lowQualityStreak >= 2) {
      clientMessage = 'Я задаю конкретные вопросы и хотел бы получать развёрнутые ответы. Видимо, сейчас не лучшее время. До свидания.';
      nextHistory = [...history, { role: 'client', content: clientMessage }];
      result = buildWebTrainingResult(state, nextHistory, behaviorSignals, true, lowQualityStreak >= 2 ? 'REPEATED_LOW_QUALITY' : 'REPEATED_LOW_EFFORT');
      endConversation = true;
    } else if (USE_ELEVENLABS_AGENT_FOR_WEB_TRAINER && isElevenLabsAgentEnabled()) {
      try {
        console.log(`[trainer] ElevenLabs agent turn start session=${session.id}`);
        const shouldSendPrompt = !hasElevenLabsAgentConversation(session.id);
        const agentOut = await runElevenLabsAgentTurn({
          sessionId: session.id,
          prompt: shouldSendPrompt ? phoneScenarioPrompt : null,
          managerText: params.managerText,
          elevenLabsVoiceId,
        });
        console.log(`[trainer] ElevenLabs agent turn done session=${session.id} hasAudio=${Boolean(agentOut.audioBase64)} conversation=${agentOut.conversationId || 'n/a'}`);
        clientMessage = agentOut.clientMessage || 'Понял вас. Расскажите, пожалуйста, подробнее.';
        clientAudioBase64 = agentOut.audioBase64;
        clientAudioMimeType = agentOut.audioMimeType;
        nextHistory = [...history, { role: 'client', content: clientMessage }];
        endConversation = agentOut.endedByAgent || shouldForceConversationEnd(clientMessage) || history.filter((turn) => turn.role === 'manager').length >= maxClientTurns;
        result = endConversation ? buildWebTrainingResult(state, nextHistory, behaviorSignals, false, null) : null;
        nextState = {
          ...state,
          client_turns: Math.max(Number(state.client_turns || 0), nextHistory.filter((turn) => turn.role === 'client').length),
        };
        nextElevenLabsConversationId = agentOut.conversationId ?? nextElevenLabsConversationId;
      } catch (error) {
        console.error('[trainer] ElevenLabs agent turn error:', error);
        const out = await getVirtualClientReply({
          car: runtime.car,
          dealership: buildDealershipFromCar(runtime.car),
          state,
          manager_last_message: params.managerText,
          dialog_history: history,
          strictness: runtime.strictness,
          max_client_turns: maxClientTurns,
          behaviorSignal: behavior,
          scenarioPrompt: phoneScenarioPrompt,
          maxResponseTokens: 220,
        });
        clientMessage = out.client_message;
        nextHistory = [...history, { role: 'client', content: clientMessage }];
        endConversation = Boolean(out.end_conversation) || shouldForceConversationEnd(clientMessage);
        result = endConversation ? buildWebTrainingResult(state, nextHistory, behaviorSignals, false, null) : null;
      }
    } else {
      const out = await getVirtualClientReply({
        car: runtime.car,
        dealership: buildDealershipFromCar(runtime.car),
        state,
        manager_last_message: params.managerText,
        dialog_history: history,
        strictness: runtime.strictness,
        max_client_turns: maxClientTurns,
        behaviorSignal: behavior,
        scenarioPrompt: phoneScenarioPrompt,
        maxResponseTokens: 220,
      });

      state.phase = out.diagnostics.current_phase;
      let topicMap = { ...state.topics };
      for (const code of out.diagnostics.topics_addressed as TopicCode[]) {
        if (!topicMap[code]) continue;
        const currentStatus = topicMap[code].status;
        const next = currentStatus === 'none' ? 'asked' : currentStatus === 'asked' ? 'answered' : currentStatus;
        const advance = advanceTopic(topicMap, code, next as any);
        if (advance.valid) topicMap = advance.map;
      }
      for (const code of out.diagnostics.topics_evaded as TopicCode[]) {
        if (!topicMap[code]) continue;
        topicMap = recordEvasion(topicMap, code);
      }
      state.topics = topicMap;
      nextState = {
        ...state,
        stage: out.update_state.stage,
        checklist: { ...state.checklist, ...out.update_state.checklist },
        notes: out.update_state.notes,
        client_turns: out.update_state.client_turns,
      };
      const evasionCheck = checkCriticalEvasions(topicMap);
      if (evasionCheck.shouldFail) {
        clientMessage = 'Я дважды задал важный вопрос и не получил ответа. Пожалуй, обращусь в другой салон.';
        nextHistory = [...history, { role: 'client', content: clientMessage }];
        result = buildWebTrainingResult(nextState, nextHistory, behaviorSignals, true, `CRITICAL_EVASION:${evasionCheck.failedTopic}`);
        endConversation = true;
      } else {
        clientMessage = out.client_message;
        nextHistory = [...history, { role: 'client', content: clientMessage }];
        endConversation = Boolean(out.end_conversation) || shouldForceConversationEnd(clientMessage);
        result = endConversation ? buildWebTrainingResult(nextState, nextHistory, behaviorSignals, false, null) : null;
      }
    }
  }

  const nowIso = new Date().toISOString();
  const clientAudio = await ensureTrainerClientAudio({
    text: clientMessage,
    ttsVoice: params.ttsVoice,
    elevenLabsVoiceId,
    audioBase64: clientAudioBase64,
    audioMimeType: clientAudioMimeType,
  });
  clientAudioBase64 = clientAudio.audioBase64;
  clientAudioMimeType = clientAudio.audioMimeType;
  const transcript: TrainerTranscriptTurn[] = [
    ...transcriptBefore,
    {
      role: 'manager',
      text: params.managerText,
      durationSec: params.durationSec,
      createdAt: nowIso,
      audioBase64: params.managerAudioBase64,
      audioMimeType: params.managerAudioMimeType,
    },
    {
      role: 'client',
      text: clientMessage,
      createdAt: nowIso,
      audioBase64: clientAudioBase64,
      audioMimeType: clientAudioMimeType,
    },
  ];
  const nextRuntime = { ...runtime, state: nextState, behaviorSignals, elevenLabsConversationId: nextElevenLabsConversationId };
  const updateData: Parameters<typeof prisma.trainerSession.update>[0]['data'] = {
    transcriptJson: jsonStringify(transcript),
    caseContextJson: jsonStringify(withTrainerRuntime(caseContext, nextRuntime)),
    elevenLabsConversationId: nextElevenLabsConversationId,
    durationSec: transcript.reduce((sum, turn) => sum + (turn.durationSec ?? 0), 0),
  };
  if (endConversation && result) {
    const forcedFail = result.verdict === 'fail' && Boolean(result.reasonCode);
    updateData.status = result.verdict === 'fail' && result.reasonCode ? 'failed' : 'completed';
    updateData.completedAt = new Date();
    updateData.failureReason = result.reasonCode;
  }
  const updated = await prisma.trainerSession.update({
    where: { id: session.id },
    data: updateData,
    include: { scenario: { select: { id: true, name: true } } },
  });
  if (endConversation && result) {
    const forcedFail = result.verdict === 'fail' && Boolean(result.reasonCode);
    closeElevenLabsAgentConversation(updated.id);
    void finalizeTrainerSessionEvaluation({
      sessionId: updated.id,
      caseContext,
      runtime: nextRuntime,
      transcript,
      forcedFail,
      failureReason: result.reasonCode,
      multiplier: session.multiplier,
    }).catch((error) => {
      console.error('trainer finalize evaluation error:', error);
    });
  }

  return {
    clientMessage,
    endConversation,
    reportReady: !endConversation,
    audioBase64: clientAudioBase64,
    audioMimeType: clientAudioMimeType,
    managerTranscript: params.managerText,
    result,
    session: trainerSessionSummary(updated),
    transcript,
  };
}

async function runTrainerSessionAudioTurn(params: {
  sessionId: string;
  audioBase64: string;
  durationSec: number | null;
  ttsVoice: TtsVoice;
}) {
  const session = await prisma.trainerSession.findUnique({ where: { id: params.sessionId } });
  if (!session) throw new Error('TRAINER_SESSION_NOT_FOUND');
  if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
    throw new Error('TRAINER_SESSION_CLOSED');
  }
  if (!isElevenLabsAgentEnabled()) {
    throw new Error('ELEVENLABS_AGENT_NOT_CONFIGURED');
  }

  const caseContext = safeJsonParseLocal<Record<string, unknown>>(session.caseContextJson, {});
  const elevenLabsVoiceId = trainerElevenLabsVoiceId(caseContext);
  const runtime = getTrainerRuntime(caseContext);
  const transcriptBefore = safeArray<TrainerTranscriptTurn>(session.transcriptJson);
  console.log(`[trainer] ElevenLabs agent audio turn start session=${session.id}`);
  const shouldSendPrompt = !hasElevenLabsAgentConversation(session.id);
  const agentOut = await runElevenLabsAgentAudioTurn({
    sessionId: session.id,
    prompt: shouldSendPrompt ? trainerScenarioPrompt(caseContext, transcriptBefore, params.ttsVoice) : null,
    audioBase64: params.audioBase64,
    elevenLabsVoiceId,
  });
  console.log(`[trainer] ElevenLabs agent audio turn done session=${session.id} hasAudio=${Boolean(agentOut.audioBase64)} conversation=${agentOut.conversationId || 'n/a'}`);

  const managerText = agentOut.userTranscript || 'Голосовое сообщение менеджера';
  const clientMessage = agentOut.clientMessage || 'Понял вас. Расскажите, пожалуйста, подробнее.';
  const clientAudio = await ensureTrainerClientAudio({
    text: clientMessage,
    ttsVoice: params.ttsVoice,
    elevenLabsVoiceId,
    audioBase64: agentOut.audioBase64,
    audioMimeType: agentOut.audioMimeType,
  });
  const historyBefore = transcriptBefore.map((turn) => ({ role: turn.role, content: turn.text }));
  const history = [
    ...historyBefore,
    { role: 'manager' as const, content: managerText },
    { role: 'client' as const, content: clientMessage },
  ];
  const behavior = agentOut.userTranscript
    ? classifyBehavior(managerText, {
      lastClientQuestion: [...historyBefore].reverse().find((turn) => turn.role === 'client')?.content,
      isClientWaitingAnswer: true,
    })
    : null;
  const behaviorSignals = behavior ? [...runtime.behaviorSignals, behavior] : runtime.behaviorSignals;
  const nowIso = new Date().toISOString();
  const transcript: TrainerTranscriptTurn[] = [
    ...transcriptBefore,
    {
      role: 'manager',
      text: managerText,
      durationSec: params.durationSec,
      createdAt: nowIso,
      audioBase64: wavBase64FromPcm16Base64(params.audioBase64),
      audioMimeType: 'audio/wav',
    },
    {
      role: 'client',
      text: clientMessage,
      createdAt: nowIso,
      audioBase64: clientAudio.audioBase64,
      audioMimeType: clientAudio.audioMimeType,
    },
  ];
  const state = { ...runtime.state };
  const maxClientTurns = (state.strictnessState?.max_client_turns as number) ?? 12;
  const endConversation = agentOut.endedByAgent || shouldForceConversationEnd(clientMessage) || history.filter((turn) => turn.role === 'manager').length >= maxClientTurns;
  const result = endConversation ? buildWebTrainingResult(state, history, behaviorSignals, false, null) : null;
  const nextRuntime = {
    ...runtime,
    state: {
      ...state,
      client_turns: Math.max(Number(state.client_turns || 0), history.filter((turn) => turn.role === 'client').length),
    },
    behaviorSignals,
    elevenLabsConversationId: agentOut.conversationId ?? runtime.elevenLabsConversationId ?? null,
  };
  const updateData: Parameters<typeof prisma.trainerSession.update>[0]['data'] = {
    transcriptJson: jsonStringify(transcript),
    caseContextJson: jsonStringify(withTrainerRuntime(caseContext, nextRuntime)),
    elevenLabsConversationId: nextRuntime.elevenLabsConversationId,
    durationSec: transcript.reduce((sum, turn) => sum + (turn.durationSec ?? 0), 0),
  };
  if (endConversation && result) {
    updateData.status = 'completed';
    updateData.completedAt = new Date();
  }

  const updated = await prisma.trainerSession.update({
    where: { id: session.id },
    data: updateData,
    include: { scenario: { select: { id: true, name: true } } },
  });
  if (endConversation && result) {
    closeElevenLabsAgentConversation(updated.id);
    void finalizeTrainerSessionEvaluation({
      sessionId: updated.id,
      caseContext,
      runtime: nextRuntime,
      transcript,
      forcedFail: false,
      failureReason: null,
      multiplier: session.multiplier,
    }).catch((error) => {
      console.error('trainer finalize evaluation error:', error);
    });
  }

  return {
    clientMessage,
    endConversation,
    reportReady: !endConversation,
    audioBase64: clientAudio.audioBase64,
    audioMimeType: clientAudio.audioMimeType,
    managerTranscript: managerText,
    result,
    session: trainerSessionSummary(updated),
    transcript,
  };
}

async function updateTrainerStreakOnCompletion(employeeId: string, sessionStartedAt: Date): Promise<void> {
  const today = trainerPlanDate(sessionStartedAt);
  const yesterday = trainerPlanDate(new Date(sessionStartedAt.getTime() - 24 * 60 * 60 * 1000));
  const current = await prisma.trainerStreak.findUnique({ where: { employeeId } });
  const nextCurrent = current?.lastActiveDate === today
    ? current.currentStreak
    : current?.lastActiveDate === yesterday
    ? current.currentStreak + 1
    : 1;
  await prisma.trainerStreak.upsert({
    where: { employeeId },
    create: {
      employeeId,
      currentStreak: nextCurrent,
      longestStreak: nextCurrent,
      lastActiveDate: today,
    },
    update: {
      currentStreak: nextCurrent,
      longestStreak: Math.max(current?.longestStreak ?? 0, nextCurrent),
      lastActiveDate: today,
    },
  });
}

async function resetTrainerPlanItemForSession(employeeId: string, sessionId: string): Promise<void> {
  const session = await prisma.trainerSession.findUnique({ where: { id: sessionId } });
  if (!session || session.sessionType !== 'plan' || session.employeeId !== employeeId) return;

  const planDate = trainerPlanDate(session.startedAt);
  const plan = await prisma.trainerDailyPlan.findUnique({
    where: { employeeId_planDate: { employeeId, planDate } },
  });
  if (!plan) return;

  const items = safeArray<Record<string, unknown>>(plan.sessionsJson);
  const nextItems = items.map((item) => (
    item.trainerSessionId === sessionId && String(item.status) === 'in_progress'
      ? { ...item, status: 'not_started', trainerSessionId: null }
      : item
  ));
  await prisma.trainerDailyPlan.update({
    where: { id: plan.id },
    data: { sessionsJson: jsonStringify(nextItems) },
  });
}

async function finalizeTrainerSessionSideEffects(sessionId: string): Promise<void> {
  const session = await prisma.trainerSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || !['completed', 'failed'].includes(session.status)) return;

  const baseScore = session.baseScore ?? session.score ?? 0;
  const finalPoints = session.status === 'failed' ? 0 : session.finalPoints ?? Math.round(baseScore * session.multiplier);

  if (session.status === 'completed') {
    await prisma.trainerScore.upsert({
      where: { trainerSessionId: session.id },
      create: {
        employeeId: session.employeeId,
        trainerSessionId: session.id,
        baseScore,
        multiplier: session.multiplier,
        finalScore: finalPoints,
      },
      update: {
        baseScore,
        multiplier: session.multiplier,
        finalScore: finalPoints,
      },
    });
  }

  if (session.sessionType === 'plan') {
    const planDate = trainerPlanDate(session.startedAt);
    const plan = await prisma.trainerDailyPlan.findUnique({
      where: { employeeId_planDate: { employeeId: session.employeeId, planDate } },
    });
    if (plan) {
      const items = safeArray<Record<string, unknown>>(plan.sessionsJson);
      const nextItems = items.map((item) => item.trainerSessionId === session.id
        ? {
          ...item,
          status: session.status,
          score: session.score,
          finalPoints,
          completedAt: session.completedAt?.toISOString() ?? new Date().toISOString(),
        }
        : item);
      await prisma.trainerDailyPlan.update({
        where: { id: plan.id },
        data: { sessionsJson: jsonStringify(nextItems) },
      });
    }
  }

  if (session.status === 'completed') {
    await updateTrainerStreakOnCompletion(session.employeeId, session.startedAt);
  }
}

// Resolve absolute path to public/index.html (works for tsx and compiled)
function getIndexPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'public', 'index.html'),
    path.resolve(__dirname, '..', 'public', 'index.html'),
    path.resolve(__dirname, '..', '..', 'public', 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const INDEX_HTML_PATH = getIndexPath();

/** Only show attempts that were properly evaluated (have score, evaluation result, or error) — excludes empty force-closed sessions */
const completedWithDataWhere = {
  status: 'completed' as const,
  OR: [
    { totalScore: { not: null } },
    { evaluationResultJson: { not: null } },
    { evaluationError: { not: null } },
  ],
};

if (!INDEX_HTML_PATH) {
  console.error('[ERROR] public/index.html not found. Checked:', path.resolve(process.cwd(), 'public'), path.resolve(__dirname, '..', 'public'));
} else {
  console.log('[OK] Mini App index:', INDEX_HTML_PATH);
}

// Static files
const publicPath = path.resolve(process.cwd(), 'public');
const publicPathAlt = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicPath));
if (publicPathAlt !== publicPath) {
  app.use(express.static(publicPathAlt));
}

// Friendly error page (Russian)
function sendErrorHtml(res: express.Response, status: number, title: string, message: string) {
  res.status(status).type('html').send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sales Boost</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:20px;background:#1a1a2e;color:#eee;">
<h1 style="color:#fff;">${title}</h1>
<p>${message}</p>
<p style="color:#888;font-size:14px;">Проверьте, что бот запущен (npm run dev) и туннель активен. Откройте /admin в боте снова.</p>
</body></html>
  `);
}

function buildVoiceCallDetailResponse(session: {
  id: number;
  callId: string;
  to: string;
  scenario: string | null;
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  durationSec: number | null;
  transcriptJson: string | null;
  evaluationJson: string | null;
  totalScore: number | null;
  failureReason: string | null;
}) {
  const transcript = session.transcriptJson
    ? (JSON.parse(session.transcriptJson) as Array<{ role: string; text: string }>)
    : [];
  let evaluation: Record<string, unknown> | null = null;
  if (session.evaluationJson) {
    try {
      evaluation = JSON.parse(session.evaluationJson) as Record<string, unknown>;
    } catch (_) {}
  }
  const callSummary =
    evaluation && (evaluation as any).call_summary && typeof (evaluation as any).call_summary === 'object'
      ? (evaluation as any).call_summary
      : null;
  const replyImprovements =
    evaluation && Array.isArray((evaluation as any).reply_improvements)
      ? (evaluation as any).reply_improvements
      : null;
  const score = session.totalScore ?? (evaluation && typeof (evaluation as any).overall_score_0_100 === 'number'
    ? (evaluation as any).overall_score_0_100
    : null);
  const checklist = evaluation && Array.isArray((evaluation as any).checklist) ? (evaluation as any).checklist : [];
  const issues = evaluation && Array.isArray((evaluation as any).issues) ? (evaluation as any).issues : [];
  const recommendations = evaluation && Array.isArray((evaluation as any).recommendations) ? (evaluation as any).recommendations : [];
  const dimensionScoresRaw = evaluation && (evaluation as any).dimension_scores ? (evaluation as any).dimension_scores : null;
  const dimensionScores =
    Array.isArray(checklist) && checklist.length > 0
      ? computeUiDimensionScoresFromChecklist(checklist as Array<{ code?: string; status?: string }>, dimensionScoresRaw)
      : dimensionScoresRaw;
  const reportTranscript = transcript
    .map((line) => ({
      role: (line.role === 'manager' || line.role === 'assistant' ? 'manager' : 'client') as 'manager' | 'client',
      text: String(line.text || '').trim(),
    }))
    .filter((line) => line.text);
  const unifiedReport = normalizeUnifiedCallReport(
    evaluation?.unified_call_report,
    {
      totalScore: score ?? 0,
      transcript: reportTranscript,
      source: 'call',
      dimensionScores: dimensionScores && typeof dimensionScores === 'object'
        ? dimensionScores as Record<string, number>
        : undefined,
    },
  );
  const qualityTag = score != null ? (score >= 76 ? 'Хорошо' : score >= 50 ? 'Средне' : 'Плохо') : null;
  const ended = !!session.endedAt;
  const hasEval = !!session.evaluationJson;
  const endedAtMs = session.endedAt ? session.endedAt.getTime() : null;
  const ageSec = endedAtMs != null ? (Date.now() - endedAtMs) / 1000 : null;
  const isRecent = ageSec != null && ageSec >= 0 && ageSec < 120;
  const isProcessing = ended && !hasEval && !session.failureReason && (transcript.length >= 2 || isRecent);
  const processingStage = !ended || hasEval || !isProcessing ? null : (transcript.length >= 2 ? 'evaluation' : 'transcript');

  return {
    id: session.id,
    callId: session.callId,
    to: session.to,
    scenario: session.scenario,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    outcome: session.outcome,
    durationSec: session.durationSec,
    transcript,
    transcriptTurns: transcript.length,
    hasEvaluation: !!session.evaluationJson,
    isProcessing,
    processingStage,
    processingError: session.failureReason,
    totalScore: score,
    qualityTag,
    dimensionScores,
    checklist,
    issues,
    recommendations,
    callSummary,
    replyImprovements,
    unifiedReport,
    strengths: checklist.filter((c: any) => c.status === 'YES').map((c: any) => c.comment || c.code),
    weaknesses: issues.map((i: any) => (i.recommendation || i.issue_type) || ''),
  };
}

// Health check: verify server is running (e.g. curl http://localhost:3000/health)
app.get('/health', (_req, res) => {
  res.json({ ok: true, message: 'Sales Boost server is running' });
});

// Voice call dialog: Voximplant scenario sends ASR text here, we return LLM reply for TTS
app.post('/voice/dialog', (req, res) => {
  console.log('[voice/dialog] POST received');
  handleVoiceDialog(req, res).catch((err) => {
    console.error('[voice/dialog] Unhandled:', err);
    res.status(500).json({ error: 'Internal error', reply_text: 'Здравствуйте, произошла ошибка. Попробуйте позже.', end_session: false });
  });
});

// ── Web training API: start session ──
app.post('/api/training/web/start', async (req, res) => {
  try {
    const body = req.body || {};
    const strictness = (body.strictness ?? 'medium') as Strictness;
    const profile = (body.profile ?? 'normal') as WebTrainingProfile;
    const replyMode = (body.replyMode ?? 'text') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;

    const car = loadCar();
    const baseState = getDefaultState(profile);
    const max_client_turns =
      strictness === 'low' ? 8 : strictness === 'high' ? 14 : baseState.strictnessState.max_client_turns;

    const state = {
      ...baseState,
      strictnessState: { strictness, max_client_turns },
    };

    const sessionId = createWebSessionId();
    const dealership = buildDealershipFromCar(car);

    const out = await getVirtualClientReply({
      car,
      dealership,
      state,
      manager_last_message: '',
      dialog_history: [],
      strictness,
      max_client_turns,
    });

    const nextState = {
      ...state,
      stage: out.update_state.stage,
      checklist: { ...state.checklist, ...out.update_state.checklist },
      notes: out.update_state.notes,
      client_turns: out.update_state.client_turns,
    };

    webTrainingSessions.set(sessionId, {
      id: sessionId,
      strictness,
      profile,
      state: nextState,
      car,
      dialogHistory: [{ role: 'client', content: out.client_message }],
      behaviorSignals: [],
    });

    let audioBase64: string | null = null;
    if (replyMode === 'text+voice' && out.client_message.trim()) {
      try {
        const buf = await generateSpeechBuffer(out.client_message, ttsVoice);
        if (buf.length) {
          audioBase64 = buf.toString('base64');
        }
      } catch (e) {
        console.error('[web-training] TTS start error:', e);
      }
    }

    res.json({
      sessionId,
      clientMessage: out.client_message,
      endConversation: out.end_conversation ?? false,
      audioBase64,
    });
  } catch (error) {
    console.error('[web-training] start error:', error);
    const msg = error instanceof Error ? error.message : String(error);

    // Максимально безопасный fallback: просто текст без внешних вызовов
    res.json({
      sessionId: null,
      clientMessage:
        'Сейчас тренажёр недоступен локально (ошибка подключения к AI‑клиенту). ' +
        'Интерфейс работает, но диалог с клиентом мы сможем полностью включить уже на проде.',
      endConversation: true,
      audioBase64: null,
      warning:
        'Локальный режим без OpenAI: запрос к виртуальному клиенту не выполнен. ' +
        'Подключим полноценного клиента на продакшене.',
      error: msg,
    });
  }
});

// ── Web training API: manager message ──
app.post('/api/training/web/message', async (req, res) => {
  try {
    const body = req.body || {};
    const { sessionId, message } = body as { sessionId?: string; message?: string };
    const replyMode = (body.replyMode ?? 'text') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }

    if (!webTrainingSessions.has(sessionId)) {
      return res.status(404).json({ error: 'Сессия не найдена или истекла' });
    }

    const out = await runWebTrainingTurn({
      sessionId,
      message,
      replyMode,
      ttsVoice,
    });

    res.json(out);
  } catch (error) {
    console.error('[web-training] message error:', error);
    const msg = error instanceof Error ? error.message : String(error);

    res.json({
      clientMessage:
        'Диалог сейчас недоступен из‑за ошибки подключения к AI‑клиенту. ' +
        'Но интерфейс теста уже готов — в продакшене он будет работать как в Telegram.',
      endConversation: true,
      audioBase64: null,
      warning:
        'Локальный режим без OpenAI: сообщения не обрабатываются. ' +
        'Полноценный диалог включим на боевом сервере.',
      error: msg,
    });
  }
});

// ── Web training API: manager voice message ──
app.post('/api/training/web/voice-message', async (req, res) => {
  try {
    const body = req.body || {};
    const { sessionId, audioBase64, mimeType } = body as {
      sessionId?: string;
      audioBase64?: string;
      mimeType?: string;
    };
    const replyMode = (body.replyMode ?? 'text+voice') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return res.status(400).json({ error: 'audioBase64 обязателен' });
    }
    if (!webTrainingSessions.has(sessionId)) {
      return res.status(404).json({ error: 'Сессия не найдена или истекла' });
    }

    const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'm4a' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `web-voice-${Date.now()}.${ext}`);
    const buf = Buffer.from(audioBase64, 'base64');
    await fs.promises.writeFile(tmpPath, buf);

    let managerText = '';
    try {
      managerText = await transcribeVoice(tmpPath);
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }

    if (!managerText.trim()) {
      return res.status(400).json({ error: 'Не удалось распознать голосовое сообщение' });
    }

    const out = await runWebTrainingTurn({
      sessionId,
      message: managerText,
      replyMode,
      ttsVoice,
    });

    res.json({ ...out, managerTranscript: managerText });
  } catch (error) {
    console.error('[web-training] voice-message error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    res.json({
      clientMessage:
        'Сейчас не удалось обработать голос на локальном стенде, но интерфейс работает. ' +
        'В продакшене ответ будет как в Telegram.',
      endConversation: true,
      audioBase64: null,
      warning:
        'Локальный fallback: проверьте доступ к OpenAI/STT (VPN/прокси). ' +
        'Диалог завершён, чтобы избежать повторных ошибок.',
      error: msg || 'Ошибка обработки голосового сообщения',
    });
  }
});

// Prevent caching of index.html so users always get latest app after deploy/refresh
function sendIndexHtml(res: express.Response) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  return res.sendFile(INDEX_HTML_PATH!);
}

// Explicit root: always serve Mini App
app.get('/', (req, res) => {
  if (INDEX_HTML_PATH) {
    try {
      return sendIndexHtml(res);
    } catch (err) {
      console.error('Error sending index.html:', err);
      sendErrorHtml(res, 500, 'Ошибка загрузки', 'Не удалось отдать страницу приложения. См. логи сервера.');
      return;
    }
  }
  sendErrorHtml(res, 404, 'Файл не найден', 'Файл public/index.html не найден. Убедитесь, что папка public и index.html есть в проекте.');
});

app.post('/api/auth/login', (req, res) => {
  handleAuthLogin(req, res).catch((error) => {
    console.error('Auth login error:', error);
    res.status(500).json({ error: 'Ошибка авторизации. Попробуйте позже.' });
  });
});

app.get('/api/auth/me', (req, res) => {
  handleAuthMe(req, res).catch((error) => {
    console.error('Auth me error:', error);
    res.status(500).json({ error: 'Ошибка проверки сессии. Попробуйте позже.' });
  });
});

// API endpoint to verify admin and get data
app.get('/api/admin/verify', async (req, res) => {
  try {
    if (req.get('authorization')?.startsWith('Bearer ')) {
      await handleAuthMe(req, res);
      return;
    }

    const { initData } = req.query;
    const isLocalhost = ['127.0.0.1', '::1', 'localhost'].includes(req.ip || '') ||
      (req.get('host') || '').startsWith('localhost');

    // Dev bypass: on localhost with ALLOW_DEV_ADMIN=true, allow without Telegram
    if (!initData && config.allowDevAdmin && isLocalhost) {
      return res.json({
        success: true,
        user: { id: 'dev', username: 'dev', firstName: 'Локальный доступ (dev)' },
      });
    }

    if (!initData) {
      return res.status(401).json({
        error: 'Нет данных авторизации. Откройте панель через кнопку «Открыть Админ-панель» в чате с ботом (напишите /admin). В браузере напрямую панель не авторизуется.',
      });
    }

    const params = new URLSearchParams(initData as string);
    const userStr = params.get('user');
    if (!userStr) {
      return res.status(401).json({ error: 'Неверные данные Telegram. Откройте панель из чата с ботом (/admin).' });
    }

    const user = JSON.parse(userStr);
    const telegramId = user.id?.toString();
    const username = user.username?.toLowerCase();

    if (!telegramId) {
      return res.status(401).json({ error: 'Не удалось определить пользователя.' });
    }

    const isAdmin = config.adminIdentifiers.includes(telegramId) ||
      (username && (
        config.adminIdentifiers.includes(username) ||
        config.adminIdentifiers.includes(`@${username}`)
      ));

    if (!isAdmin) {
      return res.status(403).json({ error: 'Нет доступа. Ваш Telegram не в списке администраторов (ADMIN_TELEGRAM_IDS в .env).' });
    }

    res.json({
      success: true,
      user: {
        id: telegramId,
        username: user.username,
        firstName: user.first_name,
      },
    });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ error: 'Ошибка сервера. Попробуйте позже.' });
  }
});

app.use('/api/admin', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Admin API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
});

app.use('/api/imports', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Imports API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
});

app.use('/api/trainer', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Trainer API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
});

async function resolveTrainerManager(req: express.Request) {
  const account = req.authAccount;
  const accountId = account?.id;
  if (!accountId) return null;
  const existing = await prisma.managerProfile.findFirst({
    where: { accountId, status: 'active' },
    include: {
      dealership: {
        include: { holding: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing;

  const dealershipId = account.memberships.find((membership) => membership.dealershipId)?.dealershipId;
  if (!dealershipId) return null;

  return prisma.managerProfile.create({
    data: {
      accountId,
      dealershipId,
      fullName: account.displayName?.trim() || account.email.split('@')[0]?.trim() || account.email,
      email: account.email,
      status: 'active',
    },
    include: {
      dealership: {
        include: { holding: true },
      },
    },
  });
}

function trainerSessionSummary(session: {
  id: string;
  sessionType: string;
  status: string;
  scenarioId: string | null;
  title?: string | null;
  score: number | null;
  finalPoints: number | null;
  failureReason: string | null;
  startedAt: Date;
  completedAt: Date | null;
  evaluationJson?: string | null;
  caseContextJson?: string | null;
  scenario?: { id: string; name: string } | null;
}) {
  const scenarioName = session.scenario?.name ?? 'Сценарий';
  const caseContext = safeJsonParseLocal<Record<string, unknown>>(session.caseContextJson, {});
  const contextTitle = typeof caseContext.dialogTitle === 'string' ? caseContext.dialogTitle.trim() : '';
  const title = (typeof session.title === 'string' && session.title.trim())
    ? session.title.trim()
    : (contextTitle || null);
  const evaluation = typeof session.evaluationJson === 'string' ? session.evaluationJson.trim() : '';
  return {
    id: session.id,
    type: session.sessionType,
    status: session.status,
    scenarioId: session.scenarioId,
    scenarioName,
    title,
    displayName: title || scenarioName,
    score: session.score,
    finalPoints: session.finalPoints,
    failureReason: session.failureReason,
    startedAt: session.startedAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
    reportReady: Boolean(evaluation && evaluation !== 'null' && evaluation !== '{}'),
  };
}

async function getOrCreateTrainerDailyPlan(manager: Awaited<ReturnType<typeof resolveTrainerManager>>) {
  if (!manager) return null;
  const planDate = trainerPlanDate();
  const existing = await prisma.trainerDailyPlan.findUnique({
    where: { employeeId_planDate: { employeeId: manager.id, planDate } },
  });
  if (existing) return existing;

  const scripts = await prisma.callScript.findMany({
    where: { holdingId: manager.dealership.holdingId ?? '' },
    orderBy: { updatedAt: 'desc' },
    take: 12,
  });
  const items = Array.from({ length: 3 }).map((_, index) => {
    const script = scripts[index % Math.max(1, scripts.length)] ?? null;
    return {
      id: trainerPlanItemId(),
      scenarioId: script?.id ?? null,
      scenarioName: script?.name ?? 'Свободная тренировка',
      status: 'not_started',
      trainerSessionId: null,
      caseContextSeed: trainerPlanItemId(),
    };
  });

  return prisma.trainerDailyPlan.create({
    data: {
      employeeId: manager.id,
      companyId: manager.dealership.holdingId,
      branchId: manager.dealershipId,
      planDate,
      sessionsJson: jsonStringify(items),
    },
  });
}

app.get('/api/trainer/profile', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });

    const [streak, scoreAgg, sessionsTotal, sessions30d, recentSessions] = await Promise.all([
      prisma.trainerStreak.findUnique({ where: { employeeId: manager.id } }),
      prisma.trainerScore.aggregate({
        where: { employeeId: manager.id },
        _sum: { finalScore: true },
      }),
      prisma.trainerSession.count({ where: { employeeId: manager.id, status: { in: ['completed', 'failed'] } } }),
      prisma.trainerSession.count({
        where: {
          employeeId: manager.id,
          status: { in: ['completed', 'failed'] },
          startedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      }),
      prisma.trainerSession.findMany({
        where: { employeeId: manager.id, status: { in: ['completed', 'failed'] } },
        orderBy: { startedAt: 'desc' },
        take: 40,
        select: {
          startedAt: true,
          completedAt: true,
          score: true,
          dimensionsJson: true,
          evaluationJson: true,
        },
      }),
    ]);

    const categoryScores = trainerCategoryInsightsFromSessions(recentSessions);
    const scoreTrend = [...recentSessions]
      .reverse()
      .filter((session) => session.score != null)
      .slice(-10)
      .map((session) => ({
        date: localDateKey(session.completedAt ?? session.startedAt),
        avgScore: Math.round(Number(session.score)),
        count: 1,
      }));
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const testsLast7d = recentSessions.filter((session) => (
      (session.completedAt ?? session.startedAt) >= weekAgo
    )).length;
    const strongest = [...categoryScores].sort((a, b) => b.score - a.score)[0] ?? null;
    const weakest = [...categoryScores].sort((a, b) => a.score - b.score)[0] ?? null;
    const scored = recentSessions.map((session) => session.score).filter((score): score is number => score != null);
    const avgScore = scored.length ? round1(scored.reduce((sum, score) => sum + score, 0) / scored.length) : 0;

    res.json({
      profile: {
        employeeId: manager.id,
        fullName: manager.fullName,
        companyId: manager.dealership.holdingId,
        companyName: manager.dealership.holding?.name ?? 'Без компании',
        branchId: manager.dealershipId,
        branchName: manager.dealership.name,
        city: manager.dealership.city,
        totalPoints: scoreAgg._sum.finalScore ?? 0,
        currentStreak: streak?.currentStreak ?? 0,
        longestStreak: streak?.longestStreak ?? 0,
        lastActiveDate: streak?.lastActiveDate ?? null,
        sessionsTotal,
        sessions30d,
        avgScore,
        testsLast7d,
        strongestCategory: strongest && strongest.score > 0
          ? { name: strongest.name, score: strongest.score }
          : null,
        weakestCategory: weakest && recentSessions.length > 0
          ? { name: weakest.name, score: weakest.score }
          : null,
        categoryScores,
        scoreTrend,
      },
    });
  } catch (error) {
    console.error('trainer/profile error:', error);
    res.status(500).json({ error: 'Не удалось загрузить профиль тренажёра.' });
  }
});

app.get('/api/trainer/scenarios', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    if (!manager.dealership.holdingId) return res.json({ items: [] });

    const scripts = await prisma.callScript.findMany({
      where: { holdingId: manager.dealership.holdingId },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({
      items: scripts.map((script) => ({
        id: script.id,
        name: script.name,
        context: script.context,
        objectionsCount: safeArray(script.objectionsJson).length,
        questionsCount: safeArray(script.questionsJson).length,
        criteriaCount: safeArray(script.successCriteriaJson).length,
      })),
    });
  } catch (error) {
    console.error('trainer/scenarios error:', error);
    res.status(500).json({ error: 'Не удалось загрузить сценарии.' });
  }
});

app.get('/api/trainer/plan/today', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    const plan = await getOrCreateTrainerDailyPlan(manager);
    const sessions = safeArray<Record<string, unknown>>(plan?.sessionsJson);
    res.json({
      plan: {
        id: plan?.id ?? null,
        date: plan?.planDate ?? trainerPlanDate(),
        sessions,
      },
    });
  } catch (error) {
    console.error('trainer/plan/today error:', error);
    res.status(500).json({ error: 'Не удалось загрузить план дня.' });
  }
});

app.get('/api/trainer/history', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    const limit = Math.min(Number.parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const sessions = await prisma.trainerSession.findMany({
      where: { employeeId: manager.id },
      include: { scenario: { select: { id: true, name: true } } },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    const catalog = await getCallReportProblemCatalog(prisma);
    res.json({ items: sessions.map(trainerSessionSummary) });
  } catch (error) {
    console.error('trainer/history error:', error);
    res.status(500).json({ error: 'Не удалось загрузить историю тренировок.' });
  }
});

app.post('/api/trainer/session/start', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });

    const body = req.body || {};
    const sessionType = body.sessionType === 'plan' ? 'plan' as const : 'free' as const;
    const difficulty = ['easy', 'medium', 'hard'].includes(String(body.difficulty)) ? String(body.difficulty) : 'medium';
    const clientType = String(body.clientType || 'random');
    const replyMode = (body.replyMode ?? 'text+voice') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;
    const planItemId = typeof body.planItemId === 'string' ? body.planItemId : null;
    let scenarioId = typeof body.scenarioId === 'string' ? body.scenarioId : null;
    let plan = null as Awaited<ReturnType<typeof getOrCreateTrainerDailyPlan>> | null;
    let planItems: Array<Record<string, unknown>> = [];
    let planItem: Record<string, unknown> | null = null;

    if (sessionType === 'plan') {
      plan = await getOrCreateTrainerDailyPlan(manager);
      planItems = safeArray<Record<string, unknown>>(plan?.sessionsJson);
      planItem = planItems.find((item) => item.id === planItemId) ?? planItems.find((item) => item.status === 'not_started') ?? null;
      if (!planItem) return res.status(400).json({ error: 'В плане дня нет доступной сессии.' });
      if (['completed', 'failed'].includes(String(planItem.status))) {
        return res.status(400).json({ error: 'Эта задача уже завершена.' });
      }
      scenarioId = typeof planItem.scenarioId === 'string' ? planItem.scenarioId : scenarioId;
    }

    const scenario = scenarioId
      ? await prisma.callScript.findFirst({
        where: {
          id: scenarioId,
          holdingId: manager.dealership.holdingId ?? '',
        },
      })
      : await prisma.callScript.findFirst({
        where: { holdingId: manager.dealership.holdingId ?? '' },
        orderBy: { updatedAt: 'desc' },
      });

    if (!scenario) {
      return res.status(400).json({ error: 'Для компании не найден доступный сценарий.' });
    }

    const importedItem = await pickTrainerImportedSampleForScript(scenario);
    const scriptProfileIds = safeJsonParseLocal<string[]>(scenario.profileIdsJson, []);
    const scriptProfiles = scriptProfileIds.length
      ? await prisma.callCustomerProfile.findMany({
        where: {
          id: { in: scriptProfileIds },
          holdingId: manager.dealership.holdingId ?? '',
        },
        orderBy: { updatedAt: 'desc' },
      })
      : [];
    const customerProfile = scriptProfiles.length
      ? scriptProfiles[Math.floor(Math.random() * scriptProfiles.length)]
      : null;
    const customerVoice = customerProfile?.voiceId
      ? await prisma.callCustomerVoice.findFirst({
        where: { id: customerProfile.voiceId, isDeleted: false, isEnabled: true },
        select: { name: true, elevenLabsCode: true },
      })
      : null;
    const trainerCustomerProfile = customerProfile
      ? {
        ...customerProfile,
        voiceName: customerVoice?.name?.trim() || null,
        elevenLabsVoiceId: customerVoice?.elevenLabsCode?.trim() || null,
      }
      : null;

    const caseContext = buildTrainerCaseContext({
      sessionType,
      scenario,
      importedItem,
      manager,
      difficulty,
      clientType,
      seed: typeof planItem?.caseContextSeed === 'string' ? planItem.caseContextSeed : null,
      customerProfile: trainerCustomerProfile,
    });
    const multiplier = sessionType === 'plan' ? 1.5 : 1;
    const session = await prisma.trainerSession.create({
      data: {
        employeeId: manager.id,
        branchId: manager.dealershipId,
        companyId: manager.dealership.holdingId,
        sessionType,
        scenarioId: scenario.id,
        difficulty,
        clientType,
        caseContextJson: jsonStringify(caseContext),
        multiplier,
      },
      include: { scenario: { select: { id: true, name: true } } },
    });

    if (sessionType === 'plan' && plan && planItem) {
      const nextItems = planItems.map((item) => item.id === planItem?.id
        ? { ...item, status: 'in_progress', trainerSessionId: session.id, scenarioId: scenario.id, scenarioName: scenario.name }
        : item);
      await prisma.trainerDailyPlan.update({
        where: { id: plan.id },
        data: { sessionsJson: jsonStringify(nextItems) },
      });
    }

    const initialMessagePromise = initializeTrainerDialog({
      sessionId: session.id,
      replyMode,
      ttsVoice,
    }).catch((error) => {
      console.error('trainer/session/start initial dialog error:', error);
      return null;
    });

    // Don't block UI on first voice turn — client polls /dialog until ready.
    void initialMessagePromise;

    res.json({
      session: trainerSessionSummary(session),
      caseContext,
      initialMessage: null,
    });
  } catch (error) {
    console.error('trainer/session/start error:', error);
    res.status(500).json({ error: 'Не удалось запустить тренировку.' });
  }
});

app.get('/api/trainer/session/:id/dialog', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    const session = await prisma.trainerSession.findFirst({
      where: { id: String(req.params.id), employeeId: manager.id },
      include: { scenario: { select: { id: true, name: true } } },
    });
    if (!session) return res.status(404).json({ error: 'Тренировка не найдена.' });
    res.json({
      session: trainerSessionSummary(session),
      caseContext: safeJsonParseLocal<Record<string, unknown>>(session.caseContextJson, {}),
      transcript: safeArray(session.transcriptJson),
    });
  } catch (error) {
    console.error('trainer/session/dialog error:', error);
    res.status(500).json({ error: 'Не удалось загрузить диалог тренировки.' });
  }
});

app.post('/api/trainer/session/:id/voice-message', async (req, res) => {
  try {
    const requestStartedAt = Date.now();
    console.log(`[trainer] voice-message received session=${String(req.params.id)}`);
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    const session = await prisma.trainerSession.findFirst({
      where: { id: String(req.params.id), employeeId: manager.id },
      select: { id: true },
    });
    if (!session) return res.status(404).json({ error: 'Тренировка не найдена.' });

    const body = req.body || {};
    const { audioBase64, mimeType } = body as { audioBase64?: string; mimeType?: string };
    const replyMode = (body.replyMode ?? 'text+voice') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;
    const durationSec = Number.isFinite(Number(body.durationSec)) ? Math.max(1, Math.round(Number(body.durationSec))) : null;
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return res.status(400).json({ error: 'audioBase64 обязателен' });
    }

    const isPcm = String(mimeType || '').toLowerCase().includes('audio/pcm');

    if (USE_ELEVENLABS_AGENT_FOR_WEB_TRAINER && isPcm && isElevenLabsAgentEnabled()) {
      try {
        const out = await runTrainerSessionAudioTurn({
          sessionId: session.id,
          audioBase64,
          durationSec,
          ttsVoice,
        });
        console.log(`[trainer] voice-message done session=${session.id} ms=${Date.now() - requestStartedAt}`);
        return res.json(out);
      } catch (error) {
        console.error('[trainer] ElevenLabs audio turn failed, falling back to STT+text:', error);
      }
    }

    // STT path (also used as fallback when direct PCM/agent turn fails)
    let tmpPath = '';
    let sttAudioBase64 = audioBase64;
    let sttMimeType = mimeType || 'audio/webm';
    if (isPcm) {
      sttAudioBase64 = wavBase64FromPcm16Base64(audioBase64);
      sttMimeType = 'audio/wav';
      tmpPath = path.join(os.tmpdir(), `trainer-voice-${Date.now()}.wav`);
    } else {
      const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'm4a' : mimeType?.includes('wav') ? 'wav' : 'webm';
      tmpPath = path.join(os.tmpdir(), `trainer-voice-${Date.now()}.${ext}`);
    }
    const buf = Buffer.from(sttAudioBase64, 'base64');
    if (buf.length < 512) {
      return res.status(400).json({ error: 'Слишком короткое голосовое сообщение. Запишите ещё раз.' });
    }
    await fs.promises.writeFile(tmpPath, buf);
    console.log(`[trainer] voice-message audio saved session=${session.id} bytes=${buf.length} mime=${sttMimeType}`);

    let managerText = '';
    try {
      console.log(`[trainer] STT start session=${session.id}`);
      managerText = await withTimeout(transcribeVoiceFast(tmpPath), 30000, 'Trainer STT');
      console.log(`[trainer] STT done session=${session.id} chars=${managerText.length}`);
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
    if (!managerText.trim()) {
      return res.status(400).json({ error: 'Не удалось распознать речь. Говорите чуть громче и дольше, затем попробуйте снова.' });
    }

    const out = await runTrainerSessionTurn({
      sessionId: session.id,
      managerText,
      durationSec,
      replyMode,
      ttsVoice,
      managerAudioBase64: sttAudioBase64,
      managerAudioMimeType: sttMimeType,
    });
    console.log(`[trainer] voice-message done session=${session.id} ms=${Date.now() - requestStartedAt}`);
    res.json(out);
  } catch (error) {
    console.error('trainer/session/voice-message error:', error);
    const message = error instanceof Error ? error.message : '';
    if (message.includes('timeout') || message.includes('TIMEOUT') || message.includes('Timeout')) {
      return res.status(504).json({ error: 'Сервис ответа клиента не успел. Отправьте сообщение ещё раз.' });
    }
    res.status(500).json({ error: 'Не удалось обработать голосовое сообщение.' });
  }
});

app.get('/api/trainer/session/:id/report', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    const session = await prisma.trainerSession.findFirst({
      where: { id: String(req.params.id), employeeId: manager.id },
      include: { scenario: { select: { id: true, name: true } } },
    });
    if (!session) return res.status(404).json({ error: 'Тренировка не найдена.' });

    res.json({
      item: {
        ...trainerSessionSummary(session),
        caseContext: safeJsonParseLocal<Record<string, unknown>>(session.caseContextJson, {}),
        transcript: safeArray(session.transcriptJson),
        dimensions: safeJsonParseLocal<Record<string, unknown> | null>(session.dimensionsJson, null),
        checklist: safeArray(session.checklistResultsJson),
        objectionsAnalysis: safeArray(session.objectionsAnalysisJson),
        topRecommendations: safeArray(session.topRecommendationsJson),
        evaluation: safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null),
        multiplier: session.multiplier,
        baseScore: session.baseScore,
        durationSec: session.durationSec,
      },
    });
  } catch (error) {
    console.error('trainer/session/report error:', error);
    res.status(500).json({ error: 'Не удалось загрузить отчёт тренировки.' });
  }
});

app.get('/api/trainer/session/:id/audit-detail', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    const session = await prisma.trainerSession.findFirst({
      where: { id: String(req.params.id), employeeId: manager.id },
      include: {
        employee: { include: { dealership: { include: { holding: true } } } },
        branch: { include: { holding: true } },
        company: true,
        scenario: true,
      },
    });
    if (!session) return res.status(404).json({ error: 'Тренировка не найдена.' });
    if (session.status !== 'completed' && session.status !== 'failed') {
      return res.status(409).json({ error: 'Отчёт появится после завершения тренировки.' });
    }
    res.json({ item: await buildTrainerAuditDetailItem(session) });
  } catch (error) {
    console.error('trainer/session/audit-detail error:', error);
    res.status(500).json({ error: 'Не удалось загрузить отчёт тренировки.' });
  }
});

app.post('/api/trainer/session/:id/abandon', async (req, res) => {
  try {
    const manager = await resolveTrainerManager(req);
    if (!manager) return res.status(404).json({ error: 'Профиль менеджера не найден.' });
    const session = await prisma.trainerSession.findFirst({
      where: { id: String(req.params.id), employeeId: manager.id },
      include: { scenario: { select: { id: true, name: true } } },
    });
    if (!session) return res.status(404).json({ error: 'Тренировка не найдена.' });
    if (session.status !== 'in_progress') {
      return res.json({ session: trainerSessionSummary(session) });
    }

    const updated = await prisma.trainerSession.update({
      where: { id: session.id },
      data: { status: 'cancelled', completedAt: new Date() },
      include: { scenario: { select: { id: true, name: true } } },
    });
    await resetTrainerPlanItemForSession(manager.id, session.id);
    closeElevenLabsAgentConversation(session.id);
    res.json({ session: trainerSessionSummary(updated) });
  } catch (error) {
    console.error('trainer/session/abandon error:', error);
    res.status(500).json({ error: 'Не удалось прервать тренировку.' });
  }
});

app.post('/api/imports/analyze-source', (req, res) => {
  handleAnalyzeImportSource(req, res).catch((error) => {
    console.error('Analyze import source error:', error);
    res.status(500).json({ error: 'Не удалось проанализировать источник.' });
  });
});

app.post('/api/imports/generate-tag-rule', (req, res) => {
  handleGenerateImportTagRule(req, res).catch((error) => {
    console.error('Generate import tag rule error:', error);
    res.status(500).json({ error: 'Не удалось сформировать правило.' });
  });
});

app.post('/api/imports/generate-tag-rules', (req, res) => {
  handleGenerateImportTagRules(req, res).catch((error) => {
    console.error('Generate import tag rules error:', error);
    res.status(500).json({ error: 'Не удалось сформировать правила.' });
  });
});

app.post('/api/imports/test-tag-rules', (req, res) => {
  handleTestImportTagRules(req, res).catch((error) => {
    console.error('Test import tag rules error:', error);
    res.status(500).json({ error: 'Не удалось протестировать правила тегов.' });
  });
});

app.post('/api/imports/preview', (req, res) => {
  handlePreviewImportConfig(req, res).catch((error) => {
    console.error('Preview import config error:', error);
    res.status(500).json({ error: 'Не удалось построить preview.' });
  });
});

app.get('/api/imported-items/tags', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Imported tags API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
}, (req, res) => {
  handleListImportedTags(req, res).catch((error) => {
    console.error('List imported tags error:', error);
    res.status(500).json({ error: 'Не удалось загрузить теги.' });
  });
});

app.get('/api/imported-items', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Imported items API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
}, (req, res) => {
  handleListImportedItems(req, res).catch((error) => {
    console.error('List imported items error:', error);
    res.status(500).json({ error: 'Не удалось загрузить данные.' });
  });
});

app.get('/api/imports', (req, res) => {
  handleListImports(req, res).catch((error) => {
    console.error('List imports error:', error);
    res.status(500).json({ error: 'Не удалось загрузить импорты.' });
  });
});

app.get('/api/admin/call-settings/customer-profiles', (req, res) => {
  handleListCallCustomerProfiles(req, res).catch((error) => {
    console.error('List call customer profiles error:', error);
    res.status(500).json({ error: 'Не удалось загрузить профили клиентов.' });
  });
});

app.get('/api/admin/call-settings/customer-voices', (req, res) => {
  handleListCallCustomerVoices(req, res).catch((error) => {
    console.error('List call customer voices error:', error);
    res.status(500).json({ error: 'Не удалось загрузить голоса клиентов.' });
  });
});

app.post('/api/admin/call-settings/customer-voices', (req, res) => {
  handleCreateCallCustomerVoice(req, res).catch((error) => {
    console.error('Create call customer voice error:', error);
    res.status(500).json({ error: 'Не удалось создать голос клиента.' });
  });
});

app.patch('/api/admin/call-settings/customer-voices/:id', (req, res) => {
  handleUpdateCallCustomerVoice(req, res).catch((error) => {
    console.error('Update call customer voice error:', error);
    res.status(500).json({ error: 'Не удалось обновить голос клиента.' });
  });
});

app.delete('/api/admin/call-settings/customer-voices/:id', (req, res) => {
  handleDeleteCallCustomerVoice(req, res).catch((error) => {
    console.error('Delete call customer voice error:', error);
    res.status(500).json({ error: 'Не удалось удалить голос клиента.' });
  });
});

app.post('/api/admin/call-settings/customer-profiles', (req, res) => {
  handleCreateCallCustomerProfile(req, res).catch((error) => {
    console.error('Create call customer profile error:', error);
    res.status(500).json({ error: 'Не удалось создать профиль клиента.' });
  });
});

app.patch('/api/admin/call-settings/customer-profiles/:id', (req, res) => {
  handleUpdateCallCustomerProfile(req, res).catch((error) => {
    console.error('Update call customer profile error:', error);
    res.status(500).json({ error: 'Не удалось обновить профиль клиента.' });
  });
});

app.delete('/api/admin/call-settings/customer-profiles/:id', (req, res) => {
  handleDeleteCallCustomerProfile(req, res).catch((error) => {
    console.error('Delete call customer profile error:', error);
    res.status(500).json({ error: 'Не удалось удалить профиль клиента.' });
  });
});

app.get('/api/admin/call-settings/scripts', (req, res) => {
  handleListCallScripts(req, res).catch((error) => {
    console.error('List call scripts error:', error);
    res.status(500).json({ error: 'Не удалось загрузить скрипты.' });
  });
});

app.post('/api/admin/call-settings/scripts', (req, res) => {
  handleCreateCallScript(req, res).catch((error) => {
    console.error('Create call script error:', error);
    res.status(500).json({ error: 'Не удалось создать скрипт.' });
  });
});

app.patch('/api/admin/call-settings/scripts/:id', (req, res) => {
  handleUpdateCallScript(req, res).catch((error) => {
    console.error('Update call script error:', error);
    res.status(500).json({ error: 'Не удалось обновить скрипт.' });
  });
});

app.delete('/api/admin/call-settings/scripts/:id', (req, res) => {
  handleDeleteCallScript(req, res).catch((error) => {
    console.error('Delete call script error:', error);
    res.status(500).json({ error: 'Не удалось удалить скрипт.' });
  });
});

app.get('/api/admin/call-settings/plan-options', (req, res) => {
  handleGetCallPlanOptions(req, res).catch((error) => {
    console.error('Get call plan options error:', error);
    res.status(500).json({ error: 'Не удалось загрузить данные плана прозвона.' });
  });
});

app.get('/api/admin/call-settings/plans', (req, res) => {
  handleListCallPlans(req, res).catch((error) => {
    console.error('List call plans error:', error);
    res.status(500).json({ error: 'Не удалось загрузить планы прозвона.' });
  });
});

app.post('/api/admin/call-settings/plans', (req, res) => {
  handleCreateCallPlan(req, res).catch((error) => {
    console.error('Create call plan error:', error);
    res.status(500).json({ error: 'Не удалось создать план прозвона.' });
  });
});

app.patch('/api/admin/call-settings/plans/:id', (req, res) => {
  handleUpdateCallPlan(req, res).catch((error) => {
    console.error('Update call plan error:', error);
    res.status(500).json({ error: 'Не удалось обновить план прозвона.' });
  });
});

app.delete('/api/admin/call-settings/plans/:id', (req, res) => {
  handleDeleteCallPlan(req, res).catch((error) => {
    console.error('Delete call plan error:', error);
    res.status(500).json({ error: 'Не удалось удалить план прозвона.' });
  });
});

app.post('/api/admin/call-settings/plans/:id/initiate', (req, res) => {
  handleInitiateCallPlan(req, res).catch((error) => {
    console.error('Initiate call plan error:', error);
    res.status(500).json({ error: 'Не удалось инициировать прозвон.' });
  });
});

app.get('/api/admin/call-settings/plans/:id/prompt-preview', (req, res) => {
  handlePreviewCallPlanPrompt(req, res).catch((error) => {
    console.error('Preview call plan prompt error:', error);
    res.status(500).json({ error: 'Не удалось сгенерировать промпт.' });
  });
});

app.get('/api/admin/call-settings/plans/:id/calls', (req, res) => {
  handleListCallPlanCalls(req, res).catch((error) => {
    console.error('List call plan calls error:', error);
    res.status(500).json({ error: 'Не удалось загрузить историю прозвона.' });
  });
});

app.get('/api/admin/call-settings/plans/:id/schedule', (req, res) => {
  handleGetCallPlanSchedule(req, res).catch((error) => {
    console.error('Get call plan schedule error:', error);
    res.status(500).json({ error: 'Не удалось загрузить расписание прозвона.' });
  });
});

app.post('/api/admin/call-settings/plans/:id/schedule/:callId/recreate', (req, res) => {
  handleRecreateCallPlanScheduleCall(req, res).catch((error) => {
    console.error('Recreate call plan schedule call error:', error);
    res.status(500).json({ error: 'Не удалось пересоздать расписание прозвона.' });
  });
});

app.post('/api/imports', (req, res) => {
  handleCreateImport(req, res).catch((error) => {
    console.error('Create import error:', error);
    res.status(500).json({ error: 'Не удалось создать импорт.' });
  });
});

app.get('/api/imports/:id', (req, res) => {
  handleGetImport(req, res).catch((error) => {
    console.error('Get import error:', error);
    res.status(500).json({ error: 'Не удалось загрузить импорт.' });
  });
});

app.patch('/api/imports/:id', (req, res) => {
  handleUpdateImport(req, res).catch((error) => {
    console.error('Update import error:', error);
    res.status(500).json({ error: 'Не удалось обновить импорт.' });
  });
});

app.delete('/api/imports/:id', (req, res) => {
  handleDeleteImport(req, res).catch((error) => {
    console.error('Delete import error:', error);
    res.status(500).json({ error: 'Не удалось удалить импорт.' });
  });
});

app.post('/api/imports/:id/run', (req, res) => {
  handleRunImport(req, res).catch((error) => {
    console.error('Run import error:', error);
    res.status(500).json({ error: 'Не удалось запустить импорт.' });
  });
});

app.post('/api/imports/:id/cancel', (req, res) => {
  handleCancelImport(req, res).catch((error) => {
    console.error('Cancel import error:', error);
    res.status(500).json({ error: 'Не удалось остановить загрузку.' });
  });
});

app.get('/api/admin/rbac/meta', (req, res) => {
  handleRbacMeta(req, res).catch((error) => {
    console.error('RBAC meta error:', error);
    res.status(500).json({ error: 'Не удалось загрузить RBAC-метаданные.' });
  });
});

app.get('/api/admin/holdings', (req, res) => {
  handleListHoldings(req, res).catch((error) => {
    console.error('List holdings error:', error);
    res.status(500).json({ error: 'Не удалось загрузить компании.' });
  });
});

app.get('/api/admin/holdings/:holdingId/recommendations', (req, res) => {
  handleHoldingRecommendations(req, res).catch((error) => {
    console.error('Holding recommendations error:', error);
    res.status(500).json({ error: 'Не удалось рассчитать рекомендации компании.' });
  });
});

app.get('/api/admin/cities', (req, res) => {
  handleListCities(req, res).catch((error) => {
    console.error('List cities route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить города.' });
  });
});

app.post('/api/admin/holdings', (req, res) => {
  handleCreateHolding(req, res).catch((error) => {
    console.error('Create holding route error:', error);
    res.status(500).json({ error: 'Не удалось создать компанию.' });
  });
});

app.patch('/api/admin/holdings/:holdingId', (req, res) => {
  handleUpdateHolding(req, res).catch((error) => {
    console.error('Update holding route error:', error);
    res.status(500).json({ error: 'Не удалось обновить компанию.' });
  });
});

app.delete('/api/admin/holdings/:holdingId', (req, res) => {
  handleDeleteHolding(req, res).catch((error) => {
    console.error('Delete holding route error:', error);
    res.status(500).json({ error: 'Не удалось удалить компанию.' });
  });
});

app.get('/api/admin/dealerships', (req, res) => {
  handleListDealerships(req, res).catch((error) => {
    console.error('List dealerships error:', error);
    res.status(500).json({ error: 'Не удалось загрузить точки.' });
  });
});

app.get('/api/admin/dealerships/:dealershipId/recommendations', (req, res) => {
  handleDealershipRecommendations(req, res).catch((error) => {
    console.error('Dealership recommendations error:', error);
    res.status(500).json({ error: 'Не удалось рассчитать рекомендации точки.' });
  });
});

app.post('/api/admin/dealerships', (req, res) => {
  handleCreateDealership(req, res).catch((error) => {
    console.error('Create dealership route error:', error);
    res.status(500).json({ error: 'Не удалось создать точку.' });
  });
});

app.patch('/api/admin/dealerships/:dealershipId', (req, res) => {
  handleUpdateDealership(req, res).catch((error) => {
    console.error('Update dealership route error:', error);
    res.status(500).json({ error: 'Не удалось обновить точку.' });
  });
});

app.delete('/api/admin/dealerships/:dealershipId', (req, res) => {
  handleDeleteDealership(req, res).catch((error) => {
    console.error('Delete dealership route error:', error);
    res.status(500).json({ error: 'Не удалось удалить точку.' });
  });
});

app.get('/api/admin/dealership-directions', (req, res) => {
  handleListDealershipDirections(req, res).catch((error) => {
    console.error('List dealership directions route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить направления точек.' });
  });
});

app.post('/api/admin/dealership-directions', (req, res) => {
  handleCreateDealershipDirection(req, res).catch((error) => {
    console.error('Create dealership direction route error:', error);
    res.status(500).json({ error: 'Не удалось создать направление точки.' });
  });
});

app.patch('/api/admin/dealership-directions/:directionId', (req, res) => {
  handleUpdateDealershipDirection(req, res).catch((error) => {
    console.error('Update dealership direction route error:', error);
    res.status(500).json({ error: 'Не удалось обновить направление точки.' });
  });
});

app.delete('/api/admin/dealership-directions/:directionId', (req, res) => {
  handleDeleteDealershipDirection(req, res).catch((error) => {
    console.error('Delete dealership direction route error:', error);
    res.status(500).json({ error: 'Не удалось удалить направление точки.' });
  });
});

app.get('/api/admin/phone-number-types', (req, res) => {
  handleListPhoneNumberTypes(req, res).catch((error) => {
    console.error('List phone number types route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить типы номеров.' });
  });
});

app.post('/api/admin/phone-number-types', (req, res) => {
  handleCreatePhoneNumberType(req, res).catch((error) => {
    console.error('Create phone number type route error:', error);
    res.status(500).json({ error: 'Не удалось создать тип номера.' });
  });
});

app.patch('/api/admin/phone-number-types/:typeId', (req, res) => {
  handleUpdatePhoneNumberType(req, res).catch((error) => {
    console.error('Update phone number type route error:', error);
    res.status(500).json({ error: 'Не удалось обновить тип номера.' });
  });
});

app.delete('/api/admin/phone-number-types/:typeId', (req, res) => {
  handleDeletePhoneNumberType(req, res).catch((error) => {
    console.error('Delete phone number type route error:', error);
    res.status(500).json({ error: 'Не удалось удалить тип номера.' });
  });
});

app.get('/api/admin/dealerships/:dealershipId/phone-numbers', (req, res) => {
  handleListDealershipPhoneNumbers(req, res).catch((error) => {
    console.error('List dealership phone numbers route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить номера телефонов.' });
  });
});

app.post('/api/admin/dealerships/:dealershipId/phone-numbers', (req, res) => {
  handleCreateDealershipPhoneNumber(req, res).catch((error) => {
    console.error('Create dealership phone number route error:', error);
    res.status(500).json({ error: 'Не удалось добавить номер телефона.' });
  });
});

app.patch('/api/admin/dealership-phone-numbers/:phoneNumberId', (req, res) => {
  handleUpdateDealershipPhoneNumber(req, res).catch((error) => {
    console.error('Update dealership phone number route error:', error);
    res.status(500).json({ error: 'Не удалось обновить номер телефона.' });
  });
});

app.delete('/api/admin/dealership-phone-numbers/:phoneNumberId', (req, res) => {
  handleDeleteDealershipPhoneNumber(req, res).catch((error) => {
    console.error('Delete dealership phone number route error:', error);
    res.status(500).json({ error: 'Не удалось удалить номер телефона.' });
  });
});

app.post('/api/admin/organization/sync-mock', (req, res) => {
  handleSyncMockOrganization(req, res).catch((error) => {
    console.error('Sync mock organization route error:', error);
    res.status(500).json({ error: 'Не удалось синхронизировать оргструктуру.' });
  });
});

app.get('/api/admin/users', (req, res) => {
  handleListUsers(req, res).catch((error) => {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Не удалось загрузить пользователей.' });
  });
});

app.get('/api/admin/users/:accountId/recommendations', (req, res) => {
  handleUserRecommendations(req, res).catch((error) => {
    console.error('User recommendations error:', error);
    res.status(500).json({ error: 'Не удалось рассчитать рекомендации пользователя.' });
  });
});

app.post('/api/admin/users', (req, res) => {
  handleCreateUser(req, res).catch((error) => {
    console.error('Create user route error:', error);
    res.status(500).json({ error: 'Не удалось создать пользователя.' });
  });
});

app.patch('/api/admin/users/:accountId', (req, res) => {
  handleUpdateUser(req, res).catch((error) => {
    console.error('Update user route error:', error);
    res.status(500).json({ error: 'Не удалось обновить пользователя.' });
  });
});

app.post('/api/admin/me/password', (req, res) => {
  handleChangeOwnPassword(req, res).catch((error) => {
    console.error('Change own password route error:', error);
    res.status(500).json({ error: 'Не удалось изменить пароль.' });
  });
});

app.post('/api/admin/users/:accountId/password', (req, res) => {
  handleChangeUserPassword(req, res).catch((error) => {
    console.error('Change user password route error:', error);
    res.status(500).json({ error: 'Не удалось изменить пароль пользователя.' });
  });
});

app.delete('/api/admin/users/:accountId', (req, res) => {
  handleDeleteUser(req, res).catch((error) => {
    console.error('Delete user route error:', error);
    res.status(500).json({ error: 'Не удалось удалить пользователя.' });
  });
});

app.get('/api/admin/users/:accountId/phone-numbers', (req, res) => {
  handleListUserPhoneNumbers(req, res).catch((error) => {
    console.error('List user phone numbers route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить номера телефонов.' });
  });
});

app.post('/api/admin/users/:accountId/phone-numbers', (req, res) => {
  handleCreateUserPhoneNumber(req, res).catch((error) => {
    console.error('Create user phone number route error:', error);
    res.status(500).json({ error: 'Не удалось добавить номер телефона.' });
  });
});

app.patch('/api/admin/user-phone-numbers/:phoneNumberId', (req, res) => {
  handleUpdateUserPhoneNumber(req, res).catch((error) => {
    console.error('Update user phone number route error:', error);
    res.status(500).json({ error: 'Не удалось обновить номер телефона.' });
  });
});

app.delete('/api/admin/user-phone-numbers/:phoneNumberId', (req, res) => {
  handleDeleteUserPhoneNumber(req, res).catch((error) => {
    console.error('Delete user phone number route error:', error);
    res.status(500).json({ error: 'Не удалось удалить номер телефона.' });
  });
});

app.get('/api/admin/permission-templates', (req, res) => {
  handleListPermissionTemplates(req, res).catch((error) => {
    console.error('List permission templates error:', error);
    res.status(500).json({ error: 'Не удалось загрузить шаблоны прав.' });
  });
});

app.post('/api/admin/permission-templates', (req, res) => {
  handleCreatePermissionTemplate(req, res).catch((error) => {
    console.error('Create permission template error:', error);
    res.status(500).json({ error: 'Не удалось создать шаблон прав.' });
  });
});

app.patch('/api/admin/permission-templates/:templateId', (req, res) => {
  handleUpdatePermissionTemplate(req, res).catch((error) => {
    console.error('Update permission template error:', error);
    res.status(500).json({ error: 'Не удалось обновить шаблон прав.' });
  });
});

app.delete('/api/admin/permission-templates/:templateId', (req, res) => {
  handleDeletePermissionTemplate(req, res).catch((error) => {
    console.error('Delete permission template error:', error);
    res.status(500).json({ error: 'Не удалось удалить шаблон прав.' });
  });
});

// Get training session details (V2 evaluation-aware)
app.get('/api/admin/training-sessions/:sessionId', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const session = await prisma.trainingSession.findUnique({
      where: { id: sessionId },
      include: {
        user: true,
        messages: { orderBy: { createdAt: 'asc' as const } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const isFailed = session.status === 'failed';
    const hasV2Eval = session.evaluationJson != null;
    const hasLegacyAssessment = session.assessmentScore != null && session.assessmentJson != null;

    // Build conversation steps from messages (sequential pairs)
    const msgs = session.messages;
    const conversationPairs: Array<{ order: number; customerMessage: string; answer: string }> = [];
    for (let i = 0; i + 1 < msgs.length; i += 2) {
      if (msgs[i].role === 'client' && msgs[i + 1].role === 'manager') {
        conversationPairs.push({
          order: conversationPairs.length + 1,
          customerMessage: msgs[i].content,
          answer: msgs[i + 1].content,
        });
      }
    }

    // Collect behavior signals from manager messages (V2)
    const managerMsgs = msgs.filter(m => m.role === 'manager' && m.qualitySignalJson);
    let behaviorSummary: any = null;
    if (managerMsgs.length > 0) {
      let toxicCount = 0;
      let lowEffortCount = 0;
      let evasionCount = 0;
      const allProhibited: string[] = [];
      for (const m of managerMsgs) {
        try {
          const sig = JSON.parse(m.qualitySignalJson!);
          if (sig.toxic) toxicCount++;
          if (sig.low_effort) lowEffortCount++;
          if (sig.evasion) evasionCount++;
          if (Array.isArray(sig.prohibited_phrase_hits)) allProhibited.push(...sig.prohibited_phrase_hits);
        } catch { /* skip */ }
      }
      behaviorSummary = {
        totalManagerMessages: managerMsgs.length,
        toxicCount,
        lowEffortCount,
        evasionCount,
        prohibitedPhrases: [...new Set(allProhibited)],
      };
    }

    if (hasV2Eval) {
      // ── V2 evaluation response ──
      const evalData = JSON.parse(session.evaluationJson as string);
      const score = evalData.overall_score_0_100 ?? session.totalScore ?? 0;
      const level = scoreToLevel(score);
      const qualityTag = isFailed ? 'Плохо' : scoreToQualityTag(score);

      const checklistItems = Array.isArray(evalData.checklist) ? evalData.checklist : [];
      const issues = Array.isArray(evalData.issues) ? evalData.issues : [];
      const recommendations = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];

      const steps = conversationPairs.map((p) => {
        return {
          order: p.order,
          customerMessage: p.customerMessage,
          answer: p.answer,
          score: null,
          feedback: null,
          betterExample: null,
          criteriaScores: {} as Record<string, number>,
        };
      });

      return res.json({
        type: 'training',
        id: session.id,
        userName: session.user.fullName,
        testTitle: 'Тренировка с виртуальным клиентом',
        clientProfile: (session as any).clientProfile ?? 'normal',
        startedAt: session.createdAt,
        finishedAt: session.completedAt,
        totalScore: score,
        level,
        qualityTag,
        failureReason: session.failureReason,
        failureReasonLabel: isFailed ? getFailureReasonLabel(session.failureReason) : null,
        dimensionScores: evalData.dimension_scores ?? null,
        checklist: checklistItems,
        issues,
        strengths: checklistItems
          .filter((c: any) => c.status === 'YES')
          .map((c: any) => c.comment || c.code),
        weaknesses: issues.map((i: any) => i.recommendation || i.issue_type),
        recommendations,
        behaviorSummary,
        steps,
      });
    }

    // ── Legacy assessment fallback ──
    const data = hasLegacyAssessment ? JSON.parse(session.assessmentJson as string) : {};
    const score = hasLegacyAssessment ? (session.assessmentScore as number) : 0;
    const level = hasLegacyAssessment ? scoreToLevel(score) : null;
    const qualityTag = isFailed ? 'Плохо' : scoreToQualityTag(score);
    const assessmentSteps = (data.steps || []) as Array<{
      step_order: number;
      step_score: number;
      feedback?: string;
      better_example?: string;
    }>;
    const globalImprovements: string[] = Array.isArray(data.improvements)
      ? (data.improvements as string[])
      : [];

    const steps = conversationPairs.map((p) => {
      const stepData = assessmentSteps.find((s) => s.step_order === p.order);
      if (!stepData) {
        const genericImprovement =
          globalImprovements[0] ||
          'Ответить подробнее и сфокусироваться на пользе для клиента и следующем шаге.';
        return {
          order: p.order,
          customerMessage: p.customerMessage,
          answer: p.answer,
          score: 0,
          feedback:
            'Этот ответ не был отдельно оценён моделью. ' +
            `Общая рекомендация: ${genericImprovement}`,
          betterExample: genericImprovement,
          criteriaScores: {} as Record<string, number>,
        };
      }
      return {
        order: p.order,
        customerMessage: p.customerMessage,
        answer: p.answer,
        score: stepData.step_score ?? 0,
        feedback: stepData.feedback ?? null,
        betterExample: stepData.better_example ?? null,
        criteriaScores: {} as Record<string, number>,
      };
    });

    res.json({
      type: 'training',
      id: session.id,
      userName: session.user.fullName,
      testTitle: 'Тренировка с виртуальным клиентом',
      clientProfile: (session as any).clientProfile ?? 'normal',
      startedAt: session.createdAt,
      finishedAt: session.completedAt,
      totalScore: hasLegacyAssessment ? session.assessmentScore : isFailed ? 0 : null,
      level,
      qualityTag,
      failureReason: session.failureReason,
      failureReasonLabel: isFailed ? getFailureReasonLabel(session.failureReason) : null,
      dimensionScores: null,
      checklist: [],
      issues: [],
      strengths: [],
      weaknesses: data.mistakes || [],
      recommendations: data.improvements || [],
      behaviorSummary,
      steps,
    });
  } catch (error) {
    console.error('Get training session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single attempt details with full feedback (must come before /api/admin/attempts)
app.get('/api/admin/attempts/:attemptId', async (req, res) => {
  try {
    const attemptId = parseInt(req.params.attemptId);
    const attempt = await prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        user: true,
        test: true,
        answers: {
          include: {
            step: true,
          },
          orderBy: {
            step: {
              order: 'asc',
            },
          },
        },
      },
    });

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Only serve attempts with meaningful data (exclude empty force-closed sessions)
    const hasData =
      attempt.totalScore != null ||
      attempt.evaluationResultJson != null ||
      attempt.evaluationError != null;
    if (!hasData) {
      return res.status(404).json({ error: 'Attempt has no evaluation data' });
    }

    let steps: Array<{
      order: number;
      customerMessage: string;
      stepGoal?: string;
      answer: string;
      score: number | null;
      feedback: string | null;
      betterExample: string | null;
      criteriaScores: Record<string, number>;
    }>;

    if (attempt.answers.length > 0) {
      steps = attempt.answers.map(answer => ({
        order: answer.step.order,
        customerMessage: answer.step.customerMessage,
        stepGoal: answer.step.stepGoal,
        answer: answer.answerText,
        score: answer.stepScore,
        feedback: answer.feedback,
        betterExample: answer.betterExample,
        criteriaScores: answer.criteriaScoresJson ? JSON.parse(answer.criteriaScoresJson) : {},
      }));
    } else if (attempt.evaluationResultJson && attempt.conversationHistoryJson) {
      const history: Array<{ role: string; text: string }> = JSON.parse(attempt.conversationHistoryJson);
      const evalResult = JSON.parse(attempt.evaluationResultJson);
      const pairs: Array<{ customerMessage: string; answer: string }> = [];
      for (let i = 0; i + 1 < history.length; i += 2) {
        if (history[i].role === 'client' && history[i + 1].role === 'manager') {
          pairs.push({ customerMessage: history[i].text, answer: history[i + 1].text });
        }
      }
      steps = (evalResult.steps || []).map((s: { step_order: number; step_score: number; feedback?: string; better_example?: string; criteria?: Record<string, number> }, idx: number) => {
        const pair = pairs[idx] || { customerMessage: '', answer: '' };
        return {
          order: s.step_order,
          customerMessage: pair.customerMessage,
          answer: pair.answer,
          score: s.step_score,
          feedback: s.feedback ?? null,
          betterExample: s.better_example ?? null,
          criteriaScores: s.criteria ?? {},
        };
      });
    } else {
      steps = [];
    }

    const score = attempt.totalScore ?? 0;
    res.json({
      id: attempt.id,
      userName: attempt.user.fullName,
      testTitle: attempt.test.title,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      totalScore: attempt.totalScore,
      level: attempt.level,
      qualityTag: scoreToQualityTag(score),
      evaluationError: attempt.evaluationError,
      strengths: attempt.strengthsJson ? JSON.parse(attempt.strengthsJson) : [],
      weaknesses: attempt.weaknessesJson ? JSON.parse(attempt.weaknessesJson) : [],
      recommendations: attempt.recommendationsJson ? JSON.parse(attempt.recommendationsJson) : [],
      suspicionFlags: attempt.suspicionFlagsJson ? JSON.parse(attempt.suspicionFlagsJson) : [],
      steps,
    });
  } catch (error) {
    console.error('Get attempt details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper: derive level from score (for backward compatibility)
function scoreToLevel(score: number): string {
  if (score < 40) return 'Junior';
  if (score < 70) return 'Middle';
  return 'Senior';
}

// Quality tag for conversation result (one word)
function scoreToQualityTag(score: number): string {
  if (score < 50) return 'Плохо';
  if (score < 76) return 'Средне';
  return 'Хорошо';
}

function getFailureReasonLabel(reason?: string | null): string {
  if (!reason) return 'Тренировка досрочно завершена';
  const base = reason.split(':')[0];
  const map: Record<string, string> = {
    PROFANITY: 'Недопустимая лексика',
    BAD_TONE: 'Грубый / враждебный тон',
    IGNORED_QUESTIONS: 'Игнорирование вопросов клиента',
    POOR_COMMUNICATION: 'Низкое качество коммуникации',
    REPEATED_LOW_EFFORT: 'Повторные некачественные ответы',
    REPEATED_LOW_QUALITY: 'Повторные некачественные/формальные ответы',
    DISENGAGEMENT: 'Менеджер завершил коммуникацию / отказался от диалога',
    rude_language: 'Недопустимая лексика',
    ignored_questions: 'Игнорирование вопросов клиента',
    poor_communication: 'Низкое качество коммуникации',
    repeated_low_effort: 'Повторные некачественные ответы',
    repeated_low_quality: 'Повторные некачественные/формальные ответы',
    disengagement: 'Менеджер завершил коммуникацию / отказался от диалога',
  };
  if (map[base]) return map[base];
  if (base === 'CRITICAL_EVASION' || base === 'critical_evasion') {
    const topic = reason.split(':')[1] ?? '';
    return `Критический вопрос проигнорирован (${topic})`;
  }
  return 'Тренировка досрочно завершена';
}

// Short summary for card (from assessment or built from strengths/weaknesses)
function buildCardSummary(
  type: 'attempt' | 'training',
  data: { quality?: string; strengths?: string[]; weaknesses?: string[]; recommendations?: string[]; mistakes?: string[]; improvements?: string[] }
): string {
  if (type === 'training' && data.quality?.trim()) {
    return data.quality;
  }
  const parts: string[] = [];
  if (data.strengths?.length) parts.push(data.strengths[0]);
  if (data.weaknesses?.length) parts.push(data.weaknesses[0]);
  if (data.mistakes?.length) parts.push(data.mistakes[0]);
  if (data.recommendations?.length && parts.length < 2) parts.push(data.recommendations[0]);
  if (data.improvements?.length && parts.length < 2) parts.push(data.improvements[0]);
  return parts.slice(0, 2).join('. ') || 'Краткая оценка диалога.';
}

// Get attempts + training sessions merged (for Employees tab)
app.get('/api/admin/attempts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 1000;

    const [attempts, trainingSessions] = await Promise.all([
      prisma.attempt.findMany({
        where: completedWithDataWhere,
        include: {
          user: true,
          test: true,
          answers: {
            include: { step: true },
            orderBy: { step: { order: 'asc' as const } },
          },
        },
        orderBy: { finishedAt: 'desc' },
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          OR: [
            { assessmentScore: { not: null } },
            { failureReason: { not: null } },
          ],
        },
        include: { user: true },
        orderBy: { completedAt: 'desc' },
      }),
    ]);

    const attemptItems = attempts.map(a => {
      const strengths = a.strengthsJson ? JSON.parse(a.strengthsJson) : [];
      const weaknesses = a.weaknessesJson ? JSON.parse(a.weaknessesJson) : [];
      const recommendations = a.recommendationsJson ? JSON.parse(a.recommendationsJson) : [];
      const score = a.totalScore ?? 0;
      return {
        type: 'attempt' as const,
        id: a.id,
        userName: a.user.fullName,
        testTitle: a.test.title,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        totalScore: a.totalScore,
        level: a.level,
        qualityTag: scoreToQualityTag(score),
        summary: buildCardSummary('attempt', { strengths, weaknesses, recommendations }),
        evaluationError: a.evaluationError,
        strengths,
        weaknesses,
        recommendations,
        steps: a.answers.map(ans => ({
          order: ans.step.order,
          customerMessage: ans.step.customerMessage,
          answer: ans.answerText,
          score: ans.stepScore,
          feedback: ans.feedback,
        })),
      };
    });

    const trainingItems = trainingSessions.map(s => {
      const hasV2Eval = s.evaluationJson != null;
      const hasLegacyAssessment = s.assessmentScore != null && s.assessmentJson != null;
      const isFailed = s.status === 'failed';

      let score = 0;
      let weaknesses: string[] = [];
      let recommendations: string[] = [];
      let dimensionScores = null;

      if (hasV2Eval) {
        const evalData = JSON.parse(s.evaluationJson as string);
        score = evalData.overall_score_0_100 ?? s.totalScore ?? 0;
        weaknesses = Array.isArray(evalData.issues)
          ? evalData.issues.map((i: any) => i.recommendation || i.issue_type)
          : [];
        recommendations = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];
        dimensionScores = evalData.dimension_scores ?? null;
      } else if (hasLegacyAssessment) {
        const data = JSON.parse(s.assessmentJson as string);
        score = s.assessmentScore as number;
        weaknesses = Array.isArray(data.mistakes) ? data.mistakes : [];
        recommendations = Array.isArray(data.improvements) ? data.improvements : [];
      }

      const failReasonLabels: Record<string, string> = {
        rude_language: 'Досрочно завершена: недопустимая лексика.',
        ignored_questions: 'Досрочно завершена: менеджер игнорировал вопросы.',
        poor_communication: 'Досрочно завершена: низкое качество коммуникации.',
        repeated_low_effort: 'Досрочно завершена: повторные некачественные ответы.',
        PROFANITY: 'Досрочно завершена: недопустимая лексика.',
        BAD_TONE: 'Досрочно завершена: грубый / враждебный тон.',
        IGNORED_QUESTIONS: 'Досрочно завершена: менеджер игнорировал вопросы.',
        POOR_COMMUNICATION: 'Досрочно завершена: низкое качество коммуникации.',
        REPEATED_LOW_EFFORT: 'Досрочно завершена: повторные некачественные ответы.',
        REPEATED_LOW_QUALITY: 'Досрочно завершена: формальные/некачественные ответы.',
        DISENGAGEMENT: 'Досрочно завершена: менеджер отказался продолжать диалог.',
      };
      const baseReason = (s.failureReason ?? '').split(':')[0];

      let summary: string;
      if (isFailed) {
        summary = failReasonLabels[baseReason]
          ?? (baseReason === 'critical_evasion' || baseReason === 'CRITICAL_EVASION'
            ? `Досрочно завершена: критический вопрос проигнорирован (${(s.failureReason ?? '').split(':')[1] ?? ''}).`
            : 'Тренировка досрочно завершена системой.');
      } else if (hasV2Eval) {
        summary = `Балл: ${score}/100`;
      } else {
        const data = hasLegacyAssessment ? JSON.parse(s.assessmentJson as string) : {};
        summary = buildCardSummary('training', {
          quality: data.quality,
          mistakes: data.mistakes,
          improvements: data.improvements,
        });
      }

      return {
        type: 'training' as const,
        id: `t-${s.id}`,
        sessionId: s.id,
        userName: s.user.fullName,
        testTitle: 'Тренировка с виртуальным клиентом',
        clientProfile: (s as any).clientProfile ?? 'normal',
        startedAt: s.createdAt,
        finishedAt: s.completedAt,
        totalScore: score,
        level: scoreToLevel(score),
        qualityTag: isFailed ? 'Плохо' : scoreToQualityTag(score),
        summary,
        evaluationError: null,
        strengths: [],
        weaknesses,
        recommendations,
        dimensionScores,
        steps: [],
      };
    });

    const merged = [...attemptItems, ...trainingItems].sort((a, b) => {
      const dateA = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
      const dateB = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
      return dateB - dateA;
    });

    const total = merged.length;
    const page = 0;
    const paginated = merged.slice(0, limit);

    res.json({
      attempts: paginated,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Get attempts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get team summary (training & attempts) with in-memory snapshot cache
app.get('/api/admin/summary', async (req, res) => {
  try {
    const now = Date.now();
    if (teamSummaryCache.data && teamSummaryCache.expiresAt > now) {
      return res.json(teamSummaryCache.data);
    }

    const [attempts, trainingSessions] = await Promise.all([
      prisma.attempt.findMany({
        where: { status: 'completed', totalScore: { not: null } },
        include: {
          user: true,
        },
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          OR: [
            { assessmentScore: { not: null } },
            { failureReason: { not: null } },
          ],
        },
        include: {
          user: true,
        },
      }),
    ]);

    const totalItems = attempts.length + trainingSessions.length;

    if (totalItems === 0) {
      const empty: TeamSummaryCache = {
        totalAttempts: 0,
        avgScore: 0,
        levelCounts: { Junior: 0, Middle: 0, Senior: 0 },
        topWeaknesses: [],
        topStrengths: [],
        expertSummary: null,
      };
      teamSummaryCache = { data: empty, expiresAt: now + ANALYTICS_TTL_MS };
      return res.json(empty);
    }

    const totalScoreAttempts = attempts.reduce((sum, a) => sum + (a.totalScore || 0), 0);
    const totalScoreTrainings = trainingSessions.reduce((sum, s) => {
      if (s.totalScore != null) return sum + s.totalScore;
      if (s.evaluationJson != null) {
        try {
          const evalData = JSON.parse(s.evaluationJson);
          if (typeof evalData.overall_score_0_100 === 'number') return sum + evalData.overall_score_0_100;
        } catch { /* skip */ }
      }
      if (s.assessmentScore != null) return sum + s.assessmentScore;
      if (s.status === 'failed') return sum;
      return sum;
    }, 0);

    const totalScore = totalScoreAttempts + totalScoreTrainings;
    const avgScore = totalItems > 0 ? totalScore / totalItems : 0;

    const levelCounts = {
      Junior: 0,
      Middle: 0,
      Senior: 0,
    };

    const allWeaknesses: Record<string, number> = {};
    const allStrengths: Record<string, number> = {};

    attempts.forEach((attempt) => {
      if (attempt.level) {
        levelCounts[attempt.level as keyof typeof levelCounts]++;
      }
      if (attempt.weaknessesJson) {
        const weaknesses = JSON.parse(attempt.weaknessesJson);
        weaknesses.forEach((w: string) => {
          allWeaknesses[w] = (allWeaknesses[w] || 0) + 1;
        });
      }
      if (attempt.strengthsJson) {
        const strengths = JSON.parse(attempt.strengthsJson);
        strengths.forEach((s: string) => {
          allStrengths[s] = (allStrengths[s] || 0) + 1;
        });
      }
    });

    trainingSessions.forEach((s) => {
      const hasV2Eval = s.evaluationJson != null;
      if (hasV2Eval) {
        try {
          const evalData = JSON.parse(s.evaluationJson as string);
          const issues: any[] = Array.isArray(evalData.issues) ? evalData.issues : [];
          const recs: string[] = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];
          const checklistItems: any[] = Array.isArray(evalData.checklist) ? evalData.checklist : [];
          issues.forEach((i: any) => {
            const text = i.recommendation || i.issue_type || '';
            if (text) allWeaknesses[text] = (allWeaknesses[text] || 0) + 1;
          });
          recs.forEach((r: string) => {
            if (r) allStrengths[r] = (allStrengths[r] || 0) + 1;
          });
          checklistItems
            .filter((c: any) => c.status === 'YES')
            .forEach((c: any) => {
              const text = c.comment || c.code;
              if (text) allStrengths[text] = (allStrengths[text] || 0) + 1;
            });
        } catch { /* skip malformed JSON */ }
      } else if (s.assessmentJson) {
        const data = JSON.parse(s.assessmentJson) as {
          mistakes?: string[];
          improvements?: string[];
          quality?: string;
        };
        const mistakes = Array.isArray(data.mistakes) ? data.mistakes : [];
        const improvements = Array.isArray(data.improvements) ? data.improvements : [];
        mistakes.forEach((w: string) => {
          allWeaknesses[w] = (allWeaknesses[w] || 0) + 1;
        });
        improvements.forEach((r: string) => {
          allStrengths[r] = (allStrengths[r] || 0) + 1;
        });
      }
    });

    const topWeaknesses = Object.entries(allWeaknesses)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([weakness, count]) => ({ weakness, count }));

    const topStrengths = Object.entries(allStrengths)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([strength, count]) => ({ strength, count }));

    // Prepare data for expert summary
    const teamData = {
      totalAttempts: totalItems,
      avgScore,
      levelCounts,
      topWeaknesses,
      topStrengths,
      attempts: [
        ...attempts.map(a => ({
          userName: a.user.fullName,
          score: a.totalScore || 0,
          level: a.level || '',
          strengths: a.strengthsJson ? JSON.parse(a.strengthsJson) : [],
          weaknesses: a.weaknessesJson ? JSON.parse(a.weaknessesJson) : [],
          recommendations: a.recommendationsJson ? JSON.parse(a.recommendationsJson) : [],
        })),
        ...trainingSessions.map(s => {
          let score = 0;
          let weaknesses: string[] = [];
          let recommendations: string[] = [];
          let strengths: string[] = [];

          if (s.evaluationJson) {
            try {
              const evalData = JSON.parse(s.evaluationJson);
              score = evalData.overall_score_0_100 ?? s.totalScore ?? s.assessmentScore ?? 0;
              weaknesses = Array.isArray(evalData.issues)
                ? evalData.issues.map((i: any) => i.recommendation || i.issue_type)
                : [];
              recommendations = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];
              strengths = Array.isArray(evalData.checklist)
                ? evalData.checklist.filter((c: any) => c.status === 'YES').map((c: any) => c.comment || c.code)
                : [];
            } catch { /* skip */ }
          } else if (s.assessmentJson) {
            const data = JSON.parse(s.assessmentJson) as { mistakes?: string[]; improvements?: string[] };
            score = s.assessmentScore ?? 0;
            weaknesses = data.mistakes || [];
            recommendations = data.improvements || [];
          }

          return {
            userName: s.user.fullName,
            score,
            level: scoreToLevel(score),
            strengths,
            weaknesses,
            recommendations,
          };
        }),
      ],
    };

    // Generate expert summary
    let expertSummary = null;
    try {
      const { generateExpertTeamSummary } = await import('./team-summary');
      expertSummary = await generateExpertTeamSummary(teamData);
    } catch (error) {
      console.error('Error generating expert summary:', error);
      // Continue without expert summary if generation fails
    }

    const payload: TeamSummaryCache = {
      totalAttempts: totalItems,
      avgScore: Math.round(avgScore * 10) / 10,
      levelCounts,
      topWeaknesses,
      topStrengths,
      expertSummary,
    };
    teamSummaryCache = { data: payload, expiresAt: now + ANALYTICS_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Get summary error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/dashboard/overview', async (req, res) => {
  try {
    const holdingId = typeof req.query.holdingId === 'string' ? req.query.holdingId.trim() : '';
    const directionId = typeof req.query.directionId === 'string' ? req.query.directionId.trim() : '';
    const dealershipTypeRaw = typeof req.query.dealershipType === 'string' ? req.query.dealershipType.trim() : '';
    const dealershipType = dealershipTypeRaw === 'own' || dealershipTypeRaw === 'franchised' ? dealershipTypeRaw : '';
    const days = 7;

    let directionMeta: { id: string; code: string | null } | null = null;
    if (directionId) {
      const direction = await prisma.dealershipDirection.findFirst({
        where: {
          id: directionId,
          ...(holdingId ? { holdingId } : {}),
        },
        select: { id: true, code: true },
      });
      if (direction) directionMeta = direction;
    }

    const [dealerships, sessions, attempts, trainingSessions, trainerSessions] = await Promise.all([
      prisma.dealership.findMany({
        where: {
          isActive: true,
          ...(holdingId ? { holdingId } : {}),
        },
        include: {
          holding: true,
          managerProfiles: { select: { id: true, accountId: true, fullName: true, status: true } },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.voiceCallSession.findMany({
        where: {
          dealershipId: { not: null },
          ...(holdingId ? { dealership: { holdingId } } : {}),
          OR: [
            { totalScore: { not: null } },
            { evaluationJson: { not: null } },
            { outcome: { in: ['no_answer', 'busy', 'failed', 'disconnected', 'completed'] } },
          ],
        },
        select: {
          id: true,
          startedAt: true,
          outcome: true,
          totalScore: true,
          evaluationJson: true,
          dimensionsJson: true,
          checklistResultsJson: true,
          dealershipId: true,
          managerId: true,
          durationSec: true,
          answerTimeSec: true,
          talkDurationSec: true,
          dealership: { select: { type: true, holding: { select: { type: true } } } },
        },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.attempt.findMany({
        where: {
          status: 'completed',
          totalScore: { not: null },
          ...(holdingId ? { user: { managerProfile: { is: { dealership: { holdingId } } } } } : {}),
        },
        select: {
          finishedAt: true,
          totalScore: true,
          user: { select: { managerProfile: { select: { id: true, dealershipId: true } } } },
        },
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          ...(holdingId ? { user: { managerProfile: { is: { dealership: { holdingId } } } } } : {}),
          OR: [
            { assessmentScore: { not: null } },
            { evaluationJson: { not: null } },
          ],
        },
        select: {
          completedAt: true,
          totalScore: true,
          evaluationJson: true,
          assessmentScore: true,
          user: { select: { managerProfile: { select: { id: true, dealershipId: true } } } },
        },
      }),
      prisma.trainerSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          ...(holdingId ? {
            OR: [
              { companyId: holdingId },
              { branch: { holdingId } },
              { employee: { dealership: { holdingId } } },
            ],
          } : {}),
        },
        select: {
          completedAt: true,
          score: true,
          evaluationJson: true,
          branchId: true,
          employee: { select: { id: true, dealershipId: true } },
        },
      }),
    ]);

    const filteredDealerships = dealerships.filter((dealership) =>
      dealershipMatchesDashboardFilters(dealership, {
        dealershipType: dealershipType || undefined,
        direction: directionMeta,
      }),
    );
    const allowedDealershipIds = new Set(filteredDealerships.map((dealership) => dealership.id));
    const uniqueEmployeeKeys = new Set(
      filteredDealerships.flatMap((dealership) => dealership.managerProfiles
        .filter((manager) => manager.status === 'active')
        .map((manager) => manager.accountId ? `account:${manager.accountId}` : `profile:${manager.id}`)),
    );

    const filteredSessions = sessions.filter(
      (session) => session.dealershipId && allowedDealershipIds.has(session.dealershipId),
    );
    const filteredAttempts = attempts.filter((attempt) => {
      const dealershipId = attempt.user?.managerProfile?.dealershipId;
      return Boolean(dealershipId && allowedDealershipIds.has(dealershipId));
    });
    const filteredTrainingSessions = trainingSessions.filter((session) => {
      const dealershipId = session.user?.managerProfile?.dealershipId;
      return Boolean(dealershipId && allowedDealershipIds.has(dealershipId));
    });
    const filteredTrainerSessions = trainerSessions.filter((session) => {
      const dealershipId = session.branchId ?? session.employee.dealershipId;
      return allowedDealershipIds.has(dealershipId);
    });

    const trainingScore = (session: { totalScore: number | null; assessmentScore: number | null; evaluationJson: string | null }) => {
      if (typeof session.totalScore === 'number') return session.totalScore;
      if (typeof session.assessmentScore === 'number') return session.assessmentScore;
      const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
      const score = evaluation?.overall_score_0_100;
      return typeof score === 'number' ? score : null;
    };
    const trainerScore = (session: { score: number | null; evaluationJson: string | null }) => {
      if (typeof session.score === 'number') return session.score;
      const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
      if (!evaluation) return null;
      return scoreFromEvaluation(evaluation, null);
    };

    const scoredValues = [
      ...filteredAttempts.map((attempt) => attempt.totalScore ?? null),
      ...filteredTrainingSessions.map(trainingScore),
      ...filteredTrainerSessions.map(trainerScore),
      ...filteredSessions.map(scoreFromAnalyticsSession),
    ].filter((score): score is number => typeof score === 'number');

    const avgScore = scoredValues.length
      ? round1(scoredValues.reduce((sum, score) => sum + score, 0) / scoredValues.length)
      : 0;

    const employeeRatings = new Map<string, { id: string; name: string; auditsCount: number; scores: number[] }>();
    const employeeKeyByProfileId = new Map<string, string>();
    for (const dealership of dealerships) {
      for (const manager of dealership.managerProfiles) {
        if (manager.status !== 'active') continue;
        const key = manager.accountId ? `account:${manager.accountId}` : `profile:${manager.id}`;
        employeeKeyByProfileId.set(manager.id, key);
        if (!employeeRatings.has(key)) {
          employeeRatings.set(key, { id: manager.accountId || manager.id, name: manager.fullName, auditsCount: 0, scores: [] });
        }
      }
    }
    const addEmployeeAudit = (managerId: string | null | undefined, score: number | null) => {
      if (!managerId) return;
      const key = employeeKeyByProfileId.get(managerId);
      const employee = key ? employeeRatings.get(key) : null;
      if (!employee) return;
      employee.auditsCount += 1;
      if (typeof score === 'number' && Number.isFinite(score)) employee.scores.push(score);
    };
    for (const session of sessions) addEmployeeAudit(session.managerId, scoreFromAnalyticsSession(session));
    for (const session of trainingSessions) addEmployeeAudit(session.user?.managerProfile?.id, trainingScore(session));
    for (const session of trainerSessions) addEmployeeAudit(session.employee.id, trainerScore(session));
    const employeeRatingRows = [...employeeRatings.values()]
      .filter((employee) => employee.scores.length > 0)
      .map((employee) => ({
        id: employee.id,
        name: employee.name,
        auditsCount: employee.auditsCount,
        aiRating: round1(employee.scores.reduce((sum, score) => sum + score, 0) / employee.scores.length),
      }))
      .filter((employee) => employee.aiRating > 0);

    const checklistCounts = new Map<string, { count: number; total: number }>();
    for (const session of filteredSessions) {
      const checklist = extractChecklistFromSession(session);
      for (const item of checklist) {
        const key = item.comment || item.code || 'Неизвестный блок';
        const current = checklistCounts.get(key) ?? { count: 0, total: 0 };
        current.total += 1;
        if (String(item.status).toUpperCase() === 'NO') current.count += 1;
        checklistCounts.set(key, current);
      }
    }
    const topWeakness = [...checklistCounts.entries()]
      .filter(([, value]) => value.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([weakness, value]) => ({ weakness, count: value.count, percent: percent(value.count, value.total) }))[0] ?? null;

    const dealershipRows = filteredDealerships.map((dealership) => {
      const dealershipSessions = filteredSessions.filter((session) => session.dealershipId === dealership.id);
      const dealershipTrainerSessions = filteredTrainerSessions.filter(
        (session) => (session.branchId ?? session.employee.dealershipId) === dealership.id,
      );
      const scored = dealershipSessions
        .map((session) => ({ ...session, resolvedScore: scoreFromAnalyticsSession(session) }))
        .filter((session) => typeof session.resolvedScore === 'number');
      const durations = dealershipSessions
        .map((session) => session.talkDurationSec ?? session.durationSec)
        .filter((duration): duration is number => typeof duration === 'number' && duration > 0);
      const avgAnswerTimeSec = averagePositiveMetric(dealershipSessions, (session) => session.answerTimeSec);
      const currentStart = new Date();
      currentStart.setDate(currentStart.getDate() - 30);
      const previousStart = new Date();
      previousStart.setDate(previousStart.getDate() - 60);
      const currentScored = scored.filter((session) => session.startedAt >= currentStart);
      const previousScored = scored.filter((session) => session.startedAt >= previousStart && session.startedAt < currentStart);
      const currentAvg = currentScored.length
        ? currentScored.reduce((sum, session) => sum + (session.resolvedScore ?? 0), 0) / currentScored.length
        : null;
      const previousAvg = previousScored.length
        ? previousScored.reduce((sum, session) => sum + (session.resolvedScore ?? 0), 0) / previousScored.length
        : null;
      return {
        id: dealership.id,
        name: dealership.name,
        managersCount: new Set(dealership.managerProfiles
          .filter((manager) => manager.status === 'active')
          .map((manager) => manager.accountId ? `account:${manager.accountId}` : `profile:${manager.id}`)).size,
        avgAiScore: scoreFromSessions(dealershipSessions),
        answerRate: answerRateFromSessions(dealershipSessions) ?? 0,
        totalAudits: dealershipSessions.length + dealershipTrainerSessions.length,
        avgDurationSec: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : 0,
        avgAnswerTimeSec: avgAnswerTimeSec ?? 0,
        lastAudit: dealershipSessions[0]?.startedAt.toISOString() ?? null,
        trend: currentAvg != null && previousAvg != null ? Math.round(currentAvg - previousAvg) : 0,
      };
    });

    const hourlyAnswerRate = Array.from({ length: 24 }, (_, hour) => {
      const hourly = filteredSessions.filter((session) => session.startedAt.getHours() === hour);
      return answerRateFromSessions(hourly) ?? 0;
    });

    const noAnswers = filteredSessions.filter((session) => session.outcome === 'no_answer').length;
    const lowDealerships = dealershipRows.filter((row) => row.totalAudits > 0 && row.avgAiScore < 50);

    res.json({
      aiSummary: await generateAnalyticsAISummary({
        level: 'network',
        score: avgScore,
        calls: filteredSessions.length,
        noAnswers,
        topIssue: topWeakness?.weakness ?? null,
        topIssuePercent: topWeakness?.percent ?? null,
        lowDealerships: lowDealerships.length,
      }),
      avgScore,
      totalAudits: filteredAttempts.length + filteredTrainingSessions.length + filteredTrainerSessions.length + filteredSessions.length,
      totalDealerships: filteredDealerships.length,
      totalEmployees: uniqueEmployeeKeys.size,
      answerRate: answerRateFromSessions(filteredSessions) ?? 0,
      totalCalls: filteredSessions.length,
      timeSeries: typeTimeSeriesFromSessions(filteredSessions, days),
      hourlyAnswerRate,
      answerTimeByCompany: dealershipRows
        .filter((row) => row.avgAnswerTimeSec > 0)
        .sort((a, b) => b.avgAnswerTimeSec - a.avgAnswerTimeSec)
        .slice(0, 8)
        .map((row) => ({ id: row.id, name: row.name, avgSec: row.avgAnswerTimeSec, totalCalls: row.totalAudits })),
      topDealerships: [...dealershipRows]
        .filter((row) => row.totalAudits > 0)
        .sort((a, b) => b.avgAiScore - a.avgAiScore)
        .slice(0, 5),
      lowDealerships: [...dealershipRows]
        .filter((row) => row.totalAudits > 0)
        .sort((a, b) => a.avgAiScore - b.avgAiScore)
        .slice(0, 5),
      topEmployees: [...employeeRatingRows]
        .sort((a, b) => b.aiRating - a.aiRating || b.auditsCount - a.auditsCount || a.name.localeCompare(b.name, 'ru'))
        .slice(0, 10),
      lowEmployees: [...employeeRatingRows]
        .sort((a, b) => a.aiRating - b.aiRating || b.auditsCount - a.auditsCount || a.name.localeCompare(b.name, 'ru'))
        .slice(0, 10),
      topWeakness: topWeakness ? { weakness: topWeakness.weakness, count: topWeakness.count } : null,
      riskLabel: lowDealerships[0]?.name ?? topWeakness?.weakness ?? null,
    });
  } catch (error) {
    console.error('dashboard/overview error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Voice calls dashboard (telephony availability) with in-memory snapshot cache
app.get('/api/admin/voice-dashboard', async (_req, res) => {
  try {
    const now = Date.now();
    if (voiceDashboardCache.data && voiceDashboardCache.expiresAt > now) {
      return res.json(voiceDashboardCache.data);
    }

    const calls = await prisma.voiceCallSession.findMany();
    if (!calls.length) {
      const empty: VoiceDashboardCache = {
        totalCalls: 0,
        answeredPercent: 0,
        missedPercent: 0,
        avgDurationSec: 0,
        outcomeBreakdown: {
          completed: 0,
          no_answer: 0,
          busy: 0,
          failed: 0,
          disconnected: 0,
        },
      };
      voiceDashboardCache = { data: empty, expiresAt: now + ANALYTICS_TTL_MS };
      return res.json(empty);
    }

    const breakdown: VoiceDashboardCache['outcomeBreakdown'] = {
      completed: 0,
      no_answer: 0,
      busy: 0,
      failed: 0,
      disconnected: 0,
    };

    let totalDuration = 0;
    let durationCount = 0;

    for (const c of calls) {
      const key = (c.outcome || 'disconnected') as keyof typeof breakdown;
      if (breakdown[key] !== undefined) {
        breakdown[key] += 1;
      } else {
        breakdown.disconnected += 1;
      }
      if (typeof c.durationSec === 'number' && c.durationSec > 0) {
        totalDuration += c.durationSec;
        durationCount += 1;
      }
    }

    const total = calls.length;
    const answered = breakdown.completed;
    const missed = total - answered;
    const answeredPercent = total > 0 ? Math.round((answered / total) * 100) : 0;
    const missedPercent = total > 0 ? Math.round((missed / total) * 100) : 0;
    const avgDurationSec = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;

    const payload: VoiceDashboardCache = {
      totalCalls: total,
      answeredPercent,
      missedPercent,
      avgDurationSec,
      outcomeBreakdown: breakdown,
    };
    voiceDashboardCache = { data: payload, expiresAt: now + ANALYTICS_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Get voice-dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get OpenAI usage/expenses for current period
app.get('/api/admin/expenses', async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const startTime = Math.floor(startOfMonth.getTime() / 1000);
    const endTime = Math.floor(endOfMonth.getTime() / 1000);

    let totalSpentUsd = 0;
    let error: string | null = null;

    try {
      const https = await import('https');
      const response = await new Promise<{ statusCode: number; data: string }>((resolve, reject) => {
        const url = `https://api.openai.com/v1/organization/costs?start_time=${startTime}&end_time=${endTime}&limit=31`;
        const apiKey = config.openaiApiKey;
        if (!apiKey) {
          reject(new Error('OPENAI_API_KEY not configured'));
          return;
        }
        const req = https.get(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }, (resp) => {
          let data = '';
          resp.on('data', (chunk) => { data += chunk; });
          resp.on('end', () => resolve({ statusCode: resp.statusCode || 0, data }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });

      if (response.statusCode === 200) {
        const json = JSON.parse(response.data);
        const buckets = json.data || [];
        for (const bucket of buckets) {
          const results = bucket.results || [];
          for (const r of results) {
            const amount = r.amount;
            if (amount && typeof amount.value === 'number') {
              totalSpentUsd += amount.value;
            }
          }
        }
      } else {
        try {
          const errJson = response.data ? JSON.parse(response.data) : {};
          error = errJson.error?.message || `API returned ${response.statusCode}`;
        } catch {
          error = `API returned ${response.statusCode}`;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = msg;
      if (msg.includes('401') || msg.includes('403') || msg.includes('organization')) {
        error = 'Требуется ключ организации (Organization API key) для доступа к данным расходов. Используйте platform.openai.com для просмотра.';
      }
    }

    res.json({
      periodStart: startOfMonth.toISOString(),
      periodEnd: endOfMonth.toISOString(),
      totalSpentUsd: Math.round(totalSpentUsd * 100) / 100,
      currency: 'USD',
      error,
      billingUrl: 'https://platform.openai.com/account/billing',
    });
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get managers list
app.get('/api/admin/managers', async (req, res) => {
  try {
    const managers = await prisma.user.findMany({
      where: { role: 'manager' },
      include: {
        attempts: {
          where: completedWithDataWhere,
          orderBy: { finishedAt: 'desc' },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    res.json({
      managers: managers.map(manager => ({
        id: manager.id,
        name: manager.fullName,
        telegramId: manager.telegramId,
        attemptsCount: manager.attempts.length,
        latestAttempt: manager.attempts[0] ? {
          id: manager.attempts[0].id,
          finishedAt: manager.attempts[0].finishedAt,
          score: manager.attempts[0].totalScore,
          level: manager.attempts[0].level,
        } : null,
      })),
    });
  } catch (error) {
    console.error('Get managers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get manager attempts
app.get('/api/admin/managers/:managerId/attempts', async (req, res) => {
  try {
    const managerId = parseInt(req.params.managerId);
    const attempts = await prisma.attempt.findMany({
      where: {
        userId: managerId,
        ...completedWithDataWhere,
      },
      include: {
        test: true,
        answers: {
          include: {
            step: true,
          },
          orderBy: {
            step: {
              order: 'asc',
            },
          },
        },
      },
      orderBy: { finishedAt: 'desc' },
    });

    res.json({
      attempts: attempts.map(attempt => ({
        id: attempt.id,
        testTitle: attempt.test.title,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        totalScore: attempt.totalScore,
        level: attempt.level,
        strengths: attempt.strengthsJson ? JSON.parse(attempt.strengthsJson) : [],
        weaknesses: attempt.weaknessesJson ? JSON.parse(attempt.weaknessesJson) : [],
        recommendations: attempt.recommendationsJson ? JSON.parse(attempt.recommendationsJson) : [],
        steps: attempt.answers.map(answer => ({
          order: answer.step.order,
          customerMessage: answer.step.customerMessage,
          answer: answer.answerText,
          score: answer.stepScore,
          feedback: answer.feedback,
        })),
      })),
    });
  } catch (error) {
    console.error('Get manager attempts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: diagnose voice env (no secrets — only presence). Uses live tunnel URL when available.
app.get('/api/admin/voice-env-check', (_req, res) => {
  const VOX_ACCOUNT_ID = !!process.env.VOX_ACCOUNT_ID?.trim();
  const VOX_API_KEY = !!process.env.VOX_API_KEY?.trim();
  const VOX_APP_ID = !!process.env.VOX_APP_ID?.trim();
  const VOX_CALLER_ID = !!process.env.VOX_CALLER_ID?.trim();
  const tunnelLive = !!getTunnelUrl()?.trim();
  const baseUrlFromEnv = !!(process.env.VOICE_DIALOG_BASE_URL || process.env.MINI_APP_URL || process.env.PUBLIC_BASE_URL)?.trim();
  const baseUrl = tunnelLive || baseUrlFromEnv;
  const voxKeys = Object.keys(process.env).filter((k) => k.startsWith('VOX_') || k.startsWith('VOICE_'));
  res.json({
    ok: VOX_ACCOUNT_ID && VOX_API_KEY && VOX_APP_ID && baseUrl,
    VOX_ACCOUNT_ID,
    VOX_API_KEY,
    VOX_APP_ID,
    VOX_CALLER_ID,
    VOICE_DIALOG_BASE_URL_or_MINI_APP_URL: baseUrl,
    tunnel_live: tunnelLive,
    voxAndVoiceKeysInProcess: voxKeys.sort(),
  });
});

// Admin: test numbers for Call tab (from .env)
app.get('/api/admin/test-numbers', (_req, res) => {
  try {
    const numbers = getTestNumbers();
    res.json({ numbers });
  } catch (err) {
    console.error('test-numbers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: start voice call (Voximplant)
app.post('/api/admin/start-voice-call', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const toRaw = body.to != null ? String(body.to).trim() : null;
    const numbers = getTestNumbers();
    const defaultTo = numbers.length > 0 ? numbers[0] : null;
    const to = toRaw || defaultTo;
    if (!to) {
      return res.status(400).json({
        error: 'Укажите номер (to) или задайте VOX_TEST_TO / VOX_TEST_NUMBERS в .env.',
      });
    }
    const scenario = (body.scenario === 'realtime' || body.scenario === 'realtime_pure' || body.scenario === 'dialog') ? body.scenario : 'realtime_pure';
    const result = await startVoiceCall(to, { scenario });
    if ('error' in result) {
      return res.status(400).json({ error: result.error });
    }
    addCall(result.callId, to);
    if (result.callSessionHistoryId) {
      setVoxSessionId(result.callId, result.callSessionHistoryId);
    }
    const toNormalized = '+' + String(to).replace(/\D/g, '');
    const manager = await resolveTrainerManager(req);
    try {
      await prisma.voiceCallSession.create({
        data: {
          callId: result.callId,
          to: toNormalized,
          scenario: result.scenario ?? 'dialog',
          source: 'manual',
          dealershipId: manager?.dealershipId ?? null,
          managerId: manager?.id ?? null,
          startedAt: new Date(result.startedAt),
        },
      });
    } catch (e) {
      console.warn('[voice] VoiceCallSession create (may already exist):', e instanceof Error ? e.message : e);
    }
    res.json({ callId: result.callId, startedAt: result.startedAt, to, scenario: result.scenario });
  } catch (err) {
    console.error('start-voice-call error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/public/demo-call/start', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const toRaw = body.to != null ? String(body.to).trim() : '';
    if (!toRaw) {
      return res.status(400).json({ error: 'Введите номер телефона.' });
    }
    const scenario = body.scenario === 'dialog' || body.scenario === 'realtime'
      ? body.scenario
      : 'realtime_pure';
    const result = await startVoiceCall(toRaw, {
      scenario,
      instructions: DEMO_CALL_PROMPT,
    });
    if ('error' in result) {
      return res.status(400).json({ error: result.error });
    }
    addCall(result.callId, toRaw);
    if (result.callSessionHistoryId) {
      setVoxSessionId(result.callId, result.callSessionHistoryId);
    }
    const toNormalized = '+' + String(toRaw).replace(/\D/g, '');
    // nginx.prod.conf overwrites X-Real-IP with $remote_addr, so prefer it over a client-supplied X-Forwarded-For chain.
    const realIp = String(req.headers['x-real-ip'] || '').trim();
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim();
    const ipAddress = (realIp || forwardedFor || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64) || null;
    try {
      await prisma.voiceCallSession.create({
        data: {
          callId: result.callId,
          to: toNormalized,
          scenario: result.scenario ?? 'realtime_pure',
          source: 'demo',
          ipAddress,
          caseContextJson: JSON.stringify({
            kind: 'fixed_demo_call',
            prompt: DEMO_CALL_PROMPT,
            criteria: DEMO_CALL_CRITERIA,
          }),
          startedAt: new Date(result.startedAt),
        },
      });
    } catch (e) {
      console.warn('[demo-call] VoiceCallSession create (may already exist):', e instanceof Error ? e.message : e);
    }
    res.json({ callId: result.callId, startedAt: result.startedAt, to: toRaw, scenario: result.scenario });
  } catch (err) {
    console.error('public demo-call/start error:', err);
    res.status(500).json({ error: 'Не удалось запустить звонок.' });
  }
});

/** Пример отчёта на странице /demo-call: полная оценка стенограммы (evaluatorV2 + LLM-сводка и улучшения ответов). */
app.post('/api/public/demo-call/evaluate-example', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const raw = (body as { transcript?: unknown }).transcript;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'Ожидается массив transcript: [{ role, text }].' });
    }
    const transcript = raw
      .map((row) =>
        row && typeof row === 'object'
          ? {
              role: String((row as { role?: unknown }).role ?? ''),
              text: String((row as { text?: unknown }).text ?? ''),
            }
          : null
      )
      .filter((x): x is { role: string; text: string } => !!x);
    const result = await evaluateDemoExampleFromTranscript(transcript);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось оценить пример.';
    console.error('public demo-call/evaluate-example error:', err);
    res.status(500).json({ error: message });
  }
});

app.get('/api/public/demo-call/:callId', async (req, res) => {
  try {
    const callId = String(req.params.callId || '').trim();
    if (!callId) {
      return res.status(400).json({ error: 'Missing callId.' });
    }
    const session = await prisma.voiceCallSession.findUnique({ where: { callId } });
    if (!session) {
      return res.status(404).json({ error: 'Звонок не найден.' });
    }
    res.json(buildVoiceCallDetailResponse(session));
  } catch (err) {
    console.error('public demo-call/:callId error:', err);
    res.status(500).json({ error: 'Не удалось получить статус звонка.' });
  }
});

app.get('/api/admin/internal-analytics/demo', async (req, res) => {
  try {
    const isPlatformSuperadmin = req.authAccount?.memberships.some(
      (membership) => membership.role === 'platform_superadmin',
    );
    if (!isPlatformSuperadmin) return res.status(403).json({ error: 'Доступно только суперадминистратору.' });

    const query = String(req.query.q || '').trim().slice(0, 100);
    const finiteNumber = (value: unknown, min: number, max: number) => {
      if (value == null || value === '') return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : undefined;
    };
    const validDate = (value: unknown) => {
      if (!value) return undefined;
      const parsed = new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    };
    const minDuration = finiteNumber(req.query.minDuration, 0, 86400);
    const maxDuration = finiteNumber(req.query.maxDuration, 0, 86400);
    const minScore = finiteNumber(req.query.minScore, 0, 100);
    const maxScore = finiteNumber(req.query.maxScore, 0, 100);
    const dateFrom = validDate(req.query.dateFrom);
    const dateTo = validDate(req.query.dateTo);
    const sessions = await prisma.voiceCallSession.findMany({
      where: {
        source: 'demo',
        ...(query ? { OR: [
          { to: { contains: query } },
          { ipAddress: { contains: query } },
          { callId: { contains: query } },
        ] } : {}),
        ...(minDuration != null || maxDuration != null ? { durationSec: { gte: minDuration, lte: maxDuration } } : {}),
        ...(minScore != null || maxScore != null ? { totalScore: { gte: minScore, lte: maxScore } } : {}),
        ...(dateFrom || dateTo ? { startedAt: { gte: dateFrom, lte: dateTo } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        callId: true,
        to: true,
        ipAddress: true,
        startedAt: true,
        endedAt: true,
        outcome: true,
        durationSec: true,
        answerTimeSec: true,
        totalScore: true,
        failureReason: true,
        evaluationJson: true,
      },
    });

    const completed = sessions.filter((item) => item.endedAt && !item.failureReason);
    const scored = sessions.filter((item) => item.totalScore != null);
    const answered = sessions.filter((item) => (item.durationSec ?? 0) > 0 || item.outcome === 'completed' || item.outcome === 'disconnected');
    const average = (values: number[]) => values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
    const outcomeBreakdown: Record<string, number> = {};
    const dailyMap = new Map<string, { calls: number; answered: number; scores: number[] }>();
    const ipCounts = new Map<string, number>();
    const weaknessCounts = new Map<string, number>();
    const criteriaMap = new Map<string, { score: number; maxScore: number; checks: number }>();

    for (const session of sessions) {
      const outcome = session.failureReason ? 'error' : (session.outcome || (session.endedAt ? 'completed' : 'processing'));
      outcomeBreakdown[outcome] = (outcomeBreakdown[outcome] || 0) + 1;
      const day = session.startedAt.toISOString().slice(0, 10);
      const daily = dailyMap.get(day) ?? { calls: 0, answered: 0, scores: [] };
      daily.calls += 1;
      if ((session.durationSec ?? 0) > 0) daily.answered += 1;
      if (session.totalScore != null) daily.scores.push(session.totalScore);
      dailyMap.set(day, daily);
      if (session.ipAddress) ipCounts.set(session.ipAddress, (ipCounts.get(session.ipAddress) || 0) + 1);

      const evaluation = safeJsonParseLocal<Record<string, any>>(session.evaluationJson, {});
      const report = evaluation?.unified_call_report;
      for (const weakness of Array.isArray(report?.weaknesses) ? report.weaknesses : []) {
        const text = String(weakness || '').trim();
        if (text) weaknessCounts.set(text, (weaknessCounts.get(text) || 0) + 1);
      }
      for (const criterion of Array.isArray(evaluation?.plan_criteria?.items) ? evaluation.plan_criteria.items : []) {
        const title = String(criterion.expectedAnswer || '').trim();
        if (!title) continue;
        const current = criteriaMap.get(title) ?? { score: 0, maxScore: 0, checks: 0 };
        current.score += Number(criterion.score) || 0;
        current.maxScore += Number(criterion.maxScore) || 0;
        current.checks += 1;
        criteriaMap.set(title, current);
      }
    }

    res.json({
      summary: {
        totalCalls: sessions.length,
        completedCalls: completed.length,
        answeredRate: sessions.length ? Math.round((answered.length / sessions.length) * 100) : 0,
        avgDurationSec: average(answered.map((item) => item.durationSec ?? 0).filter((value) => value > 0)),
        avgAnswerTimeSec: average(sessions.map((item) => item.answerTimeSec ?? 0).filter((value) => value > 0)),
        avgScore: average(scored.map((item) => item.totalScore ?? 0)),
        uniqueIps: ipCounts.size,
        repeatVisitors: [...ipCounts.values()].filter((count) => count > 1).length,
      },
      scoreDistribution: {
        good: scored.filter((item) => (item.totalScore ?? 0) >= 76).length,
        medium: scored.filter((item) => (item.totalScore ?? 0) >= 50 && (item.totalScore ?? 0) < 76).length,
        bad: scored.filter((item) => (item.totalScore ?? 0) < 50).length,
      },
      outcomeBreakdown,
      criteria: [...criteriaMap.entries()].map(([title, value]) => ({
        title,
        checks: value.checks,
        completionPercent: value.maxScore > 0 ? Math.round((value.score / value.maxScore) * 100) : 0,
      })),
      topWeaknesses: [...weaknessCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([text, count]) => ({ text, count })),
      daily: [...dailyMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-30)
        .map(([date, value]) => ({ date, calls: value.calls, answered: value.answered, avgScore: average(value.scores) })),
      recentCalls: sessions.slice(0, 100).map((session) => ({
        id: session.id,
        callId: session.callId,
        phone: session.to,
        ipAddress: session.ipAddress,
        startedAt: session.startedAt.toISOString(),
        outcome: session.failureReason ? 'error' : (session.outcome || (session.endedAt ? 'completed' : 'processing')),
        durationSec: session.durationSec,
        totalScore: session.totalScore,
        error: session.failureReason,
      })),
    });
  } catch (error) {
    console.error('internal demo analytics error:', error);
    res.status(500).json({ error: 'Не удалось загрузить внутреннюю аналитику.' });
  }
});

// Admin: create batch call orchestration job
app.post('/api/admin/call-batches', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const jobsRaw = Array.isArray((body as { jobs?: unknown[] }).jobs) ? ((body as { jobs: unknown[] }).jobs) : [];
    const jobs = jobsRaw
      .map((j) => (j && typeof j === 'object' ? j as { phone?: unknown; dealershipId?: unknown; dealershipName?: unknown } : null))
      .filter((j): j is { phone?: unknown; dealershipId?: unknown; dealershipName?: unknown } => !!j)
      .map((j) => ({
        phone: j.phone != null ? String(j.phone) : '',
        dealershipId: j.dealershipId != null ? String(j.dealershipId) : null,
        dealershipName: j.dealershipName != null ? String(j.dealershipName) : null,
      }));

    const out = await createCallBatch({
      mode: (body as { mode?: 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily' }).mode ?? 'manual',
      title: (body as { title?: string }).title,
      jobs,
      maxConcurrency: Number((body as { maxConcurrency?: number }).maxConcurrency ?? 10),
      startIntervalMs: Number((body as { startIntervalMs?: number }).startIntervalMs ?? 250),
      maxAttempts: Number((body as { maxAttempts?: number }).maxAttempts ?? 3),
      scenario: (body as { scenario?: 'dialog' | 'realtime' | 'realtime_pure' }).scenario ?? 'realtime_pure',
      testMode: !!(body as { testMode?: boolean }).testMode,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось создать батч.';
    res.status(400).json({ error: message });
  }
});

app.get('/api/admin/call-batches/:id', async (req, res) => {
  try {
    const { batch, jobsPreview, dealershipSummary } = await getCallBatch(req.params.id);
    res.json({ batch, jobsPreview, dealershipSummary });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Батч не найден.';
    res.status(404).json({ error: message });
  }
});

app.get('/api/admin/call-batches', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const modeRaw = String(req.query.mode ?? 'all').trim();
    const allowedModes = new Set(['all', 'manual', 'single_dealership', 'all_dealerships', 'auto_daily']);
    const mode = allowedModes.has(modeRaw) ? modeRaw as 'all' | 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily' : 'all';
    const items = await listCallBatches(limit, mode);
    res.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось получить список batch';
    res.status(400).json({ error: message });
  }
});

app.get('/api/admin/super-admin/dealership-schedules', async (_req, res) => {
  try {
    const schedules = getDealershipDirectory().map((d) => ({
      id: d.id,
      name: d.name,
      city: d.city,
      workStartHour: d.workStartHour,
      workEndHour: d.workEndHour,
    }));
    res.json({ schedules });
  } catch (err) {
    console.error('super-admin/dealership-schedules error:', err);
    res.json({ schedules: [] });
  }
});

app.get('/api/admin/super-admin/call-orchestrator-config', async (_req, res) => {
  try {
    const callSource = getCallSourceInfo();
    res.json({
      callSource,
      autoDailyEnabled: process.env.AUTO_DAILY_CALLS_ENABLED === 'true' || process.env.AUTO_DAILY_CALLS_ENABLED === '1',
      batchTestModeEnabled: process.env.CALL_BATCH_TEST_MODE === 'true' || process.env.CALL_BATCH_TEST_MODE === '1',
      sourceMode: process.env.CALL_SOURCE_MODE || 'mock',
    });
  } catch (err) {
    console.error('super-admin/call-orchestrator-config error:', err);
    res.json({
      callSource: { mode: 'mock', targetsAvailable: 0, usingMockFallback: true },
      autoDailyEnabled: false,
      batchTestModeEnabled: false,
      sourceMode: 'mock',
    });
  }
});

app.get('/api/admin/call-batches/:id/jobs', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const statusRaw = String(req.query.status ?? '').trim();
    const allowedStatuses = new Set(['queued', 'dialing', 'in_progress', 'retry_wait', 'completed', 'failed', 'cancelled']);
    const status = allowedStatuses.has(statusRaw) ? statusRaw as 'queued' | 'dialing' | 'in_progress' | 'retry_wait' | 'completed' | 'failed' | 'cancelled' : undefined;
    const out = await getCallBatchJobs(req.params.id, limit, offset, status);
    res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось получить jobs батча.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/admin/call-batches/:id/pause', async (req, res) => {
  try {
    await pauseCallBatch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось поставить батч на паузу.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/admin/call-batches/:id/resume', async (req, res) => {
  try {
    await resumeCallBatch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось возобновить батч.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/admin/call-batches/:id/cancel', async (req, res) => {
  try {
    await cancelCallBatch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось отменить батч.';
    res.status(400).json({ error: message });
  }
});

function normalizeVoxWebhookEvent(rawEvent: unknown): string {
  const event = String(rawEvent ?? '').trim().toLowerCase();
  if (!event) return '';
  if (event === 'hangup' || event === 'disconnect' || event === 'completed' || event === 'ended') {
    return 'disconnected';
  }
  if (event === 'answer') return 'connected';
  if (event === 'ringing') return 'progress';
  return event;
}

const voxFinalWatchdogs = new Map<string, NodeJS.Timeout>();
const voxWatchdogMeta = new Map<string, { to: string; voxSessionId?: number | null }>();
const VOX_FINAL_WEBHOOK_TIMEOUT_MS = (() => {
  const raw = Number(process.env.VOX_FINAL_WEBHOOK_TIMEOUT_MS || 6 * 60 * 1000);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 6 * 60 * 1000;
})();

function clearVoxFinalWatchdog(callId: string): void {
  const timer = voxFinalWatchdogs.get(callId);
  if (timer) {
    clearTimeout(timer);
    voxFinalWatchdogs.delete(callId);
  }
}

function armVoxFinalWatchdog(callId: string): void {
  clearVoxFinalWatchdog(callId);
  const timer = setTimeout(() => {
    const meta = voxWatchdogMeta.get(callId);
    if (!meta?.to) return;
    console.warn('[webhooks/vox] final webhook timeout -> synthetic finalize', {
      callId,
      to: meta.to,
      voxSessionId: meta.voxSessionId ?? null,
      timeoutMs: VOX_FINAL_WEBHOOK_TIMEOUT_MS,
    });
    const syntheticPayload = {
      call_id: callId,
      to: meta.to,
      event: 'failed',
      details: { reason: 'final_webhook_timeout' },
      vox_session_id: meta.voxSessionId ?? undefined,
    };
    finalizeVoiceCallSession(syntheticPayload).catch((err) => {
      console.error('[webhooks/vox] synthetic finalizeVoiceCallSession error:', err instanceof Error ? err.message : err);
    });
    onVoxBatchWebhook(syntheticPayload).catch((err) => {
      console.error('[webhooks/vox] synthetic onVoxBatchWebhook error:', err instanceof Error ? err.message : err);
    });
    voxFinalWatchdogs.delete(callId);
  }, VOX_FINAL_WEBHOOK_TIMEOUT_MS);
  voxFinalWatchdogs.set(callId, timer);
}

function safeVoxPayloadPreview(value: unknown, maxLen = 4000): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}... [truncated ${text.length - maxLen} chars]` : text;
  } catch {
    return '[unserializable payload]';
  }
}

app.use('/webhooks/vox', (req, _res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  const requestId = `vox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  (req as express.Request & { voxRequestId?: string }).voxRequestId = requestId;
  console.log('[webhooks/vox] request', {
    requestId,
    at: new Date().toISOString(),
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    query: req.query,
    ip: req.ip,
    forwardedFor: req.get('x-forwarded-for') || null,
    host: req.get('host') || null,
    userAgent: req.get('user-agent') || null,
    contentType: req.get('content-type') || null,
    bodyKeys: body ? Object.keys(body) : [],
    bodyPreview: safeVoxPayloadPreview(body ?? req.body),
  });
  next();
});

app.get('/webhooks/vox', (_req, res) => {
  res.status(200).json({
    ok: true,
    message: 'Voximplant webhook endpoint is alive. Expected method: POST.',
  });
});

// Voximplant webhook: call events (disconnected, failed, no_answer, busy)
app.post('/webhooks/vox', async (req, res) => {
  res.status(200).end();
  const requestId = (req as express.Request & { voxRequestId?: string }).voxRequestId || null;
  const payload = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const voxSessionIdRaw =
    (payload as { vox_session_id?: unknown }).vox_session_id ??
    (payload as { vox_call_id?: unknown }).vox_call_id ??
    (payload as { call_session_history_id?: unknown }).call_session_history_id ??
    null;
  const voxSessionId = (() => {
    if (typeof voxSessionIdRaw === 'number') return Number.isFinite(voxSessionIdRaw) && voxSessionIdRaw > 0 ? voxSessionIdRaw : null;
    if (typeof voxSessionIdRaw === 'string') {
      const parsed = Number.parseInt(voxSessionIdRaw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    // Some payloads may send an object; try common shapes.
    if (voxSessionIdRaw && typeof voxSessionIdRaw === 'object') {
      const obj = voxSessionIdRaw as Record<string, unknown>;
      const nested = obj.call_session_history_id ?? obj.session_id ?? obj.id ?? null;
      if (typeof nested === 'number') return Number.isFinite(nested) && nested > 0 ? nested : null;
      if (typeof nested === 'string') {
        const parsed = Number.parseInt(nested, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
    }
    return null;
  })();
  const normalizedPayload =
    voxSessionId != null
      ? { ...payload, vox_session_id: voxSessionId }
      : payload;
  const event = normalizeVoxWebhookEvent((payload as any).event ?? (payload as any).event_type ?? '');
  const hasTranscript = Array.isArray((normalizedPayload as { transcript?: unknown }).transcript);
  const callIdStr = String((normalizedPayload as { call_id?: unknown }).call_id ?? '');
  if (callIdStr && voxSessionId != null) {
    setVoxSessionId(callIdStr, voxSessionId);
  }
  const toStr = String((normalizedPayload as { to?: unknown }).to ?? '').trim();
  if (callIdStr && toStr) {
    voxWatchdogMeta.set(callIdStr, {
      to: toStr,
      voxSessionId: voxSessionId ?? null,
    });
  }
  console.log('[webhooks/vox] received', {
    requestId,
    event,
    callId: (normalizedPayload as { call_id?: unknown }).call_id,
    to: (normalizedPayload as { to?: unknown }).to ?? null,
    voxSessionId: (normalizedPayload as { vox_session_id?: unknown }).vox_session_id ?? null,
    voxSessionIdRaw: voxSessionIdRaw ?? null,
    keys: Object.keys(normalizedPayload),
    transcriptTurns: hasTranscript ? (normalizedPayload as { transcript: unknown[] }).transcript.length : 0,
  });
  const isFinalEvent = ['disconnected', 'failed', 'no_answer', 'busy'].includes(event);
  if (!isFinalEvent) {
    if (event === 'connected') {
      recordVoiceCallConnected(normalizedPayload).catch((err) => {
        console.error('[webhooks/vox] recordVoiceCallConnected error:', {
          requestId,
          event,
          callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
          error: err instanceof Error ? err.message : err,
        });
      });
    }
    if (callIdStr) {
      armVoxFinalWatchdog(callIdStr);
    }
    console.log('[webhooks/vox] non-final event (ignored for finalize)', {
      requestId,
      event,
      callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
    });
    return;
  }

  console.log('[webhooks/vox] final event -> start finalize', {
    requestId,
    event,
    callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
  });
  if (callIdStr) {
    clearVoxFinalWatchdog(callIdStr);
  }

  if (isFinalEvent) {
    finalizeVoiceCallSession(normalizedPayload).catch((err) => {
      console.error('[webhooks/vox] finalizeVoiceCallSession error:', {
        requestId,
        event,
        callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
        error: err instanceof Error ? err.message : err,
      });
    });
    onVoxBatchWebhook(normalizedPayload).catch((err) => {
      console.error('[webhooks/vox] onVoxBatchWebhook error:', {
        requestId,
        event,
        callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
        error: err instanceof Error ? err.message : err,
      });
    });
  }
});

// Admin: call history from DB (persisted; same phone = multiple cards)
app.get('/api/admin/call-history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const source = typeof req.query.source === 'string' ? req.query.source : '';
    const dealershipId = typeof req.query.dealershipId === 'string' ? req.query.dealershipId : '';
    const planId = typeof req.query.planId === 'string' ? req.query.planId : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const where: any = {};
    if (source === 'scheduled') where.source = 'scheduled';
    if (source === 'manual') where.source = 'manual';
    if (dealershipId) where.dealershipId = dealershipId;
    if (planId) where.planId = planId;
    if (status === 'no_answer') where.outcome = 'no_answer';
    if (status === 'broken') where.outcome = { in: ['busy', 'failed', 'disconnected'] };
    if (status === 'good') where.totalScore = { gte: 76 };
    if (status === 'medium') where.totalScore = { gte: 50, lt: 76 };
    if (status === 'bad') where.totalScore = { lt: 50 };
    const sessions = await prisma.voiceCallSession.findMany({
      where,
      include: { dealership: true, manager: true, plan: true },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    const calls = sessions.map((s) => {
      const transcript = s.transcriptJson
        ? (JSON.parse(s.transcriptJson) as Array<{ role: string; text: string }>)
        : [];
      const hasEvaluation = !!s.evaluationJson;
      const ended = !!s.endedAt;
      const endedAtMs = s.endedAt ? s.endedAt.getTime() : null;
      const ageSec = endedAtMs != null ? (Date.now() - endedAtMs) / 1000 : null;
      const isRecent = ageSec != null && ageSec >= 0 && ageSec < 120;
      // Avoid "stuck processing" forever when there is no transcript: only show processing for recent ended calls.
      const isProcessing = ended && !hasEvaluation && !s.failureReason && (transcript.length >= 2 || isRecent);
      const processingStage = ended && !hasEvaluation && isProcessing
        ? (transcript.length >= 2 ? 'evaluation' : 'transcript')
        : null;
      return {
        id: s.id,
        callId: s.callId,
        to: s.to,
        scenario: s.scenario,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        outcome: s.outcome,
        answerTimeSec: s.answerTimeSec,
        durationSec: s.durationSec,
        talkDurationSec: s.talkDurationSec,
        source: s.source,
        dealershipId: s.dealershipId,
        dealershipName: s.dealership?.name ?? null,
        managerId: s.managerId,
        managerName: s.manager?.fullName ?? null,
        planId: s.planId,
        planName: s.plan?.name ?? null,
        transcript,
        transcriptTurns: transcript.length,
        totalScore: s.totalScore,
        hasEvaluation,
        isProcessing,
        processingStage,
        processingError: s.failureReason,
      };
    });
    res.json({ calls });
  } catch (err) {
    console.error('call-history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: one call session detail (for card open: checklist, recommendations, transcript)
app.get('/api/admin/call-history/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const session = await prisma.voiceCallSession.findFirst({
      where: { id },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(buildVoiceCallDetailResponse(session));
  } catch (err) {
    console.error('call-history/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/analytics/overview', async (req, res) => {
  try {
    const holdingId = typeof req.query.holdingId === 'string' ? req.query.holdingId.trim() : '';
    const now = new Date();
    const currentStart = new Date(now);
    currentStart.setDate(currentStart.getDate() - 30);
    const previousStart = new Date(now);
    previousStart.setDate(previousStart.getDate() - 60);

    const [sessions, dealerships, holdings, phoneNumbers] = await Promise.all([
      prisma.voiceCallSession.findMany({
        where: {
          dealershipId: { not: null },
          ...(holdingId ? { dealership: { holdingId } } : {}),
          OR: [
            { totalScore: { not: null } },
            { evaluationJson: { not: null } },
            { outcome: { in: ['no_answer', 'busy', 'failed', 'disconnected'] } },
          ],
        },
        include: {
          dealership: { include: { holding: true } },
          manager: true,
          plan: true,
        },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.dealership.findMany({
        where: {
          isActive: true,
          ...(holdingId ? { holdingId } : {}),
        },
        include: { holding: true },
        orderBy: { name: 'asc' },
      }),
      prisma.holding.findMany({
        where: {
          isActive: true,
          ...(holdingId ? { id: holdingId } : {}),
        },
        include: { dealerships: true },
        orderBy: { name: 'asc' },
      }),
      prisma.phoneNumber.findMany({
        where: {
          isActive: true,
          ...(holdingId ? {
            OR: [
              { dealership: { holdingId } },
              { account: { managerProfiles: { some: { dealership: { holdingId } } } } },
            ],
          } : {}),
        },
        select: { phone: true, typeId: true, type: { select: { name: true, ownership: true } } },
      }),
    ]);
    const scriptIds = [...new Set(sessions.map((session) => session.plan?.scriptId).filter((id): id is string => Boolean(id)))];
    const scripts = scriptIds.length
      ? await prisma.callScript.findMany({
          where: { id: { in: scriptIds } },
          select: { id: true, questionsJson: true, objectionsJson: true, successCriteriaJson: true },
        })
      : [];
    const scriptsById = new Map(scripts.map((script) => [script.id, script]));

    const scored = sessions.filter((session) => typeof session.totalScore === 'number');
    const totalCalls = sessions.length;
    const avgScore = scored.length ? round1(scored.reduce((sum, session) => sum + (session.totalScore ?? 0), 0) / scored.length) : 0;
    const failedCount = scored.filter((session) => (session.totalScore ?? 0) < 50).length;
    const noAnswerCount = sessions.filter((session) => session.outcome === 'no_answer').length;
    const answeredCount = sessions.filter((session) => session.outcome !== 'no_answer' && session.outcome !== 'busy' && session.outcome !== 'failed').length;

    const checklistCounts = new Map<string, { count: number; total: number }>();
    const dimensionSums = new Map<string, { sum: number; count: number }>();
    let communicationOk = 0;
    let communicationMedium = 0;
    let communicationWeak = 0;

    for (const session of sessions) {
      const checklist = extractChecklistFromSession(session);
      for (const item of checklist) {
        const key = item.comment || item.code || 'Неизвестный блок';
        const current = checklistCounts.get(key) ?? { count: 0, total: 0 };
        current.total += 1;
        if (String(item.status).toUpperCase() === 'NO') current.count += 1;
        checklistCounts.set(key, current);
      }

      const dimensions = extractDimensionsFromSession(session);
      for (const [key, value] of Object.entries(dimensions)) {
        const current = dimensionSums.get(key) ?? { sum: 0, count: 0 };
        current.sum += value;
        current.count += 1;
        dimensionSums.set(key, current);
      }
      const communication = dimensions.communication;
      if (typeof communication === 'number') {
        if (communication >= 76) communicationOk += 1;
        else if (communication >= 50) communicationMedium += 1;
        else communicationWeak += 1;
      }
    }

    const topErrors = [...checklistCounts.entries()]
      .filter(([, value]) => value.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([error, value]) => ({ error, count: value.count, percent: percent(value.count, value.total) }));

    const scriptCompliance = dimensionBreakdownFromSessions(sessions).map((item) => ({
      block: item.block,
      rate: item.score,
    }));

    const dealershipStats = dealerships.map((dealership) => {
      const dealershipSessions = sessions.filter((session) => session.dealershipId === dealership.id);
      const dealershipScored = dealershipSessions.filter((session) => typeof session.totalScore === 'number');
      const currentScored = dealershipScored.filter((session) => session.startedAt >= currentStart);
      const previousScored = dealershipScored.filter((session) => session.startedAt >= previousStart && session.startedAt < currentStart);
      const score = dealershipScored.length
        ? round1(dealershipScored.reduce((sum, session) => sum + (session.totalScore ?? 0), 0) / dealershipScored.length)
        : 0;
      const currentAvg = currentScored.length
        ? currentScored.reduce((sum, session) => sum + (session.totalScore ?? 0), 0) / currentScored.length
        : null;
      const previousAvg = previousScored.length
        ? previousScored.reduce((sum, session) => sum + (session.totalScore ?? 0), 0) / previousScored.length
        : null;
      return {
        id: dealership.id,
        name: dealership.name,
        dealer: dealership.holding?.name ?? 'Без дилера',
        type: dealership.type,
        city: dealership.city,
        score,
        delta: currentAvg != null && previousAvg != null ? Math.round(currentAvg - previousAvg) : 0,
        calls: dealershipSessions.length,
        noAnswers: dealershipSessions.filter((session) => session.outcome === 'no_answer').length,
      };
    });
    const holdingRows = holdings.map((holding) => {
      const dealershipIds = new Set(holding.dealerships.map((dealership) => dealership.id));
      const holdingSessions = sessions.filter((session) => session.dealershipId && dealershipIds.has(session.dealershipId));
      return {
        id: holding.id,
        name: holding.name,
        type: holding.type,
        dealershipsCount: holding.dealerships.length,
        score: scoreFromSessions(holdingSessions),
        calls: holdingSessions.length,
        noAnswers: holdingSessions.filter((session) => session.outcome === 'no_answer').length,
        lowDealerships: holding.dealerships.filter((dealership) => {
          const dealershipSessions = holdingSessions.filter((session) => session.dealershipId === dealership.id);
          return dealershipSessions.length > 0 && scoreFromSessions(dealershipSessions) < 50;
        }).length,
      };
    });

    const comparedDealerships = dealershipStats
      .filter((item) => item.calls > 0)
      .sort((a, b) => a.score - b.score);
    const worstDealership = comparedDealerships[0] ?? null;
    const bestDealership = comparedDealerships[comparedDealerships.length - 1] ?? null;
    const lowDealerships = dealershipStats.filter((item) => item.calls > 0 && item.score < 50).length;
    const topProblem = topErrors[0] ?? null;
    const worstDimension = scriptCompliance[0] ?? null;
    const ownSessions = sessions.filter((session) => !isFranchisedSession(session));
    const franchiseSessions = sessions.filter((session) => isFranchisedSession(session));
    const leaderIds = new Set(comparedDealerships.slice(-3).map((item) => item.id));
    const laggardIds = new Set(comparedDealerships.slice(0, 3).map((item) => item.id));
    const leaderSessions = sessions.filter((session) => session.dealershipId && leaderIds.has(session.dealershipId));
    const laggardSessions = sessions.filter((session) => session.dealershipId && laggardIds.has(session.dealershipId));
    const sourceByPhone = new Map(phoneNumbers.map((phone) => [normalizeCallPhone(phone.phone), phone]));
    const sourceGroups = new Map<string, { id: string; name: string; ownership: string; sessions: typeof sessions }>();
    for (const session of sessions) {
      const fallback = sourceByPhone.get(normalizeCallPhone(session.to));
      const sourceId = session.phoneNumberTypeId ?? fallback?.typeId;
      if (!sourceId) continue;
      const group = sourceGroups.get(sourceId) ?? {
        id: sourceId,
        name: session.phoneNumberTypeName ?? fallback?.type.name ?? sourceId,
        ownership: session.phoneNumberOwnership ?? fallback?.type.ownership ?? '',
        sessions: [],
      };
      group.sessions.push(session);
      sourceGroups.set(sourceId, group);
    }
    const currentScored = sessions.filter((session) => session.startedAt >= currentStart && typeof scoreFromAnalyticsSession(session) === 'number');
    const currentNetworkScore = currentScored.length ? scoreFromSessions(currentScored) : 0;
    const phoneNumberTypeComparison = [...sourceGroups.values()].map((group) => {
      const current = group.sessions.filter((session) => session.startedAt >= currentStart && typeof scoreFromAnalyticsSession(session) === 'number');
      const previous = group.sessions.filter((session) => session.startedAt >= previousStart && session.startedAt < currentStart && typeof scoreFromAnalyticsSession(session) === 'number');
      const score = current.length ? scoreFromSessions(current) : 0;
      const previousScore = previous.length ? scoreFromSessions(previous) : null;
      return {
        id: group.id,
        name: group.name,
        ownership: group.ownership,
        calls: current.length,
        score,
        delta: round1(score - currentNetworkScore),
        trend: previousScore === null ? null : round1(score - previousScore),
      };
    }).filter((item) => item.calls > 0).sort((a, b) => b.score - a.score || b.calls - a.calls);

    const errorsInsight: AnalyticsInsight = topProblem
      ? {
          fact: `Блок «${topProblem.error}» чаще всего получает NO: ${topProblem.percent}%`,
          interpretation: 'Это главный повторяющийся паттерн в привязанных звонках',
          action: 'Разобрать примеры звонков и обновить тренировку по этому блоку',
        }
      : { fact: 'Нет выраженных NO-блоков', interpretation: 'По привязанным звонкам системная проблема не выделяется', action: '', stable: true };

    const commTotal = communicationOk + communicationMedium + communicationWeak;
    const commWeakPercent = percent(communicationWeak, commTotal);
    const commInsight: AnalyticsInsight = commWeakPercent > 0
      ? {
          fact: `Слабая коммуникация в ${commWeakPercent}% оценённых звонков`,
          interpretation: 'Коммуникационный блок снижает общее качество разговоров',
          action: 'Проверить формулировки менеджеров и добавить короткую тренировку речевого поведения',
        }
      : { fact: 'Коммуникация без явных провалов', interpretation: 'В привязанных звонках показатель стабилен', action: '', stable: true };

    const scriptInsight: AnalyticsInsight = worstDimension
      ? {
          fact: `Самый слабый блок: «${worstDimension.block}» — ${worstDimension.rate}%`,
          interpretation: worstDimension.rate < 60 ? 'Есть системный риск потери лида на этом этапе' : 'Блок требует наблюдения, но не выглядит критичным',
          action: worstDimension.rate < 60 ? 'Собрать звонки с низким баллом и назначить точечную отработку' : '',
          stable: worstDimension.rate >= 60,
        }
      : { fact: 'Измерения пока не рассчитаны', interpretation: 'Нет оценённых привязанных звонков', action: '', stable: true };

    const trendInsight: AnalyticsInsight = worstDealership
      ? {
          fact: `Самый низкий балл у точки «${worstDealership.name}»: ${worstDealership.score}`,
          interpretation: worstDealership.score < 50 ? 'Точка заметно проседает относительно сети' : 'Разница между точками пока умеренная',
          action: worstDealership.score < 50 ? 'Открыть точку и разобрать историю звонков' : '',
          stable: worstDealership.score >= 50,
        }
      : { fact: 'Нет привязанных звонков по точкам', interpretation: 'Аналитика появится после плановых или размеченных звонков', action: '', stable: true };

    const actions = [];
    if (topProblem) {
      actions.push({
        priority: 'P0',
        target: `Блок «${topProblem.error}»`,
        action: 'Разобрать звонки с повторяющимся NO и обновить рекомендации менеджерам',
        reason: `${topProblem.count} повторений среди оценённых пунктов`,
        expectedEffect: '+5-10 баллов в слабом блоке',
        drillType: 'audits',
      });
    }
    if (worstDealership && worstDealership.score < 50) {
      actions.push({
        priority: 'P0',
        target: `Точка «${worstDealership.name}»`,
        action: 'Проверить звонки точки и расписание прозвонов',
        reason: `Средний балл ${worstDealership.score}`,
        expectedEffect: 'Стабилизировать точку выше 50',
        drillType: 'dealership',
        drillFilter: worstDealership.id,
      });
    }
    if (noAnswerCount > 0) {
      actions.push({
        priority: 'P1',
        target: 'Недозвоны',
        action: 'Проверить рабочие часы и доступность номеров в планах',
        reason: `${noAnswerCount} недозвонов`,
        expectedEffect: 'Повысить дозвон по расписаниям',
        drillType: 'audits',
      });
    }
    if (actions.length === 0) {
      actions.push({
        priority: 'P2',
        target: bestDealership ? `Точка «${bestDealership.name}»` : 'Привязанные звонки',
        action: 'Продолжать накопление выборки для устойчивой аналитики',
        reason: totalCalls > 0 ? `${totalCalls} привязанных звонков` : 'Пока нет привязанных звонков',
        expectedEffect: 'Уверенные тренды после расширения выборки',
        drillType: 'audits',
      });
    }

    res.json({
      aiSummary: await generateAnalyticsAISummary({
        level: 'network',
        score: avgScore,
        calls: totalCalls,
        noAnswers: noAnswerCount,
        topIssue: topProblem?.error ?? null,
        topIssuePercent: topProblem?.percent ?? null,
        worstDimension: worstDimension?.block ?? null,
        lowDealerships,
      }),
      keyInsights: [
        {
          fact: `Средний балл сети — ${avgScore}`,
          interpretation: scored.length ? `Рассчитано по ${scored.length} оценённым привязанным звонкам` : 'Пока нет оценённых привязанных звонков',
          impact: avgScore < 50 ? 'high' : avgScore < 76 ? 'medium' : 'low',
        },
        {
          fact: `Дозвон — ${percent(answeredCount, totalCalls)}%`,
          interpretation: `${noAnswerCount} недозвонов из ${totalCalls} привязанных звонков`,
          impact: noAnswerCount > 0 ? 'medium' : 'low',
        },
        {
          fact: `Точек ниже 50: ${lowDealerships}`,
          interpretation: lowDealerships > 0 ? 'Есть точки с критическим средним баллом' : 'Критичных точек в текущей выборке нет',
          impact: lowDealerships > 0 ? 'high' : 'low',
        },
        ...(topProblem ? [{
          fact: `Топ проблема: «${topProblem.error}»`,
          interpretation: `${topProblem.percent}% NO среди появлений блока`,
          impact: 'high' as const,
        }] : []),
      ],
      actions,
      errorsInsight,
      commInsight,
      scriptInsight,
      trendInsight,
      avgScore,
      totalAudits: totalCalls,
      failRate: percent(failedCount, scored.length),
      commBreakdown: [
        { label: 'Сильная коммуникация', percent: percent(communicationOk, commTotal), color: '#2D9B5E' },
        { label: 'Средняя коммуникация', percent: percent(communicationMedium, commTotal), color: '#D4842A' },
        { label: 'Слабая коммуникация', percent: percent(communicationWeak, commTotal), color: '#E05252' },
      ],
      topErrors,
      timeSeries: timeSeriesFromSessions(sessions, 14),
      weeklyTypeTrend: weeklyTypeTrendFromSessions(sessions),
      typeCategoryComparison: categoryComparisonFromSessions(ownSessions, franchiseSessions),
      phoneNumberTypeComparison,
      typeTopErrors: {
        own: topIssuesFromSessions(ownSessions, 5, DEFAULT_CALL_REPORT_PROBLEMS),
        franchise: topIssuesFromSessions(franchiseSessions, 5, DEFAULT_CALL_REPORT_PROBLEMS),
      },
      leadersLaggards: {
        leadersErrors: topIssuesFromSessions(leaderSessions, 5, DEFAULT_CALL_REPORT_PROBLEMS),
        laggardsErrors: topIssuesFromSessions(laggardSessions, 5, DEFAULT_CALL_REPORT_PROBLEMS),
        leadersQuestions: topScriptQuestionsFromSessions(leaderSessions, scriptsById, 5),
        laggardsQuestions: topScriptQuestionsFromSessions(laggardSessions, scriptsById, 5),
      },
      dealershipComparison: comparedDealerships.map((item) => ({ id: item.id, name: item.name, score: item.score, delta: item.delta })),
      scriptCompliance,
      holdingRows,
      dealershipRows: dealershipStats.sort((a, b) => b.calls - a.calls || a.score - b.score),
      dealershipTimeSeries: dealershipStats.map((item) => ({
        id: item.id,
        name: item.name,
        points: timeSeriesFromSessions(sessions.filter((session) => session.dealershipId === item.id), 14),
      })),
      meta: {
        linkedCalls: totalCalls,
        scoredCalls: scored.length,
        ignoredUnlinkedCalls: await prisma.voiceCallSession.count({ where: { dealershipId: null } }),
      },
    });
  } catch (err) {
    console.error('analytics/overview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/analytics/comparison-summary', async (req, res) => {
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rawItems
      .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .slice(0, 6);
    if (items.length < 2) return res.status(400).json({ error: 'Выберите минимум два объекта для сравнения.' });
    const level = typeof req.body?.level === 'string' ? req.body.level.slice(0, 40) : 'comparison';
    const item = await generateComparisonAISummary({ level, items });
    res.json({ item });
  } catch (err) {
    console.error('analytics/comparison-summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/analytics/dealerships', async (req, res) => {
  try {
    const rawDays = String(req.query.days || 'all');
    const requestedDays = Number.parseInt(rawDays, 10);
    const days = requestedDays === 7 ? 7 : requestedDays === 30 ? 30 : null;
    const periodStart = days === null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [dealerships, sessions, managerCounts] = await Promise.all([
      prisma.dealership.findMany({ where: { isActive: true }, include: { holding: true }, orderBy: { name: 'asc' } }),
      prisma.voiceCallSession.findMany({
        where: {
          dealershipId: { not: null },
          ...(periodStart ? { startedAt: { gte: periodStart } } : {}),
        },
        select: {
          id: true,
          startedAt: true,
          outcome: true,
          totalScore: true,
          evaluationJson: true,
          dimensionsJson: true,
          checklistResultsJson: true,
          dealershipId: true,
          managerId: true,
          answerTimeSec: true,
          durationSec: true,
          talkDurationSec: true,
        },
      }),
      prisma.managerProfile.groupBy({ by: ['dealershipId'], _count: { id: true } }),
    ]);
    const managerCountByDealership = new Map(managerCounts.map((item) => [item.dealershipId, item._count.id]));
    const items = dealerships.map((dealership) => {
      const dealershipSessions = sessions.filter((session) => session.dealershipId === dealership.id);
      const score = scoreFromSessions(dealershipSessions);
      const answerRate = answerRateFromSessions(dealershipSessions);
      const delta = deltaFromSessions(dealershipSessions);
      const avgAnswerTimeSec = averagePositiveMetric(dealershipSessions, (session) => session.answerTimeSec);
      return {
        id: dealership.id,
        name: dealership.name,
        city: dealership.city || '—',
        type: dealership.type,
        dealer: dealership.holding?.name ?? 'Без дилера',
        aiRating: score,
        answerRate,
        avgAnswerTimeSec,
        auditsCount: dealershipSessions.length,
        employeesCount: managerCountByDealership.get(dealership.id) ?? 0,
        deltaRating: delta,
        status: analyticsStatus(score, answerRate, dealershipSessions.length),
      };
    });
    res.json({ items });
  } catch (err) {
    console.error('analytics/dealerships error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/analytics/holdings', async (_req, res) => {
  try {
    const [holdings, sessions, catalog] = await Promise.all([
      prisma.holding.findMany({
        where: { isActive: true },
        include: { dealerships: true },
        orderBy: { name: 'asc' },
      }),
      prisma.voiceCallSession.findMany({
        where: { dealershipId: { not: null } },
        select: {
          id: true,
          startedAt: true,
          outcome: true,
          totalScore: true,
          evaluationJson: true,
          dimensionsJson: true,
          checklistResultsJson: true,
          dealershipId: true,
          managerId: true,
        },
      }),
      getCallReportProblemCatalog(prisma),
    ]);

    const items = holdings.map((holding) => {
      const dealershipIds = new Set(holding.dealerships.map((dealership) => dealership.id));
      const holdingSessions = sessions.filter((session) => session.dealershipId && dealershipIds.has(session.dealershipId));
      const dealershipScores = holding.dealerships.map((dealership) => {
        const dealershipSessions = holdingSessions.filter((session) => session.dealershipId === dealership.id);
        return {
          id: dealership.id,
          calls: dealershipSessions.length,
          score: scoreFromSessions(dealershipSessions),
        };
      });
      return {
        id: holding.id,
        name: holding.name,
        type: holding.type,
        dealershipsCount: holding.dealerships.length,
        avgScore: scoreFromSessions(holdingSessions),
        calls: holdingSessions.length,
        noAnswers: holdingSessions.filter((session) => session.outcome === 'no_answer').length,
        lowDealerships: dealershipScores.filter((item) => item.calls > 0 && item.score < 50).length,
        topProblem: topIssuesFromSessions(holdingSessions, 1, catalog)[0]?.issue ?? null,
      };
    });
    res.json({ items });
  } catch (err) {
    console.error('analytics/holdings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/call-report-problems', async (_req, res) => {
  try {
    const items = await getCallReportProblemCatalog(prisma);
    res.json({ items });
  } catch (error) {
    console.error('call-report-problems error:', error);
    res.status(500).json({ error: 'Не удалось загрузить справочник проблем.' });
  }
});

app.get('/api/admin/analytics/holdings/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const holding = await prisma.holding.findUnique({
      where: { id },
      include: { dealerships: { include: { _count: { select: { managerProfiles: true } } } } },
    });
    if (!holding) return res.status(404).json({ error: 'Holding not found' });

    const dealershipIds = holding.dealerships.map((dealership) => dealership.id);
    const sessions = dealershipIds.length > 0
      ? await prisma.voiceCallSession.findMany({
          where: { dealershipId: { in: dealershipIds } },
          select: {
            id: true,
            startedAt: true,
            outcome: true,
            totalScore: true,
            evaluationJson: true,
            dimensionsJson: true,
            checklistResultsJson: true,
            dealershipId: true,
            managerId: true,
            manager: { select: { id: true, fullName: true } },
          },
          orderBy: { startedAt: 'desc' },
        })
      : [];
    const trainerSessions = dealershipIds.length > 0
      ? await prisma.trainerSession.findMany({
          where: {
            OR: [
              { branchId: { in: dealershipIds } },
              { employee: { dealershipId: { in: dealershipIds } } },
            ],
          },
          select: {
            id: true,
            startedAt: true,
            completedAt: true,
            score: true,
            status: true,
            failureReason: true,
            evaluationJson: true,
            branchId: true,
            employee: { select: { fullName: true, dealershipId: true } },
            branch: { select: { name: true } },
          },
          orderBy: { startedAt: 'desc' },
          take: 200,
        })
      : [];
    const catalog = await getCallReportProblemCatalog(prisma);
    const dealershipNameById = new Map(holding.dealerships.map((dealership) => [dealership.id, dealership.name]));

    const score = scoreFromSessions(sessions);
    const noAnswers = sessions.filter((session) => session.outcome === 'no_answer').length;
    const topIssues = topIssuesFromSessions(sessions, 5, catalog);
    const scriptCompliance = dimensionBreakdownFromSessions(sessions).map((item) => ({
      block: item.block,
      rate: item.score,
    }));
    const weakestBlock = [...scriptCompliance].sort((a, b) => a.rate - b.rate)[0] ?? null;
    const dealershipRows = holding.dealerships.map((dealership) => {
      const dealershipSessions = sessions.filter((session) => session.dealershipId === dealership.id);
      const dealershipScore = scoreFromSessions(dealershipSessions);
      return {
        id: dealership.id,
        name: dealership.name,
        dealer: holding.name,
        type: dealership.type,
        city: dealership.city || '—',
        score: dealershipScore,
        delta: deltaFromSessions(dealershipSessions),
        calls: dealershipSessions.length,
        noAnswers: dealershipSessions.filter((session) => session.outcome === 'no_answer').length,
        employeesCount: dealership._count.managerProfiles,
        status: analyticsStatus(dealershipScore, answerRateFromSessions(dealershipSessions), dealershipSessions.length),
      };
    });
    const lowDealerships = dealershipRows.filter((row) => row.calls > 0 && row.score < 50).length;

    const item = {
      id: holding.id,
      name: holding.name,
      type: holding.type,
      dealershipsCount: holding.dealerships.length,
      avgScore: score,
      calls: sessions.length,
      noAnswers,
      lowDealerships,
      topProblem: topIssues[0]?.issue ?? null,
      aiSummary: await generateAnalyticsAISummary({
        level: 'holding',
        name: holding.name,
        score,
        calls: sessions.length,
        noAnswers,
        topIssue: topIssues[0]?.issue ?? null,
        topIssuePercent: topIssues[0]?.percent ?? null,
        worstDimension: weakestBlock?.block ?? null,
        lowDealerships,
      }),
      dealershipRows: dealershipRows.sort((a, b) => b.calls - a.calls || a.score - b.score),
      timeSeries: timeSeriesFromSessions(sessions, 14),
      activitySeries: {
        month: callActivitySeriesMonth(sessions, 30),
        all: callActivitySeriesAllTime(sessions),
      },
      dealershipActivitySeries: holding.dealerships.map((dealership) => {
        const dealershipSessions = sessions.filter((session) => session.dealershipId === dealership.id);
        return {
          id: dealership.id,
          name: dealership.name,
          series: {
            month: callActivitySeriesMonth(dealershipSessions, 30),
            all: callActivitySeriesAllTime(dealershipSessions),
          },
        };
      }),
      topIssues: topIssues.map((issue) => ({ issue: issue.issue, percent: issue.percent })),
      scriptCompliance,
      audits: [
        ...sessions.map((session) => ({
          id: `call-${session.id}`,
          date: session.startedAt.toISOString(),
          type: 'call' as const,
          employeeName: session.manager?.fullName ?? 'Неизвестно',
          dealershipName: (session.dealershipId && dealershipNameById.get(session.dealershipId)) || '—',
          score: Math.round(session.totalScore ?? 0),
          verdict: session.outcome === 'no_answer'
            ? 'Недозвон'
            : (session.totalScore ?? 0) < 50
              ? 'Нуждается в доработке'
              : 'Оценено',
        })),
        ...trainerSessions.map((session) => {
          const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
          const score = Math.round(scoreFromEvaluation(evaluation, session.score));
          const dealershipId = session.branchId || session.employee?.dealershipId || null;
          return {
            id: `trainer-${session.id}`,
            date: (session.completedAt ?? session.startedAt).toISOString(),
            type: 'trainer' as const,
            employeeName: session.employee?.fullName ?? 'Неизвестно',
            dealershipName: session.branch?.name
              || (dealershipId ? dealershipNameById.get(dealershipId) : null)
              || '—',
            score,
            verdict: session.status === 'failed' || !!session.failureReason
              ? 'Провал'
              : session.status === 'abandoned'
                ? 'Прервано'
                : session.status === 'completed'
                  ? 'Пройдено'
                  : 'В процессе',
          };
        }),
      ].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 200),
      meta: {
        linkedCalls: sessions.length,
        scoredCalls: sessions.filter((session) => scoreFromAnalyticsSession(session) !== null).length,
      },
    };

    res.json({ item });
  } catch (err) {
    console.error('analytics/holdings/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

type AnalyticsPlanParticipation = {
  id: string;
  name: string;
  targetType: string;
  targetMatch: 'dealership' | 'employees';
  targetsCount: number;
  frequency: string;
  callTimeFrom: string;
  callTimeTo: string;
  lastInitiatedAt: string | null;
};

function normalizePlanTargetIds(targetIdsJson: string | null | undefined): string[] {
  const parsed = safeJsonParseLocal<unknown>(targetIdsJson, []);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
}

function normalizePlanParticipation(
  plan: {
    id: string;
    name: string;
    targetType: string;
    targetIdsJson: string;
    frequency: string;
    callTimeFrom: string;
    callTimeTo: string;
    lastInitiatedAt: Date | null;
  },
  targetMatch: AnalyticsPlanParticipation['targetMatch'],
  targetsCount: number,
): AnalyticsPlanParticipation {
  return {
    id: plan.id,
    name: plan.name,
    targetType: plan.targetType,
    targetMatch,
    targetsCount,
    frequency: plan.frequency,
    callTimeFrom: plan.callTimeFrom,
    callTimeTo: plan.callTimeTo,
    lastInitiatedAt: plan.lastInitiatedAt?.toISOString() ?? null,
  };
}

async function assertCanMutateAnalyticsPlan(req: express.Request, holdingId: string): Promise<void> {
  const account = req.authAccount;
  if (!account) throw new Error('Требуется авторизация.');
  if (account.memberships.some((membership) => membership.role === 'platform_superadmin')) return;
  if (account.memberships.some((membership) => membership.holdingId === holdingId)) return;
  const dealershipIds = account.memberships
    .map((membership) => membership.dealershipId)
    .filter(Boolean) as string[];
  if (dealershipIds.length > 0) {
    const allowedDealership = await prisma.dealership.findFirst({
      where: { id: { in: dealershipIds }, holdingId },
      select: { id: true },
    });
    if (allowedDealership) return;
  }
  throw new Error('Нет доступа к расписанию.');
}

app.get('/api/admin/analytics/dealerships/:id/plans', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const dealership = await prisma.dealership.findUnique({
      where: { id },
      include: { managerProfiles: { where: { status: 'active' }, select: { id: true } } },
    });
    if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
    if (!canAccessDealershipForActiveRole(req, dealership)) return res.status(403).json({ error: 'Нет доступа к этой точке.' });
    if (!dealership.holdingId) return res.json({ items: [] });

    const managerIds = new Set(dealership.managerProfiles.map((manager) => manager.id));
    const plans = await prisma.callPlan.findMany({
      where: { holdingId: dealership.holdingId },
      orderBy: [{ updatedAt: 'desc' }],
    });

    const items = plans.reduce<AnalyticsPlanParticipation[]>((acc, plan) => {
      const targetIds = normalizePlanTargetIds(plan.targetIdsJson);
      if (plan.targetType === 'dealerships' && targetIds.includes(dealership.id)) {
        acc.push(normalizePlanParticipation(plan, 'dealership', targetIds.length));
      } else if (plan.targetType === 'employees' && targetIds.some((targetId) => managerIds.has(targetId))) {
        acc.push(normalizePlanParticipation(plan, 'employees', targetIds.filter((targetId) => managerIds.has(targetId)).length));
      }
      return acc;
    }, []);

    res.json({ items });
  } catch (err) {
    console.error('analytics/dealerships/:id/plans error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/analytics/dealerships/:id/plans/:planId/exclude', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const planId = String(req.params.planId || '').trim();
    const dealership = await prisma.dealership.findUnique({
      where: { id },
      include: { managerProfiles: { where: { status: 'active' }, select: { id: true } } },
    });
    if (!dealership || !dealership.holdingId) return res.status(404).json({ error: 'Точка не найдена.' });
    if (!canAccessDealershipForActiveRole(req, dealership)) return res.status(403).json({ error: 'Нет доступа к этой точке.' });
    const plan = await prisma.callPlan.findFirst({ where: { id: planId, holdingId: dealership.holdingId } });
    if (!plan) return res.status(404).json({ error: 'Расписание не найдено.' });
    await assertCanMutateAnalyticsPlan(req, plan.holdingId);

    const targetIds = normalizePlanTargetIds(plan.targetIdsJson);
    const dealershipManagerIds = new Set(dealership.managerProfiles.map((manager) => manager.id));
    const idsToRemove = plan.targetType === 'dealerships'
      ? new Set([dealership.id])
      : new Set(targetIds.filter((targetId) => dealershipManagerIds.has(targetId)));
    if (idsToRemove.size === 0) return res.status(400).json({ error: 'Точка уже не участвует в этом расписании.' });

    const nextTargetIds = targetIds.filter((targetId) => !idsToRemove.has(targetId));
    if (nextTargetIds.length === 0) {
      return res.status(400).json({ error: 'Нельзя оставить расписание без участников. Откройте настройки плана и удалите его или добавьте другие цели.' });
    }

    await prisma.callPlan.update({
      where: { id: plan.id },
      data: { targetIdsJson: JSON.stringify(nextTargetIds) },
    });
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось исключить точку из расписания.';
    console.error('analytics/dealerships/:id/plans/:planId/exclude error:', err);
    res.status(message.includes('доступ') ? 403 : 500).json({ error: message });
  }
});

app.get('/api/admin/analytics/dealerships/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const dealership = await prisma.dealership.findUnique({ where: { id }, include: { holding: true, managerProfiles: true } });
    if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
    if (!canAccessDealershipForActiveRole(req, dealership)) return res.status(403).json({ error: 'Нет доступа к этой точке.' });
    const sessions = await prisma.voiceCallSession.findMany({
      where: { dealershipId: id },
      include: { manager: true, plan: { select: { scriptId: true, name: true } } },
      orderBy: { startedAt: 'desc' },
    });
    const managerIds = dealership.managerProfiles.map((manager) => manager.id);
    const trainerSessions = await prisma.trainerSession.findMany({
      where: {
        OR: [
          { branchId: id },
          ...(managerIds.length ? [{ employeeId: { in: managerIds } }] : []),
        ],
      },
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
        score: true,
        status: true,
        failureReason: true,
        evaluationJson: true,
        employee: { select: { fullName: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 200,
    });
    const scriptIds = [...new Set(sessions.map((session) => session.plan?.scriptId).filter((scriptId): scriptId is string => Boolean(scriptId)))];
    const scripts = scriptIds.length
      ? await prisma.callScript.findMany({
          where: { id: { in: scriptIds } },
          select: { id: true, questionsJson: true, objectionsJson: true, successCriteriaJson: true },
        })
      : [];
    const scriptsById = new Map(scripts.map((script) => [script.id, script]));
    const score = scoreFromSessions(sessions);
    const answerRate = answerRateFromSessions(sessions);
    const avgAnswerTimeSec = averagePositiveMetric(sessions, (session) => session.answerTimeSec);
    const avgCallDurationSec = averagePositiveMetric(sessions, (session) => session.talkDurationSec ?? session.durationSec);
    const delta = deltaFromSessions(sessions);
    const topIssues = topIssuesFromSessions(sessions);
    const noAnswers = sessions.filter((session) => session.outcome === 'no_answer').length;
    const blockBreakdown = dimensionBreakdownFromSessions(sessions);
    const weakestBlock = [...blockBreakdown].sort((a, b) => a.score - b.score)[0] ?? null;
    const outcomeBreakdown = {
      completed: sessions.filter((session) => session.outcome === 'completed').length,
      no_answer: sessions.filter((session) => session.outcome === 'no_answer').length,
      busy: sessions.filter((session) => session.outcome === 'busy').length,
      failed: sessions.filter((session) => session.outcome === 'failed').length,
      disconnected: sessions.filter((session) => session.outcome === 'disconnected').length,
    };
    let communicationStrong = 0;
    let communicationMedium = 0;
    let communicationWeak = 0;
    for (const session of sessions) {
      const communication = extractDimensionsFromSession(session).communication;
      if (typeof communication !== 'number') continue;
      if (communication >= 76) communicationStrong += 1;
      else if (communication >= 50) communicationMedium += 1;
      else communicationWeak += 1;
    }
    const communicationTotal = communicationStrong + communicationMedium + communicationWeak;
    const employees = dealership.managerProfiles.map((manager) => {
      const managerSessions = sessions.filter((session) => session.managerId === manager.id);
      const managerScore = scoreFromSessions(managerSessions);
      const managerTopIssue = topIssuesFromSessions(managerSessions, 1)[0];
      return {
        id: manager.id,
        accountId: manager.accountId ?? null,
        name: manager.fullName,
        aiRating: managerScore,
        auditsCount: managerSessions.length,
        typicalError: managerTopIssue?.issue ?? 'Нет данных',
        status: analyticsStatus(managerScore, null, managerSessions.length),
      };
    });
    const item = {
      id: dealership.id,
      name: dealership.name,
      city: dealership.city || '—',
      aiRating: score,
      answerRate,
      avgAnswerTimeSec,
      avgCallDurationSec,
      auditsCount: sessions.length,
      employeesCount: dealership.managerProfiles.length,
      deltaRating: delta,
      status: analyticsStatus(score, answerRate, sessions.length),
      noAnswers,
      outcomeBreakdown,
      communicationBreakdown: [
        { label: 'Сильная коммуникация', percent: percent(communicationStrong, communicationTotal), color: '#2D9B5E' },
        { label: 'Средняя коммуникация', percent: percent(communicationMedium, communicationTotal), color: '#D4842A' },
        { label: 'Слабая коммуникация', percent: percent(communicationWeak, communicationTotal), color: '#E05252' },
      ],
      scriptCompliance: blockBreakdown.map((item) => ({ block: item.block, rate: item.score, hint: item.hint })),
      aiSummary: await generateAnalyticsAISummary({
        level: 'dealership',
        name: dealership.name,
        score,
        calls: sessions.length,
        noAnswers,
        topIssue: topIssues[0]?.issue ?? null,
        topIssuePercent: topIssues[0]?.percent ?? null,
        worstDimension: weakestBlock?.block ?? null,
        trend: delta,
      }),
      employees,
      audits: [
        ...sessions.map((session) => ({
          id: `call-${session.id}`,
          date: session.startedAt.toISOString(),
          type: 'call' as const,
          employeeName: session.manager?.fullName ?? 'Неизвестно',
          score: Math.round(session.totalScore ?? 0),
          verdict: session.outcome === 'no_answer'
            ? 'Недозвон'
            : (session.totalScore ?? 0) < 50
              ? 'Нуждается в доработке'
              : 'Оценено',
        })),
        ...trainerSessions.map((session) => {
          const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
          const score = Math.round(scoreFromEvaluation(evaluation, session.score));
          return {
            id: `trainer-${session.id}`,
            date: (session.completedAt ?? session.startedAt).toISOString(),
            type: 'trainer' as const,
            employeeName: session.employee?.fullName ?? 'Неизвестно',
            score,
            verdict: session.status === 'failed' || !!session.failureReason
              ? 'Провал'
              : session.status === 'abandoned'
                ? 'Прервано'
                : session.status === 'completed'
                  ? 'Пройдено'
                  : 'В процессе',
          };
        }),
      ].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 200),
      timeSeries: timeSeriesFromSessions(sessions),
      activitySeries: {
        month: callActivitySeriesMonth(sessions, 30),
        all: callActivitySeriesAllTime(sessions),
      },
      hourlyAnswerRate: Array.from({ length: 24 }, (_, hour) => {
        const hourly = sessions.filter((session) => session.startedAt.getHours() === hour);
        const rate = answerRateFromSessions(hourly);
        return rate ?? 0;
      }),
      topIssues: topIssues.map((item) => ({ issue: item.issue, percent: item.percent })),
      topQuestions: topScriptQuestionsFromSessions(sessions, scriptsById, 5).map((item) => item.question),
      recommendedTrainings: topIssues.slice(0, 5).map((item) => ({
        title: item.issue,
        description: `Встречается в ${item.percent}% проверок точки. Разберите звонки с этой проблемой и обновите короткий чек-лист менеджеров.`,
      })),
    };
    res.json({ item });
  } catch (err) {
    console.error('analytics/dealerships/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/analytics/managers/:id/plans', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const manager = await resolveAccessibleAnalyticsManager(req, id);
    if (!manager) return res.status(404).json({ error: 'Manager not found' });
    if (!manager.dealership.holdingId) return res.json({ items: [] });

    const plans = await prisma.callPlan.findMany({
      where: { holdingId: manager.dealership.holdingId },
      orderBy: [{ updatedAt: 'desc' }],
    });

    const items = plans.reduce<AnalyticsPlanParticipation[]>((acc, plan) => {
      const targetIds = normalizePlanTargetIds(plan.targetIdsJson);
      if (plan.targetType === 'employees' && targetIds.includes(manager.id)) {
        acc.push(normalizePlanParticipation(plan, 'employees', targetIds.length));
      } else if (plan.targetType === 'dealerships' && targetIds.includes(manager.dealershipId)) {
        acc.push(normalizePlanParticipation(plan, 'dealership', targetIds.length));
      }
      return acc;
    }, []);

    res.json({ items });
  } catch (err) {
    console.error('analytics/managers/:id/plans error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/analytics/managers/:id/plans/:planId/exclude', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const planId = String(req.params.planId || '').trim();
    const manager = await prisma.managerProfile.findUnique({ where: { id }, include: { dealership: true } });
    if (!manager || !manager.dealership.holdingId) return res.status(404).json({ error: 'Менеджер не найден.' });
    const plan = await prisma.callPlan.findFirst({ where: { id: planId, holdingId: manager.dealership.holdingId } });
    if (!plan) return res.status(404).json({ error: 'Расписание не найдено.' });
    await assertCanMutateAnalyticsPlan(req, plan.holdingId);

    const targetIds = normalizePlanTargetIds(plan.targetIdsJson);
    if (plan.targetType === 'dealerships' && targetIds.includes(manager.dealershipId)) {
      return res.status(400).json({ error: 'Менеджер участвует через расписание всей точки. Чтобы исключить его, настройте план точки.' });
    }
    if (plan.targetType !== 'employees' || !targetIds.includes(manager.id)) {
      return res.status(400).json({ error: 'Менеджер уже не участвует в этом расписании.' });
    }

    const nextTargetIds = targetIds.filter((targetId) => targetId !== manager.id);
    if (nextTargetIds.length === 0) {
      return res.status(400).json({ error: 'Нельзя оставить расписание без участников. Откройте настройки плана и удалите его или добавьте другие цели.' });
    }

    await prisma.callPlan.update({
      where: { id: plan.id },
      data: { targetIdsJson: JSON.stringify(nextTargetIds) },
    });
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось исключить менеджера из расписания.';
    console.error('analytics/managers/:id/plans/:planId/exclude error:', err);
    res.status(message.includes('доступ') ? 403 : 500).json({ error: message });
  }
});

app.get('/api/admin/analytics/managers/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const manager = await resolveAccessibleAnalyticsManager(req, id);
    if (!manager) return res.status(404).json({ error: 'Manager not found' });
    const [sessions, dealershipSessions, networkSessions, dealershipManagers, trainerSessions, trainerScoreAgg, trainerStreak] = await Promise.all([
      prisma.voiceCallSession.findMany({
        where: { managerId: manager.id },
        include: { plan: { select: { name: true, scriptId: true } } },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.voiceCallSession.findMany({
        where: { dealershipId: manager.dealershipId },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.voiceCallSession.findMany({
        where: { dealershipId: { not: null } },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.managerProfile.findMany({
        where: { dealershipId: manager.dealershipId, status: 'active' },
        select: { id: true },
      }),
      prisma.trainerSession.findMany({
        where: { employeeId: manager.id },
        include: { scenario: { select: { name: true } } },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.trainerScore.aggregate({
        where: { employeeId: manager.id },
        _sum: { finalScore: true },
      }),
      prisma.trainerStreak.findUnique({ where: { employeeId: manager.id } }),
    ]);
    const scriptIds = [...new Set(sessions.map((session) => session.plan?.scriptId).filter((scriptId): scriptId is string => Boolean(scriptId)))];
    const scripts = scriptIds.length
      ? await prisma.callScript.findMany({
          where: { id: { in: scriptIds } },
          select: { id: true, questionsJson: true, objectionsJson: true, successCriteriaJson: true },
        })
      : [];
    const scriptsById = new Map(scripts.map((script) => [script.id, script]));
    const score = scoreFromSessions(sessions);
    const delta = deltaFromSessions(sessions);
    const answerRate = answerRateFromSessions(sessions);
    const failsCount = sessions.filter((session) => typeof session.totalScore === 'number' && (session.totalScore ?? 0) < 50).length;
    const commFlag = communicationFlagFromSessions(sessions);
    const topIssues = topIssuesFromSessions(sessions);
    const blockBreakdown = dimensionBreakdownFromSessions(sessions);
    const noAnswers = sessions.filter((session) => session.outcome === 'no_answer').length;
    const weakestBlock = [...blockBreakdown].sort((a, b) => a.score - b.score)[0] ?? null;
    const dealershipSessionsCount = dealershipSessions.length;
    const dealershipManagerScores = dealershipManagers
      .map((item) => {
        const managerSessions = networkSessions.filter((session) => session.managerId === item.id);
        return {
          id: item.id,
          calls: managerSessions.length,
          score: scoreFromSessions(managerSessions),
        };
      })
      .filter((item) => item.calls > 0)
      .sort((a, b) => b.score - a.score);
    const rankIndex = dealershipManagerScores.findIndex((item) => item.id === manager.id);
    const managerSeries = timeSeriesFromSessions(sessions);
    const dealershipSeries = timeSeriesFromSessions(dealershipSessions);
    const networkSeries = timeSeriesFromSessions(networkSessions);
    const dealershipSeriesByDate = new Map(dealershipSeries.map((point) => [point.date, point]));
    const networkSeriesByDate = new Map(networkSeries.map((point) => [point.date, point]));
    const outcomeBreakdown = {
      completed: sessions.filter((session) => session.outcome === 'completed').length,
      no_answer: sessions.filter((session) => session.outcome === 'no_answer').length,
      busy: sessions.filter((session) => session.outcome === 'busy').length,
      failed: sessions.filter((session) => session.outcome === 'failed').length,
      disconnected: sessions.filter((session) => session.outcome === 'disconnected').length,
    };
    let communicationStrong = 0;
    let communicationMedium = 0;
    let communicationWeak = 0;
    for (const session of sessions) {
      const communication = extractDimensionsFromSession(session).communication;
      if (typeof communication !== 'number') continue;
      if (communication >= 76) communicationStrong += 1;
      else if (communication >= 50) communicationMedium += 1;
      else communicationWeak += 1;
    }
    const communicationTotal = communicationStrong + communicationMedium + communicationWeak;
    const trainerCompleted = trainerSessions.filter((session) => session.status === 'completed' || session.status === 'failed');
    const trainerScored = trainerCompleted.filter((session) => typeof session.score === 'number');
    const trainerAvgScore = trainerScored.length
      ? round1(trainerScored.reduce((sum, session) => sum + (session.score ?? 0), 0) / trainerScored.length)
      : 0;
    const trainer30dStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const trainerIssueCounts = new Map<string, { weak: number; total: number }>();
    for (const session of trainerCompleted) {
      const checklist = safeArray<{ status?: string; comment?: string; code?: string }>(session.checklistResultsJson);
      for (const item of checklist) {
        const issue = item.comment || item.code || 'Пункт чек-листа';
        const current = trainerIssueCounts.get(issue) ?? { weak: 0, total: 0 };
        current.total += 1;
        const status = String(item.status || '').toUpperCase();
        if (status === 'NO' || status === 'PARTIAL') current.weak += 1;
        trainerIssueCounts.set(issue, current);
      }
    }
    const trainerWeakPatterns = [...trainerIssueCounts.entries()]
      .map(([issue, value]) => ({ issue, percent: percent(value.weak, value.total) }))
      .filter((item) => item.percent > 33)
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 5);
    const trainerWeeklyScore = timeSeriesFromSessions(trainerCompleted.map((session) => ({
      id: 0,
      startedAt: session.startedAt,
      outcome: session.status,
      totalScore: session.score,
      evaluationJson: session.evaluationJson,
      dimensionsJson: session.dimensionsJson,
      checklistResultsJson: session.checklistResultsJson,
      dealershipId: session.branchId,
      managerId: session.employeeId,
    })), 12);
    const status = sessions.length === 0
      ? 'no-data'
      : score < 50 || failsCount >= 2 ? 'critical'
      : score < 70 ? 'risk'
      : 'norm';
    const item = {
      id: manager.id,
      accountId: manager.accountId ?? null,
      fullName: manager.fullName,
      dealershipId: manager.dealershipId,
      dealershipName: manager.dealership.name,
      city: manager.dealership.city || '—',
      aiRating: score,
      deltaRating: delta,
      answerRate,
      auditsCount: sessions.length,
      failsCount,
      noAnswers,
      noAnswerRate: percent(noAnswers, sessions.length),
      directCalls: sessions.length,
      dealershipCalls: dealershipSessionsCount,
      dealershipRank: rankIndex >= 0
        ? { rank: rankIndex + 1, total: dealershipManagerScores.length }
        : null,
      communicationFlag: commFlag,
      outcomeBreakdown,
      communicationBreakdown: [
        { label: 'Сильная коммуникация', percent: percent(communicationStrong, communicationTotal), color: '#2D9B5E' },
        { label: 'Средняя коммуникация', percent: percent(communicationMedium, communicationTotal), color: '#D4842A' },
        { label: 'Слабая коммуникация', percent: percent(communicationWeak, communicationTotal), color: '#E05252' },
      ],
      topMistakeLabel: topIssues[0]?.issue ?? 'Нет данных',
      status,
      aiSummary: await generateAnalyticsAISummary({
        level: 'manager',
        name: manager.fullName,
        score,
        calls: sessions.length,
        noAnswers,
        topIssue: topIssues[0]?.issue ?? null,
        topIssuePercent: topIssues[0]?.percent ?? null,
        worstDimension: weakestBlock?.block ?? null,
        trend: delta,
        failsCount,
      }),
      strengths: blockBreakdown.filter((item) => item.score >= 76).slice(0, 2).map((item) => item.block),
      growthAreas: blockBreakdown.filter((item) => item.score < 70).slice(0, 2).map((item) => item.block),
      trainingFocus: topIssues[0]?.issue ?? 'Накопить больше звонков для устойчивой оценки',
      timeSeries: managerSeries,
      comparisonTimeSeries: managerSeries.map((point) => ({
        date: point.date,
        managerScore: point.avgScore,
        dealershipScore: dealershipSeriesByDate.get(point.date)?.avgScore ?? 0,
        networkScore: networkSeriesByDate.get(point.date)?.avgScore ?? 0,
      })),
      blockBreakdown,
      topIssues: topIssues.map((item) => ({ issue: item.issue, percent: item.percent })),
      topQuestions: topScriptQuestionsFromSessions(sessions, scriptsById, 5).map((item) => item.question),
      recommendedTrainings: topIssues.slice(0, 5).map((item) => ({
        title: item.issue,
        description: `Встречается в ${item.percent}% проверок сотрудника. Начните разбор с цитат в отчётах и сравните с лучшими примерами по категории.`,
      })),
      audits: [
        ...sessions.map((session) => ({
          id: `call-${session.id}`,
          date: session.startedAt.toISOString(),
          type: 'call' as const,
          score: Math.round(session.totalScore ?? 0),
          outcome: session.outcome,
          verdict: session.outcome === 'no_answer' ? 'Недозвон' : (session.totalScore ?? 0) < 50 ? 'Нуждается в доработке' : 'Оценено',
        })),
        ...trainerSessions.map((session) => {
          const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
          const score = Math.round(scoreFromEvaluation(evaluation, session.score));
          return {
            id: `trainer-${session.id}`,
            date: (session.completedAt ?? session.startedAt).toISOString(),
            type: 'trainer' as const,
            score,
            outcome: null as string | null,
            verdict: session.status === 'failed' || !!session.failureReason
              ? 'Провал'
              : session.status === 'abandoned'
                ? 'Прервано'
                : session.status === 'completed'
                  ? 'Пройдено'
                  : 'В процессе',
          };
        }),
      ].sort((a, b) => +new Date(b.date) - +new Date(a.date)),
      noAnswerHistory: sessions
        .filter((session) => session.outcome === 'no_answer')
        .map((session) => ({
          id: `call-${session.id}`,
          date: session.startedAt.toISOString(),
          planName: session.plan?.name ?? null,
          verdict: 'Недозвон',
        })),
      trainer: {
        totalPoints: trainerScoreAgg._sum.finalScore ?? 0,
        currentStreak: trainerStreak?.currentStreak ?? 0,
        longestStreak: trainerStreak?.longestStreak ?? 0,
        sessionsTotal: trainerCompleted.length,
        sessions30d: trainerCompleted.filter((session) => session.startedAt >= trainer30dStart).length,
        avgScore: trainerAvgScore,
        weeklyScore: trainerWeeklyScore,
        weakPatterns: trainerWeakPatterns,
        history: trainerSessions.slice(0, 12).map((session) => ({
          id: session.id,
          date: session.startedAt.toISOString(),
          type: session.sessionType,
          scenarioName: session.scenario?.name ?? 'Сценарий',
          score: session.score,
          finalPoints: session.finalPoints,
          status: session.status,
        })),
      },
    };
    res.json({ item });
  } catch (err) {
    console.error('analytics/managers/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/analytics/managers', async (_req, res) => {
  try {
    const [managers, sessions] = await Promise.all([
      prisma.managerProfile.findMany({
        where: { status: 'active' },
        include: { dealership: true },
        orderBy: { fullName: 'asc' },
      }),
      prisma.voiceCallSession.findMany({
        where: { dealershipId: { not: null } },
        select: {
          id: true,
          startedAt: true,
          outcome: true,
          totalScore: true,
          evaluationJson: true,
          dimensionsJson: true,
          checklistResultsJson: true,
          dealershipId: true,
          managerId: true,
        },
      }),
    ]);

    const items = managers.map((manager) => {
      const directSessions = sessions.filter((session) => session.managerId === manager.id);
      const dealershipSessions = sessions.filter((session) => session.dealershipId === manager.dealershipId);
      const score = scoreFromSessions(directSessions);
      const delta = deltaFromSessions(directSessions);
      const failsCount = directSessions.filter((session) => typeof session.totalScore === 'number' && (session.totalScore ?? 0) < 50).length;
      const commFlag = communicationFlagFromSessions(directSessions);
      const topIssue = topIssuesFromSessions(directSessions, 1)[0]?.issue ?? 'Нет данных';
      const dataState = directSessions.length > 0
        ? 'full'
        : dealershipSessions.length > 0
        ? 'partial'
        : 'none';
      const status = dataState === 'none'
        ? 'no-data'
        : score < 50 || failsCount >= 2
        ? 'critical'
        : score < 70
        ? 'risk'
        : 'norm';
      return {
        id: manager.id,
        accountId: manager.accountId ?? null,
        fullName: manager.fullName,
        dealershipId: manager.dealershipId,
        dealershipName: manager.dealership.name,
        city: manager.dealership.city || '—',
        aiRating: score,
        deltaRating: delta,
        auditsCount: directSessions.length,
        failsCount,
        communicationFlag: commFlag,
        topMistakeLabel: topIssue,
        status,
        dataState,
        directCalls: directSessions.length,
        dealershipCalls: dealershipSessions.length,
      };
    });
    res.json({ items });
  } catch (err) {
    console.error('analytics/managers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Super Admin: platform-level data (no schema change) ─────────────────

// Merged audits: attempts + training sessions + voice calls (platform-wide list)
app.get('/api/admin/super-admin/audits', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const activeRole = getActiveAdminRole(req);
    const voiceScopeWhere = buildVoiceCallSessionScopeWhere(req.authAccount, activeRole);
    const trainerScopeWhere = buildTrainerSessionScopeWhere(req.authAccount, activeRole);
    const [voiceSessions, trainerSessions, catalog, auditPhoneNumbers] = await Promise.all([
      prisma.voiceCallSession.findMany({
        where: {
          AND: [
            voiceScopeWhere,
            {
              OR: [
                { totalScore: { not: null } },
                { evaluationJson: { not: null } },
                { outcome: { in: ['completed', 'no_answer', 'busy', 'failed', 'disconnected'] } },
              ],
            },
          ],
        },
        include: {
          dealership: { include: { holding: true } },
          manager: true,
          plan: true,
        },
        orderBy: { startedAt: 'desc' },
        take: limit,
      }),
      prisma.trainerSession.findMany({
        where: {
          AND: [
            trainerScopeWhere,
            { status: { in: ['completed', 'failed'] } },
          ],
        },
        include: {
          employee: { include: { dealership: { include: { holding: true } } } },
          branch: { include: { holding: true } },
          company: true,
          scenario: true,
        },
        orderBy: { startedAt: 'desc' },
        take: limit,
      }),
      getCallReportProblemCatalog(prisma),
      prisma.phoneNumber.findMany({
        where: { isActive: true },
        select: { id: true, phone: true, typeId: true, type: { select: { name: true } } },
      }),
    ]);
    const auditPhoneByNumber = new Map(auditPhoneNumbers.map((phone) => [normalizeCallPhone(phone.phone), phone]));

    const auditFromCall = (s: typeof voiceSessions[number]) => {
      const fallbackPhone = auditPhoneByNumber.get(normalizeCallPhone(s.to));
      let score = s.totalScore ?? 0;
      if (s.evaluationJson) {
        try {
          const e = JSON.parse(s.evaluationJson);
          score = scoreFromEvaluation(e, s.totalScore);
        } catch { /* skip */ }
      }
      const type = s.source === 'trainer' || s.scenario === 'trainer' || s.scenario === 'training' ? 'trainer' as const : 'call' as const;
      const auditStatus = s.outcome === 'no_answer' || s.outcome === 'busy'
        ? 'interrupted' as const
        : s.outcome === 'failed' || !!s.failureReason || score < 50
        ? 'failed' as const
        : 'completed' as const;
      const verdict = auditStatus === 'interrupted'
        ? 'Звонок не завершён'
        : auditStatus === 'failed'
        ? 'Нуждается в разборе'
        : 'Оценено';
      return {
        id: `call-${s.id}`,
        type,
        company: s.dealership?.holding?.name ?? 'Без компании',
        dealer: s.dealership?.name ?? s.to,
        holdingId: s.dealership?.holdingId ?? null,
        dealershipId: s.dealershipId,
        dealershipName: s.dealership?.name ?? null,
        city: s.dealership?.city ?? null,
        employeeId: s.managerId,
        employeeAccountId: s.manager?.accountId ?? null,
        date: s.startedAt.toISOString(),
        aiScore: Math.round(score * 10) / 10,
        status: score >= 76 ? 'Good' as const : score >= 50 ? 'Medium' as const : 'Bad' as const,
        auditStatus,
        durationSec: s.durationSec ?? 0,
        outcome: s.outcome,
        answerTimeSec: s.answerTimeSec,
        phoneNumberId: s.phoneNumberId ?? fallbackPhone?.id ?? null,
        phoneNumberTypeId: s.phoneNumberTypeId ?? fallbackPhone?.typeId ?? null,
        phoneNumberTypeName: s.phoneNumberTypeName ?? fallbackPhone?.type.name ?? null,
        phoneNumber: s.to,
        verdict,
        communicationFlag: communicationFlagFromSessions([s]),
        reportIssues: extractReportIssuesFromSession(s, catalog),
        userName: s.manager?.fullName ?? null,
        detailId: s.id,
        detailType: type,
      };
    };

    const auditFromTrainer = (s: typeof trainerSessions[number]) => {
      const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(s.evaluationJson, null);
      const hasScore = s.score !== null || evaluation !== null;
      const score = hasScore ? scoreFromEvaluation(evaluation, s.score) : null;
      const branch = s.branch ?? s.employee?.dealership ?? null;
      const company = s.company ?? branch?.holding ?? s.employee?.dealership?.holding ?? null;
      const auditStatus = s.status === 'failed' || !!s.failureReason || (score !== null && score < 50)
        ? 'failed' as const
        : 'completed' as const;
      return {
        id: `trainer-${s.id}`,
        type: 'trainer' as const,
        company: company?.name ?? 'Без компании',
        dealer: branch?.name ?? company?.name ?? 'Без точки',
        holdingId: company?.id ?? branch?.holdingId ?? null,
        dealershipId: branch?.id ?? null,
        dealershipName: branch?.name ?? null,
        city: branch?.city ?? null,
        employeeId: s.employeeId,
        employeeAccountId: s.employee?.accountId ?? null,
        date: (s.completedAt ?? s.startedAt).toISOString(),
        aiScore: score === null ? null : Math.round(score * 10) / 10,
        status: score === null ? 'Medium' as const : score >= 76 ? 'Good' as const : score >= 50 ? 'Medium' as const : 'Bad' as const,
        auditStatus,
        durationSec: s.durationSec ?? 0,
        outcome: null,
        answerTimeSec: null,
        phoneNumberId: null,
        phoneNumberTypeId: null,
        phoneNumberTypeName: null,
        phoneNumber: null,
        verdict: score === null ? 'Аналитика считается' : auditStatus === 'failed' ? 'Нуждается в разборе' : 'Оценено',
        communicationFlag: communicationFlagFromSessions([s as unknown as AnalyticsSession]),
        reportIssues: extractReportIssuesFromSession(s, catalog),
        userName: s.employee?.fullName ?? null,
        detailId: s.id,
        detailType: 'trainer' as const,
      };
    };

    const items = [...voiceSessions.map(auditFromCall), ...trainerSessions.map(auditFromTrainer)]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    res.json({ audits: items });
  } catch (err) {
    console.error('super-admin/audits error:', err);
    res.json({ audits: [] });
  }
});

async function buildTrainerAuditDetailItem(session: {
  id: string;
  employeeId: string;
  score: number | null;
  status: string;
  failureReason: string | null;
  durationSec: number | null;
  startedAt: Date;
  completedAt: Date | null;
  evaluationJson: string | null;
  transcriptJson: string | null;
  checklistResultsJson: string | null;
  topRecommendationsJson: string | null;
  dimensionsJson: string | null;
  objectionsAnalysisJson: string | null;
  employee?: { fullName: string; dealership?: { id: string; name: string; city: string | null; holding?: { id: string; name: string } | null } | null } | null;
  branch?: { id: string; name: string; city: string | null; holding?: { id: string; name: string } | null } | null;
  company?: { id: string; name: string } | null;
  scenario?: { id: string; name: string } | null;
}) {
  let evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
  const score = scoreFromEvaluation(evaluation, session.score);
  const status = session.status === 'failed' || !!session.failureReason || score < 50
    ? 'failed' as const
    : 'completed' as const;
  const dimensions = extractDimensionsFromSession(session);
  const blocksBreakdown = Object.entries(dimensions).map(([key, value]) => ({
    block: dimensionLabel(key),
    score: Math.round(value),
    hint: `Средний балл блока «${dimensionLabel(key)}»`,
  })).sort((a, b) => a.score - b.score);
  const rawChecklist = extractChecklistFromSession(session);
  const checklist = rawChecklist
    .filter((item) => String(item.status || '').toUpperCase() !== 'NA')
    .map((item) => {
      const normalized = String(item.status || '').toUpperCase();
      return {
        label: AUDIT_CHECKLIST_LABELS[item.code || ''] || item.comment || item.code || 'Пункт чек-листа',
        result: normalized === 'YES' ? 'pass' as const : normalized === 'NO' ? 'fail' as const : 'warn' as const,
        quote: item.comment || (normalized === 'YES' ? 'Выполнено' : normalized === 'NO' ? 'Не выполнено' : 'Частично выполнено'),
      };
    });
  const transcriptRaw = safeJsonParseLocal<Array<{ role?: string; text?: string; content?: string }> | null>(session.transcriptJson, null) ?? [];
  const duration = session.durationSec ?? 0;
  const step = transcriptRaw.length > 0 ? Math.max(1, Math.floor(duration / transcriptRaw.length)) : 0;
  const transcript = transcriptRaw.map((line, index) => {
    const seconds = index * step;
    const speaker = line.role === 'manager' || line.role === 'assistant' ? 'manager' as const : 'client' as const;
    return {
      speaker,
      time: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
      text: String(line.text || line.content || ''),
      critical: false,
    };
  }).filter((line) => line.text.trim());
  const recommendationsRaw = safeJsonParseLocal<unknown[]>(session.topRecommendationsJson, []);
  const recommendations = Array.isArray(evaluation?.recommendations) ? evaluation.recommendations as unknown[] : recommendationsRaw;
  const recommendedTrainings = recommendations.slice(0, 3).map((item) => {
    const text = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
      ? String((item as Record<string, unknown>).recommendation || (item as Record<string, unknown>).title || (item as Record<string, unknown>).description || 'Рекомендация')
      : 'Рекомендация';
    return { title: text, description: 'Отработать в тренажёре' };
  });
  const catalog = await getCallReportProblemCatalog(prisma);
  const reportIssues = extractReportIssuesFromSession(session, catalog);
  const errors = reportIssues.slice(0, 5).map((issue, index) => ({
    issue,
    percent: Math.max(30, Math.min(100, 100 - index * 12)),
  }));
  const branch = session.branch ?? session.employee?.dealership ?? null;
  const company = session.company ?? branch?.holding ?? null;
  const endedAt = session.completedAt ?? session.startedAt;
  const reportTranscript = transcriptRaw
    .map((line) => ({
      role: (line.role === 'manager' || line.role === 'assistant' ? 'manager' : 'client') as 'manager' | 'client',
      text: String(line.text || line.content || '').trim(),
    }))
    .filter((line) => line.text);
  let unifiedReport = normalizeUnifiedCallReport(
    evaluation?.unified_call_report,
    { totalScore: score, transcript: reportTranscript, source: 'trainer', dimensionScores: dimensions },
    catalog,
  );
  if (!unifiedReport && reportTranscript.length >= 2) {
    try {
      unifiedReport = await generateUnifiedTrainerReport({
        transcript: reportTranscript,
        totalScore: score,
        evaluation: evaluation ?? {},
        scenarioName: session.scenario?.name ?? null,
      });
      evaluation = {
        ...(evaluation ?? {}),
        unified_call_report: unifiedReport,
      };
      await prisma.trainerSession.update({
        where: { id: session.id },
        data: { evaluationJson: JSON.stringify(evaluation) },
      });
    } catch (reportError) {
      console.warn('trainer audit detail unified report generation failed:', reportError instanceof Error ? reportError.message : reportError);
    }
  }

  return {
    id: `trainer-${session.id}`,
    type: 'trainer' as const,
    dateTime: endedAt.toISOString(),
    employeeId: session.employeeId,
    employeeName: session.employee?.fullName ?? 'Не назначен',
    dealershipId: branch?.id ?? '',
    dealershipName: branch?.name ?? company?.name ?? 'Без точки',
    city: branch?.city ?? '—',
    totalScore: score,
    verdict: status === 'failed' ? 'Нуждается в разборе' : 'Оценено',
    status,
    duration,
    communicationFlag: communicationFlagFromSessions([session as unknown as AnalyticsSession]),
    blocksBreakdown,
    checklist,
    transcript,
    events: [
      { time: '00:00', label: 'Тренировка начата', type: 'info' as const },
      { time: duration ? `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}` : '00:00', label: `Статус: ${session.status}`, type: status === 'completed' ? 'info' as const : 'warning' as const },
      ...(session.failureReason ? [{ time: '00:00', label: getFailureReasonLabel(session.failureReason), type: 'error' as const }] : []),
    ],
    errors,
    topQuestions: reportIssues.slice(0, 5),
    recommendedTrainings,
    answerTimeSec: null,
    attempts: null,
    callback: null,
    scenarioName: session.scenario?.name ?? null,
    assignedBy: null,
    failReason: session.failureReason ? getFailureReasonLabel(session.failureReason) : null,
    unifiedReport,
  };
}

app.get('/api/admin/audits/:id', async (req, res) => {
  try {
    const rawId = String(req.params.id || '').trim();
    if (rawId.startsWith('trainer-')) {
      const trainerId = rawId.replace(/^trainer-/, '');
      const session = await prisma.trainerSession.findFirst({
        where: {
          AND: [
            { id: trainerId },
            buildTrainerSessionScopeWhere(req.authAccount, getActiveAdminRole(req)),
          ],
        },
        include: {
          employee: { include: { dealership: { include: { holding: true } } } },
          branch: { include: { holding: true } },
          company: true,
          scenario: true,
        },
      });
      if (!session) return res.status(404).json({ error: 'Audit not found' });
      return res.json({ item: await buildTrainerAuditDetailItem(session) });
    }

    const numericId = Number.parseInt(rawId.replace(/^call-/, ''), 10);
    if (!Number.isFinite(numericId)) return res.status(400).json({ error: 'Invalid audit id' });

    const session = await prisma.voiceCallSession.findFirst({
      where: {
        AND: [
          { id: numericId },
          buildVoiceCallSessionScopeWhere(req.authAccount, getActiveAdminRole(req)),
        ],
      },
      include: {
        dealership: { include: { holding: true } },
        manager: true,
        plan: true,
      },
    });
    if (!session) return res.status(404).json({ error: 'Audit not found' });

    let evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
    const planCriteria = extractPlanCriteriaEvaluation(evaluation);
    const score = scoreFromEvaluation(evaluation, session.totalScore);
    const type = session.source === 'trainer' || session.scenario === 'trainer' || session.scenario === 'training' ? 'trainer' as const : 'call' as const;
    const status = session.outcome === 'no_answer' || session.outcome === 'busy'
      ? 'interrupted' as const
      : session.outcome === 'failed' || !!session.failureReason || score < 50
      ? 'failed' as const
      : 'completed' as const;
    const dimensions = extractDimensionsFromSession(session);
    const blocksBreakdown = Object.entries(dimensions).map(([key, value]) => ({
      block: dimensionLabel(key),
      score: Math.round(value),
      hint: `Средний балл блока «${dimensionLabel(key)}»`,
    })).sort((a, b) => a.score - b.score);

    const checklistLabels = AUDIT_CHECKLIST_LABELS;
    const issueLabels = AUDIT_ISSUE_LABELS;
    const severityScore = (severity: unknown) => {
      const normalized = String(severity || '').toUpperCase();
      if (normalized === 'HIGH') return 100;
      if (normalized === 'MEDIUM') return 70;
      if (normalized === 'LOW') return 40;
      return 60;
    };

    const rawChecklist = extractChecklistFromSession(session);
    const checklist = planCriteria
      ? planCriteria.items.map((item, index) => {
        const ratio = item.maxScore > 0 ? item.score / item.maxScore : 0;
        const result = ratio >= 0.8 ? 'pass' as const : ratio >= 0.4 ? 'warn' as const : 'fail' as const;
        return {
          label: item.expectedAnswer || `Критерий скрипта ${index + 1}`,
          result,
          quote: item.evidence || `Баллы: ${round1(item.score)} из ${round1(item.maxScore)}`,
        };
      })
      : rawChecklist
        .filter((item) => String(item.status || '').toUpperCase() !== 'NA')
        .map((item) => {
          const normalized = String(item.status || '').toUpperCase();
          const evidence = Array.isArray((item as { evidence?: unknown }).evidence)
            ? ((item as { evidence?: unknown[] }).evidence ?? []).map((value) => String(value).trim()).filter(Boolean)
            : [];
          return {
            label: checklistLabels[item.code || ''] || item.comment || item.code || 'Пункт чек-листа',
            result: normalized === 'YES' ? 'pass' as const : normalized === 'NO' ? 'fail' as const : 'warn' as const,
            quote: evidence[0] || item.comment || (normalized === 'YES' ? 'Выполнено' : normalized === 'NO' ? 'Не выполнено' : 'Частично выполнено'),
          };
        });

    const transcriptRaw = safeJsonParseLocal<Array<{ role?: string; text?: string; content?: string }> | null>(session.transcriptJson, null) ?? [];
    const duration = session.durationSec ?? 0;
    const step = transcriptRaw.length > 0 ? Math.max(1, Math.floor(duration / transcriptRaw.length)) : 0;
    const transcript = transcriptRaw.map((line, index) => {
      const seconds = index * step;
      const speaker = line.role === 'manager' || line.role === 'assistant' ? 'manager' as const : 'client' as const;
      return {
        speaker,
        time: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
        text: String(line.text || line.content || ''),
        critical: false,
      };
    }).filter((line) => line.text.trim());

    const issues = Array.isArray(evaluation?.issues) ? evaluation.issues as Array<Record<string, unknown>> : [];
    const recommendations = Array.isArray(evaluation?.recommendations) ? evaluation.recommendations as unknown[] : [];
    const failedPlanCriteria = planCriteria?.items
      .map((item, index) => {
        const maxScore = item.maxScore > 0 ? item.maxScore : 100;
        const lostPercent = Math.round(((maxScore - item.score) / maxScore) * 100);
        return {
          issue: item.expectedAnswer || `Критерий скрипта ${index + 1}`,
          evidence: item.evidence,
          percent: Math.max(0, Math.min(100, lostPercent)),
        };
      })
      .filter((item) => item.percent > 0) ?? [];
    const topQuestions = planCriteria
      ? failedPlanCriteria.slice(0, 5).map((item) => item.issue)
      : rawChecklist
        .filter((item) => ['NO', 'PARTIAL'].includes(String(item.status || '').toUpperCase()))
        .slice(0, 5)
        .map((item) => checklistLabels[item.code || ''] || item.comment || item.code || 'Провальный пункт чек-листа');
    const recommendationRows = recommendations.slice(0, 3).map((item) => {
      const text = typeof item === 'string'
        ? item
        : item && typeof item === 'object'
        ? String((item as Record<string, unknown>).recommendation || (item as Record<string, unknown>).title || (item as Record<string, unknown>).description || 'Рекомендация')
        : 'Рекомендация';
      return { title: text, description: 'Отработать на основе текущего звонка' };
    });
    const recommendedTrainings = recommendationRows.length > 0
      ? recommendationRows
      : failedPlanCriteria.slice(0, 3).map((item) => ({
        title: item.issue,
        description: item.evidence || 'Отработать по критерию скрипта',
      }));
    const checklistErrors = rawChecklist
      .filter((item) => ['NO', 'PARTIAL'].includes(String(item.status || '').toUpperCase()))
      .map((item) => {
        const status = String(item.status || '').toUpperCase();
        const weight = typeof (item as { weight?: unknown }).weight === 'number' ? Number((item as { weight?: number }).weight) : 6;
        return {
          issue: checklistLabels[item.code || ''] || item.comment || item.code || 'Ошибка чек-листа',
          percent: status === 'NO' ? Math.min(100, Math.max(40, weight * 10)) : Math.min(70, Math.max(30, weight * 7)),
        };
      });
    const issueErrors = issues.map((item) => ({
      issue: issueLabels[String(item.issue_type || '')] || String(item.recommendation || item.comment || item.issue_type || 'Ошибка'),
      percent: severityScore(item.severity),
    }));
    const scriptErrors = failedPlanCriteria.map((item) => ({
      issue: item.issue,
      percent: item.percent,
    }));
    const errorRows = (planCriteria ? scriptErrors : [...checklistErrors, ...issueErrors])
      .filter((item, index, list) => item.issue && list.findIndex((candidate) => candidate.issue === item.issue) === index)
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 5);

    const events = [
      { time: '00:00', label: 'Звонок начат', type: 'info' as const },
      ...(session.outcome ? [{ time: duration ? `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}` : '00:00', label: `Исход: ${session.outcome}`, type: status === 'completed' ? 'info' as const : 'warning' as const }] : []),
      ...(session.failureReason ? [{ time: '00:00', label: session.failureReason, type: 'error' as const }] : []),
    ];

    const reportTranscript = transcriptRaw
      .map((line) => ({
        role: (line.role === 'manager' || line.role === 'assistant' ? 'manager' : 'client') as 'manager' | 'client',
        text: String(line.text || line.content || '').trim(),
      }))
      .filter((line) => line.text);
    const catalog = await getCallReportProblemCatalog(prisma);
    let unifiedReport = normalizeUnifiedCallReport(
      evaluation?.unified_call_report,
      { totalScore: score, transcript: reportTranscript, dimensionScores: dimensions },
      catalog,
    );
    if (!unifiedReport && type === 'call' && evaluation && reportTranscript.length >= 2) {
      try {
        unifiedReport = await generateUnifiedCallReport({
          transcript: reportTranscript,
          outcome: session.outcome,
          totalScore: score,
          evaluation,
        });
        evaluation = {
          ...evaluation,
          unified_call_report: unifiedReport,
        };
        await prisma.voiceCallSession.update({
          where: { id: session.id },
          data: { evaluationJson: JSON.stringify(evaluation) },
        });
      } catch (reportError) {
        console.warn('admin/audits/:id unified report generation failed:', reportError instanceof Error ? reportError.message : reportError);
      }
    }

    res.json({
      item: {
        id: `call-${session.id}`,
        type,
        dateTime: session.startedAt.toISOString(),
        employeeId: session.managerId ?? '',
        employeeName: session.manager?.fullName ?? 'Не назначен',
        dealershipId: session.dealershipId ?? '',
        dealershipName: session.dealership?.name ?? session.to,
        city: session.dealership?.city ?? '—',
        totalScore: score,
        verdict: status === 'interrupted' ? 'Звонок не завершён' : status === 'failed' ? 'Нуждается в разборе' : 'Оценено',
        status,
        duration,
        communicationFlag: communicationFlagFromSessions([session]),
        blocksBreakdown,
        checklist,
        transcript,
        events,
        errors: errorRows,
        topQuestions,
        recommendedTrainings,
        answerTimeSec: session.answerTimeSec ?? null,
        attempts: null,
        callback: null,
        scenarioName: type === 'trainer' ? session.scenario ?? session.plan?.name ?? null : null,
        assignedBy: null,
        failReason: session.failureReason,
        unifiedReport,
      },
    });
  } catch (err) {
    console.error('admin/audits/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Time-series: last 7 days avg AI score (for dashboard chart)
app.get('/api/admin/super-admin/time-series', async (_req, res) => {
  try {
    const days = 7;
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const [attempts, trainingSessions, voiceSessions] = await Promise.all([
      prisma.attempt.findMany({
        where: {
          status: 'completed',
          totalScore: { not: null },
          finishedAt: { gte: start },
        },
        select: { finishedAt: true, totalScore: true },
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          completedAt: { gte: start },
          OR: [
            { assessmentScore: { not: null } },
            { evaluationJson: { not: null } },
          ],
        },
        select: { completedAt: true, totalScore: true, evaluationJson: true, assessmentScore: true },
      }),
      prisma.voiceCallSession.findMany({
        where: {
          startedAt: { gte: start },
          OR: [
            { totalScore: { not: null } },
            { evaluationJson: { not: null } },
          ],
        },
        select: { startedAt: true, totalScore: true, evaluationJson: true },
      }),
    ]);

    const byDay: Record<string, { sum: number; count: number }> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      byDay[key] = { sum: 0, count: 0 };
    }

    const addScore = (date: Date | null, score: number) => {
      if (!date) return;
      const key = new Date(date).toISOString().slice(0, 10);
      if (byDay[key]) {
        byDay[key].sum += score;
        byDay[key].count += 1;
      }
    };

    attempts.forEach((a) => addScore(a.finishedAt, a.totalScore!));
    trainingSessions.forEach((s) => {
      let score = s.totalScore ?? s.assessmentScore ?? 0;
      if (score === 0 && s.evaluationJson) {
        try {
          const e = JSON.parse(s.evaluationJson);
          score = e.overall_score_0_100 ?? 0;
        } catch { /* skip */ }
        addScore(s.completedAt, score);
      } else if (score > 0) {
        addScore(s.completedAt, score);
      }
    });
    voiceSessions.forEach((s) => {
      let score = s.totalScore ?? 0;
      if (score === 0 && s.evaluationJson) {
        try {
          const e = JSON.parse(s.evaluationJson);
          score = e.overall_score_0_100 ?? 0;
        } catch { /* skip */ }
        addScore(s.startedAt, score);
      } else if (score > 0) {
        addScore(s.startedAt, score);
      }
    });

    const series = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { sum, count }]) => ({
        date,
        avgScore: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
        count,
      }));

    res.json({ series });
  } catch (err) {
    console.error('super-admin/time-series error:', err);
    res.json({ series: [] });
  }
});

// Mock companies & dealers for local/test (no DB entities for company/dealer)
app.get('/api/admin/super-admin/mock-entities', async (req, res) => {
  try {
    const isLocalhost = /localhost|127\.0\.0\.1/.test(req.get('host') || req.get('origin') || '');
    const useMock = !!(isLocalhost || config.allowDevAdmin || process.env.NODE_ENV !== 'production' || req.query.mock === '1');
    const companies = useMock
      ? [
          { id: 'corp-1', name: 'Компания Север', autodealers: 4, avgAiScore: 82.4, answerRate: 78, lastAudit: new Date(Date.now() - 86400000).toISOString().slice(0, 10), trend: 1 },
          { id: 'corp-2', name: 'Drive Group', autodealers: 3, avgAiScore: 75.1, answerRate: 71, lastAudit: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), trend: -1 },
          { id: 'corp-3', name: 'МоторСервис', autodealers: 5, avgAiScore: 88.2, answerRate: 85, lastAudit: new Date().toISOString().slice(0, 10), trend: 1 },
          { id: 'corp-4', name: 'Авто Плюс', autodealers: 2, avgAiScore: 69.3, answerRate: 62, lastAudit: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), trend: 0 },
          { id: 'corp-5', name: 'КарДилер', autodealers: 6, avgAiScore: 79.5, answerRate: 74, lastAudit: new Date(Date.now() - 86400000).toISOString().slice(0, 10), trend: -1 },
        ]
      : [];
    const dealers = useMock
      ? getDealershipDirectory().map((d, idx) => ({
          id: d.id,
          name: d.name,
          city: d.city,
          avgScore: [84.2, 79.3, 87.6, 52.1, 91.2][idx] ?? 75,
          audits: [24, 18, 31, 12, 40][idx] ?? 15,
          bestEmployee: ['Иван П.', 'Мария К.', 'Алексей В.', 'Ольга С.', 'Дмитрий Л.'][idx] ?? '—',
          worstMetric: ['—', 'Answer time', '—', 'Script adherence', '—'][idx] ?? '—',
          workStartHour: d.workStartHour,
          workEndHour: d.workEndHour,
        }))
      : [];
    res.json({ companies, dealers });
  } catch (err) {
    console.error('super-admin/mock-entities error:', err);
    res.json({ companies: [], dealers: [] });
  }
});

// Settings (view-only): scripts count, phones count, language, telephony
app.get('/api/admin/super-admin/settings', async (_req, res) => {
  try {
    const [testCount, phoneResult] = await Promise.all([
      prisma.test.count(),
      prisma.voiceCallSession.findMany({ select: { to: true } }).then((sessions) => {
        const distinct = new Set(sessions.map((s) => s.to));
        return distinct.size;
      }),
    ]);
    res.json({
      totalScripts: testCount,
      totalPhones: phoneResult,
      platformLanguage: 'RU / KZ',
      telephonyProvider: 'Voximplant',
    });
  } catch (err) {
    console.error('super-admin/settings error:', err);
    res.json({
      totalScripts: 0,
      totalPhones: 0,
      platformLanguage: 'RU / KZ',
      telephonyProvider: '—',
    });
  }
});

// Fallback: for any non-API GET request, serve Mini App (so /index.html etc. work)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  if (INDEX_HTML_PATH) {
    try {
      return sendIndexHtml(res);
    } catch (err) {
      console.error('Error sending index.html (fallback):', err);
    }
  }
  next();
});

// Final 404: friendly message instead of plain "Not Found"
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Маршрут не найден', path: req.path });
  }
  if (req.path.startsWith('/webhooks/')) {
    return res.status(404).json({ error: 'Webhook route not found', path: req.path });
  }
  sendErrorHtml(
    res,
    404,
    'Страница не найдена',
    `Запрошенный адрес «${req.path}» не найден. Mini App открывается по корневому адресу (/) — проверьте URL в настройках бота.`
  );
});

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Try multiple paths for certificates (dev and production)
    const possibleCertPaths = [
      path.join(process.cwd(), 'cert.pem'),
      path.join(__dirname, '../../cert.pem'),
      path.join(__dirname, '../cert.pem'),
    ];
    const possibleKeyPaths = [
      path.join(process.cwd(), 'key.pem'),
      path.join(__dirname, '../../key.pem'),
      path.join(__dirname, '../key.pem'),
    ];

    let certPath: string | null = null;
    let keyPath: string | null = null;

    for (const cp of possibleCertPaths) {
      if (fs.existsSync(cp)) {
        certPath = cp;
        break;
      }
    }

    for (const kp of possibleKeyPaths) {
      if (fs.existsSync(kp)) {
        keyPath = kp;
        break;
      }
    }

    // For tunnel (Cloudflare), always use HTTP - tunnel provides HTTPS
    // When miniAppUrl is localhost, always use HTTP so the site loads in browser immediately
    const useTunnel = config.miniAppUrl.includes('trycloudflare.com') || config.miniAppUrl.includes('loca.lt') || config.miniAppUrl.includes('localtunnel.me') || config.miniAppUrl.includes('serveo') || config.miniAppUrl.includes('lhr.life');
    const isLocalhost = config.miniAppUrl.includes('localhost') || config.miniAppUrl.includes('127.0.0.1');
    const useHttp = useTunnel || isLocalhost || !certPath || !keyPath || !config.miniAppUrl.startsWith('https://');

    const onListen = () => {
      startCallBatchOrchestrator();
      startCallPlanScheduler();
      startImportScheduler();
      resolve();
    };

    const host = '0.0.0.0'; // listen on all interfaces (Railway requires this)
    const port = parseInt(process.env.PORT || String(config.port), 10);

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error('[ERROR] Port ' + port + ' is already in use.');
        console.error('        Stop the other process or use another port: PORT=3002 npm run dev');
      } else {
        console.error('[ERROR] Server error:', err);
      }
      reject(err);
    };

    function attachVoiceStream(server: http.Server | https.Server): void {
      const wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (ws, _req) => {
        console.log('[voice/stream] Client connected, waiting for message');
        ws.on('message', (data: Buffer | string) => {
          handleVoiceStreamMessage(ws, data.toString());
        });
      });
      server.on('upgrade', (request, socket, head) => {
        if (request.url?.startsWith('/voice/stream')) {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      });
    }

    if (!useHttp && certPath && keyPath) {
      const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
      const httpsServer = https.createServer(options, app);
      attachVoiceStream(httpsServer);
      httpsServer.on('error', onError);
      httpsServer.listen(port, host, () => {
        console.log('[OK] HTTPS server: http://localhost:' + port);
        console.log('     Mini App URL: ' + config.miniAppUrl);
        console.log('     (Self-signed cert - Telegram may show warning)');
        onListen();
      });
    } else {
      const httpServer = http.createServer(app);
      attachVoiceStream(httpServer);
      httpServer.on('error', onError);
      httpServer.listen(port, host, () => {
        const voiceUrls = resolveVoiceCallUrls();
        console.log('[OK] HTTP server: http://localhost:' + port);
        console.log('     Open in browser: http://localhost:' + port);
        console.log('     Health: http://localhost:' + port + '/health');
        console.log('     Voice stream: ws://localhost:' + port + '/voice/stream');
        console.log('     Vox webhook event_url: ' + (voiceUrls.eventUrl || '(not resolved)'));
        if (useTunnel) {
          console.log('     Tunnel will provide HTTPS for Telegram.');
        }
        onListen();
      });
    }
  });
}
