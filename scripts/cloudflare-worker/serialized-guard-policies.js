const MAX_ACTIVATION_CODE_ATTEMPTS = 5;
const AI_RESERVATION_TTL_MS = 5 * 60 * 1000;

function emptyUsage(period) {
  return {
    period,
    requests: 0,
    estimatedCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

function normalizeUsage(value, period) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    ...emptyUsage(period),
    ...usage,
    period,
    requests: Math.max(0, Number(usage.requests) || 0),
    estimatedCostUsd: Math.max(0, Number(usage.estimatedCostUsd) || 0),
    promptTokens: Math.max(0, Number(usage.promptTokens) || 0),
    completionTokens: Math.max(0, Number(usage.completionTokens) || 0),
  };
}

function pruneExpiredReservations(reservations, now, preservedId = "") {
  for (const [id, reservation] of Object.entries(reservations)) {
    if (id !== preservedId && (!reservation || Number(reservation.expiresAt) <= now)) {
      delete reservations[id];
    }
  }
}

export async function applyActivationAttempt(storage, body) {
  const action = body.action;
  const result = await storage.transaction(async (transaction) => {
    const stored = await transaction.get("challenge");
    const challenge =
      stored && typeof stored === "object" ? stored : { attempts: 0, redeemed: false };

    if (challenge.redeemed) {
      return { status: "redeemed", attempts: challenge.attempts || 0 };
    }
    if (action === "redeem") {
      challenge.redeemed = true;
      await transaction.put("challenge", challenge);
      return { status: "redeemed", attempts: challenge.attempts || 0 };
    }
    if ((challenge.attempts || 0) >= MAX_ACTIVATION_CODE_ATTEMPTS) {
      return { status: "limited", attempts: challenge.attempts };
    }
    if (action === "invalid") {
      challenge.attempts = (challenge.attempts || 0) + 1;
      await transaction.put("challenge", challenge);
      return { status: "recorded", attempts: challenge.attempts };
    }
    return { status: "ready", attempts: challenge.attempts || 0 };
  });

  const expiresAt = Number(body?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    await storage.setAlarm(expiresAt);
  }
  return result;
}

export async function applyRateLimit(storage, body) {
  const max = Math.floor(Number(body?.max));
  const windowMs = Math.floor(Number(body?.windowMs));
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return { error: "Invalid rate-limit configuration" };
  }

  const now = Date.now();
  const result = await storage.transaction(async (transaction) => {
    const stored = await transaction.get("rate-limit");
    const current =
      stored && typeof stored === "object" && Number(stored.expiresAt) > now
        ? stored
        : { count: 0, expiresAt: now + windowMs };

    if ((current.count || 0) >= max) {
      return {
        status: "limited",
        count: current.count || 0,
        remaining: 0,
        expiresAt: current.expiresAt,
      };
    }

    const next = {
      count: (current.count || 0) + 1,
      expiresAt: current.expiresAt,
    };
    await transaction.put("rate-limit", next);
    return {
      status: "allowed",
      count: next.count,
      remaining: Math.max(0, max - next.count),
      expiresAt: next.expiresAt,
    };
  });

  await storage.setAlarm(result.expiresAt);
  return result;
}

export async function applyCheckoutRedemption(storage, body) {
  const operation = body?.operation;
  const claimId = String(body?.claimId || "").trim();
  const claimTtlMs = Math.floor(Number(body?.claimTtlMs));
  const redemptionTtlMs = Math.floor(Number(body?.redemptionTtlMs));
  if (
    !["begin", "commit", "release"].includes(operation) ||
    !claimId ||
    !Number.isFinite(claimTtlMs) ||
    claimTtlMs <= 0 ||
    !Number.isFinite(redemptionTtlMs) ||
    redemptionTtlMs <= 0
  ) {
    return { error: "Invalid checkout redemption action" };
  }

  const now = Date.now();
  const result = await storage.transaction(async (transaction) => {
    const stored = await transaction.get("checkout-redemption");
    const current = stored && typeof stored === "object" ? stored : null;

    if (operation === "begin") {
      if (current?.status === "redeemed" && Number(current.expiresAt) > now) {
        return { status: "redeemed", expiresAt: current.expiresAt };
      }
      if (current?.status === "claimed" && Number(current.expiresAt) > now) {
        return { status: "claimed", expiresAt: current.expiresAt };
      }
      const next = {
        status: "claimed",
        claimId,
        expiresAt: now + claimTtlMs,
      };
      await transaction.put("checkout-redemption", next);
      return { status: "claimed-by-caller", expiresAt: next.expiresAt };
    }

    if (current?.status !== "claimed" || current.claimId !== claimId) {
      return { status: current?.status === "redeemed" ? "redeemed" : "claim-lost" };
    }

    if (operation === "release") {
      await transaction.put("checkout-redemption", {
        status: "available",
        expiresAt: now,
      });
      return { status: "released", expiresAt: now };
    }

    const next = {
      status: "redeemed",
      expiresAt: now + redemptionTtlMs,
    };
    await transaction.put("checkout-redemption", next);
    return { status: "redeemed-by-caller", expiresAt: next.expiresAt };
  });

  if (Number(result?.expiresAt) > now) {
    await storage.setAlarm(result.expiresAt);
  }
  return result;
}

