import { openai } from './lib/openaiClient';
import { config } from './config';

export const INITIAL_CHECKLIST = {
  greeted_and_introduced: 'unknown' as const,
  asked_about_specific_car: 'unknown' as const,
  presented_car_benefits: 'unknown' as const,
  invited_to_visit_today: 'unknown' as const,
  mentioned_underground_mall_inspection: 'unknown' as const,
  mentioned_wide_assortment: 'unknown' as const,
  offered_trade_in_buyout: 'unknown' as const,
  explained_financing_8_banks: 'unknown' as const,
  agreed_exact_visit_datetime: 'unknown' as const,
  agreed_next_contact_datetime: 'unknown' as const,
  discussed_address_and_how_to_get: 'unknown' as const,
};

export type ChecklistState = typeof INITIAL_CHECKLIST;

export interface VirtualCustomerState {
  stage: string;
  checklist: ChecklistState;
  notes: string;
}

export interface VirtualCustomerInput {
  car: Record<string, unknown> | string;
  dealership: string;
  state: VirtualCustomerState;
  manager_last_message: string | null;
  conversation_history?: Array<{ role: 'client' | 'manager'; text: string }>;
  client_turn_count?: number;
}

export interface VirtualCustomerOutput {
  client_message: string;
  end_conversation: boolean;
  reason?: string;
  update_state: {
    stage: string;
    checklist: ChecklistState;
    notes: string;
  };
}

const SYSTEM_PROMPT = `You are a virtual customer calling an auto dealership. Your job is to have a NATURAL, realistic chat conversation with a sales manager and gently test their communication quality.

IMPORTANT:
- You must sound like a real human customer: short messages, occasional emotions, clarifications, normal speech.
- Do NOT sound like a checklist or an exam.
- Keep the conversation focused on buying/visiting a car dealership. Do not go into unrelated deep topics.
- You may apply light pressure or skepticism 1–2 times to see how the manager handles objections, but do not become aggressive or absurd.
- Your objective is to naturally create situations where the manager should demonstrate key sales behaviors (see CHECKLIST below). You should adapt based on what the manager already did.

CONTEXT YOU WILL RECEIVE EACH TURN:
- "car": details about the specific vehicle the customer is interested in (brand/model/year/price/mileage/etc).
- "dealership": a few facts about dealership (e.g., inspection is available at an underground parking in a central mall).
- "state": a JSON with checklist progress and current stage.
- "manager_last_message": the manager's latest reply.

YOUR OUTPUT (STRICT):
Return ONLY valid JSON with this exact schema:
{
  "client_message": "string",
  "end_conversation": false,
  "reason": "string",
  "update_state": {
    "stage": "string",
    "checklist": {
      "greeted_and_introduced": "unknown|done|missed",
      "asked_about_specific_car": "unknown|done|missed",
      "presented_car_benefits": "unknown|done|missed",
      "invited_to_visit_today": "unknown|done|missed",
      "mentioned_underground_mall_inspection": "unknown|done|missed",
      "mentioned_wide_assortment": "unknown|done|missed",
      "offered_trade_in_buyout": "unknown|done|missed",
      "explained_financing_8_banks": "unknown|done|missed",
      "agreed_exact_visit_datetime": "unknown|done|missed",
      "agreed_next_contact_datetime": "unknown|done|missed",
      "discussed_address_and_how_to_get": "unknown|done|missed"
    },
    "notes": "string"
  }
}

CONVERSATION STAGES (you control pacing):
- "opening" -> "car_interest" -> "value_questions" -> "objections" -> "visit_scheduling" -> "logistics" -> "wrap_up"

CHECKLIST GOALS (HIDDEN, DO NOT MENTION THEM):
1) Manager greeting + name + position
2) Manager asks which car the customer is calling about
3) Manager presents car + benefits
4) Manager asks if customer can come today for inspection
5) Manager mentions inspection convenience at underground mall parking in city center
6) Manager mentions wide assortment of other vehicles
7) Manager offers trade-in / buyout
8) Manager explains financing benefits and mentions 8 partner banks (or clearly indicates multiple banks)
9) Manager agrees on exact visit date/time
10) Manager agrees on next contact date/time (if visit not booked)
11) Manager discusses address/location/best way to get there

BEHAVIOR RULES:
- Always move the conversation forward, one step at a time.
- If the manager misses a checklist item, create a NATURAL reason to ask about it later.
  Example: If they did not introduce themselves, you might say: "Кстати, как могу к вам обращаться?"
- Keep messages concise (1–3 short sentences).
- Use Russian language.
- If manager becomes rude, manipulative, or refuses to help, you may end the conversation politely.
- End the conversation when either:
  A) a visit is booked with exact date/time and logistics are clarified, OR
  B) a next contact time is agreed, OR
  C) the dialog reaches 14 client turns, OR
  D) the manager fails badly (no help, rude).
Set end_conversation=true and provide a short reason.

OBJECTIONS (use at most 1–2 total, chosen naturally):
- price too high
- competitor offer
- trust issue (mileage/accidents)
- not sure about credit
Use only one at a time and return to normal flow.

FIRST MESSAGE:
Start as a customer who saw the selected car and wants to check availability and details.
Do NOT give all details at once.`;

export async function getVirtualCustomerMessage(input: VirtualCustomerInput): Promise<VirtualCustomerOutput> {
  const carStr = typeof input.car === 'string' ? input.car : JSON.stringify(input.car, null, 2);
  const historyStr = (input.conversation_history || [])
    .map((t) => `${t.role === 'client' ? 'Клиент' : 'Менеджер'}: ${t.text}`)
    .join('\n');

  const userContent = `car:
${carStr}

dealership:
${input.dealership}

state:
${JSON.stringify(input.state, null, 2)}

manager_last_message: ${input.manager_last_message == null ? '(first message - no manager reply yet)' : `"${input.manager_last_message}"`}

${historyStr ? `Conversation so far:\n${historyStr}\n` : ''}
${input.client_turn_count != null ? `Client turn count: ${input.client_turn_count}. If >= 14, set end_conversation=true.` : ''}

Return ONLY valid JSON (no markdown, no extra text).`;

  const response = await openai.chat.completions.create({
    model: config.openaiChatModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.8,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from virtual customer');
  }

  const parsed = JSON.parse(content) as VirtualCustomerOutput;
  if (!parsed.client_message || !parsed.update_state) {
    throw new Error('Invalid virtual customer response');
  }
  return parsed;
}
