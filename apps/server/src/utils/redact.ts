const SENSITIVE_KEY = /(?:api[_-]?key|auth[_-]?token|access[_-]?token|authorization|cookie)/i;
const KEY_VALUE = /((?:"?(?:OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)"?)\s*[=:]\s*["']?)[^\s,"']+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]+/gi;
const COMMON_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function redactString(value: string): string {
  return value
    .replace(KEY_VALUE, "$1[REDACTED]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(COMMON_TOKEN, "[REDACTED]");
}

export function redactSensitive<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item),
    ])) as T;
  }
  return value;
}
