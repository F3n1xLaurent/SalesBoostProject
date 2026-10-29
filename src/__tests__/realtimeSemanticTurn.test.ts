import { describe, expect, it } from 'vitest';
import { compatibleChatMaxTokens } from '../lib/openaiClient';
import { parseSemanticTurnDecision } from '../voice/realtimeSemanticTurn';

describe('realtime semantic turn decision', () => {
  it('parses and bounds a valid decision', () => {
    expect(parseSemanticTurnDecision('{"complete":false,"confidence":1.4,"reason":"мысль продолжается"}')).toEqual({
      complete: false,
      confidence: 1,
      reason: 'мысль продолжается',
    });
  });

  it('rejects malformed decisions', () => {
    expect(parseSemanticTurnDecision('{}')).toBeNull();
    expect(parseSemanticTurnDecision('not json')).toBeNull();
  });

  it('uses the token limit field supported by the configured model family', () => {
    expect(compatibleChatMaxTokens('openai/gpt-5-mini', 90)).toEqual({ max_completion_tokens: 90 });
    expect(compatibleChatMaxTokens('gpt-4o-mini', 90)).toEqual({ max_tokens: 90 });
  });
});
