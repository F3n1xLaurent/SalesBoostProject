import { openai } from '../lib/openaiClient';
import { config } from '../config';
import type { Car } from '../data/carLoader';
import type { DialogState } from '../state/defaultState';
import type { ConversationPhase } from '../logic/phaseManager';
import type { TopicCode } from '../logic/topicStateMachine';
import type { ClientProfile, ObjectionType } from '../logic/clientProfile';
import { profileToPromptDescription } from '../logic/clientProfile';
import type { BehaviorSignal } from '../logic/behaviorClassifier';

// ── Public types ──

export type Strictness = 'low' | 'medium' | 'high';

export interface VirtualClientOutput {
  client_message: string;
  end_conversation: boolean;
  reason: string;
  diagnostics: {
    current_phase: ConversationPhase;
    topics_addressed: TopicCode[];
    topics_evaded: TopicCode[];
    manager_tone: 'positive' | 'neutral' | 'negative' | 'hostile';
    manager_engagement: 'active' | 'passive' | 'disengaged';
    misinformation_detected: boolean;
    phase_checks_update: Record<string, boolean>;
  };
  update_state: {
    stage: string;
    checklist: Record<string, 'unknown' | 'done' | 'missed'>;
    notes: string;
    client_turns: number;
  };
}

export interface VirtualClientInput {
  car: Car;
  dealership: string;
  state: DialogState;
  manager_last_message: string;
  dialog_history: Array<{ role: 'client' | 'manager'; content: string }>;
  strictness?: Strictness;
  max_client_turns?: number;
  behaviorSignal?: BehaviorSignal;
  /** For voice: use lower max_tokens so the model answers shorter and faster. */
  maxResponseTokens?: number;
}

// ── Prompt ──

