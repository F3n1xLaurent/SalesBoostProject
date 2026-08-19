/**
 * Admin panel API — uses existing endpoints + panel-specific routes.
 * No backend schema changes; mock entities for local/test.
 */
import { apiFetch } from '../../entities/session';

const API_BASE = '';

function relabelHoldingError(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  return message
    .replace(/\u0425\u043e\u043b\u0434\u0438\u043d\u0433\u0438/g, 'Компании')
    .replace(/\u0445\u043e\u043b\u0434\u0438\u043d\u0433\u0438/g, 'компании')
    .replace(/\u0425\u043e\u043b\u0434\u0438\u043d\u0433\u043e\u0432/g, 'Компаний')
    .replace(/\u0445\u043e\u043b\u0434\u0438\u043d\u0433\u043e\u0432/g, 'компаний')
    .replace(/\u0425\u043e\u043b\u0434\u0438\u043d\u0433\u0430/g, 'Компании')
    .replace(/\u0445\u043e\u043b\u0434\u0438\u043d\u0433\u0430/g, 'компании')
    .replace(/\u0425\u043e\u043b\u0434\u0438\u043d\u0433\u043e\u043c/g, 'Компанией')
    .replace(/\u0445\u043e\u043b\u0434\u0438\u043d\u0433\u043e\u043c/g, 'компанией')
    .replace(/\u0425\u043e\u043b\u0434\u0438\u043d\u0433/g, 'Компания')
    .replace(/\u0445\u043e\u043b\u0434\u0438\u043d\u0433/g, 'компанию');
}

function relabelDealershipError(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  return message
    .replace(/\u0410\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u044b/g, 'Точки')
    .replace(/\u0430\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u044b/g, 'точки')
    .replace(/\u0410\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u043e\u0432/g, 'Точек')
    .replace(/\u0430\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u043e\u0432/g, 'точек')
    .replace(/\u0410\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u0430/g, 'Точки')
    .replace(/\u0430\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u0430/g, 'точки')
    .replace(/\u0410\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u043e\u043c/g, 'Точкой')
    .replace(/\u0430\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d\u043e\u043c/g, 'точкой')
    .replace(/\u0410\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d/g, 'Точка')
    .replace(/\u0430\u0432\u0442\u043e\u0441\u0430\u043b\u043e\u043d/g, 'точку');
}

export interface PlatformSummary {
  totalAttempts: number;
  avgScore: number;
  levelCounts: { Junior: number; Middle: number; Senior: number };
  topWeaknesses: { weakness: string; count: number }[];
  topStrengths?: { strength: string; count: number }[];
  expertSummary?: string | null;
}

export interface PlatformVoice {
  totalCalls: number;
  answeredPercent: number;
  missedPercent: number;
  avgDurationSec: number;
  outcomeBreakdown?: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
}

export interface DashboardDealershipRow {
  id: string;
  name: string;
  managersCount: number;
  avgAiScore: number;
  answerRate: number;
  totalAudits: number;
  avgDurationSec: number;
  lastAudit: string | null;
  trend: number;
}

export interface DashboardOverview {
  aiSummary?: AnalyticsAISummary;
  avgScore: number;
  totalAudits: number;
  totalDealerships: number;
  totalEmployees: number;
  answerRate: number;
  totalCalls: number;
  timeSeries: TimeSeriesPoint[];
  hourlyAnswerRate: number[];
  answerTimeByCompany: { id: string; name: string; avgSec: number; totalCalls: number }[];
  topDealerships: DashboardDealershipRow[];
  lowDealerships: DashboardDealershipRow[];
  topEmployees: DashboardEmployeeRatingRow[];
  lowEmployees: DashboardEmployeeRatingRow[];
  topWeakness: { weakness: string; count: number } | null;
  riskLabel: string | null;
}

export interface DashboardEmployeeRatingRow {
  id: string;
  name: string;
  auditsCount: number;
  aiRating: number;
}

export interface AuditItem {
  id: string;
  type: 'attempt' | 'training' | 'trainer' | 'call';
  company: string;
  dealer: string;
  holdingId?: string | null;
  dealershipId?: string | null;
  dealershipName?: string | null;
  city?: string | null;
  employeeId?: string | null;
  employeeAccountId?: string | null;
  date: string;
  aiScore: number | null;
  status: 'Good' | 'Medium' | 'Bad';
  auditStatus?: 'completed' | 'failed' | 'interrupted';
  durationSec?: number | null;
  outcome?: string | null;
  answerTimeSec?: number | null;
  phoneNumberId?: string | null;
  phoneNumberTypeId?: string | null;
  phoneNumberTypeName?: string | null;
  phoneNumber?: string | null;
  verdict?: string | null;
  communicationFlag?: 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';
  reportIssues?: string[];
  userName: string | null;
  detailId: number | string;
  detailType: 'attempt' | 'training' | 'trainer' | 'call';
}

export interface CallReportProblemItem {
  code: string;
  title: string;
  category: string;
  sortOrder: number;
}

export interface AuditDetailItem {
  id: string;
  type: 'trainer' | 'call';
  dateTime: string;
  employeeId: string;
  employeeName: string;
  dealershipId: string;
  dealershipName: string;
  city: string;
  totalScore: number;
  verdict: string;
  status: 'completed' | 'failed' | 'interrupted';
  duration: number;
  communicationFlag: 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';
  blocksBreakdown: { block: string; score: number; hint: string }[];
  checklist: { label: string; result: 'pass' | 'warn' | 'fail'; quote: string }[];
  transcript: { speaker: 'client' | 'manager'; time: string; text: string; critical?: boolean }[];
  events: { time: string; label: string; type: 'info' | 'warning' | 'error' }[];
  errors: { issue: string; percent: number }[];
  topQuestions: string[];
  recommendedTrainings: { title: string; description: string }[];
  answerTimeSec: number | null;
  attempts: number | null;
  callback: boolean | null;
  scenarioName: string | null;
  assignedBy: string | null;
  failReason: string | null;
  unifiedReport: {
    version: 'call-report-v1';
    source: 'call' | 'trainer';
    summary: string;
    totalScore: number;
    verdict: 'Хорошо' | 'Средне' | 'Плохо';
    categories: Array<{ name: 'Контакт' | 'Диагностика' | 'Продукт' | 'Закрытие' | 'Коммуникация'; score: number; comment: string }>;
    strengths: string[];
    weaknesses: string[];
    keyFindings: Array<{
      problemTitle: string;
      importance: 'Критично' | 'Важно' | 'Средне';
      category: 'Контакт' | 'Диагностика' | 'Продукт' | 'Закрытие' | 'Коммуникация';
      quote: string;
      comment: string;
      betterExample: string;
    }>;
    dialog: Array<{
      role: 'client' | 'manager';
      text: string;
      mark: 'positive' | 'normal' | 'negative' | null;
      comment: string | null;
      betterExample?: string | null;
    }>;
    recommendations: Array<{
      text: string;
      category: 'Контакт' | 'Диагностика' | 'Продукт' | 'Закрытие' | 'Коммуникация';
      problemTitle: string | null;
    }>;
  } | null;
}

