const SENSITIVE_KEY = /(?:api[_-]?key|auth(?:orization)?|auth[_-]?token|access[_-]?token|cookie|password|secret|token)/i;
const KEY_VALUE = /((?:"?[A-Za-z0-9_-]*(?:api[_-]?key|auth(?:orization)?|cookie|password|secret|token)[A-Za-z0-9_-]*"?)\s*[=:]\s*["']?)[^\s,"']+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]+/gi;
const COMMON_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function redactString(value: string): string {
  if (/^\s*[{[]/.test(value)) {
    try {
      return JSON.stringify(redactSensitive(JSON.parse(value)));
    } catch {
      // Preserve non-JSON diagnostic text and apply token-pattern redaction below.
    }
  }
  return value
    .replace(BEARER, "$1[REDACTED]")
    .replace(KEY_VALUE, "$1[REDACTED]")
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
