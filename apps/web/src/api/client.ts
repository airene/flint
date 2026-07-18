import { apiErrorSchema, type ApiErrorCode } from "@local-pair-review/shared";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ResponseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: unknown } };
}

export type ApiQueryValue = string | number | boolean | null | undefined;
export type ApiQuery = Readonly<Record<string, ApiQueryValue | readonly ApiQueryValue[]>>;

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: ApiQuery;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface ApiClient {
  request<T>(path: string, responseSchema: ResponseSchema<T>, options?: ApiRequestOptions): Promise<T>;
}

export interface CreateApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof globalThis.fetch;
}

function appendQuery(search: URLSearchParams, key: string, value: ApiQueryValue): void {
  if (value !== undefined && value !== null) search.append(key, String(value));
}

function requestUrl(baseUrl: string, path: string, query?: ApiQuery): string {
  const target = baseUrl
    ? `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
    : path;
  if (!query) return target;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const values: readonly ApiQueryValue[] = Array.isArray(value)
      ? value
      : [value as ApiQueryValue];
    for (const item of values) appendQuery(search, key, item);
  }
  const encoded = search.toString();
  if (!encoded) return target;
  return `${target}${target.includes("?") ? "&" : "?"}${encoded}`;
}

async function jsonPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiClientError(
      response.status,
      "INTERNAL_ERROR",
      "The server returned an invalid JSON response.",
    );
  }
}

function transportError(error: unknown): never {
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  if (error instanceof ApiClientError) throw error;
  throw new ApiClientError(
    0,
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unable to reach the local server.",
  );
}

export function createApiClient(options: CreateApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const fetcher = options.fetcher ?? globalThis.fetch;

  return {
    async request<T>(path: string, responseSchema: ResponseSchema<T>, requestOptions: ApiRequestOptions = {}): Promise<T> {
      const headers = new Headers(requestOptions.headers);
      headers.set("accept", "application/json");
      const hasBody = requestOptions.body !== undefined;
      if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");

      let response: Response;
      try {
        response = await fetcher(requestUrl(baseUrl, path, requestOptions.query), {
          method: requestOptions.method ?? "GET",
          headers,
          ...(hasBody ? { body: JSON.stringify(requestOptions.body) } : {}),
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        });
      } catch (error) {
        return transportError(error);
      }

      let payload: unknown;
      try {
        payload = await jsonPayload(response);
      } catch (error) {
        return transportError(error);
      }

      if (!response.ok) {
        const parsedError = apiErrorSchema.safeParse(payload);
        if (parsedError.success) {
          throw new ApiClientError(
            response.status,
            parsedError.data.code,
            parsedError.data.message,
            parsedError.data.details,
          );
        }
        throw new ApiClientError(
          response.status,
          "INTERNAL_ERROR",
          `The local server returned HTTP ${response.status}.`,
        );
      }

      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiClientError(
          response.status,
          "INTERNAL_ERROR",
          "The server response did not match the shared API contract.",
          parsed.error.issues,
        );
      }
      return parsed.data;
    },
  };
}

export const apiClient = createApiClient();
