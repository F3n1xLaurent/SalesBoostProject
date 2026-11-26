// Targeted repair for the feed used by calls 1511/1514. No calls are started.
// Default: preview only. Pass --apply to save a backup and commit atomically.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

async function repairUsedTags(db, { apply = false, backupRoot = path.join(os.tmpdir(), 'salesboost-used-tag-backups') } = {}) {
  return db.$transaction(async tx => {
    const source = await tx.importSource.findUniqueOrThrow({
      where: { id: 'cmwt4co6q04hazmyt960jxk30' },
      select: { id: true, holdingId: true, tagRulesJson: true },
    });
    const script = await tx.callScript.findUniqueOrThrow({
      where: { id: 'cmwue171a00karwkb3b7dqq46' },
      select: { holdingId: true, dataConditionJson: true },
    });
    if (!source.holdingId || source.holdingId !== script.holdingId) throw new Error('Source and script companies differ');
    const rules = JSON.parse(source.tagRulesJson);
    const selectedTags = JSON.parse(script.dataConditionJson).tags;
    if (!Array.isArray(rules) || !Array.isArray(selectedTags) || !selectedTags.includes('С пробегом')) {
      throw new Error('Unexpected source rules or script selection');
    }
    const existing = rules.filter(rule => rule.name === 'С пробегом');
    if (existing.length > 1 || existing.some(rule => rule.enabled !== true
      || rule.condition?.field !== 'run' || rule.condition?.operator !== 'greaterThan'
      || ![0, '0'].includes(rule.condition?.value))) {
      throw new Error('A different used-car rule already exists; no changes made');
    }
    const ruleAdded = existing.length === 0;
    const nextRules = ruleAdded ? [...rules, { id: randomUUID(), name: 'С пробегом', enabled: true,
      condition: { field: 'run', operator: 'greaterThan', value: 0 } }] : rules;
    const items = await tx.importedItem.findMany({
      where: { importSourceId: source.id, isActive: true },
      select: { id: true, tagsJson: true, normalizedDataJson: true },
    });
    if (!items.length) throw new Error('Feed has no active items');
    const rows = items.map(item => {
      const run = JSON.parse(item.normalizedDataJson).run;
      if (!['string', 'number'].includes(typeof run) || String(run).trim() === ''
        || !Number.isFinite(Number(run)) || Number(run) < 0) {
        throw new Error(`Invalid mileage for ${item.id}; no changes made`);
      }
      const tags = JSON.parse(item.tagsJson);
      if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw new Error(`Invalid tags for ${item.id}`);
      const next = Number(run) > 0
        ? tags.includes('С пробегом') ? tags : [...tags, 'С пробегом']
        : tags.filter(tag => tag !== 'С пробегом');
      return { ...item, tags, next, changed: JSON.stringify(next) !== JSON.stringify(tags) };
    });
    const matches = tags => selectedTags.every(tag => tags.includes(tag));
    const result = { applied: apply, total: rows.length, ruleAdded,
      changedItems: rows.filter(row => row.changed).length,
      matchingBefore: rows.filter(row => matches(row.tags)).length,
      matchingAfterRepair: rows.filter(row => matches(row.next)).length, backupPath: null };
    if (!result.matchingAfterRepair) throw new Error('Repair would leave the script selection empty; no changes made');
    if (!apply || (!ruleAdded && !result.changedItems)) return result;
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    result.backupPath = path.join(backupRoot, randomUUID() + '.json');
    await fs.writeFile(result.backupPath, JSON.stringify({ format: 'salesboost-used-tag-backup-v1',
      createdAt: new Date().toISOString(), sourceId: source.id, tagRulesJson: source.tagRulesJson,
      items: rows.map(row => ({ id: row.id, tagsJson: row.tagsJson })),
    }, null, 2), { mode: 0o600, flag: 'wx' });
    if (ruleAdded) await tx.importSource.update({ where: { id: source.id }, data: { tagRulesJson: JSON.stringify(nextRules) } });
    for (const row of rows.filter(row => row.changed)) {
      await tx.importedItem.update({ where: { id: row.id }, data: { tagsJson: JSON.stringify(row.next) } });
    }
    return result;
  }, { timeout: 15000 });
}

module.exports = { repairUsedTags };
if (require.main === module || (process.argv[1] === '-' && module.filename.endsWith('[stdin]'))) {
  require('dotenv/config');
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/repair-import-used-tags.cjs [--apply]');
    return repairUsedTags(db, { apply: args.includes('--apply'),
      ...(process.env.NODE_ENV === 'production' ? { backupRoot: '/data/import-tag-repairs' } : {}) });
  }).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
