export type ImdAction =
  | "job.open"
  | "launch.open"
  | "oracle.request"
  | "workflow.open"
  | "schedule.create"
  | "schedule.topup";

export interface PaymentPolicy {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  decimals: number;
}

export interface ActionPolicy {
  action: ImdAction;
  version: string;
  payment: PaymentPolicy;
  quoteTtlSeconds: number;
  limits?: Record<string, unknown>;
}

export interface Capabilities {
  actions: ActionPolicy[];
  limits: Record<string, unknown>;
  authentication: Record<string, unknown>;
  payment: Record<string, unknown>;
}

export interface Quote {
  v: 1;
  id: string;
  action: ImdAction;
  policyVersion: string;
  inputHash: string;
  issuedAt: number;
  expiresAt: number;
  payment: PaymentPolicy & { scheme: "exact" };
  unitAmount?: string;
  runs?: number;
  terms: { purchase: "action-admission"; resultGuaranteed: false };
  quoteHash: string;
}

export type OrderStatus =
  | "quoted"
  | "expired"
  | "payment_pending"
  | "payment_failed"
  | "paid";

export interface Order {
  id: string;
  requestKey: string;
  status: OrderStatus;
  quote: Quote;
  inputJson: string;
  createdAt: string;
  paidAt: string | null;
}

export type StatusValue =
  | "quoted"
  | "expired"
  | "payment_pending"
  | "payment_failed"
  | "admission_pending"
  | "admitted";

export interface RequestStatus {
  status: StatusValue;
  order: Order;
  payment: Record<string, unknown> | null;
  admission: Record<string, unknown> | null;
}

export interface X402Accept {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { assetTransferMethod?: "permit2"; [k: string]: unknown };
}

export interface Challenge {
  x402Version: 2;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: X402Accept[];
  quote: Quote;
  requesterScopeHash: string;
  resourceUrl: string;
  input: unknown;
}

export interface ImdError {
  error: string;
  detail?: string;
  reason?: string;
  problems?: unknown[];
}

export class ImdApiError extends Error {
  httpStatus: number;
  body: ImdError;

  constructor(httpStatus: number, body: ImdError) {
    super(`IMD ${httpStatus}: ${body.error}${body.detail ? ` — ${body.detail}` : ""}`);
    this.name = "ImdApiError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}