const SYSTEM_PROMPT = `You are a virtual customer (buyer) communicating with a car dealership sales manager.
You simulate a REALISTIC buyer conversation to TEST the manager's sales skills.

=== YOUR ROLE ===
You are a customer who saw an ad for a specific car and is calling/messaging the dealership.
You sound natural, remember what was said, never repeat yourself.
You do NOT coach, hint, or teach the manager. You simply react as a real buyer would.

=== CONVERSATION PHASES ===
The dialog progresses through diagnostic phases. You drive the conversation through them:

PHASE 1 — first_contact
- You initiate contact about the car.
- You wait for the manager to introduce themselves, name the salon, clarify which car.
- If the manager doesn't introduce themselves or name the salon, note it silently and move on.

PHASE 2 — needs_discovery
- You mention what you're looking for (commute, family, budget, etc.).
- This gives the manager a chance to ask clarifying questions about your needs.
- If they just jump to listing specs without asking about you — note it.

PHASE 3 — product_presentation
- You listen to the manager's presentation of the car.
- Ask about specific features relevant to your stated needs.
- If the manager says something factually wrong about the car, express confusion.

PHASE 4 — money_and_objections
- You raise exactly ONE financial/objection topic based on the assigned objection_type.
- credit: "А в кредит можно? Какие условия?"
- trade_in: "А если я свою машину сдам в счёт? Есть trade-in?"
- price: "Цена немного кусается. У конкурентов видел дешевле."
- competitor: "А почему именно эту? Видел [конкурент] по похожей цене, у них комплектация лучше."
- After the manager responds, do NOT re-raise the same objection. Move on.

PHASE 5 — closing_attempt
- You show readiness to move forward IF the manager proposes a next step.
- If the manager proposes a visit/test-drive, agree and try to fix date/time.
- If the manager doesn't propose anything, wait 1-2 turns, then say you'll think about it.

=== TOPIC RULES ===
Topics: intro, salon_name, car_identification, needs, product_presentation, credit, trade_in, objection, next_step, scheduling, follow_up.

- You may raise a topic once.
- You may ask ONE clarification per topic if the answer was incomplete.
- After that, the topic is CLOSED — do NOT return to it.
- NEVER ask the same question twice unless it is the single allowed clarification attempt.
- NEVER loop on the same topic with rephrased questions.
- If the manager evades a question twice, note the evasion silently and move on.

=== HARD TONE & BEHAVIOR RULES (CRITICAL) ===

You will receive a "behavior_alert" field describing the manager's last message quality.
React to it as follows:

1. If manager_behavior is "toxic" or "bad_tone":
   - NEVER thank them. NEVER praise. NEVER be accommodating.
   - Respond with SHORT, FIRM, emotionally realistic displeasure.
   - Example: "Простите, но мне не нравится такой тон." / "Это неуместно."
   - If behavior_severity is HIGH, respond once and set end_conversation=true.

2. If manager_behavior is "low_effort" (e.g. "ок", "хз", one-word answer):
   - NEVER say "спасибо" or "понятно" to a lazy answer.
   - Be direct: "Можете ответить конкретнее?" / "Мне нужен развёрнутый ответ."
   - If this is the 2nd low-effort in a row (low_effort_streak >= 2), be firmer:
     "Я задаю конкретные вопросы. Мне нужны нормальные ответы."

3. If manager_behavior is "evasion":
   - Say directly that you noticed the question was dodged:
     "Вы не ответили на мой вопрос." / "Я спрашивал о другом."
   - Do NOT repeat the question more than once.

4. If manager_behavior is "dismissive" (prohibited phrases like "посмотрите на сайте"):
   - React with mild frustration: "Я звоню именно чтобы узнать от вас, а не с сайта."

5. If manager_behavior is NORMAL:
   - Respond naturally, move conversation forward.
   - Be a realistic buyer — not overly friendly or supportive.

ABSOLUTE RULES:
- NEVER praise a bad answer.
- NEVER thank a rude or lazy reply.
- NEVER repeat the same question more than once (one clarification attempt allowed).
- Keep messages SHORT: 1-2 sentences when reacting to poor behavior.
- Your emotional reaction must be proportional to the offense.

=== BEHAVIORAL PROFILE ===
{PROFILE_DESCRIPTION}

=== OUTPUT FORMAT (STRICT JSON) ===
Return ONLY valid JSON:
{
  "client_message": "string (1-3 sentences, Russian)",
  "end_conversation": false,
  "reason": "string",
  "diagnostics": {
    "current_phase": "first_contact|needs_discovery|product_presentation|money_and_objections|closing_attempt",
    "topics_addressed": ["topic_codes the manager addressed this turn"],
    "topics_evaded": ["topic_codes the manager evaded this turn"],
    "manager_tone": "positive|neutral|negative|hostile",
    "manager_engagement": "active|passive|disengaged",
    "misinformation_detected": false,
    "phase_checks_update": {
      "introduced": true/false,
      "named_salon": true/false,
      "clarified_car": true/false,
      "took_initiative": true/false,
      "asked_clarifying_questions": true/false,
      "jumped_to_specs": true/false,
      "structured_presentation": true/false,
      "connected_to_needs": true/false,
      "shut_down_client": true/false,
      "eco_handled": true/false,
      "proposed_next_step": true/false,
      "suggested_visit": true/false,
      "fixed_date_time": true/false,
      "suggested_follow_up": true/false
    }
  },
  "update_state": {
    "stage": "string",
    "checklist": { ... },
    "notes": "string",
    "client_turns": number
  }
}

=== LANGUAGE & STYLE ===
- Language: Russian
- Tone: realistic buyer, not a pushover
- Length: 1–3 sentences per message (1-2 when reacting to bad behavior)
- No emojis, no meta-commentary
- NEVER break character

=== END CONDITIONS ===
Set end_conversation=true when:
1) Visit date/time is agreed and logistics discussed
2) Next contact time is agreed
3) client_turns >= max_client_turns
4) Conversation naturally concludes

=== FIRST MESSAGE ===
If manager_last_message is empty, start as a buyer who saw the ad and wants to check availability.`;

