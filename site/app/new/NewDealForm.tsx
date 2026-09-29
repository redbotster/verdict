"use client";

import { useState } from "react";
import { createWalletClient, createPublicClient, custom, getContractAddress, type Address } from "viem";
import { compileReleaseDeal, registerDeal, getDeploymentArtifact, type CompileFormInput } from "./actions";
import { computeTermsHash } from "@/lib/terms";
import type { OracleRequestInput } from "@verdict/oracle-compiler";

const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

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

  const [deployedAddress, setDeployedAddress] = useState("");
  const [rpcUrl, setRpcUrl] = useState("");
  const [chainId, setChainId] = useState("1");
  const [registerStatus, setRegisterStatus] = useState<"idle" | "pending" | "done">("idle");
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [deployStatus, setDeployStatus] = useState<"idle" | "approving" | "deploying" | "done">("idle");
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployTxHashes, setDeployTxHashes] = useState<{ approve?: `0x${string}`; deploy?: `0x${string}` }>({});

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

  // Deploys the real contract with the payer's connected wallet — the payer has to approve the token
  // spend anyway (the constructor pulls `amount` via transferFrom), so the payer is also the one who
  // pays gas to deploy. The escrow address isn't known until deployment, so this approves a
  // nonce-predicted CREATE address first (same trick as server/resolver/scripts/base-mainnet-demo.ts),
  // then deploys and confirms the result actually landed at that exact address.
  async function handleDeploy() {
    if (!compiled || !payerAddress || !payeeAddress || !payerAuthorization) return;
    setDeployError(null);
    setDeployTxHashes({});
    try {
      if (!window.ethereum) throw new Error("No browser wallet found.");
      const { abi, bytecode } = await getDeploymentArtifact();
      const walletClient = createWalletClient({ transport: custom(window.ethereum) });
      const publicClient = createPublicClient({ transport: custom(window.ethereum) });

      const chainIdNum = await publicClient.getChainId();
      const nonce = await publicClient.getTransactionCount({ address: payerAddress });
      // +1: the approve tx below consumes the current nonce first, so the deploy lands one after it.
      const predictedEscrow = getContractAddress({ from: payerAddress, nonce: BigInt(nonce + 1) });

      setDeployStatus("approving");
      const approveHash = await walletClient.writeContract({
        address: form.token as Address,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [predictedEscrow, BigInt(form.amount)],
        account: payerAddress,
        chain: null,
      });
      setDeployTxHashes((h) => ({ ...h, approve: approveHash }));
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== "success") throw new Error(`approve() reverted: ${approveHash}`);

      setDeployStatus("deploying");
      const deployHash = await walletClient.deployContract({
        abi,
        bytecode,
        args: [
          payerAddress,
          payeeAddress,
          form.token as Address,
          BigInt(form.amount),
          deadlineSeconds,
          BigInt(Number(form.graceHours) * 3600),
          compiled.questionHash,
          form.oracleSigner as Address,
          form.feeRecipient as Address,
          Number(form.feeBps),
          BigInt(Number(form.challengeWindowHours) * 3600),
          "IMD-Attestation",
          "1",
          payerAuthorization,
        ],
        account: payerAddress,
        chain: null,
      });
      setDeployTxHashes((h) => ({ ...h, deploy: deployHash }));
      const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
      if (deployReceipt.status !== "success") throw new Error(`deployment reverted: ${deployHash}`);
      if (!deployReceipt.contractAddress) throw new Error(`deploy succeeded but the receipt has no contractAddress: ${deployHash}`);
      if (deployReceipt.contractAddress.toLowerCase() !== predictedEscrow.toLowerCase()) {
        throw new Error(`deployed to ${deployReceipt.contractAddress}, predicted ${predictedEscrow} — another transaction from this wallet landed in between`);
      }

      setDeployedAddress(deployReceipt.contractAddress);
      setChainId(String(chainIdNum));
      setDeployStatus("done");
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : String(err));
      setDeployStatus("idle");
    }
  }

  async function handleRegister() {
    if (!compiled) return;
    setRegisterStatus("pending");
    setRegisterError(null);
    const result = await registerDeal({
      escrowAddress: deployedAddress,
      chainId: Number(chainId),
      rpcUrl,
      githubRepo: form.githubRepo,
      input: compiled.input,
      questionHash: compiled.questionHash,
    });
    if (!result.ok) {
      setRegisterStatus("idle");
      setRegisterError(result.error);
      return;
    }
    setRegisterStatus("done");
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

      {step === "done" && compiled && deployStatus !== "done" && registerStatus !== "done" && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Deploy this escrow</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Sends two real transactions from the payer&apos;s wallet: approving the token spend, then deploying the contract, which pulls the funds in immediately. Your wallet
            will prompt for both. Gas is paid by the payer.
          </p>
          {deployError && <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{deployError}</div>}
          {deployTxHashes.approve && (
            <p className="break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">approve tx: {deployTxHashes.approve}</p>
          )}
          {deployTxHashes.deploy && (
            <p className="break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">deploy tx: {deployTxHashes.deploy}</p>
          )}
          <button
            disabled={deployStatus !== "idle"}
            onClick={handleDeploy}
            className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {deployStatus === "approving" && "Approving token spend…"}
            {deployStatus === "deploying" && "Deploying escrow…"}
            {deployStatus === "idle" && "Deploy with payer's wallet"}
          </button>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Deployed elsewhere instead? Skip this and paste the address directly into &quot;Register the deployed escrow&quot; below.
          </p>
        </div>
      )}

      {deployStatus === "done" && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          Deployed to <span className="font-mono text-xs">{deployedAddress}</span> on chain {chainId}. Fill in an RPC URL below and register it.
        </div>
      )}

      {step === "done" && compiled && registerStatus !== "done" && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Register the deployed escrow</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Once the payload above has actually been deployed, paste the resulting address here. This reads its real on-chain state and refuses to save anything whose
            questionHash doesn&apos;t match what was compiled.
          </p>
          {registerError && <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{registerError}</div>}
          <Field label="Deployed escrow address">
            <input className={inputClass} placeholder="0x…" value={deployedAddress} onChange={(e) => setDeployedAddress(e.target.value)} />
          </Field>
          <Field label="RPC URL" hint="must be reachable from this server, not just your browser">
            <input className={inputClass} placeholder="https://…" value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} />
          </Field>
          <Field label="Chain ID">
            <input type="number" className={inputClass} value={chainId} onChange={(e) => setChainId(e.target.value)} />
          </Field>
          <button
            disabled={registerStatus === "pending" || !deployedAddress || !rpcUrl}
            onClick={handleRegister}
            className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {registerStatus === "pending" ? "Reading on-chain state & saving…" : "Register deal"}
          </button>
        </div>
      )}

      {registerStatus === "done" && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          Registered. View it at{" "}
          <a href={`/deals/${deployedAddress}`} className="underline">
            /deals/{deployedAddress}
          </a>
          .
        </div>
      )}
    </div>
  );
}
