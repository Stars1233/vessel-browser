const MAX_ACTIVATION_CODE_ATTEMPTS = 5;

export class ActivationAttemptGuard {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const action = body?.action;
    if (action !== "check" && action !== "invalid" && action !== "redeem") {
      return Response.json({ error: "Invalid activation guard action" }, { status: 400 });
    }

    const result = await this.storage.transaction(async (transaction) => {
      const stored = await transaction.get("challenge");
      const challenge = stored && typeof stored === "object"
        ? stored
        : { attempts: 0, redeemed: false };

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
      await this.storage.setAlarm(expiresAt);
    }
    return Response.json(result);
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}