export async function applyAiBudget(storage, body) {
  const period = String(body?.period || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return { error: "Invalid AI usage period" };
  }

  const reservationId = String(body?.reservationId || "").trim();
  if (body.action !== "ai-get" && !reservationId) {
    return { error: "reservationId is required" };
  }

  const storageKey = `ai-budget:${period}`;
  const now = Date.now();
  return storage.transaction(async (transaction) => {
    const stored = await transaction.get(storageKey);
    const state =
      stored && typeof stored === "object"
        ? stored
        : {
            period,
            usage: normalizeUsage(body?.baseline, period),
            reservations: {},
          };
    state.usage = normalizeUsage(state.usage, period);
    state.reservations =
      state.reservations && typeof state.reservations === "object" ? state.reservations : {};
    pruneExpiredReservations(
      state.reservations,
      now,
      body.action === "ai-reconcile" ? reservationId : "",
    );

    if (body.action === "ai-get") {
      await transaction.put(storageKey, state);
      return { status: "ready", usage: state.usage };
    }

    if (body.action === "ai-reserve") {
      const budgetUsd = Number(body?.budgetUsd);
      const reservationUsd = Number(body?.reservationUsd);
      if (
        !Number.isFinite(budgetUsd) ||
        budgetUsd <= 0 ||
        !Number.isFinite(reservationUsd) ||
        reservationUsd <= 0
      ) {
        return { error: "Invalid AI budget reservation" };
      }
      if (state.reservations[reservationId]) {
        return { error: "Duplicate AI budget reservation" };
      }
      const reservedUsd = Object.values(state.reservations).reduce(
        (total, reservation) => total + Math.max(0, Number(reservation?.costUsd) || 0),
        0,
      );
      if (state.usage.estimatedCostUsd + reservedUsd + reservationUsd > budgetUsd) {
        return { status: "limited", usage: state.usage, reservedUsd };
      }
      state.reservations[reservationId] = {
        costUsd: reservationUsd,
        expiresAt: now + AI_RESERVATION_TTL_MS,
      };
      await transaction.put(storageKey, state);
      return { status: "reserved", usage: state.usage, reservedUsd: reservedUsd + reservationUsd };
    }

    const reservation = state.reservations[reservationId];
    if (!reservation) {
      await transaction.put(storageKey, state);
      return { status: "already-reconciled", usage: state.usage };
    }
    delete state.reservations[reservationId];
    if (body?.commit) {
      const promptTokens = Math.max(0, Number(body?.promptTokens) || 0);
      const completionTokens = Math.max(0, Number(body?.completionTokens) || 0);
      const reportedCostUsd = Number(body?.actualCostUsd);
      const actualCostUsd =
        Number.isFinite(reportedCostUsd) && reportedCostUsd > 0
          ? reportedCostUsd
          : Math.max(0, Number(reservation.costUsd) || 0);
      state.usage = {
        ...state.usage,
        requests: state.usage.requests + 1,
        promptTokens: state.usage.promptTokens + promptTokens,
        completionTokens: state.usage.completionTokens + completionTokens,
        estimatedCostUsd: state.usage.estimatedCostUsd + actualCostUsd,
      };
    }
    await transaction.put(storageKey, state);
    return { status: "reconciled", usage: state.usage };
  });
}
