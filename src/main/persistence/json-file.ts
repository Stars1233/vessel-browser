import { safeStorage } from "electron";
import fs from "fs";
import { createLogger } from "../../shared/logger";
import { writeFileAtomic } from "../utils/safe-fs";

const logger = createLogger("JsonPersistence");
const SECURE_STORAGE_UNAVAILABLE_MESSAGE = "Secure persistence requires OS-backed secret storage.";

class SecureStorageUnavailableError extends Error {
  constructor() {
    super(SECURE_STORAGE_UNAVAILABLE_MESSAGE);
    this.name = "SecureStorageUnavailableError";
  }
}

interface LoadJsonFileOptions<T> {
  filePath: string;
  fallback: T;
  parse: (raw: unknown) => T;
  secure?: boolean;
}

interface DebouncedJsonPersistenceOptions<T> {
  debounceMs: number;
  filePath: string;
  getValue: () => T | null | undefined;
  logLabel: string;
  resetOnSchedule?: boolean;
  secure?: boolean;
  serialize?: (value: T) => unknown;
}

function canUseSafeStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function assertSecureStorageAvailable(): void {
  if (!canUseSafeStorage() || !safeStorage.encryptString || !safeStorage.decryptString) {
    throw new SecureStorageUnavailableError();
  }
}

function isSecureStorageUnavailableError(err: unknown): boolean {
  return err instanceof SecureStorageUnavailableError;
}

function decodeStoredData(data: Buffer, secure: boolean): string {
  if (secure) {
    assertSecureStorageAvailable();
    return safeStorage.decryptString(data);
  }
  return data.toString("utf-8");
}

function encodeStoredData(payload: string, secure: boolean): Buffer | string {
  if (secure) {
    assertSecureStorageAvailable();
    return safeStorage.encryptString(payload);
  }
  return payload;
}

export function loadJsonFile<T>({
  filePath,
  fallback,
  parse,
  secure = false,
}: LoadJsonFileOptions<T>): T {
  try {
    const raw = fs.readFileSync(filePath);
    const decoded = decodeStoredData(raw, secure);
    return parse(JSON.parse(decoded));
  } catch (err) {
    const isMissingFile = err instanceof Error && "code" in err && err.code === "ENOENT";
    if (isMissingFile) {
      logger.info(`Persistence file not found; using fallback defaults: ${filePath}`);
    } else if (isSecureStorageUnavailableError(err)) {
      throw err;
    } else {
      logger.warn(`Failed to load ${filePath}, using fallback:`, err);
    }
    return fallback;
  }
}

export function createDebouncedJsonPersistence<T>({
  debounceMs,
  filePath,
  getValue,
  logLabel,
  resetOnSchedule = false,
  secure = false,
  serialize,
}: DebouncedJsonPersistenceOptions<T>) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveDirty = false;
  let writeChain = Promise.resolve();

  const persistNow = async (): Promise<void> => {
    saveDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    let prepared: { data: Buffer | string } | { error: unknown };
    try {
      const value = getValue();
      if (value == null) return writeChain;
      const payload = JSON.stringify(serialize ? serialize(value) : value, null, 2);
      prepared = { data: encodeStoredData(payload, secure) };
    } catch (error) {
      prepared = { error };
    }

    writeChain = writeChain
      .catch(() => {
        // A failed write must not prevent a later snapshot from being attempted.
      })
      .then(async () => {
        try {
          if ("error" in prepared) throw prepared.error;
          await writeFileAtomic(filePath, prepared.data, { mode: 0o600 });
        } catch (err) {
          logger.error(`Failed to save ${logLabel}:`, err);
          throw err;
        }
      });
    return writeChain;
  };

  const schedule = (): void => {
    saveDirty = true;
    if (saveTimer) {
      if (!resetOnSchedule) return;
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (saveDirty) {
        void persistNow().catch((err) => {
          logger.error(`Failed to save ${logLabel}:`, err);
        });
      }
    }, debounceMs);
  };

  const flush = (): Promise<void> => {
    return saveDirty ? persistNow() : writeChain;
  };

  return {
    persistNow,
    schedule,
    flush,
  };
}