// ── Helpers ──

function carSummary(car: Car): string {
  const loc = car.location as { city?: string; address?: string; inspection_place?: string };
  const terms = car.deal_terms as {
    credit?: { banks_count?: number; monthly_payment_from_rub?: number };
    trade_in?: boolean;
    buyout?: boolean;
  };
  return [
    `title: ${car.title}`,
    `price_rub: ${car.price_rub}`,
    `brand: ${car.brand}, model: ${car.model}, year: ${car.year}, mileage_km: ${car.mileage_km}`,
    `location: ${loc?.city ?? ''}, ${loc?.address ?? ''}, inspection: ${loc?.inspection_place ?? 'подземная парковка ТЦ'}`,
    `credit: ${terms?.credit?.banks_count ?? 8} banks, monthly from ${terms?.credit?.monthly_payment_from_rub ?? '~37000'} RUB`,
    `trade_in: ${terms?.trade_in ?? false}, buyout: ${terms?.buyout ?? false}`,
  ].join('\n');
}

export function buildDealershipFromCar(car: Car): string {
  const loc = car.location as { city?: string; address?: string; inspection_place?: string };
  const terms = car.deal_terms as { credit?: { banks_count?: number } };
  const banks = terms?.credit?.banks_count ?? 8;
  const inspection = loc?.inspection_place ?? 'подземная парковка ТЦ';
  const city = loc?.city ?? 'город';
  const address = loc?.address ?? '';
  return `Автосалон в ${city}${address ? `, ${address}` : ''}. Осмотр: ${inspection}. Кредит: ${banks} банков-партнёров.`;
}

const HISTORY_LIMIT = 8;
const MAX_RESPONSE_TOKENS = 500;
const FALLBACK_CLIENT_MESSAGE = 'Здравствуйте! Я увидел объявление о вашем автомобиле. Он ещё доступен для покупки?';

function topicSummary(state: DialogState): string {
  const lines: string[] = [];
  for (const [code, ts] of Object.entries(state.topics)) {
    if (ts.status !== 'none') {
      lines.push(`  ${code}: ${ts.status} (evasions: ${ts.evasion_count})`);
    }
  }
  return lines.length ? lines.join('\n') : '  (all topics: none)';
}

// ── Parse ──

