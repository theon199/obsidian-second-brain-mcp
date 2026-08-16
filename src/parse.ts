export function parseJsonOrText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseCount(text: string): number {
  const exact = Number(text.trim());
  if (Number.isFinite(exact)) return exact;
  return nonEmptyLines(text).length;
}
