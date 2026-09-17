import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '../db';
import { buildRealtimeCallPrompt } from './callSettingsManagement';

const DEMO_PROFILE_ID = 'default';
const DEMO_SCRIPT_ID = 'default';
const DEFAULT_DEMO_VOICE_ID = 'sergey';
const DEMO_VOICE_IDS = new Set(['mikhail', 'sergey', 'anna']);
const TEMPERAMENTS = new Set(['calm', 'doubtful', 'irritated', 'hurried']);
const PATIENCE = new Set(['low', 'medium', 'high']);
const REPLY_LENGTHS = new Set(['short', 'medium', 'detailed']);
const GENDERS = new Set(['male', 'female']);

export type DemoCallObjection = {
  id: string;
  phrase: string;
  whenAppropriate: string;
};

export type DemoCallQuestion = {
  id: string;
  text: string;
  required: boolean;
};

export type DemoCallSuccessCriterion = {
  id: string;
  sourceType: 'question' | 'objection';
  sourceId: string;
  expectedAnswer: string;
  score: number;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function text(value: unknown, maxLength = 20_000): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function assertSuperadmin(req: Request): void {
  const account = req.authAccount;
  if (!account?.memberships.some((membership) => membership.role === 'platform_superadmin')) {
    throw new Error('Настройки демо-стенда доступны только суперадминистратору.');
  }
}

function normalizeVoice(voice: Awaited<ReturnType<typeof prisma.demoCallVoice.findFirstOrThrow>>) {
  return {
    id: voice.id,
    name: voice.name,
    description: voice.description,
    gender: voice.gender as 'male' | 'female',
    elevenLabsVoiceId: voice.elevenLabsVoiceId,
    communicationModifier: voice.communicationModifier,
    sortOrder: voice.sortOrder,
    isEnabled: voice.isEnabled,
    createdAt: voice.createdAt,
    updatedAt: voice.updatedAt,
  };
}

function normalizeProfile(profile: Awaited<ReturnType<typeof prisma.demoCallProfile.findFirstOrThrow>>) {
  return {
    id: profile.id,
    name: profile.name,
    age: profile.age,
    ageFrom: profile.ageFrom,
    ageTo: profile.ageTo,
    character: profile.character,
    temperament: profile.temperament,
    patience: profile.patience,
    replyLength: profile.replyLength,
    communicationStyle: profile.communicationStyle,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function normalizeScript(script: Awaited<ReturnType<typeof prisma.demoCallScript.findFirstOrThrow>>) {
  return {
    id: script.id,
    profileId: script.profileId,
    name: script.name,
    companyName: script.companyName,
    companyDescription: script.companyDescription,
    itemTitle: script.itemTitle,
    context: script.context,
    dataText: script.dataText,
    objections: parseJson<DemoCallObjection[]>(script.objectionsJson, []),
    questions: parseJson<DemoCallQuestion[]>(script.questionsJson, []),
    successCriteria: parseJson<DemoCallSuccessCriterion[]>(script.successCriteriaJson, []),
    createdAt: script.createdAt,
    updatedAt: script.updatedAt,
  };
}

export async function getDemoCallConfiguration() {
  const [voices, profile, script] = await Promise.all([
    prisma.demoCallVoice.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    prisma.demoCallProfile.findUnique({ where: { id: DEMO_PROFILE_ID } }),
    prisma.demoCallScript.findUnique({ where: { id: DEMO_SCRIPT_ID } }),
  ]);
  if (!profile || !script || voices.length === 0) {
    throw new Error('Конфигурация демо-стенда не заполнена. Примените актуальные миграции БД.');
  }
  return {
    voices: voices.map((voice) => normalizeVoice(voice)),
    profile: normalizeProfile(profile),
    script: normalizeScript(script),
  };
}

export async function resolveDemoCallRuntime(clientValue: unknown, destinationPhone: string) {
  const configuration = await getDemoCallConfiguration();
  const requestedId = text(clientValue, 64).toLowerCase();
  const activeVoices = configuration.voices.filter((voice) => voice.isEnabled);
  const voice = activeVoices.find((item) => item.id === requestedId)
    ?? activeVoices.find((item) => item.id === DEFAULT_DEMO_VOICE_ID)
    ?? activeVoices[0];
  if (!voice) throw new Error('В демо-стенде нет включённых голосов.');

  const profile = configuration.profile;
  const script = configuration.script;
  const communicationStyle = [profile.communicationStyle, voice.communicationModifier]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
  const prompt = buildRealtimeCallPrompt({
    script: {
      context: script.context,
      objectionsJson: JSON.stringify(script.objections),
      questionsJson: JSON.stringify(script.questions),
      successCriteriaJson: JSON.stringify(script.successCriteria),
    },
    profile: {
      age: profile.age,
      ageFrom: profile.ageFrom,
      ageTo: profile.ageTo,
      temperament: profile.temperament,
      patience: profile.patience,
      replyLength: profile.replyLength,
      communicationStyle,
    },
    importedItem: {
      title: script.itemTitle || script.name,
      description: script.dataText,
    },
    customerVoiceName: voice.gender === 'female' ? 'Женский' : 'Мужской',
    clientName: voice.name,
    destinationPhone,
    holding: {
      name: script.companyName || 'Демо-стенд',
      description: script.companyDescription || null,
    },
  });

  return {
    voice,
    profile,
    script,
    prompt,
    criteria: script.successCriteria.map((criterion) => ({
      expectedAnswer: criterion.expectedAnswer,
      score: criterion.score,
    })),
  };
}

function parseVoicePayload(body: Record<string, unknown>) {
  const name = text(body.name, 80);
  const description = text(body.description, 180);
  const gender = text(body.gender, 16);
  const elevenLabsVoiceId = text(body.elevenLabsVoiceId, 160);
  const communicationModifier = text(body.communicationModifier, 2_000);
  if (!name) throw new Error('Укажите имя голоса.');
  if (!GENDERS.has(gender)) throw new Error('Некорректный пол голоса.');
  if (!elevenLabsVoiceId) throw new Error('Укажите ElevenLabs Voice ID.');
  return { name, description, gender, elevenLabsVoiceId, communicationModifier };
}

function parseProfilePayload(body: Record<string, unknown>) {
  const name = text(body.name, 160);
  const fallbackAge = Math.max(18, Math.min(65, Math.round(Number(body.age ?? 35)) || 35));
  const fromValue = Math.round(Number(body.ageFrom ?? fallbackAge));
  const toValue = Math.round(Number(body.ageTo ?? fallbackAge));
  const ageFrom = Math.max(18, Math.min(65, Math.min(fromValue, toValue)));
  const ageTo = Math.max(18, Math.min(65, Math.max(fromValue, toValue)));
  const temperament = text(body.temperament, 32);
  const patience = text(body.patience, 32);
  const replyLength = text(body.replyLength, 32);
  if (!name) throw new Error('Укажите название профиля.');
  if (!TEMPERAMENTS.has(temperament)) throw new Error('Некорректный темперамент.');
  if (!PATIENCE.has(patience)) throw new Error('Некорректное терпение клиента.');
  if (!REPLY_LENGTHS.has(replyLength)) throw new Error('Некорректная длина реплик.');
  return {
    name,
    age: Math.round((ageFrom + ageTo) / 2),
    ageFrom,
    ageTo,
    character: text(body.character, 1_000),
    temperament,
    patience,
    replyLength,
    communicationStyle: text(body.communicationStyle, 8_000),
  };
}

function normalizeObjections(value: unknown): DemoCallObjection[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((raw) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      id: text(item.id, 100) || randomUUID(),
      phrase: text(item.phrase, 1_000),
      whenAppropriate: text(item.whenAppropriate, 2_000),
    };
  }).filter((item) => item.phrase);
}

function normalizeQuestions(value: unknown): DemoCallQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((raw) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      id: text(item.id, 100) || randomUUID(),
      text: text(item.text, 2_000),
      required: Boolean(item.required),
    };
  }).filter((item) => item.text);
}