function extractMessageFromRaw(raw: string): string {
  const cleaned = raw.trim();
  const jsonMatch = cleaned.match(/"client_message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (jsonMatch?.[1]) {
    return jsonMatch[1].replace(/\\"/g, '"').trim() || FALLBACK_CLIENT_MESSAGE;
  }
  const firstLine = cleaned.split('\n')[0]?.trim() || '';
  if (firstLine.length > 5 && firstLine.length < 500 && !firstLine.startsWith('{')) {
    return firstLine;
  }
  return FALLBACK_CLIENT_MESSAGE;
}

function parseVirtualClientOutput(raw: string, currentState: DialogState): VirtualClientOutput {
  let cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
  let parsed: any;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      cleaned = cleaned.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ');
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        console.warn('[virtualClient] JSON.parse failed, fallback. Raw:', cleaned.slice(0, 300));
        return buildFallbackOutput(extractMessageFromRaw(cleaned), currentState);
      }
    }
  }

  const o = parsed && typeof parsed === 'object' ? parsed : {};
  let msg = typeof o.client_message === 'string' ? o.client_message.trim() : '';
  if (!msg) {
    msg = extractMessageFromRaw(cleaned);
  }

  const endConv = o.end_conversation === true;
  const reason = typeof o.reason === 'string' ? o.reason : '';

  const diag = o.diagnostics && typeof o.diagnostics === 'object' ? o.diagnostics : {};
  const us = o.update_state && typeof o.update_state === 'object' ? o.update_state : {};

  const validPhases = ['first_contact', 'needs_discovery', 'product_presentation', 'money_and_objections', 'closing_attempt'];
  const currentPhase = validPhases.includes(diag.current_phase) ? diag.current_phase : currentState.phase;

  const validTones = ['positive', 'neutral', 'negative', 'hostile'];
  const validEngagement = ['active', 'passive', 'disengaged'];

  const diagnostics: VirtualClientOutput['diagnostics'] = {
    current_phase: currentPhase,
    topics_addressed: Array.isArray(diag.topics_addressed) ? diag.topics_addressed : [],
    topics_evaded: Array.isArray(diag.topics_evaded) ? diag.topics_evaded : [],
    manager_tone: validTones.includes(diag.manager_tone) ? diag.manager_tone : 'neutral',
    manager_engagement: validEngagement.includes(diag.manager_engagement)
      ? diag.manager_engagement
      : 'active',
    misinformation_detected: diag.misinformation_detected === true,
    phase_checks_update:
      diag.phase_checks_update && typeof diag.phase_checks_update === 'object'
        ? diag.phase_checks_update
        : {},
  };

  const stage = typeof us.stage === 'string' ? us.stage : currentState.stage;
  const notes = typeof us.notes === 'string' ? us.notes : currentState.notes ?? '';
  const ct = us.client_turns;
  const client_turns =
    typeof ct === 'number' && Number.isFinite(ct)
      ? ct
      : (currentState.client_turns ?? 0) + 1;

  const LEGACY_KEYS = [
    'greeted_and_introduced', 'asked_about_specific_car', 'presented_car_benefits',
    'invited_to_visit_today', 'mentioned_underground_mall_inspection', 'mentioned_wide_assortment',
    'offered_trade_in_buyout', 'explained_financing_8_banks', 'agreed_exact_visit_datetime',
    'agreed_next_contact_datetime', 'discussed_address_and_how_to_get',
  ];
  const rawChecklist = us.checklist && typeof us.checklist === 'object' ? us.checklist : {};
  const checklist: Record<string, 'unknown' | 'done' | 'missed'> = {};
  for (const key of LEGACY_KEYS) {
    const v = (rawChecklist as any)[key];
    checklist[key] = v === 'done' || v === 'missed' ? v : 'unknown';
  }

  return {
    client_message: msg || FALLBACK_CLIENT_MESSAGE,
    end_conversation: endConv,
    reason,
    diagnostics,
    update_state: { stage, checklist, notes, client_turns },
  };
}

function buildFallbackOutput(message: string, state: DialogState): VirtualClientOutput {
  return {
    client_message: message,
    end_conversation: false,
    reason: '',
    diagnostics: {
      current_phase: state.phase,
      topics_addressed: [],
      topics_evaded: [],
      manager_tone: 'neutral',
      manager_engagement: 'active',
      misinformation_detected: false,
      phase_checks_update: {},
    },
    update_state: {
      stage: state.stage,
      checklist: {},
      notes: state.notes ?? '',
      client_turns: (state.client_turns ?? 0) + 1,
    },
  };
}

// ── Main call ──

