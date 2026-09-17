export const ORGANIZATION_NAME_MIN_LENGTH = 2;
export const ORGANIZATION_NAME_MAX_LENGTH = 100;

export type OrganizationNameKind = 'holding' | 'dealership';

const ALLOWED_ORGANIZATION_NAME_PATTERN = /^[\p{L}\p{M}\p{N} .,:+'"«»„“№&()/\-–—]+$/u;
const HAS_LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;

function entityLabel(kind: OrganizationNameKind): string {
  return kind === 'holding' ? 'компании' : 'точки';
}

export function normalizeOrganizationName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function validateOrganizationName(
  value: string,
  kind: OrganizationNameKind,
): string | null {
  const normalized = normalizeOrganizationName(value);
  const length = Array.from(normalized).length;
  const label = entityLabel(kind);

  if (length < ORGANIZATION_NAME_MIN_LENGTH || length > ORGANIZATION_NAME_MAX_LENGTH) {
    return `Название ${label} должно содержать от ${ORGANIZATION_NAME_MIN_LENGTH} до ${ORGANIZATION_NAME_MAX_LENGTH} символов.`;
  }
  if (!HAS_LETTER_OR_NUMBER_PATTERN.test(normalized) || !ALLOWED_ORGANIZATION_NAME_PATTERN.test(normalized)) {
    return `Название ${label} содержит недопустимые символы.`;
  }
  return null;
}
