import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalTrainerTestReport, trainerTestDiagnostics } from '../testing/trainerTestDiagnostics';
import type { TrainerTestRun } from '../testing/trainerAutoTesting';

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
describe('trainer diagnostics by UUID', () => {
  it('opens the trainer archive by ID through the real CLI without booting a server or providers', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'trainer-cli-')); temporary.push(cwd);
    const root = path.join(cwd, 'storage/trainer-regression'); await fs.mkdir(path.join(root, 'trainer-run'), { recursive: true });
    const check = { id: 'trainer-ending', title: 'Прощание', status: 'fail', evidence: ['Два прощания'] };
    const run = { id: 'trainer-run', ownerId: 'private-owner', executorPid: 123, target: 'trainer', status: 'completed', checklist: [check], cases: [{ id: 'trainer-script', checks: [check], voices: [{ provider: 'elevenlabs', voiceId: 'one' }], inputs: [{ text: 'Прощайте', accepted: true }] }], configuration: { source: { context: { apiKey: 'private-api-key' } } } } as unknown as TrainerTestRun;
    await fs.writeFile(path.join(root, run.id, 'report.json'), JSON.stringify(run));
    expect((await readLocalTrainerTestReport(run.id, root)).id).toBe(run.id);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', require.resolve('tsx'), path.resolve('scripts/inspect-autotest.ts'), 'trainer-run', '--check', 'trainer-ending', '--json'], { cwd });
    const report = JSON.parse(stdout).report; expect(report.id).toBe(run.id); expect(report.cases[0].voices[0].voiceId).toBe('one');
    expect(stdout).not.toContain('private-owner'); expect(stdout).not.toContain('private-api-key'); expect(stdout).not.toContain('executorPid');
    expect(() => trainerTestDiagnostics(run, { checkId: 'unknown' })).toThrow('Неизвестный пункт');
    await expect(readLocalTrainerTestReport('../trainer-run', root)).rejects.toThrow('Некорректный ID');
  });
});