export async function getVirtualClientReply(input: VirtualClientInput): Promise<VirtualClientOutput> {
  const carStr = carSummary(input.car);
  const history = input.dialog_history.slice(-HISTORY_LIMIT);
  const historyStr = history
    .map((m) => `${m.role === 'client' ? 'Клиент' : 'Менеджер'}: ${m.content}`)
    .join('\n');

  const strictness = input.strictness ?? 'medium';
  const maxClientTurns = input.max_client_turns ?? 10;
  const profile: ClientProfile = input.state.client_profile ?? 'normal';
  const objType: ObjectionType = input.state.objection_triggered ?? 'price';

  const profileDesc = profileToPromptDescription(profile);
  const systemPrompt = SYSTEM_PROMPT.replace('{PROFILE_DESCRIPTION}', profileDesc);

  // Build behavior alert for the CustomerAgent
  const beh = input.behaviorSignal;
  let behaviorAlert = 'manager_behavior: NORMAL\nbehavior_severity: NONE';
  if (beh) {
    const flags: string[] = [];
    if (beh.toxic) flags.push('toxic');
    if (beh.low_effort) flags.push('low_effort');
    if (beh.evasion) flags.push('evasion');
    if (beh.prohibited_phrase_hits.length > 0) flags.push('prohibited_phrases');
    const label = flags.length > 0 ? flags.join(', ') : 'NORMAL';
    behaviorAlert = [
      `manager_behavior: ${label}`,
      `behavior_severity: ${beh.severity}`,
      `low_effort_streak: ${input.state.low_effort_streak}`,
      beh.prohibited_phrase_hits.length > 0
        ? `prohibited_hits: ${beh.prohibited_phrase_hits.join(', ')}`
        : null,
      beh.rationale !== 'no issues detected' ? `rationale: ${beh.rationale}` : null,
    ].filter(Boolean).join('\n');
  }

  const userContent = `=== CAR DATA ===
${carStr}

=== DEALERSHIP ===
${input.dealership}

=== SESSION STATE ===
phase: ${input.state.phase}
client_turns: ${input.state.client_turns}
client_profile: ${profile}
objection_type_to_trigger: ${objType}
strictness: ${strictness}
max_client_turns: ${maxClientTurns}

=== BEHAVIOR ALERT (react to this!) ===
${behaviorAlert}

=== TOPIC STATUS ===
${topicSummary(input.state)}

=== DIALOG HEALTH ===
patience: ${input.state.dialog_health.patience}, trust: ${input.state.dialog_health.trust}, irritation: ${input.state.dialog_health.irritation}

=== MANAGER'S LAST MESSAGE ===
${input.manager_last_message ? `"${input.manager_last_message}"` : '(first message — you open the conversation)'}

${historyStr ? `=== CONVERSATION HISTORY ===\n${historyStr}\n` : ''}
INSTRUCTIONS:
- If client_turns >= ${maxClientTurns}, set end_conversation=true.
- Progress through phases naturally. Current phase: ${input.state.phase}.
- In phase money_and_objections, trigger objection type: ${objType}.
- REACT TO BEHAVIOR ALERT: if toxic/low_effort/evasion, respond firmly per the rules.
- Report diagnostics accurately.
- Return ONLY valid JSON.`;

  let content: string | null = null;
  try {
    const maxTokens = input.maxResponseTokens ?? MAX_RESPONSE_TOKENS;
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: maxTokens,
    });
    content = response.choices[0]?.message?.content ?? null;
  } catch (apiErr) {
    const err = apiErr as { status?: number; code?: string; message?: string };
    const status = err?.status;
    const code = err?.code;
    const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
    console.error('[virtualClient] OpenAI API error:', { status, code, message: errMsg });
    if (status === 401 || code === 'invalid_api_key') {
      throw new Error('OpenAI: неверный API ключ. Проверьте OPENAI_API_KEY в .env');
    }
    if (
      status === 429 ||
      code === 'insufficient_quota' ||
      (typeof errMsg === 'string' && errMsg.toLowerCase().includes('quota'))
    ) {
      throw new Error('OpenAI: закончился баланс или лимит. Пополните счёт на platform.openai.com');
    }
    if (status === 403 && code === 'unsupported_country_region_territory') {
      throw new Error(
        'OpenAI: API недоступен в вашем регионе. Используйте VPN/прокси: добавьте HTTPS_PROXY в .env.'
      );
    }
    if (status === 403) {
      throw new Error('OpenAI: доступ запрещён (баланс или права на модель).');
    }
    throw new Error(`OpenAI API: ${errMsg}`);
  }

  if (!content?.trim()) {
    console.warn('[virtualClient] empty response, fallback');
    return buildFallbackOutput(FALLBACK_CLIENT_MESSAGE, input.state);
  }

  return parseVirtualClientOutput(content, input.state);
}
