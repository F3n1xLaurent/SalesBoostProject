import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'undici';

const apply = process.argv.includes('--apply');
const accountId = process.env.VOX_ACCOUNT_ID?.trim();
const apiKey = process.env.VOX_API_KEY?.trim();
const applicationId = process.env.VOX_APP_ID?.trim();
const scenarioName = process.env.VOX_OPENAI_REALTIME_SCENARIO_NAME?.trim() || 'voice_openai_realtime';
const ruleName = process.env.VOX_OPENAI_REALTIME_RULE_NAME?.trim() || 'voice_openai_realtime_rule';
const protectedNames = new Set([
  'voice_realtime_pure', 'voice_comet_realtime_test', 'voice_yandex_realtime_test',
  process.env.VOX_REALTIME_PURE_SCENARIO_NAME, process.env.VOX_COMET_REALTIME_SCENARIO_NAME,
  process.env.VOX_REALTIME_PURE_RULE_NAME, process.env.VOX_COMET_REALTIME_RULE_NAME,
].filter(Boolean));

async function api(method: string, params: Record<string, string> = {}): Promise<any> {
  const response = await request(`https://api.voximplant.com/platform_api/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account_id: accountId!, api_key: apiKey!, output: 'json', ...params }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = JSON.parse(await response.body.text());
  if (response.statusCode >= 400 || parsed.error || parsed.result === 0) {
    throw new Error(`${method}: ${String(parsed.error?.msg ?? parsed.msg ?? `HTTP ${response.statusCode}`).slice(0, 250)}`);
  }
  return parsed;
}
async function main() {
  if (!accountId || !apiKey || !applicationId) throw new Error('Нужны VOX_ACCOUNT_ID, VOX_API_KEY и VOX_APP_ID.');
  if (protectedNames.has(scenarioName) || protectedNames.has(ruleName)) throw new Error('Нельзя перезаписывать старый или тестовый сценарий/правило.');
  const source = await fs.readFile(path.resolve('voximplant/scenario_voice_openai_realtime.js'), 'utf8');
  let scenario = (await api('GetScenarios', { scenario_name: scenarioName, count: '100' })).result?.find((s: any) => s.scenario_name === scenarioName);
  let rule = (await api('GetRules', { application_id: applicationId, rule_name: ruleName, with_scenarios: 'true', count: '100' })).result?.find((r: any) => r.rule_name === ruleName);
  if (rule?.scenarios?.some((s: any) => s.scenario_name !== scenarioName)) throw new Error('У целевого правила есть другой сценарий; существующие привязки не изменены.');
  let remote: string | null = null;
  if (scenario) {
    const detail = await api('GetScenarios', { scenario_id: String(scenario.scenario_id), with_script: 'true' });
    remote = detail.result?.[0]?.scenario_script ?? null;
  }
  if (!apply) {
    console.log(JSON.stringify({ mode: 'check', scenarioName, ruleName, scenarioExists: Boolean(scenario), ruleExists: Boolean(rule),
      scriptMatches: remote === source, bound: Boolean(rule?.scenarios?.some((s: any) => s.scenario_name === scenarioName)) }, null, 2));
    return;
  }
  if (scenario && remote !== source) {
    if (typeof remote !== 'string') throw new Error('Не удалось получить прежнее тело целевого сценария для резервной копии.');
    const backupDir = path.resolve('storage/voximplant-scenario-backups');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${scenario.scenario_id}-${Date.now()}.js`), remote, { mode: 0o600 });
    await api('SetScenarioInfo', { scenario_id: String(scenario.scenario_id), scenario_script: source });
  } else if (!scenario) {
    const added = await api('AddScenario', { scenario_name: scenarioName, scenario_script: source, rewrite: 'false' });
    scenario = { scenario_id: added.scenario_id, scenario_name: scenarioName };
  }
  if (!rule) {
    const added = await api('AddRule', { application_id: applicationId, rule_name: ruleName,
      rule_pattern: '^__salesboost_openai_outbound__$', scenario_id: String(scenario.scenario_id) });
    rule = { rule_id: added.rule_id };
  } else if (!rule.scenarios?.length) {
    await api('BindScenario', { application_id: applicationId, rule_id: String(rule.rule_id), scenario_id: String(scenario.scenario_id), bind: 'true' });
  }
  const verified = await api('GetScenarios', { scenario_id: String(scenario.scenario_id), with_script: 'true' });
  const rules = await api('GetRules', { application_id: applicationId, rule_id: String(rule.rule_id), with_scenarios: 'true' });
  if (verified.result?.[0]?.scenario_script !== source
    || !rules.result?.[0]?.scenarios?.some((s: any) => Number(s.scenario_id) === Number(scenario.scenario_id))) throw new Error('Проверка загруженного сценария/правила не пройдена.');
  console.log(JSON.stringify({ mode: 'deployed', scenarioName, ruleName, scenarioId: scenario.scenario_id, ruleId: rule.rule_id,
    sha256: createHash('sha256').update(source).digest('hex'), legacyUntouched: true }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
