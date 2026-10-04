import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalSupportAttachmentStorage,
  supportAttachmentExtension,
  supportAttachmentKey,
} from '../storage/supportAttachmentStorage';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('support attachment storage', () => {
  it('accepts safe document and image types only', () => {
    expect(supportAttachmentExtension('image/png')).toBe('.png');
    expect(supportAttachmentExtension('application/pdf')).toBe('.pdf');
    expect(supportAttachmentExtension('text/html')).toBeNull();
    expect(supportAttachmentExtension('image/svg+xml')).toBeNull();
  });

  it('stores a file inside its configured root', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'support-attachment-'));
    temporaryDirectories.push(directory);
    const storage = new LocalSupportAttachmentStorage(directory);
    const key = supportAttachmentKey('ticket-1', 'attachment-1', 'image/png');
    await storage.save(key, Buffer.from('png-content'));
    await expect(readFile(storage.resolvePath(key), 'utf8')).resolves.toBe('png-content');
  });

  it('rejects paths escaping the storage root', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'support-attachment-'));
    temporaryDirectories.push(directory);
    const storage = new LocalSupportAttachmentStorage(directory);
    expect(() => storage.resolvePath('../secret.txt')).toThrow('Invalid support attachment storage key');
  });
});
