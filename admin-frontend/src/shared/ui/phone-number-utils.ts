export function formatPhoneInput(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  const hasExplicitPlus = trimmed.startsWith('+');
  const normalizedRu = normalizeRuDigits(digits, hasExplicitPlus);
  if (normalizedRu) return formatRuPhone(normalizedRu);

  if (hasExplicitPlus) {
    return formatInternationalPhone(digits);
  }

  return formatLocalPhone(digits);
}

export function formatPhoneInputLive(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  const hasExplicitPlus = trimmed.startsWith('+');
  const normalizedRu = normalizeRuDigits(digits, hasExplicitPlus);
  if (normalizedRu) return formatRuPhone(normalizedRu);

  if (hasExplicitPlus) return formatInternationalPhone(digits);
  return groupPhoneDigits(digits).join(' ');
}

function normalizeRuDigits(digits: string, hasExplicitPlus: boolean): string | null {
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
  }
  if (!hasExplicitPlus && digits.length === 10 && digits.startsWith('9')) {
    return `7${digits}`;
  }
  return null;
}

function formatRuPhone(digits: string): string {
  const parts = [
    `+${digits.slice(0, 1)}`,
    digits.slice(1, 4),
    digits.slice(4, 7),
    digits.slice(7, 9),
    digits.slice(9, 11),
  ].filter(Boolean);
  return parts.join(' ');
}

function formatInternationalPhone(digits: string): string {
  const countryCodeLength = guessCountryCodeLength(digits);
  const countryCode = digits.slice(0, countryCodeLength);
  const nationalNumber = digits.slice(countryCodeLength);
  return [`+${countryCode}`, ...groupPhoneDigits(nationalNumber)].filter(Boolean).join(' ');
}

function formatLocalPhone(digits: string): string {
  return groupPhoneDigits(digits).join(' ');
}

function guessCountryCodeLength(digits: string): number {
  if (digits.length <= 1) return 1;

  const oneDigitCodes = new Set(['1', '7']);
  const twoDigitCodes = new Set([
    '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
    '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84',
    '86', '90', '91', '92', '93', '94', '95', '98',
  ]);

  if (oneDigitCodes.has(digits.slice(0, 1))) return 1;
  if (digits.length >= 2 && twoDigitCodes.has(digits.slice(0, 2))) return 2;
  return Math.min(3, digits.length);
}

function groupPhoneDigits(digits: string): string[] {
  if (!digits) return [];
  if (digits.length <= 3) return [digits];
  if (digits.length <= 6) return [digits.slice(0, 3), digits.slice(3)];
  if (digits.length <= 8) return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  return [
    digits.slice(0, 3),
    digits.slice(3, 6),
    digits.slice(6, 8),
    digits.slice(8, 10),
    digits.slice(10),
  ].filter(Boolean);
}