export interface TimeSeriesPoint {
  date: string;
  avgScore: number;
  count: number;
  ownScore?: number;
  franchiseScore?: number;
  ownCount?: number;
  franchiseCount?: number;
}

export type AnalyticsImpact = 'high' | 'medium' | 'low';
export type AnalyticsPriority = 'P0' | 'P1' | 'P2';

export interface AnalyticsAISummary {
  summary: string;
  recommendations: string[];
  source?: 'generated' | 'fallback' | 'llm';
}

export type RecommendationSignalKind = 'checklist' | 'lagging' | 'trend' | 'source' | 'missed' | 'answer_speed';
export interface RecommendationSignal {
  id: string;
  kind: RecommendationSignalKind;
  scope: 'quick' | 'systemic';
  importance: number;
  entityId?: string;
  entityName?: string;
  entityAccountId?: string;
  problemCode?: string;
  sourceTypeId?: string;
  sourceName?: string;
  phoneNumberId?: string;
  phoneNumber?: string;
  ownership?: 'dealership' | 'user';
  metrics: Record<string, number>;
}
export interface RecommendationResult {
  state: 'insufficient_data' | 'normal' | 'findings';
  evaluatedCalls: number;
  minimumCalls: number;
  quick: RecommendationSignal[];
  systemic: RecommendationSignal[];
  growthPoint: RecommendationSignal | null;
}
export interface RecommendationsResponse {
  entity: { id: string; name: string; level: 'holding' | 'dealership' | 'user' };
  recommendations: RecommendationResult;
}

export interface AnalyticsSectionInsight {
  fact: string;
  interpretation: string;
  action: string;
  stable?: boolean;
}

export interface AnalyticsOverview {
  aiSummary?: AnalyticsAISummary;
  keyInsights: Array<{
    fact: string;
    interpretation: string;
    impact: AnalyticsImpact;
    delta?: string;
  }>;
  actions: Array<{
    priority: AnalyticsPriority;
    target: string;
    action: string;
    reason: string;
    expectedEffect: string;
    drillType?: 'employees' | 'dealership' | 'audits';
    drillFilter?: string;
  }>;
  errorsInsight: AnalyticsSectionInsight;
  commInsight: AnalyticsSectionInsight;
  scriptInsight: AnalyticsSectionInsight;
  trendInsight: AnalyticsSectionInsight;
  avgScore: number;
  totalAudits: number;
  failRate: number;
  commBreakdown: { label: string; percent: number; color: string }[];
  topErrors: { error: string; count: number; percent: number }[];
  timeSeries?: TimeSeriesPoint[];
  weeklyTypeTrend?: { week: string; ownScore: number; franchiseScore: number; ownCount: number; franchiseCount: number }[];
  typeCategoryComparison?: { category: string; ownScore: number; franchiseScore: number }[];
  phoneNumberTypeComparison?: { id: string; name: string; ownership: string; calls: number; noAnswers: number; score: number; delta: number; trend: number | null }[];
  typeTopErrors?: {
    own: { issue: string; count: number; percent: number }[];
    franchise: { issue: string; count: number; percent: number }[];
  };
  leadersLaggards?: {
    leadersErrors: { issue: string; count: number; percent: number }[];
    laggardsErrors: { issue: string; count: number; percent: number }[];
    leadersQuestions: { question: string; count: number; percent: number }[];
    laggardsQuestions: { question: string; count: number; percent: number }[];
  };
  dealershipComparison: { id?: string; name: string; score: number; delta: number }[];
  dealershipTimeSeries?: { id: string; name: string; points: TimeSeriesPoint[] }[];
  dealershipRows?: Array<{
    id: string;
    name: string;
    dealer: string;
    type: DealershipType;
    city: string | null;
    score: number;
    delta: number;
    calls: number;
    noAnswers: number;
  }>;
  holdingRows?: Array<{
    id: string;
    name: string;
    type: HoldingType;
    dealershipsCount: number;
    score: number;
    calls: number;
    noAnswers: number;
    lowDealerships: number;
  }>;
  scriptCompliance: { block: string; rate: number }[];
  meta?: {
    linkedCalls: number;
    scoredCalls: number;
    ignoredUnlinkedCalls: number;
  };
}

export type AnalyticsDealershipStatus = 'norm' | 'risk' | 'critical' | 'no-data';

export interface AnalyticsDealershipRow {
  id: string;
  name: string;
  city: string;
  type: DealershipType;
  dealer: string;
  aiRating: number;
  answerRate: number | null;
  avgAnswerTimeSec: number | null;
  avgCallDurationSec?: number | null;
  auditsCount: number;
  employeesCount: number;
  deltaRating: number | null;
  status: AnalyticsDealershipStatus;
}

export interface AnalyticsHoldingRow {
  id: string;
  name: string;
  type: HoldingType;
  dealershipsCount: number;
  avgScore: number;
  calls: number;
  noAnswers: number;
  lowDealerships: number;
  topProblem: string | null;
}

export interface AnalyticsHoldingDealershipRow {
  id: string;
  name: string;
  dealer: string;
  type: DealershipType;
  city: string;
  score: number;
  delta: number;
  calls: number;
  noAnswers: number;
  employeesCount: number;
  status: AnalyticsDealershipStatus;
}

export interface HoldingActivityPoint {
  key: string;
  label: string;
  totalCalls: number;
  missedCalls: number;
  avgScore: number | null;
}

export interface AnalyticsHoldingDetail extends AnalyticsHoldingRow {
  aiSummary?: AnalyticsAISummary;
  dealershipRows: AnalyticsHoldingDealershipRow[];
  timeSeries: { date: string; avgScore: number; count: number }[];
  activitySeries?: {
    month: HoldingActivityPoint[];
    all: HoldingActivityPoint[];
  };
  dealershipActivitySeries?: Array<{
    id: string;
    name: string;
    series: {
      month: HoldingActivityPoint[];
      all: HoldingActivityPoint[];
    };
  }>;
  topIssues: { issue: string; percent: number }[];
  scriptCompliance: { block: string; rate: number }[];
  audits: Array<{
    id: string;
    date: string;
    type: 'training' | 'trainer' | 'call';
    employeeName: string;
    dealershipName: string;
    score: number;
    verdict?: string;
  }>;
  meta?: {
    linkedCalls: number;
    scoredCalls: number;
  };
}

