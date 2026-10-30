import { autoTestDiagnostics, formatAutoTestDiagnostics, readLocalAutoTestReport, redactDiagnosticData } from '../src/testing/autoTestingDiagnostics';
import { compareRegressionRuns } from '../src/voice/realtimeRegressionHistory';
import { readLocalTrainerTestReport, trainerTestDiagnostics } from '../src/testing/trainerTestDiagnostics';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('Разбор сохранённого автотеста без API и повторного запуска.\nnpm run inspect-autotest -- <ID> [--check ending] [--scenario callback] [--compare <предыдущий-ID>] [--json]');
    return;
  }
  const id = args.shift()!;
  const options: Record<string, string> = {};
  let json = false;
  while (args.length) {
    const name = args.shift()!;
    if (name === '--json') { json = true; continue; }
    if (!['--check', '--scenario', '--compare'].includes(name) || !args[0] || args[0].startsWith('--')) throw new Error(`Неизвестный аргумент или пропущено значение: ${name}. Используйте --help.`);
    options[name] = args.shift()!;
  }
  const selection = { checkId: options['--check'], scenarioId: options['--scenario'] };
  // UUIDs are unique across both archives. No provider calls or server credentials needed.
  const trainer = await readLocalTrainerTestReport(id).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (trainer) {
    const before = options['--compare'] ? trainerTestDiagnostics(await readLocalTrainerTestReport(options['--compare']), selection) : undefined;
    console.log(JSON.stringify({ report: trainerTestDiagnostics(trainer, selection), ...(before ? { before } : {}) }, null, 2)); return;
  }
  const run = await readLocalAutoTestReport(id);
  const report = autoTestDiagnostics(run, { checkId: options['--check'], scenarioId: options['--scenario'] });
  // Comparisons also use saved files only; opening a report never starts a paid test.
  const comparison = options['--compare'] ? redactDiagnosticData(compareRegressionRuns(await readLocalAutoTestReport(options['--compare']), run)) : undefined;
  console.log(json ? JSON.stringify({ ...report, comparison }, null, 2) : `${formatAutoTestDiagnostics(report)}${comparison ? `\nCOMPARISON ${JSON.stringify(comparison, null, 2)}` : ''}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
