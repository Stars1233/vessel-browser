export class AiBudgetUnavailableError extends Error {
  constructor(cause) {
    super("AI budget guard is unavailable", { cause });
    this.name = "AiBudgetUnavailableError";
  }
}

export function currentUsagePeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function emptyUsage(period = currentUsagePeriod()) {
  return {
    period,
    requests: 0,
    estimatedCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

export function estimateMinimaxCostUsd(promptTokens = 0, completionTokens = 0) {
  const inputCost = (Number(promptTokens) || 0) * 0.30 / 1_000_000;
  const outputCost = (Number(completionTokens) || 0) * 1.20 / 1_000_000;
  return (inputCost + outputCost) * 1.055;
}

function providerUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const promptValue = value.prompt_tokens ?? value.promptTokens;
  const completionValue = value.completion_tokens ?? value.completionTokens;
  const promptTokens = typeof promptValue === "number" && Number.isFinite(promptValue)
    ? Math.max(0, promptValue)
    : 0;
  const completionTokens = typeof completionValue === "number" && Number.isFinite(completionValue)
    ? Math.max(0, completionValue)
    : 0;
  if (promptTokens + completionTokens <= 0) return null;
  return { promptTokens, completionTokens };
}

export function createAiUsageLedger({
  kv,
  guardAction,
  hashSubject,
  ledgerTtlSeconds,
  now = () => new Date(),
  onReadError = () => {},
}) {
  const periodNow = () => currentUsagePeriod(now());
  const usageKey = async (subject, period) => {
    const normalized = String(subject || "anonymous").trim().toLowerCase();
    return `ai-usage:${period}:${await hashSubject(normalized)}`;
  };
  const readBaseline = async (subject, period = periodNow()) => {
    if (!kv) return emptyUsage(period);
    const raw = await kv.get(await usageKey(subject, period));
    if (!raw) return emptyUsage(period);
    try {
      return { ...emptyUsage(period), ...JSON.parse(raw), period };
    } catch {
      return emptyUsage(period);
    }
  };
  const mirror = async (subject, usage) => {
    if (!kv) return;
    await kv.put(await usageKey(subject, usage.period), JSON.stringify(usage), {
      expirationTtl: ledgerTtlSeconds,
    });
  };

  return {
    async get(subject) {
      const baseline = await readBaseline(subject);
      if (!guardAction) return baseline;
      try {
        const result = await guardAction(`ai-budget:${subject}`, {
          action: "ai-get",
          period: baseline.period,
          baseline,
        });
        if (!result?.usage) return baseline;
        await mirror(subject, result.usage);
        return result.usage;
      } catch (error) {
        onReadError(error);
        return baseline;
      }
    },

    async reserve(subject, budgetUsd, reservationUsd, id) {
      const period = periodNow();
      const baseline = await readBaseline(subject, period);
      const result = await guardAction(`ai-budget:${subject}`, {
        action: "ai-reserve",
        period,
        baseline,
        budgetUsd,
        reservationUsd,
        reservationId: id,
      });
      return {
        ...result,
        reservation: result?.status === "reserved" ? { id, period } : null,
      };
    },

    async reconcile(subject, reservation, rawUsage, commit) {
      const usage = providerUsage(rawUsage);
      const result = await guardAction(`ai-budget:${subject}`, {
        action: "ai-reconcile",
        period: reservation.period,
        reservationId: reservation.id,
        commit,
        promptTokens: usage?.promptTokens || 0,
        completionTokens: usage?.completionTokens || 0,
        actualCostUsd: usage
          ? estimateMinimaxCostUsd(usage.promptTokens, usage.completionTokens)
          : undefined,
      });
      if (result?.usage) await mirror(subject, result.usage);
      return result?.usage;
    },
  };
}

async function reconcileBeforeRethrow(ledger, subject, reservation, usage, commit, error) {
  try {
    await ledger.reconcile(subject, reservation, usage, commit);
  } catch (reconciliationError) {
    throw new AggregateError(
      [error, reconciliationError],
      "AI provider request and budget reconciliation both failed",
    );
  }
  throw error;
}

export async function executePremiumAiCompletion({
  body,
  config,
  plan,
  subject,
  ledger,
  model,
  apiUrl,
  apiKey,
  appUrl,
  fetchImpl = fetch,
}) {
  const requestedOutputTokens = Number(
    body.max_tokens || body.max_completion_tokens || config.maxOutputTokens,
  );
  const maxOutputTokens = Number.isFinite(requestedOutputTokens) && requestedOutputTokens > 0
    ? Math.min(Math.floor(requestedOutputTokens), config.maxOutputTokens)
    : config.maxOutputTokens;
  const upstreamBody = {
    ...body,
    model,
    stream: false,
    max_tokens: maxOutputTokens,
  };
  const serializedUpstreamBody = JSON.stringify(upstreamBody);
  const promptTokenUpperBound = new TextEncoder().encode(serializedUpstreamBody).byteLength;
  const reservationUsd = Math.max(
    0.000001,
    estimateMinimaxCostUsd(promptTokenUpperBound, maxOutputTokens),
  );

  let reservationResult;
  try {
    reservationResult = await ledger.reserve(
      subject,
      config.monthlyAiBudgetUsd,
      reservationUsd,
      crypto.randomUUID(),
    );
  } catch (error) {
    throw new AiBudgetUnavailableError(error);
  }
  if (reservationResult.status === "limited") {
    return { kind: "limited", usage: reservationResult.usage };
  }
  const reservation = reservationResult.reservation;

  let upstream;
  try {
    upstream = await fetchImpl(`${apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": String(appUrl || "https://quantaintellect.com"),
        "X-Title": "Vessel Browser",
      },
      body: serializedUpstreamBody,
    });
  } catch (error) {
    return reconcileBeforeRethrow(ledger, subject, reservation, null, false, error);
  }

  let text;
  try {
    text = await upstream.text();
  } catch (error) {
    return reconcileBeforeRethrow(ledger, subject, reservation, null, upstream.ok, error);
  }

  let responseBody = text;
  let responseUsage = null;
  try {
    const parsed = JSON.parse(text);
    responseUsage = parsed.usage || null;
    parsed.model = model;
    parsed.vessel = { plan, model };
    responseBody = JSON.stringify(parsed);
  } catch {
    // Preserve non-JSON provider responses while still reconciling the reservation.
  }
  await ledger.reconcile(subject, reservation, responseUsage, upstream.ok);

  return {
    kind: "response",
    body: responseBody,
    status: upstream.status,
    contentType: upstream.headers.get("Content-Type") || "application/json",
  };
}