function normalizeCriteria(
  value: unknown,
  questions: DemoCallQuestion[],
  objections: DemoCallObjection[],
): DemoCallSuccessCriterion[] {
  if (!Array.isArray(value)) return [];
  const questionIds = new Set(questions.map((item) => item.id));
  const objectionIds = new Set(objections.map((item) => item.id));
  return value.slice(0, 100).map((raw) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sourceType = item.sourceType === 'objection' ? 'objection' : 'question';
    const sourceId = text(item.sourceId, 100);
    return {
      id: text(item.id, 100) || randomUUID(),
      sourceType,
      sourceId,
      expectedAnswer: text(item.expectedAnswer, 5_000),
      score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
    } satisfies DemoCallSuccessCriterion;
  }).filter((item) => (
    item.sourceType === 'question' ? questionIds.has(item.sourceId) : objectionIds.has(item.sourceId)
  ));
}

function parseScriptPayload(body: Record<string, unknown>) {
  const name = text(body.name, 200);
  const itemTitle = text(body.itemTitle, 500);
  const questions = normalizeQuestions(body.questions);
  const objections = normalizeObjections(body.objections);
  const successCriteria = normalizeCriteria(body.successCriteria, questions, objections);
  if (!name) throw new Error('Укажите название скрипта.');
  if (!itemTitle) throw new Error('Укажите основной объект разговора.');
  return {
    name,
    itemTitle,
    context: text(body.context, 20_000),
    dataText: text(body.dataText, 100_000),
    objectionsJson: JSON.stringify(objections),
    questionsJson: JSON.stringify(questions),
    successCriteriaJson: JSON.stringify(successCriteria),
  };
}