export interface AnalyticsDealershipDetail extends AnalyticsDealershipRow {
  aiSummary?: AnalyticsAISummary;
  noAnswers?: number;
  outcomeBreakdown?: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
  communicationBreakdown?: { label: string; percent: number; color: string }[];
  scriptCompliance?: { block: string; rate: number; hint?: string }[];
  employees: Array<{
    id: string;
    name: string;
    aiRating: number;
    auditsCount: number;
    typicalError: string;
    status: string;
  }>;
  audits: Array<{
    id: string;
    date: string;
    type: 'training' | 'trainer' | 'call';
    employeeName: string;
    score: number;
    verdict?: string;
  }>;
  timeSeries: { date: string; avgScore: number; count: number }[];
  activitySeries?: {
    month: HoldingActivityPoint[];
    all: HoldingActivityPoint[];
  };
  hourlyAnswerRate: number[];
  topIssues: { issue: string; percent: number }[];
  topQuestions: string[];
  recommendedTrainings: { title: string; description: string }[];
}

export interface AnalyticsManagerDetail {
  id: string;
  accountId?: string | null;
  fullName: string;
  dealershipId: string;
  dealershipName: string;
  city: string;
  aiRating: number;
  deltaRating: number | null;
  answerRate?: number | null;
  auditsCount: number;
  failsCount: number;
  noAnswers?: number;
  noAnswerRate?: number;
  directCalls?: number;
  dealershipCalls?: number;
  dealershipRank?: { rank: number; total: number } | null;
  outcomeBreakdown?: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
  communicationBreakdown?: { label: string; percent: number; color: string }[];
  communicationFlag: 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';
  topMistakeLabel: string;
  status: AnalyticsDealershipStatus;
  aiSummary?: AnalyticsAISummary;
  strengths: string[];
  growthAreas: string[];
  trainingFocus: string;
  timeSeries: { date: string; avgScore: number; count: number }[];
  comparisonTimeSeries?: { date: string; managerScore: number; dealershipScore: number; networkScore: number }[];
  blockBreakdown: { block: string; score: number; hint: string }[];
  topIssues: { issue: string; percent: number }[];
  topQuestions: string[];
  recommendedTrainings: { title: string; description: string }[];
  audits: Array<{ id: string; date: string; type: 'training' | 'trainer' | 'call'; score: number; verdict: string; outcome?: string | null }>;
  noAnswerHistory?: Array<{ id: string; date: string; planName: string | null; verdict: string }>;
  trainer?: {
    totalPoints: number;
    currentStreak: number;
    longestStreak: number;
    sessionsTotal: number;
    sessions30d: number;
    avgScore: number;
    weeklyScore: { date: string; avgScore: number; count: number }[];
    weakPatterns: { issue: string; percent: number }[];
    history: Array<{ id: string; date: string; type: 'plan' | 'free' | string; scenarioName: string; score: number | null; finalPoints: number | null; status: string }>;
  };
}

export interface AnalyticsManagerRow {
  id: string;
  accountId?: string | null;
  fullName: string;
  dealershipId: string;
  dealershipName: string;
  city: string;
  aiRating: number;
  deltaRating: number | null;
  auditsCount: number;
  failsCount: number;
  communicationFlag: 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';
  topMistakeLabel: string;
  status: AnalyticsDealershipStatus;
  dataState: 'full' | 'partial' | 'none';
  directCalls: number;
  dealershipCalls: number;
}

export interface MockCompany {
  id: string;
  name: string;
  autodealers: number;
  avgAiScore: number;
  answerRate: number;
  lastAudit: string;
  trend: number;
}

export interface MockDealer {
  id: string;
  name: string;
  city: string;
  avgScore: number;
  audits: number;
  bestEmployee: string;
  worstMetric: string;
}

export interface SuperAdminSettings {
  totalScripts: number;
  totalPhones: number;
  platformLanguage: string;
  telephonyProvider: string;
}

export type AdminPanelSettings = SuperAdminSettings;

export interface RbacPermissionDefinition {
  key: string;
  description: string;
  scopes: string[];
}

export interface RbacMeta {
  roles: string[];
  permissions: RbacPermissionDefinition[];
  holdings: Array<{ id: string; name: string }>;
  dealerships: Array<{ id: string; name: string; holdingId: string | null; holdingName: string | null }>;
  permissionTemplates: PermissionTemplateItem[];
  canManageTemplates: boolean;
}

export type HoldingType = 'own' | 'franchised';
export type DealershipType = 'own' | 'franchised';
export type DealershipDirection = string;

export interface HoldingItem {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  type: HoldingType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  dealershipsCount: number;
  dealerships: Array<{
    id: string;
    name: string;
    code: string | null;
    city: string | null;
    address: string | null;
    workingHoursFrom: string | null;
    workingHoursTo: string | null;
    isActive: boolean;
    holdingId: string | null;
  }>;
}

export interface DealershipItem {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  type: DealershipType;
  directions: DealershipDirection[];
  city: string | null;
  address: string | null;
  workingHoursFrom: string | null;
  workingHoursTo: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  holdingId: string | null;
  holdingName: string | null;
  managersCount: number;
}

