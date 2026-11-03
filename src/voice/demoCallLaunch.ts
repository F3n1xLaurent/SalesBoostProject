import type { RequestHandler } from 'express';
import { prisma } from '../db';
import { resolveDemoCallRuntime } from './demoCallConfiguration';
import { markCallPlanLaunchFailed, prepareDemoCallTelephony } from './callPlanTelephony';

export async function launchDemoCall(phone: string, client: unknown, ipAddress: string | null) {
  const runtime = await resolveDemoCallRuntime(client, phone);
  const prepared = await prepareDemoCallTelephony(phone, {
    planId: `demo:${runtime.script.id}`,
    planName: runtime.script.name,
    prompt: runtime.prompt,
    elevenLabsVoiceId: runtime.voice.elevenLabsVoiceId,
    customerVoiceId: runtime.voice.id,
    subjectTitle: runtime.script.itemTitle || runtime.script.name,
    subjectDescription: runtime.script.dataText,
  });
  try {
    // Persist before dialing: immediate lifecycle webhooks must see source,
    // scenario and the frozen evaluation context, just like ordinary calls.
    await prisma.voiceCallSession.create({ data: {
      callId: prepared.callId, to: phone, scenario: prepared.scenario, source: 'demo', ipAddress,
      startedAt: new Date(prepared.startedAt),
      caseContextJson: JSON.stringify({
        kind: 'fixed_demo_call', demoClientId: runtime.voice.id,
        elevenLabsVoiceId: prepared.telephony.voiceId,
        demoVoiceUpdatedAt: runtime.voice.updatedAt,
        demoProfileId: runtime.profile.id, demoProfileUpdatedAt: runtime.profile.updatedAt,
        demoScriptId: runtime.script.id, demoScriptUpdatedAt: runtime.script.updatedAt,
        prompt: runtime.prompt, criteria: runtime.criteria, telephony: prepared.telephony,
      }),
    } });
    await prepared.start();
  } catch (error) {
    await prepared.dispose().catch((cleanupError) => console.error('[demo-call] provider cleanup failed', cleanupError));
    await markCallPlanLaunchFailed(prepared.callId, error).catch((saveError) => console.error('[demo-call] launch failure persistence failed', saveError));
    throw error;
  }
  return { callId: prepared.callId, startedAt: prepared.startedAt, to: phone, client: runtime.voice.id, scenario: prepared.scenario };
}

export function createDemoCallStartHandler({ notify, launch = launchDemoCall }: {
  notify: (input: { callId: string; phone: string }) => void;
  launch?: typeof launchDemoCall;
}): RequestHandler {
  return async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const phone = '+' + String(body.to ?? '').replace(/\D/g, '');
    if (!/^\+[1-9]\d{10,14}$/.test(phone)) {
      res.status(400).json({ error: 'Введите корректный номер телефона.' }); return;
    }
    const realIp = String(req.headers['x-real-ip'] || '').trim();
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim();
    const ipAddress = (realIp || forwardedFor || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64) || null;
    try {
      // Ignore legacy body.scenario: public requests cannot select another engine.
      const result = await launch(phone, body.client, ipAddress);
      notify({ callId: result.callId, phone });
      res.json(result);
    } catch (error) {
      console.error('[demo-call] realtime launch failed', error);
      res.status(503).json({ error: 'Не удалось запустить звонок. Попробуйте ещё раз чуть позже.' });
    }
  };
}
