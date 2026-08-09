import type { ProviderConfig } from "../../shared/types";
import { resolveProviderBaseUrl } from "../../shared/providers";
import { isLocalBaseUrl } from "./air-gapped";

export interface StoredProviderSecret {
  providerId: ProviderConfig["id"];
  apiKey: string;
  endpointOrigin?: string;
}

export interface ProviderSecretLoadResult {
  provider: ProviderConfig | null;
  secretToPersist?: StoredProviderSecret;
  issue?: string;
}

export interface ProviderSecretUpdateResult {
  provider: ProviderConfig;
  secret: StoredProviderSecret | null;
}

export function normalizeProviderEndpointOrigin(
  provider: Pick<ProviderConfig, "id" | "baseUrl">,
): string {
  const baseUrl = resolveProviderBaseUrl(provider);

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Provider endpoint must be a valid HTTP or HTTPS URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Provider endpoint must not contain embedded credentials.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalBaseUrl(baseUrl))) {
    throw new Error("Provider endpoint must use HTTPS unless it is a local endpoint.");
  }
  return parsed.origin.toLowerCase();
}

export function resolveProviderSecretForLoad(
  provider: ProviderConfig | null | undefined,
  stored: StoredProviderSecret | null,
): ProviderSecretLoadResult {
  if (!provider) return { provider: null };

  let endpointOrigin: string;
  try {
    endpointOrigin = normalizeProviderEndpointOrigin(provider);
  } catch (error) {
    return {
      provider: null,
      issue: error instanceof Error ? error.message : "The provider endpoint is invalid.",
    };
  }

  const legacyApiKey = provider.apiKey?.trim() || "";
  const storedMatchesEndpoint = Boolean(
    stored?.providerId === provider.id &&
    (!stored.endpointOrigin || stored.endpointOrigin === endpointOrigin),
  );
  const apiKey = storedMatchesEndpoint ? stored.apiKey : legacyApiKey;
  const shouldMigrateSecret =
    Boolean(legacyApiKey) || (storedMatchesEndpoint && !stored?.endpointOrigin);

  const result: ProviderSecretLoadResult = {
    provider: {
      ...provider,
      apiKey,
      hasApiKey: Boolean(apiKey),
    },
  };
  if (shouldMigrateSecret) {
    result.secretToPersist = {
      providerId: provider.id,
      apiKey: legacyApiKey || stored?.apiKey || "",
      endpointOrigin,
    };
  }
  return result;
}

export function resolveProviderSecretForUpdate(
  provider: ProviderConfig,
  existingSecret: StoredProviderSecret | null,
): ProviderSecretUpdateResult {
  const incomingApiKey = provider.apiKey.trim();
  const endpointOrigin = normalizeProviderEndpointOrigin(provider);
  const preserveExisting =
    !incomingApiKey &&
    provider.hasApiKey === true &&
    existingSecret?.providerId === provider.id &&
    existingSecret.endpointOrigin === endpointOrigin;

  if (
    !incomingApiKey &&
    provider.hasApiKey === true &&
    existingSecret?.apiKey &&
    !preserveExisting
  ) {
    throw new Error("Provider or endpoint changed. Re-enter the API key before saving.");
  }

  const apiKey = preserveExisting ? existingSecret?.apiKey || "" : incomingApiKey;
  return {
    provider: {
      ...provider,
      apiKey,
      hasApiKey: Boolean(apiKey),
    },
    secret: apiKey
      ? {
          providerId: provider.id,
          apiKey,
          endpointOrigin,
        }
      : null,
  };
}
