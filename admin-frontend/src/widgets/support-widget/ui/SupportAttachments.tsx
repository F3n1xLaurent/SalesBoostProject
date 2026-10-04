import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import type { SupportMessage } from '../../../shared/api/support';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export function appendSupportFiles(current: File[], incoming: File[]): { files: File[]; error: string | null } {
  const accepted: File[] = [];
  for (const file of incoming) {
    if (!ALLOWED_TYPES.has(file.type)) return { files: current, error: `Формат файла «${file.name}» не поддерживается.` };
    if (file.size > MAX_FILE_BYTES) return { files: current, error: `Файл «${file.name}» больше 10 МБ.` };
    if (file.size === 0) return { files: current, error: `Файл «${file.name}» пуст.` };
    accepted.push(file);
  }
  const unique = [...current];
  for (const file of accepted) {
    if (!unique.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) {
      unique.push(file);
    }
  }
  if (unique.length > MAX_FILES) return { files: current, error: `К одному сообщению можно прикрепить не больше ${MAX_FILES} файлов.` };
  return { files: unique, error: null };
}

export function pastedSupportFiles(event: React.ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      if (file.name && file.name !== 'image.png') return file;
      return new File([file], `screenshot-${Date.now()}-${index + 1}.png`, { type: file.type || 'image/png' });
    })
    .filter((file): file is File => Boolean(file));
}

function fileSize(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

export function SupportFilePicker(props: {
  files: File[];
  disabled?: boolean;
  onChange: (files: File[]) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const add = (incoming: File[]) => {
    const result = appendSupportFiles(props.files, incoming);
    if (result.error) props.onError(result.error);
    props.onChange(result.files);
  };
  return (
    <div className="support-widget-file-picker">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,.docx,.xlsx"
        onChange={(event) => {
          add(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />
      <button type="button" onClick={() => inputRef.current?.click()} disabled={props.disabled || props.files.length >= MAX_FILES}>
        <Paperclip size={17} /> Прикрепить файл
      </button>
      {props.files.length > 0 && (
        <div className="support-widget-pending-files">
          {props.files.map((file, index) => (
            <span key={`${file.name}:${file.size}:${index}`}>
              {file.type.startsWith('image/') ? <ImageIcon size={14} /> : <FileText size={14} />}
              <b>{file.name}</b><small>{fileSize(file.size)}</small>
              <button type="button" aria-label={`Убрать ${file.name}`} onClick={() => props.onChange(props.files.filter((_, fileIndex) => fileIndex !== index))}><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SupportAttachment(props: {
  attachment: SupportMessage['attachments'][number];
  loadBlob: (attachmentId: string) => Promise<Blob>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isImage = props.attachment.mimeType.startsWith('image/');

  useEffect(() => {
    if (!isImage) return;
    let active = true;
    let objectUrl: string | null = null;
    props.loadBlob(props.attachment.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, props.attachment.id]);

  useEffect(() => {
    if (!previewOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [previewOpen]);

  const download = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const blob = await props.loadBlob(props.attachment.id);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = props.attachment.originalName;
      anchor.target = '_blank';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`support-widget-attachment${isImage ? ' is-image' : ''}`}
        onClick={() => {
          if (isImage && url) setPreviewOpen(true);
          else void download();
        }}
      >
        {isImage && url ? <img src={url} alt={props.attachment.originalName} /> : isImage ? <ImageIcon size={18} /> : <FileText size={18} />}
        <span><b>{props.attachment.originalName}</b><small>{fileSize(props.attachment.sizeBytes)}</small></span>
      </button>
      {isImage && url && previewOpen && (
        <div className="support-widget-image-preview" role="dialog" aria-modal="true" aria-label={props.attachment.originalName} onClick={() => setPreviewOpen(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <button type="button" aria-label="Закрыть изображение" onClick={() => setPreviewOpen(false)}><X size={20} /></button>
            <img src={url} alt={props.attachment.originalName} />
          </div>
        </div>
      )}
    </>
  );
}

export function SupportMessageAttachments(props: {
  attachments: SupportMessage['attachments'];
  loadBlob: (attachmentId: string) => Promise<Blob>;
}) {
  if (!props.attachments.length) return null;
  return (
    <div className="support-widget-attachments">
      {props.attachments.map((attachment) => <SupportAttachment key={attachment.id} attachment={attachment} loadBlob={props.loadBlob} />)}
    </div>
  );
}
