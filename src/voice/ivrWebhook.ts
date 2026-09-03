type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function sanitizePart(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const part = String(value).trim();
  return part && part.length <= 16 ? part : null;
}

function parsePath(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(sanitizePart).filter((item): item is string => item !== null).slice(0, 32);
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsePath(parsed);
  } catch { /* accept a delimited path below */ }
  return text.split(/\s*(?:-|>|,|\/)\s*/).map(sanitizePart).filter((item): item is string => item !== null).slice(0, 32);
}

export function extractIvrPath(payload: UnknownRecord, previousPath: string[] = []): string[] {
  const details = asRecord(payload.details);
  const data = asRecord(payload.data);
  const accumulated = payload.ivr_path ?? payload.ivrPath ?? payload.accumulated_path ?? payload.accumulatedPath
    ?? payload.selected_path ?? payload.path ?? details.ivr_path ?? details.ivrPath
    ?? details.accumulated_path ?? details.accumulatedPath ?? details.selected_path ?? details.path
    ?? data.ivr_path ?? data.ivrPath ?? data.accumulated_path ?? data.accumulatedPath ?? data.selected_path ?? data.path;
  const parsed = parsePath(accumulated);
  if (parsed.length > 0) return parsed;
  const selected = sanitizePart(
    payload.selected_digit ?? payload.selectedDigit ?? payload.digit ?? payload.selected
      ?? details.selected_digit ?? details.selectedDigit ?? details.digit ?? details.selected
      ?? data.selected_digit ?? data.selectedDigit ?? data.digit ?? data.selected,
  );
  return selected ? [...previousPath, selected].slice(0, 32) : previousPath;
}

export function parseStoredIvrPath(value: string | null | undefined): string[] {
  return parsePath(value);
}
