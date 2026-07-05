import { apiJson } from '../../entities/session';

const API_BASE = '';

export type TrainerSessionStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed' | 'paused' | string;
export type TrainerSessionType = 'plan' | 'free' | string;

export interface TrainerProfile {
  employeeId: string;
  fullName: string;
  companyId: string | null;
  companyName: string;
  branchId: string;
  branchName: string;
  city: string | null;
  totalPoints: number;
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string | null;
  sessionsTotal: number;
  sessions30d: number;
}

export interface TrainerScenario {
  id: string;
  name: string;
  context: string;
  objectionsCount: number;
  questionsCount: number;
  criteriaCount: number;
}

export interface TrainerPlanItem {
  id: string;
  scenarioId: string | null;
  scenarioName: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'failed' | string;
  trainerSessionId: string | null;
  caseContextSeed?: string;
  completedAt?: string | null;
}

export interface TrainerPlan {
  id: string | null;
  date: string;
  sessions: TrainerPlanItem[];
}

export interface TrainerSessionSummary {
  id: string;
  type: TrainerSessionType;
  status: TrainerSessionStatus;
  scenarioId: string | null;
  scenarioName: string;
  score: number | null;
  finalPoints: number | null;
  failureReason: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface TrainerReport extends TrainerSessionSummary {
  caseContext: Record<string, unknown>;
  transcript: Array<{ role?: string; text?: string; content?: string; audioBase64?: string | null; audioMimeType?: string | null }>;
  dimensions: Record<string, unknown> | null;
  checklist: Array<Record<string, unknown>>;
  objectionsAnalysis: Array<Record<string, unknown>>;
  topRecommendations: Array<Record<string, unknown> | string>;
  evaluation: Record<string, unknown> | null;
  multiplier: number;
  baseScore: number | null;
  durationSec: number | null;
}

export interface TrainerDialogMessage {
  role: 'client' | 'manager';
  text: string;
  durationSec?: number | null;
  createdAt?: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
}

export interface TrainerInitialMessage {
  clientMessage: string;
  audioBase64: string | null;
  audioMimeType?: string | null;
  transcript: TrainerDialogMessage[];
}

export interface TrainerTurnResponse {
  clientMessage: string;
  endConversation: boolean;
  audioBase64: string | null;
  audioMimeType?: string | null;
  managerTranscript: string;
  result: Record<string, unknown> | null;
  session: TrainerSessionSummary;
  transcript: TrainerDialogMessage[];
}

export async function fetchTrainerProfile(): Promise<TrainerProfile> {
  const data = await apiJson<{ profile: TrainerProfile }>(`${API_BASE}/api/trainer/profile`);
  return data.profile;
}

export async function fetchTrainerScenarios(): Promise<TrainerScenario[]> {
  const data = await apiJson<{ items: TrainerScenario[] }>(`${API_BASE}/api/trainer/scenarios`);
  return data.items;
}

export async function fetchTrainerTodayPlan(): Promise<TrainerPlan> {
  const data = await apiJson<{ plan: TrainerPlan }>(`${API_BASE}/api/trainer/plan/today`);
  return data.plan;
}

export async function fetchTrainerHistory(): Promise<TrainerSessionSummary[]> {
  const data = await apiJson<{ items: TrainerSessionSummary[] }>(`${API_BASE}/api/trainer/history`);
  return data.items;
}

export async function startTrainerSession(payload: {
  sessionType: 'plan' | 'free';
  scenarioId?: string | null;
  planItemId?: string | null;
  difficulty?: 'easy' | 'medium' | 'hard';
  clientType?: string;
}): Promise<{ session: TrainerSessionSummary; caseContext: Record<string, unknown>; initialMessage: TrainerInitialMessage | null }> {
  return apiJson(`${API_BASE}/api/trainer/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, replyMode: 'text+voice', voice: 'male' }),
  });
}

export async function fetchTrainerReport(id: string): Promise<TrainerReport> {
  const data = await apiJson<{ item: TrainerReport }>(`${API_BASE}/api/trainer/session/${encodeURIComponent(id)}/report`);
  return data.item;
}

export async function fetchTrainerDialog(id: string): Promise<{ session: TrainerSessionSummary; caseContext: Record<string, unknown>; transcript: TrainerDialogMessage[] }> {
  return apiJson(`${API_BASE}/api/trainer/session/${encodeURIComponent(id)}/dialog`);
}

export async function abandonTrainerSession(id: string): Promise<{ session: TrainerSessionSummary }> {
  return apiJson(`${API_BASE}/api/trainer/session/${encodeURIComponent(id)}/abandon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function sendTrainerVoiceMessage(id: string, payload: {
  audioBase64: string;
  mimeType: string;
  durationSec: number;
}): Promise<TrainerTurnResponse> {
  return apiJson(`${API_BASE}/api/trainer/session/${encodeURIComponent(id)}/voice-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, replyMode: 'text+voice', voice: 'male' }),
  });
}