export async function handleGetDemoCallAdminConfiguration(req: Request, res: Response): Promise<void> {
  try {
    assertSuperadmin(req);
    res.json(await getDemoCallConfiguration());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось загрузить настройки демо-стенда.';
    res.status(message.includes('суперадминистратору') ? 403 : 400).json({ error: message });
  }
}

export async function handleUpdateDemoCallVoice(req: Request, res: Response): Promise<void> {
  try {
    assertSuperadmin(req);
    const id = text(req.params.id, 64).toLowerCase();
    if (!DEMO_VOICE_IDS.has(id)) throw new Error('Голос демо-стенда не найден.');
    const data = parseVoicePayload((req.body || {}) as Record<string, unknown>);
    const updated = await prisma.demoCallVoice.update({ where: { id }, data });
    res.json({ item: normalizeVoice(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить голос.';
    res.status(message.includes('суперадминистратору') ? 403 : message.includes('не найден') ? 404 : 400).json({ error: message });
  }
}

export async function handleUpdateDemoCallProfile(req: Request, res: Response): Promise<void> {
  try {
    assertSuperadmin(req);
    const data = parseProfilePayload((req.body || {}) as Record<string, unknown>);
    const updated = await prisma.demoCallProfile.update({ where: { id: DEMO_PROFILE_ID }, data });
    res.json({ item: normalizeProfile(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить профиль.';
    res.status(message.includes('суперадминистратору') ? 403 : message.includes('not found') ? 404 : 400).json({ error: message });
  }
}

export async function handleUpdateDemoCallScript(req: Request, res: Response): Promise<void> {
  try {
    assertSuperadmin(req);
    const data = parseScriptPayload((req.body || {}) as Record<string, unknown>);
    const updated = await prisma.demoCallScript.update({ where: { id: DEMO_SCRIPT_ID }, data });
    res.json({ item: normalizeScript(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить скрипт.';
    res.status(message.includes('суперадминистратору') ? 403 : message.includes('not found') ? 404 : 400).json({ error: message });
  }
}

export async function handleGetPublicDemoCallConfiguration(_req: Request, res: Response): Promise<void> {
  try {
    const configuration = await getDemoCallConfiguration();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      voices: configuration.voices
        .filter((voice) => voice.isEnabled)
        .map((voice) => ({ id: voice.id, name: voice.name, description: voice.description })),
      defaultVoiceId: configuration.voices.some((voice) => voice.id === DEFAULT_DEMO_VOICE_ID && voice.isEnabled)
        ? DEFAULT_DEMO_VOICE_ID
        : configuration.voices.find((voice) => voice.isEnabled)?.id ?? null,
    });
  } catch (error) {
    console.error('[demo-call] public configuration error:', error instanceof Error ? error.message : error);
    res.status(503).json({ error: 'Демо-стенд временно не настроен.' });
  }
}
