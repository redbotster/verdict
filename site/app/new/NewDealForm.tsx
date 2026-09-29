"use client";

import { useState } from "react";
import { createWalletClient, custom, type Address } from "viem";
import { compileReleaseDeal, type CompileFormInput } from "./actions";
import { computeTermsHash } from "@/lib/terms";
import type { OracleRequestInput } from "@verdict/oracle-compiler";

type Step = "form" | "compiled" | "signed" | "done";

interface Compiled {
  input: OracleRequestInput;
  questionHash: `0x${string}`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  );
}

const inputClass = "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950";

async function connectWallet(): Promise<Address> {
  if (!window.ethereum) throw new Error("No browser wallet found (window.ethereum) — install one to continue.");
  const wallet = createWalletClient({ transport: custom(window.ethereum) });
  const [address] = await wallet.requestAddresses();
  return address;
}

export function NewDealForm() {
  const [step, setStep] = useState<Step>("form");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [form, setForm] = useState({
    githubRepo: "",
    deadlineIso: "",
    amount: "1000000000",
    token: "",
    oracleSigner: "",
    feeRecipient: "",
    feeBps: "100",
    graceHours: "168",
    challengeWindowHours: "24",
  });

  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [payeeAddress, setPayeeAddress] = useState<Address | null>(null);
  const [payerAddress, setPayerAddress] = useState<Address | null>(null);
  const [payerAuthorization, setPayerAuthorization] = useState<`0x${string}` | null>(null);
  const [payeeAcknowledgment, setPayeeAcknowledgment] = useState<`0x${string}` | null>(null);
  const [deadlineSeconds, setDeadlineSeconds] = useState<bigint>(0n);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleCompile(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const formInput: CompileFormInput = { githubRepo: form.githubRepo, deadlineIso: form.deadlineIso };
    const result = await compileReleaseDeal(formInput);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDeadlineSeconds(BigInt(Math.floor(new Date(form.deadlineIso).getTime() / 1000)));
    setCompiled({ input: result.input, questionHash: result.questionHash as `0x${string}` });
    setStep("compiled");
  }

  async function connectPayee() {
    setError(null);
    try {
      setPayeeAddress(await connectWallet());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function connectAndSignAsPayer() {
    if (!payeeAddress || !compiled) return;
    setError(null);
    try {
      if (!window.ethereum) throw new Error("No browser wallet found.");
      const wallet = createWalletClient({ transport: custom(window.ethereum) });
      const [payer] = await wallet.requestAddresses();
      const termsHash = computeTermsHash({
        payer,
        payee: payeeAddress,
        token: form.token as Address,
        amount: BigInt(form.amount),
        deadline: deadlineSeconds,
        grace: BigInt(Number(form.graceHours) * 3600),
        questionHash: compiled.questionHash,
        oracleSigner: form.oracleSigner as Address,
        feeRecipient: form.feeRecipient as Address,
        feeBps: Number(form.feeBps),
        challengeWindow: BigInt(Number(form.challengeWindowHours) * 3600),
      });
      const sig = await wallet.signMessage({ account: payer, message: { raw: termsHash } });
      setPayerAddress(payer);
      setPayerAuthorization(sig);
      setStep("signed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function signPayeeAcknowledgment() {
    if (!payeeAddress || !compiled) return;
    setError(null);
    try {
      if (!window.ethereum) throw new Error("No browser wallet found.");
      const wallet = createWalletClient({ transport: custom(window.ethereum) });
      const message = `I approve the Verdict deal terms with question hash ${compiled.questionHash} at ${new Date().toISOString()}`;
      const sig = await wallet.signMessage({ account: payeeAddress, message });
      setPayeeAcknowledgment(sig);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</div>}

      {step === "form" && (
        <form onSubmit={handleCompile} className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <Field label="GitHub repo" hint="owner/repo — the release_published template">
            <input required className={inputClass} placeholder="acme/widget" value={form.githubRepo} onChange={(e) => set("githubRepo", e.target.value)} />
          </Field>
          <Field label="Deadline">
            <input required type="datetime-local" className={inputClass} value={form.deadlineIso} onChange={(e) => set("deadlineIso", e.target.value)} />
          </Field>
          <Field label="Amount (token base units)" hint="e.g. 1000000000 = 1000 USDC at 6 decimals">
            <input required className={inputClass} value={form.amount} onChange={(e) => set("amount", e.target.value)} />
          </Field>
          <Field label="Token address">
            <input required className={inputClass} placeholder="0x…" value={form.token} onChange={(e) => set("token", e.target.value)} />
          </Field>
          <Field label="Oracle signer" hint="PLACEHOLDER — must match IMD's real attestation signer address, unconfirmed (see docs/DAY-ONE-FINDINGS.md)">
            <input required className={inputClass} placeholder="0x…" value={form.oracleSigner} onChange={(e) => set("oracleSigner", e.target.value)} />
          </Field>
          <Field label="Fee recipient">
            <input required className={inputClass} placeholder="0x…" value={form.feeRecipient} onChange={(e) => set("feeRecipient", e.target.value)} />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Fee (bps, max 200)">
              <input required type="number" min={0} max={200} className={inputClass} value={form.feeBps} onChange={(e) => set("feeBps", e.target.value)} />
            </Field>
            <Field label="Grace (hours)">
              <input required type="number" min={0} className={inputClass} value={form.graceHours} onChange={(e) => set("graceHours", e.target.value)} />
            </Field>
            <Field label="Challenge window (hours)">
              <input required type="number" min={0} className={inputClass} value={form.challengeWindowHours} onChange={(e) => set("challengeWindowHours", e.target.value)} />
            </Field>
          </div>
          <button disabled={pending} type="submit" className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
            {pending ? "Compiling against IMD…" : "Compile question"}
          </button>
        </form>
      )}

      {compiled && step !== "form" && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Compiled question (real IMD quote)</h2>
          <p className="text-sm text-zinc-800 dark:text-zinc-200">{compiled.input.question}</p>
          <p className="mt-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">questionHash: {compiled.questionHash}</p>
        </div>
      )}

      {step === "compiled" && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Dual approval</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            The payee connects first so the payer&apos;s signature can bind to both addresses. Neither signature is a transaction — nothing is sent on-chain here.
          </p>
          {!payeeAddress ? (
            <button onClick={connectPayee} className="self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700">
              Connect wallet as payee
            </button>
          ) : (
            <p className="text-sm">
              Payee: <span className="font-mono text-xs">{payeeAddress}</span>
            </p>
          )}
          {payeeAddress && (
            <button onClick={connectAndSignAsPayer} className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              Connect wallet as payer &amp; sign authorization
            </button>
          )}
        </div>
      )}

      {(step === "signed" || step === "done") && payerAddress && payerAuthorization && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Payer authorization signed</h2>
          <p className="text-sm">
            Payer: <span className="font-mono text-xs">{payerAddress}</span>
          </p>
          <p className="break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">{payerAuthorization}</p>
          {step === "signed" && (
            <button onClick={signPayeeAcknowledgment} className="self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700">
              Payee: review &amp; acknowledge these terms
            </button>
          )}
        </div>
      )}

      {step === "done" && compiled && payerAddress && payeeAddress && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Ready-to-deploy payload</h2>
          <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
            `oracleSigner`, `domainName`, and `domainVersion` are unconfirmed against a live IMD attestation — see docs/DAY-ONE-FINDINGS.md before actually deploying this.
          </p>
          <pre className="overflow-x-auto rounded-md bg-zinc-100 p-4 text-xs dark:bg-zinc-950">
            {JSON.stringify(
              {
                payer: payerAddress,
                payee: payeeAddress,
                token: form.token,
                amount: form.amount,
                deadline: deadlineSeconds.toString(),
                grace: (Number(form.graceHours) * 3600).toString(),
                questionHash: compiled.questionHash,
                oracleSigner: form.oracleSigner,
                feeRecipient: form.feeRecipient,
                feeBps: Number(form.feeBps),
                challengeWindow: (Number(form.challengeWindowHours) * 3600).toString(),
                domainName: "IMD-Attestation",
                domainVersion: "1",
                payerAuthorization,
                payeeAcknowledgment,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
