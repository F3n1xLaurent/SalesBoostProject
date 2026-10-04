import { randomUUID } from 'crypto';
import { mkdir, rename, rm, writeFile } from 'fs/promises';
import path from 'path';

export const MAX_SUPPORT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
]);

export function supportAttachmentExtension(mimeType: string): string | null {
  return ALLOWED_MIME_TYPES.get(mimeType.toLowerCase().split(';')[0].trim()) ?? null;
}

function safeSegment(value: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : randomUUID();
}

export function supportAttachmentKey(ticketId: string, attachmentId: string, mimeType: string): string {
  const extension = supportAttachmentExtension(mimeType);
  if (!extension) throw new Error('Unsupported attachment type');
  return `tickets/${safeSegment(ticketId)}/${safeSegment(attachmentId)}/file${extension}`;
}

export class LocalSupportAttachmentStorage {
  private readonly rootDir: string;

  constructor(rootDir = process.env.SUPPORT_ATTACHMENTS_DIR?.trim() || path.resolve(process.cwd(), 'storage', 'support-attachments')) {
    this.rootDir = path.resolve(rootDir);
  }

  resolvePath(key: string): string {
    const target = path.resolve(this.rootDir, key);
    if (target !== this.rootDir && !target.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Invalid support attachment storage key');
    }
    return target;
  }

  async save(key: string, data: Buffer): Promise<void> {
    if (data.length === 0) throw new Error('Attachment is empty');
    if (data.length > MAX_SUPPORT_ATTACHMENT_BYTES) throw new Error('Attachment is too large');
    const target = this.resolvePath(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }
}

export const supportAttachmentStorage = new LocalSupportAttachmentStorage();

