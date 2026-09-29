import { NewDealForm } from "./NewDealForm";

export const metadata = { title: "New deal — Verdict" };

export default function NewDealPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">New deal</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Compiles a real question against the live IMD API, then walks payer and payee through the spec&apos;s dual-approval
          step — both review the pinned question and sign off before funding.
        </p>
      </div>
      <NewDealForm />
      <p className="text-center text-xs text-zinc-400 dark:text-zinc-600">
        This produces a deployment payload, it doesn&apos;t deploy anything. See{" "}
        <code className="font-mono">site/README.md</code> for what&apos;s real here and what&apos;s still a placeholder.
      </p>
    </div>
  );
}