export interface DealershipDirectionItem {
  id: string;
  holdingId: string;
  holdingName: string;
  name: string;
  code: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionTemplateItem {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  assignedAccountsCount: number;
  isSystem: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserAccountItem {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  memberships: Array<{
    id: string;
    role: string;
    holdingId: string | null;
    holdingName: string | null;
    dealershipId: string | null;
    dealershipName: string | null;
    dealershipType: DealershipType | null;
    scopeLabel: string;
  }>;
  managerProfiles: Array<{
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    status: string;
    dealershipId: string;
    dealershipName: string;
    dealershipType: DealershipType;
    holdingId: string | null;
    holdingName: string | null;
  }>;
  phoneNumbers: PhoneNumberItem[];
  permissionTemplates: Array<{
    id: string;
    name: string;
    description: string | null;
    permissions: string[];
  }>;
  analytics: {
    aiRating: number;
    deltaRating: number | null;
    auditsCount: number;
    failsCount: number;
    communicationFlag: 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';
    topMistakeLabel: string;
    status: 'norm' | 'risk' | 'critical' | 'no-data';
  };
}

export interface CallBatchListItem {
  id: string;
  mode: 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily';
  status: 'running' | 'paused' | 'cancelled' | 'completed';
  title: string | null;
  totalJobs: number;
  queuedJobs: number;
  inProgressJobs: number;
  completedJobs: number;
  failedJobs: number;
  retryingJobs: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CallBatchJobItem {
  id: string;
  dealershipId: string | null;
  dealershipName: string | null;
  phone: string;
  status: 'queued' | 'dialing' | 'in_progress' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  endedAt: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  linkedAuditId?: string | null;
  hasTranscript?: boolean;
  linkReason?: string | null;
}

export type CustomerTemperament = 'calm' | 'doubtful' | 'irritated' | 'hurried';
export type CustomerPatience = 'low' | 'medium' | 'high';
export type ReplyLength = 'short' | 'medium' | 'detailed';

export interface CallCustomerProfileItem {
  id: string;
  holdingId: string;
  name: string;
  voiceId: string;
  age: number;
  ageFrom: number;
  ageTo: number;
  character: string;
  temperament: CustomerTemperament;
  patience: CustomerPatience;
  replyLength: ReplyLength;
  communicationStyle: string;
  createdAt: string;
  updatedAt: string;
}

export interface CallCustomerVoiceItem {
  id: string;
  name: string;
  elevenLabsCode: string | null;
  openaiCode: string | null;
  isEnabled: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CallScriptObjection {
  id: string;
  phrase: string;
  whenAppropriate: string;
}

export interface CallScriptQuestion {
  id: string;
  text: string;
  required: boolean;
}

export interface CallScriptSuccessCriterion {
  id: string;
  sourceType: 'question' | 'objection';
  sourceId: string;
  expectedAnswer: string;
  score: number;
}

export interface CallScriptDataCondition {
  holdingId: string | null;
  tags: string[];
}

export interface CallScriptItem {
  id: string;
  holdingId: string;
  name: string;
  profileIds: string[];
  context: string;
  dataCondition: CallScriptDataCondition;
  objections: CallScriptObjection[];
  questions: CallScriptQuestion[];
  successCriteria: CallScriptSuccessCriterion[];
  createdAt: string;
  updatedAt: string;
}

export type CallPlanTargetType = 'employees' | 'dealerships';
export type CallPlanFrequency = 'manual' | 'daily' | 'weekly';
export type CallPlanWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CallPlanItem {
  id: string;
  holdingId: string;
  name: string;
  targetType: CallPlanTargetType;
  targetIds: string[];
  scriptId: string;
  phoneNumberTypeId: string;
  frequency: CallPlanFrequency;
  weekdays: CallPlanWeekday[];
  callTimeFrom: string;
  callTimeTo: string;
  timezoneOffsetMinutes: number;
  lastInitiatedAt: string | null;
  lastBatchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsPlanParticipation {
  id: string;
  name: string;
  targetType: CallPlanTargetType;
  targetMatch: 'dealership' | 'employees';
  targetsCount: number;
  frequency: CallPlanFrequency;
  callTimeFrom: string;
  callTimeTo: string;
  lastInitiatedAt: string | null;
}

export interface CallPlanEmployeeOption {
  id: string;
  accountId: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  dealershipId: string;
  dealershipName: string;
  phoneNumbers: Array<{ id: string; typeId: string; typeName: string; phone: string }>;
}

export interface CallPlanDealershipOption {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  employeesCount: number;
}

export interface CallPlanOptions {
  employees: CallPlanEmployeeOption[];
  dealerships: CallPlanDealershipOption[];
  phoneNumberTypes: PhoneNumberTypeItem[];
  scripts: CallScriptItem[];
}

export interface CallPlanPromptPreview {
  prompt: string;
  profile: CallCustomerProfileItem | null;
  importedItem: {
    id: string;
    title: string;
    description: string;
    tags: string[];
  } | null;
  script: CallScriptItem;
}

export interface CallPlanCallItem {
  id: string;
  auditId: string | null;
  planId: string;
  callId: string;
  employeeId: string | null;
  employeeName: string | null;
  dealershipId: string | null;
  dealershipName: string | null;
  phone: string;
  phoneNumberTypeId: string;
  scriptId: string;
  profileId: string | null;
  importedItemId: string | null;
  status: string;
  outcome: string | null;
  scheduledAt: string | null;
  startedAt: string;
  endedAt: string | null;
  answerTimeSec: number | null;
  talkDurationSec: number | null;
  transcript: Array<{ role: 'manager' | 'client'; text: string }>;
  evaluation: unknown | null;
  totalScore: number | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PhoneNumberOwnership = 'dealership' | 'user';

export interface PhoneNumberTypeItem {
  id: string;
  holdingId: string | null;
  name: string;
  ownership: PhoneNumberOwnership;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PhoneNumberItem {
  id: string;
  typeId: string;
  typeName: string;
  phone: string;
  dealershipId: string | null;
  accountId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  totalCalls: number;
  successfulCalls: number;
  missedCalls: number;
}

export type ImportFormat = 'json' | 'xml' | 'csv';
export type ImportStatus = 'active' | 'paused' | 'error';
export type ImportSchedule = 'manual' | 'hourly' | 'daily' | 'weekly' | 'custom';
export type ImportTagOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'exists'
  | 'notExists'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterOrEqual'
  | 'lessOrEqual'
  | 'in'
  | 'regex';

export interface ImportAIConfig {
  entityType: string;
  externalIdField: string | null;
  titleFields: string[];
  descriptionFields: string[];
  fieldLabels: Record<string, string>;
  importantFields: string[];
  ignoredFields: string[];
}

export interface ImportTagRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: {
    field: string;
    operator: ImportTagOperator;
    value?: unknown;
  };
}

export interface ImportPreviewItem {
  title: string;
  description: string;
  tags: string[];
}

export interface ImportAnalyzeResult {
  format: ImportFormat;
  itemsPath: string;
  sampleItems: unknown[];
  aiConfig: ImportAIConfig;
  previewItems: ImportPreviewItem[];
}

export interface ImportSourceItem {
  id: string;
  holdingId: string | null;
  holdingName: string | null;
  name: string;
  url: string;
  format: ImportFormat;
  status: ImportStatus;
  schedule: string | null;
  itemsPath: string;
  entityType: string;
  aiConfig: ImportAIConfig;
  tagRules: ImportTagRule[];
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  itemsCount: number;
  activeRun: ImportRunItem | null;
}

export interface ImportedItem {
  id: string;
  importSourceId: string;
  externalId: string | null;
  title: string;
  description: string;
  rawData: unknown;
  normalizedData: Record<string, unknown>;
  tags: string[];
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImportedDataItem extends ImportedItem {
  importSourceName: string;
  importSourceFormat: ImportFormat;
  holdingId: string | null;
  holdingName: string | null;
}

export interface ImportedItemsResult {
  items: ImportedDataItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ImportRunItem {
  id: string;
  importSourceId: string;
  status: 'success' | 'error' | 'running' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  totalItems: number;
  createdItems: number;
  updatedItems: number;
  skippedItems: number;
  errorMessage: string | null;
}

export async function fetchSummary(): Promise<PlatformSummary | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/summary`);
  if (!res.ok) return null;
  const data = await res.json();
  return data as PlatformSummary;
}

export async function fetchDashboardOverview(filters?: {
  holdingId?: string | null;
  directionId?: string | null;
  dealershipType?: 'own' | 'franchised' | null;
}): Promise<DashboardOverview | null> {
  const params = new URLSearchParams();
  if (filters?.holdingId) params.set('holdingId', filters.holdingId);
  if (filters?.directionId) params.set('directionId', filters.directionId);
  if (filters?.dealershipType) params.set('dealershipType', filters.dealershipType);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/dashboard/overview${suffix}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return null;
  return await res.json() as DashboardOverview;
}

export async function analyzeImportSource(url: string): Promise<ImportAnalyzeResult> {
  const res = await apiFetch(`${API_BASE}/api/imports/analyze-source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось проанализировать источник.');
  return data as ImportAnalyzeResult;
}

export async function generateImportTagRule(payload: {
  text: string;
  availableFields: string[];
}): Promise<Omit<ImportTagRule, 'id'>> {
  const res = await apiFetch(`${API_BASE}/api/imports/generate-tag-rule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось сформировать правило.');
  return data as Omit<ImportTagRule, 'id'>;
}

export async function generateImportTagRules(payload: {
  sampleItems: unknown[];
  availableFields: string[];
}): Promise<ImportTagRule[]> {
  const res = await apiFetch(`${API_BASE}/api/imports/generate-tag-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось сформировать правила.');
  return Array.isArray(data.rules) ? data.rules as ImportTagRule[] : [];
}

export async function testImportTagRules(payload: {
  sampleItems: unknown[];
  tagRules: ImportTagRule[];
}): Promise<Array<{ item: unknown; tags: string[] }>> {
  const res = await apiFetch(`${API_BASE}/api/imports/test-tag-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось протестировать правила тегов.');
  return Array.isArray(data.items) ? data.items as Array<{ item: unknown; tags: string[] }> : [];
}

export async function previewImportConfig(payload: {
  sampleItems: unknown[];
  aiConfig: ImportAIConfig;
  tagRules: ImportTagRule[];
}): Promise<ImportPreviewItem[]> {
  const res = await apiFetch(`${API_BASE}/api/imports/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось построить preview.');
  return Array.isArray(data.previewItems) ? data.previewItems as ImportPreviewItem[] : [];
}

export async function fetchImports(params?: { holdingId?: string | null }): Promise<ImportSourceItem[]> {
  const query = new URLSearchParams();
  if (params?.holdingId) query.set('holdingId', params.holdingId);
  const res = await apiFetch(`${API_BASE}/api/imports${query.toString() ? `?${query.toString()}` : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить импорты.');
  return Array.isArray(data.items) ? data.items as ImportSourceItem[] : [];
}

export async function fetchImportedItems(params?: {
  limit?: number;
  offset?: number;
  sourceId?: string | null;
  sourceIds?: string[];
  holdingId?: string | null;
  search?: string;
  tags?: string[];
}): Promise<ImportedItemsResult> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset != null) query.set('offset', String(params.offset));
  if (params?.sourceIds?.length) query.set('sourceIds', params.sourceIds.join(','));
  else if (params?.sourceId) query.set('sourceId', params.sourceId);
  if (params?.holdingId) query.set('holdingId', params.holdingId);
  if (params?.search?.trim()) query.set('search', params.search.trim());
  if (params?.tags?.length) query.set('tags', params.tags.join(','));
  const res = await apiFetch(`${API_BASE}/api/imported-items${query.toString() ? `?${query.toString()}` : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить данные.');
  return {
    items: Array.isArray(data.items) ? data.items as ImportedDataItem[] : [],
    total: typeof data.total === 'number' ? data.total : 0,
    limit: typeof data.limit === 'number' ? data.limit : params?.limit ?? 25,
    offset: typeof data.offset === 'number' ? data.offset : params?.offset ?? 0,
  };
}

export async function fetchImportedTags(params?: { holdingId?: string | null }): Promise<string[]> {
  const query = new URLSearchParams();
  if (params?.holdingId) query.set('holdingId', params.holdingId);
  const res = await apiFetch(`${API_BASE}/api/imported-items/tags${query.toString() ? `?${query.toString()}` : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить теги.');
  return Array.isArray(data.tags) ? data.tags as string[] : [];
}

export async function fetchImportDetail(id: string): Promise<{
  item: ImportSourceItem;
  importedItems: ImportedItem[];
  runs: ImportRunItem[];
}> {
  const res = await apiFetch(`${API_BASE}/api/imports/${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить импорт.');
  return data;
}

export async function createImportSource(payload: {
  holdingId: string;
  name: string;
  url: string;
  format: ImportFormat;
  schedule: string | null;
  itemsPath: string;
  aiConfig: ImportAIConfig;
  tagRules: ImportTagRule[];
}): Promise<ImportSourceItem> {
  const res = await apiFetch(`${API_BASE}/api/imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать импорт.');
  return data.item as ImportSourceItem;
}

export async function updateImportSource(id: string, payload: Partial<Pick<ImportSourceItem, 'holdingId' | 'name' | 'url' | 'status' | 'schedule' | 'aiConfig' | 'tagRules'>>): Promise<ImportSourceItem> {
  const res = await apiFetch(`${API_BASE}/api/imports/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить импорт.');
  return data.item as ImportSourceItem;
}

export async function deleteImportSource(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/imports/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить импорт.');
}

export async function runImportSource(id: string, options?: { signal?: AbortSignal }): Promise<ImportRunItem> {
  const res = await apiFetch(`${API_BASE}/api/imports/${id}/run`, { method: 'POST', signal: options?.signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось запустить импорт.');
  return data.run as ImportRunItem;
}

export async function cancelImportSource(id: string): Promise<ImportRunItem | null> {
  const res = await apiFetch(`${API_BASE}/api/imports/${id}/cancel`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось остановить загрузку.');
  return (data.run ?? null) as ImportRunItem | null;
}

export async function fetchHoldings(filters?: {
  search?: string;
  type?: 'all' | HoldingType;
  status?: 'all' | 'active' | 'inactive';
}): Promise<HoldingItem[]> {
  const params = new URLSearchParams();
  const search = filters?.search?.trim();
  if (search) params.set('search', search);
  if (filters?.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters?.status && filters.status !== 'all') params.set('status', filters.status);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/holdings${suffix}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchDealerships(): Promise<DealershipItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchDealershipDirections(filters?: {
  holdingId?: string | null;
  active?: boolean;
}): Promise<DealershipDirectionItem[]> {
  const params = new URLSearchParams();
  if (filters?.holdingId) params.set('holdingId', filters.holdingId);
  if (filters?.active) params.set('active', 'true');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-directions${suffix}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить направления точек.');
  return Array.isArray(data.items) ? data.items as DealershipDirectionItem[] : [];
}

export async function createDealershipDirection(payload: {
  holdingId: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
}): Promise<DealershipDirectionItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-directions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать направление точки.');
  return data.item as DealershipDirectionItem;
}

export async function updateDealershipDirection(
  directionId: string,
  payload: {
    name?: string;
    code?: string | null;
    isActive?: boolean;
  },
): Promise<DealershipDirectionItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-directions/${directionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить направление точки.');
  return data.item as DealershipDirectionItem;
}

export async function deleteDealershipDirection(directionId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-directions/${directionId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить направление точки.');
}

export async function fetchCities(params?: { search?: string; limit?: number; offset?: number }): Promise<{ items: string[]; hasMore: boolean; offset: number; limit: number }> {
  const query = new URLSearchParams();
  const search = params?.search?.trim();
  query.set('limit', String(params?.limit ?? 100));
  query.set('offset', String(params?.offset ?? 0));
  if (search) query.set('search', search);

  const res = await apiFetch(`${API_BASE}/api/admin/cities?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить города.');
  return {
    items: Array.isArray(data.items) ? data.items : [],
    hasMore: Boolean(data.hasMore),
    offset: typeof data.offset === 'number' ? data.offset : params?.offset ?? 0,
    limit: typeof data.limit === 'number' ? data.limit : params?.limit ?? 100,
  };
}

export async function createHolding(payload: {
  name: string;
  description?: string | null;
  type?: HoldingType;
  code?: string | null;
  isActive?: boolean;
  dealershipIds?: string[];
}): Promise<HoldingItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/holdings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(relabelHoldingError(data?.error) || 'Не удалось создать компанию.');
  return data.item as HoldingItem;
}

export async function updateHolding(
  holdingId: string,
  payload: {
    name?: string;
    description?: string | null;
    type?: HoldingType;
    code?: string | null;
    isActive?: boolean;
    dealershipIds?: string[];
  },
): Promise<HoldingItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/holdings/${holdingId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(relabelHoldingError(data?.error) || 'Не удалось обновить компанию.');
  return data.item as HoldingItem;
}

export async function deleteHolding(holdingId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/holdings/${holdingId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(relabelHoldingError(data?.error) || 'Не удалось удалить компанию.');
}

export async function createDealership(payload: {
  name: string;
  code?: string | null;
  description?: string | null;
  type?: DealershipType;
  directions?: DealershipDirection[];
  city?: string | null;
  address?: string | null;
  workingHoursFrom: string;
  workingHoursTo: string;
  holdingId?: string | null;
  isActive?: boolean;
}): Promise<DealershipItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(relabelDealershipError(data?.error) || 'Не удалось создать точку.');
  return data.item as DealershipItem;
}

export async function updateDealership(
  dealershipId: string,
  payload: {
    name?: string;
    code?: string | null;
    description?: string | null;
    type?: DealershipType;
    directions?: DealershipDirection[];
    city?: string | null;
    address?: string | null;
    workingHoursFrom?: string;
    workingHoursTo?: string;
    holdingId?: string | null;
    isActive?: boolean;
  },
): Promise<DealershipItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(relabelDealershipError(data?.error) || 'Не удалось обновить точку.');
  return data.item as DealershipItem;
}

export async function deleteDealership(dealershipId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(relabelDealershipError(data?.error) || 'Не удалось удалить точку.');
}

export async function fetchPhoneNumberTypes(filters?: {
  holdingId?: string | null;
  ownership?: PhoneNumberOwnership;
  active?: boolean;
}): Promise<PhoneNumberTypeItem[]> {
  const params = new URLSearchParams();
  if (filters?.holdingId) params.set('holdingId', filters.holdingId);
  if (filters?.ownership) params.set('ownership', filters.ownership);
  if (filters?.active) params.set('active', 'true');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/phone-number-types${suffix}`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as PhoneNumberTypeItem[] : [];
}

export async function createPhoneNumberType(payload: {
  holdingId: string;
  name: string;
  ownership: PhoneNumberOwnership;
  isActive?: boolean;
}): Promise<PhoneNumberTypeItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/phone-number-types`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать тип номера.');
  return data.item as PhoneNumberTypeItem;
}

export async function updatePhoneNumberType(
  typeId: string,
  payload: {
    holdingId?: string;
    name?: string;
    ownership?: PhoneNumberOwnership;
    isActive?: boolean;
  },
): Promise<PhoneNumberTypeItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/phone-number-types/${typeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить тип номера.');
  return data.item as PhoneNumberTypeItem;
}

export async function deletePhoneNumberType(typeId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/phone-number-types/${typeId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить тип номера.');
}

export async function fetchDealershipPhoneNumbers(dealershipId: string): Promise<PhoneNumberItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}/phone-numbers`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as PhoneNumberItem[] : [];
}

export async function createDealershipPhoneNumber(
  dealershipId: string,
  payload: { typeId: string; phone: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}/phone-numbers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось добавить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function updateDealershipPhoneNumber(
  phoneNumberId: string,
  payload: { typeId?: string; phone?: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-phone-numbers/${phoneNumberId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function deleteDealershipPhoneNumber(phoneNumberId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-phone-numbers/${phoneNumberId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить номер телефона.');
}

export async function fetchUserPhoneNumbers(accountId: string): Promise<PhoneNumberItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}/phone-numbers`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as PhoneNumberItem[] : [];
}

export async function createUserPhoneNumber(
  accountId: string,
  payload: { typeId: string; phone: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}/phone-numbers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось добавить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function updateUserPhoneNumber(
  phoneNumberId: string,
  payload: { typeId?: string; phone?: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/user-phone-numbers/${phoneNumberId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function deleteUserPhoneNumber(phoneNumberId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/user-phone-numbers/${phoneNumberId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить номер телефона.');
}

export async function syncMockOrganization(): Promise<{
  holdingsCreated: number;
  dealershipsCreated: number;
  dealershipsUpdated: number;
}> {
  const res = await apiFetch(`${API_BASE}/api/admin/organization/sync-mock`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось синхронизировать моковую структуру.');
  return data.summary ?? { holdingsCreated: 0, dealershipsCreated: 0, dealershipsUpdated: 0 };
}

export async function fetchCallCustomerProfiles(params: { holdingId: string }): Promise<CallCustomerProfileItem[]> {
  const query = new URLSearchParams({ holdingId: params.holdingId });
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-profiles?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить профили клиентов.');
  return Array.isArray(data.items) ? data.items as CallCustomerProfileItem[] : [];
}

export async function fetchCallCustomerVoices(): Promise<CallCustomerVoiceItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-voices`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить голоса клиентов.');
  return Array.isArray(data.items) ? data.items as CallCustomerVoiceItem[] : [];
}

export async function createCallCustomerVoice(payload: Omit<CallCustomerVoiceItem, 'createdAt' | 'updatedAt'>): Promise<CallCustomerVoiceItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-voices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать голос клиента.');
  return data.item as CallCustomerVoiceItem;
}

export async function updateCallCustomerVoice(id: string, payload: Omit<CallCustomerVoiceItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<CallCustomerVoiceItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-voices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить голос клиента.');
  return data.item as CallCustomerVoiceItem;
}

export async function deleteCallCustomerVoice(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить голос клиента.');
}

export async function createCallCustomerProfile(payload: Omit<CallCustomerProfileItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<CallCustomerProfileItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать профиль клиента.');
  return data.item as CallCustomerProfileItem;
}

export async function updateCallCustomerProfile(id: string, payload: Omit<CallCustomerProfileItem, 'id' | 'holdingId' | 'createdAt' | 'updatedAt'>): Promise<CallCustomerProfileItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-profiles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить профиль клиента.');
  return data.item as CallCustomerProfileItem;
}

export async function deleteCallCustomerProfile(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/customer-profiles/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить профиль клиента.');
}

export async function fetchCallScripts(params: { holdingId: string }): Promise<CallScriptItem[]> {
  const query = new URLSearchParams({ holdingId: params.holdingId });
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/scripts?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить скрипты.');
  return Array.isArray(data.items) ? data.items as CallScriptItem[] : [];
}

export async function createCallScript(payload: Omit<CallScriptItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<CallScriptItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/scripts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать скрипт.');
  return data.item as CallScriptItem;
}

export async function updateCallScript(id: string, payload: Omit<CallScriptItem, 'id' | 'holdingId' | 'createdAt' | 'updatedAt'>): Promise<CallScriptItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/scripts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить скрипт.');
  return data.item as CallScriptItem;
}

export async function deleteCallScript(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/scripts/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить скрипт.');
}

export async function fetchCallPlanOptions(params: { holdingId: string }): Promise<CallPlanOptions> {
  const query = new URLSearchParams({ holdingId: params.holdingId });
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plan-options?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить данные плана прозвона.');
  return {
    employees: Array.isArray(data.employees) ? data.employees as CallPlanEmployeeOption[] : [],
    dealerships: Array.isArray(data.dealerships) ? data.dealerships as CallPlanDealershipOption[] : [],
    phoneNumberTypes: Array.isArray(data.phoneNumberTypes) ? data.phoneNumberTypes as PhoneNumberTypeItem[] : [],
    scripts: Array.isArray(data.scripts) ? data.scripts as CallScriptItem[] : [],
  };
}

export async function fetchCallPlans(params: { holdingId: string }): Promise<CallPlanItem[]> {
  const query = new URLSearchParams({ holdingId: params.holdingId });
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить планы прозвона.');
  return Array.isArray(data.items) ? data.items as CallPlanItem[] : [];
}

export async function createCallPlan(payload: Omit<CallPlanItem, 'id' | 'createdAt' | 'updatedAt' | 'lastInitiatedAt' | 'lastBatchId'>): Promise<CallPlanItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать план прозвона.');
  return data.item as CallPlanItem;
}

export async function updateCallPlan(id: string, payload: Omit<CallPlanItem, 'id' | 'createdAt' | 'updatedAt' | 'lastInitiatedAt' | 'lastBatchId'>): Promise<CallPlanItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить план прозвона.');
  return data.item as CallPlanItem;
}

export async function deleteCallPlan(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить план прозвона.');
}

export async function initiateCallPlan(id: string): Promise<{ item: CallPlanItem; callId: string; batchId: string; totalJobs: number }> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans/${id}/initiate`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось инициировать прозвон.');
  return data as { item: CallPlanItem; callId: string; batchId: string; totalJobs: number };
}

export async function previewCallPlanPrompt(id: string): Promise<CallPlanPromptPreview> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans/${id}/prompt-preview`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось сгенерировать промпт.');
  return data as CallPlanPromptPreview;
}

export async function fetchCallPlanCalls(id: string): Promise<CallPlanCallItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans/${id}/calls`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить историю прозвона.');
  return Array.isArray(data.items) ? data.items as CallPlanCallItem[] : [];
}

export async function fetchCallPlanSchedule(id: string, date: string): Promise<{ date: string; items: CallPlanCallItem[] }> {
  const query = new URLSearchParams({ date });
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans/${id}/schedule?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить расписание прозвона.');
  return {
    date: String(data.date || date),
    items: Array.isArray(data.items) ? data.items as CallPlanCallItem[] : [],
  };
}

export async function recreateCallPlanScheduleCall(planId: string, callId: string): Promise<CallPlanCallItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-settings/plans/${planId}/schedule/${callId}/recreate`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось пересоздать расписание прозвона.');
  return data.item as CallPlanCallItem;
}

export async function fetchVoiceDashboard(): Promise<PlatformVoice | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/voice-dashboard`);
  if (!res.ok) return null;
  return (await res.json()) as PlatformVoice;
}

export async function fetchAudits(limit = 100): Promise<AuditItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/audits?limit=${limit}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return data.audits ?? [];
}

export async function fetchAuditDetail(id: string): Promise<AuditDetailItem | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/audits/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Не удалось загрузить проверку.');
  const data = await res.json().catch(() => ({}));
  return data.item ?? null;
}

export async function fetchTimeSeries(): Promise<TimeSeriesPoint[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/time-series`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return data.series ?? [];
}

export async function fetchCallReportProblems(): Promise<CallReportProblemItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-report-problems`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить справочник проблем.');
  return Array.isArray(data.items) ? data.items as CallReportProblemItem[] : [];
}

export async function fetchAnalyticsOverview(filters?: { holdingId?: string | null }): Promise<AnalyticsOverview | null> {
  const params = new URLSearchParams();
  if (filters?.holdingId) params.set('holdingId', filters.holdingId);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/overview${suffix}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return null;
  return await res.json() as AnalyticsOverview;
}

async function fetchRecommendations(path: string): Promise<RecommendationsResponse> {
  const res = await apiFetch(`${API_BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить рекомендации.');
  return data as RecommendationsResponse;
}

export function fetchHoldingRecommendations(id: string): Promise<RecommendationsResponse> {
  return fetchRecommendations(`/api/admin/holdings/${encodeURIComponent(id)}/recommendations`);
}

export function fetchDealershipRecommendations(id: string): Promise<RecommendationsResponse> {
  return fetchRecommendations(`/api/admin/dealerships/${encodeURIComponent(id)}/recommendations`);
}

export function fetchUserRecommendations(id: string): Promise<RecommendationsResponse> {
  return fetchRecommendations(`/api/admin/users/${encodeURIComponent(id)}/recommendations`);
}

export async function fetchAnalyticsComparisonSummary(input: {
  level: string;
  items: Array<Record<string, unknown>>;
}): Promise<AnalyticsAISummary> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/comparison-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось сформировать AI-анализ сравнения.');
  return data.item as AnalyticsAISummary;
}

export async function fetchAnalyticsDealerships(days: 7 | 30 | 'all' = 'all'): Promise<AnalyticsDealershipRow[]> {
  const params = new URLSearchParams({ days: String(days) });
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/dealerships?${params.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Не удалось загрузить аналитику точек.');
  }
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as AnalyticsDealershipRow[] : [];
}

export async function fetchAnalyticsHoldings(): Promise<AnalyticsHoldingRow[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/holdings`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Не удалось загрузить аналитику компаний.');
  }
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as AnalyticsHoldingRow[] : [];
}

export async function fetchAnalyticsHoldingDetail(id: string): Promise<AnalyticsHoldingDetail | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/holdings/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return (data.item ?? null) as AnalyticsHoldingDetail | null;
}

export async function fetchAnalyticsDealershipDetail(id: string): Promise<AnalyticsDealershipDetail | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/dealerships/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return (data.item ?? null) as AnalyticsDealershipDetail | null;
}

export async function fetchAnalyticsDealershipPlans(id: string): Promise<AnalyticsPlanParticipation[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/dealerships/${encodeURIComponent(id)}/plans`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as AnalyticsPlanParticipation[] : [];
}

export async function excludeDealershipFromAnalyticsPlan(dealershipId: string, planId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/dealerships/${encodeURIComponent(dealershipId)}/plans/${encodeURIComponent(planId)}/exclude`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось исключить точку из расписания.');
}

export async function fetchAnalyticsManagerDetail(id: string): Promise<AnalyticsManagerDetail | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/managers/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return (data.item ?? null) as AnalyticsManagerDetail | null;
}

export async function fetchAnalyticsManagerPlans(id: string): Promise<AnalyticsPlanParticipation[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/managers/${encodeURIComponent(id)}/plans`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as AnalyticsPlanParticipation[] : [];
}

export async function excludeManagerFromAnalyticsPlan(managerId: string, planId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/managers/${encodeURIComponent(managerId)}/plans/${encodeURIComponent(planId)}/exclude`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось исключить менеджера из расписания.');
}

export async function fetchAnalyticsManagers(): Promise<AnalyticsManagerRow[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/analytics/managers`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Не удалось загрузить аналитику сотрудников.');
  }
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as AnalyticsManagerRow[] : [];
}

export async function fetchMockEntities(): Promise<{ companies: MockCompany[]; dealers: MockDealer[] }> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/mock-entities`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return { companies: [], dealers: [] };
  const data = await res.json();
  return { companies: data.companies ?? [], dealers: data.dealers ?? [] };
}

export async function fetchSuperAdminSettings(): Promise<SuperAdminSettings | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/settings`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return null;
  return (await res.json()) as SuperAdminSettings;
}

export const fetchAdminPanelSettings = fetchSuperAdminSettings;

export async function fetchCallBatches(limit = 60, mode: 'all' | 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily' = 'all'): Promise<CallBatchListItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-batches?limit=${limit}&mode=${mode}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchCallBatchJobs(batchId: string, limit = 300): Promise<CallBatchJobItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-batches/${batchId}/jobs?limit=${limit}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchCallBatchById(batchId: string): Promise<CallBatchListItem | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-batches/${batchId}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.batch ?? null) as CallBatchListItem | null;
}

export async function fetchRbacMeta(): Promise<RbacMeta> {
  const res = await apiFetch(`${API_BASE}/api/admin/rbac/meta`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) throw new Error('Не удалось загрузить RBAC-метаданные');
  return (await res.json()) as RbacMeta;
}

export async function fetchUsers(search = ''): Promise<{ items: UserAccountItem[]; canManageTemplates: boolean }> {
  const suffix = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/users${suffix}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) throw new Error('Не удалось загрузить сотрудников');
  return (await res.json()) as { items: UserAccountItem[]; canManageTemplates: boolean };
}

export async function createUser(payload: Record<string, unknown>): Promise<UserAccountItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать сотрудника');
  return data.item as UserAccountItem;
}

export async function updateUser(accountId: string, payload: Record<string, unknown>): Promise<UserAccountItem | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить сотрудника');
  return (data.item ?? null) as UserAccountItem | null;
}

export async function changeOwnPassword(password: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/me/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось изменить пароль');
}

export async function changeUserPassword(accountId: string, password: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось изменить пароль сотрудника');
}

export async function deleteUser(accountId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить сотрудника');
}

export async function fetchPermissionTemplates(): Promise<PermissionTemplateItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить шаблоны прав');
  return Array.isArray(data.items) ? data.items as PermissionTemplateItem[] : [];
}

export async function createPermissionTemplate(payload: Record<string, unknown>): Promise<PermissionTemplateItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать шаблон прав');
  return data.item as PermissionTemplateItem;
}

export async function updatePermissionTemplate(templateId: string, payload: Record<string, unknown>): Promise<PermissionTemplateItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить шаблон прав');
  return data.item as PermissionTemplateItem;
}

export async function deletePermissionTemplate(templateId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates/${templateId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить шаблон прав');
}
