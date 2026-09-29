import type { Challenge } from "../../imd-client/src/types.ts";
import {
  buildPermit2Authorization,
  permit2PaymentTypedData,
  quoteApprovalTypedData,
  encodePaymentSignatureHeader,
} from "../../imd-client/src/paymentSigning.ts";
import type { PaymentPayload } from "../../imd-client/src/paymentSigning.ts";

export interface PaymentSignature {
  paymentSignatureB64: string;
  quoteSignature: string;
}

export type PaymentSigner = (challenge: Challenge) => Promise<PaymentSignature>;

// Kept for callers that haven't wired a real signer at all.
export class PaymentSigningNotWiredError extends Error {
  constructor() {
    super(
      "No PaymentSigner was provided. Use imdPaymentSigner(account) (see paymentSigner.ts) with a " +
        "real signing account, or provide your own PaymentSigner via ResolveDealOptions.",
    );
    this.name = "PaymentSigningNotWiredError";
  }
}

export const NOT_IMPLEMENTED_PAYMENT_SIGNER: PaymentSigner = async () => {
  throw new PaymentSigningNotWiredError();
};

// Minimal signer interface — matches viem's LocalAccount / WalletClient account shape (address +
// signTypedData) without depending on viem's own types here.
export interface TypedDataSigner {
  address: `0x${string}`;
  signTypedData(args: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

// The real IMD payment signer: builds and signs both required signatures — the Permit2
// PermitWitnessTransferFrom payment, then the QuoteApproval binding it to the exact quote —
// following the schema reverse-engineered from IMD's own shipped frontend (explorer.imd.fun),
// documented in docs/DAY-ONE-FINDINGS.md §13. Never live-tested against a real paid submission
// (that costs real $IMD) — see this project's README for what's confirmed vs. what still needs a
// real end-to-end run.
export function imdPaymentSigner(account: TypedDataSigner): PaymentSigner {
  return async (challenge: Challenge): Promise<PaymentSignature> => {
    const accept = challenge.accepts[0];
    if (!accept) throw new Error("challenge.accepts is empty — nothing to pay with");

    const auth = buildPermit2Authorization(account.address, accept);
    const paymentTypedData = permit2PaymentTypedData(accept.network, auth);
    const paymentSignature = await account.signTypedData(paymentTypedData);

    const payload: PaymentPayload = {
      x402Version: 2,
      payload: { signature: paymentSignature, permit2Authorization: auth },
      accepted: accept,
    };

    const approvalTypedData = quoteApprovalTypedData(challenge.quote, challenge, payload);
    const quoteSignature = await account.signTypedData(approvalTypedData);

    return { paymentSignatureB64: encodePaymentSignatureHeader(payload), quoteSignature };
  };
}
