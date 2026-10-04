import { describe, expect, it } from 'vitest';
import { REALTIME_CALL_GUARDRAILS } from '../voice/realtimeCallGuardrails';

describe('realtime call guardrails', () => {
  it('keeps silent while an IVR or hold message is active', () => {
    expect(REALTIME_CALL_GUARDRAILS).toContain('СОЕДИНЕНИЕ С ЖИВЫМ СОТРУДНИКОМ');
    expect(REALTIME_CALL_GUARDRAILS).toContain('режим молчаливого ожидания');
    expect(REALTIME_CALL_GUARDRAILS).toContain('системный инструмент skip_turn');
    expect(REALTIME_CALL_GUARDRAILS).toContain('Никогда не вызывай send_dtmf в ответ на «шум дороги»');
    expect(REALTIME_CALL_GUARDRAILS).toContain('Никогда не вызывай send_dtmf с пустым digit');
    expect(REALTIME_CALL_GUARDRAILS).toContain('Музыка, шум и тишина не являются новыми ходами диалога');
    expect(REALTIME_CALL_GUARDRAILS).toContain('«жду соединения»');
    expect(REALTIME_CALL_GUARDRAILS).toContain('ТИШИНА И МНОГОТОЧИЕ');
    expect(REALTIME_CALL_GUARDRAILS).toContain('проверить связь только ОДИН раз');
    expect(REALTIME_CALL_GUARDRAILS).toContain('верни только текст «...»');
    expect(REALTIME_CALL_GUARDRAILS).toContain('Сбросить правило одной проверки связи можно только после новой осмысленной реплики');
    expect(REALTIME_CALL_GUARDRAILS).toContain('Не формируй и не повторяй их снова');
    expect(REALTIME_CALL_GUARDRAILS).toContain('если живой сотрудник явно попросил повторить');
  });
});
