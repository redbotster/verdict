import { randomBytes } from "node:crypto";
import type {
  Capabilities,
  Challenge,
  ImdAction,
  ImdError,
  Order,
  RequestStatus,
} from "./types.ts";
import { ImdApiError } from "./types.ts";

const BASE_URL = "https://api.imd.fun";

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok && res.status !== 402) throw new ImdApiError(res.status, body as ImdError);
  return body as T;
}

export function generateClientToken(): string {
  return randomBytes(32).toString("hex");
}

export class ImdClient {
  constructor(private readonly token: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  // Step 1 — always re-read; never hardcode price/payTo/quoteTtlSeconds.
  static async getCapabilities(): Promise<Capabilities> {
    const res = await fetch(`${BASE_URL}/requests/capabilities`);
    return parseJsonOrThrow<Capabilities>(res);
  }

  // Step 3 — free. A 422 here means "refused, nothing charged": callers should
  // surface body.detail/problems to the question compiler's lint loop, not retry blindly.
  async quote(
    action: ImdAction,
    input: unknown,
    requestKey: string = crypto.randomUUID(),
  ): Promise<{ created: boolean; order: Order }> {
    const res = await fetch(`${BASE_URL}/requests/quote`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ requestKey, action, input }),
    });
    return parseJsonOrThrow(res);
  }

  // Step 4 — empty-body submit. Free: returns the 402 challenge, charges nothing.
  async getChallenge(orderId: string): Promise<Challenge> {
    const res = await fetch(`${BASE_URL}/requests/${orderId}/submit`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    if (res.status !== 402) {
      throw new Error(
        `expected 402 challenge, got ${res.status}: ${JSON.stringify(await res.json())}`,
      );
    }
    return res.json() as Promise<Challenge>;
  }

  // Steps 5+6 — NOT implemented here. IMD's quoteApprovalTypedData EIP-712 layout
  // (domain/types beyond what /requests/{id}/submit's 402 body exposes) is only
  // documented in IMD's own signing helper (apps/control-plane/src/paid-access/x402.ts
  // in Identity-md/protocol), which is not publicly reachable from here. Do not guess
  // at this schema — a wrong domain silently produces an invalid signature and IMD
  // returns 402 payment_rejected, or worse, signs something unintended. Get the exact
  // struct from IMD support/partnership docs, or from a real SDK they publish, before
  // wiring a signer in here.
  async pay(
    orderId: string,
    paymentSignatureB64: string,
    quoteSignature: string,
  ): Promise<RequestStatus> {
    const res = await fetch(`${BASE_URL}/requests/${orderId}/submit`, {
      method: "POST",
      headers: { ...this.headers(), "PAYMENT-SIGNATURE": paymentSignatureB64 },
      body: JSON.stringify({ quoteSignature }),
    });
    return parseJsonOrThrow(res);
  }

  // Step 7/8 — poll GET /requests/:id, then follow admission.result's own URLs
  // (workflow/oracle-specific poll, not covered by this shared client).
  async getStatus(orderId: string): Promise<RequestStatus> {
    const res = await fetch(`${BASE_URL}/requests/${orderId}`, {
      headers: this.headers(),
    });
    return parseJsonOrThrow(res);
  }

  async pollUntilAdmitted(
    orderId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<RequestStatus> {
    const intervalMs = opts.intervalMs ?? 3000;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getStatus(orderId);
      if (status.status === "admitted" || status.status === "expired" || status.status === "payment_failed") {
        return status;
      }
      if (Date.now() > deadline) throw new Error(`timed out polling order ${orderId}, last status ${status.status}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
