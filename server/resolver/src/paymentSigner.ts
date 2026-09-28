import type { Challenge } from "../../imd-client/src/types.ts";

export interface PaymentSignature {
  paymentSignatureB64: string;
  quoteSignature: string;
}

export type PaymentSigner = (challenge: Challenge) => Promise<PaymentSignature>;

// Same gap imd-client's pay() already documents: IMD's Permit2 payload and EIP-712
// quoteApprovalTypedData schema were never confirmed (their reference implementation is in a
// private repo — see docs/DAY-ONE-FINDINGS.md). Do not guess at this scheme.
export class PaymentSigningNotWiredError extends Error {
  constructor() {
    super(
      "IMD's Permit2 payment payload and quote-approval signing scheme are unconfirmed " +
        "(see docs/DAY-ONE-FINDINGS.md, 'What's still unconfirmed'). Provide a real PaymentSigner " +
        "via ResolveDealOptions once that scheme is obtained from IMD directly.",
    );
    this.name = "PaymentSigningNotWiredError";
  }
}

export const NOT_IMPLEMENTED_PAYMENT_SIGNER: PaymentSigner = async () => {
  throw new PaymentSigningNotWiredError();
};
