# Draft message to IMD

Not sent. Drafted for you to review, edit, and send through whatever channel you have with them
(support email, Discord, etc.) — this repo has no confirmed contact channel on file.

---

Hi — building on top of the oracle API (`api.imd.fun`). A few things I couldn't find in the public
docs and had to work out by reading the explorer app's own frontend bundle. Wanted to check these
with you directly rather than keep relying on a reverse-engineered understanding.

**1. Payment-signing schema.** The docs don't cover how a client is supposed to construct and sign
the payment for a paid `oracle.request`. I recovered the schema from `explorer.imd.fun`'s shipped JS
— a Permit2 `PermitWitnessTransferFrom` signature plus a separate EIP-712 "QuoteApproval" signature,
sent as a base64-JSON `PAYMENT-SIGNATURE` header, with a fixed intermediary spender
(`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`). Implemented it and it worked — a real paid request
was admitted on the first attempt (tx
`0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb`). Can you confirm this is
actually the intended, stable schema, and not just current frontend implementation detail that could
change without notice? If it's meant to be public, it'd save the next integrator from having to do
the same archaeology.

**2. Panel disagreement / source clustering.** On that same real request, all 4 responding panelists
independently reached the same correct real-world answer, but the request still resolved
`"disagreed"` (`"1 of 4 answers agreed; 4 were required."`). Looking at the response, the clustering
appears to key off each panelist's cited source URL rather than the answer itself — 3 members cited
a GitHub API URL, 1 cited the equivalent web page, and they weren't unified into one cluster. Is that
expected behavior? Does `guards.sources` (or some other request-time parameter) let a requester
constrain which source panelists must cite, to make clustering more reliable? As it stands, this
means a real "true" outcome can end up with zero attestation ever signed, indistinguishable
on-chain from "never assessed."

**3. Panel size and pricing.** Everything so far has used the default panel size at the listed flat
price (0.5 IMD). Does requesting a larger panel (7, 9 members) change the price, or is that governed
some other way? Wanted to check before running a real paid quote at a non-default size.

Happy to share more detail on any of this — the tx, the recovered schema, or the full disagreement
response — if useful on your end.
