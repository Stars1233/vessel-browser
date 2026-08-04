const SENSITIVE_KEY =
  /(?:password|passwd|passcode|secret|token|authorization|cookie|api[-_]?key|credential|totp|otp|card|cvv|cvc)/i;
const MAX_STRING_LENGTH = 2000;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;

function redactValue(value: unknown, key: string, depth: number): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey, depth + 1),
      ]),
    );
  }
  return value;
}

export function redactRunValue(actionName: string, value: unknown): unknown {
  const normalizedAction = actionName.trim().toLowerCase();
  if (
    normalizedAction.includes("vault") ||
    normalizedAction.includes("credential") ||
    normalizedAction.includes("totp")
  ) {
    return "[REDACTED]";
  }
  return redactValue(value, "", 0);
}

export function summarizeRunOutput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_STRING_LENGTH
    ? `${normalized.slice(0, MAX_STRING_LENGTH)}[truncated]`
    : normalized;
}
