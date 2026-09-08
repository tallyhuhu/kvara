import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import propertyHero from "../assets/property-hero.png";
import "./proof.css";

type Proof = {
  chainId: number; updatedAt: string;
  metrics: { households: number; payingWallets: number; payments: number; settledUsdc: string; transactions: number };
  coverage: { candidateRecords: number; checkedRecords: number; limited: boolean; finality: string };
  recent: Array<{ txHash: string; logIndex: number; amount: string; timestamp: string; basescanUrl: string; status: string }>;
  attribution: { status: string; code: string | null };
  addresses: { usdc: string };
};
const api = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";
const date = (value: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
const short = (value: string) => `${value.slice(0, 8)}...${value.slice(-6)}`;

export function ProofPage() {
  const [proof, setProof] = useState<Proof>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    document.title = "Kvara Live Proof | Real activity on Base";
    return () => { document.title = "Kvara"; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true); setError(false);
    fetch(`${api}/api/public/proof`, { signal: controller.signal, credentials: "omit" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        const result = await response.json() as Proof;
        if (result.chainId !== 8453 || !result.metrics || !Array.isArray(result.recent)) throw new Error("Invalid proof");
        if (current) setProof(result);
      }).catch(() => { if (current) setError(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [revision]);
  const metrics = proof ? [
    [proof.metrics.settledUsdc, "USDC settled", "Verified native USDC transfers."],
    [String(proof.metrics.payments), "Rent transfers", "Distinct payment transfer events."],
    [String(proof.metrics.payingWallets), "Paying wallets", "Distinct senders of verified rent."],
    [String(proof.metrics.transactions), "Base transactions", "Distinct verified payment hashes."],
    [String(proof.metrics.households), "Households recorded", "Includes closed and test households."]
  ] : [];
  return (
    <main className="proof-page">
      <div className="proof-shell">
        <header className="proof-header">
          <a className="proof-brand" href="/" aria-label="Kvara home">Kvara<span>.</span></a>
          <nav aria-label="Main navigation"><a href="/"><ArrowLeft size={15} /> Home</a><a className="proof-open" href="/#app">Open app <ArrowUpRight size={15} /></a></nav>
        </header>
        <section className="proof-intro">
          <div><p className="proof-network"><span /> Base Mainnet</p><h1>Kvara Live Proof</h1><p>Real activity on Base. Open to verification.</p></div>
          <div className="proof-update"><button type="button" onClick={() => setRevision((n) => n + 1)} disabled={loading} aria-label="Refresh metrics" title="Refresh metrics"><RefreshCw size={18} className={loading ? "proof-spin" : ""} /></button>
            <span>{proof ? <>Last updated<br /><time dateTime={proof.updatedAt}>{date(proof.updatedAt)} UTC</time></> : "Checking recorded activity"}</span></div>
        </section>
        <div aria-live="polite">
          {error && <p className="proof-notice" role="alert">Live proof is temporarily unavailable. {proof ? "The figures below are from the last successful update." : "No figures are shown until verification succeeds."} <button onClick={() => setRevision((n) => n + 1)} disabled={loading}>Try again</button></p>}
          {loading && !proof && <p className="proof-empty" role="status">Verifying recorded payments on Base...</p>}
        </div>
        {proof && <>
          <dl className="proof-metrics" aria-label="Product metrics">{metrics.map(([value, label, definition]) => <div key={label}><dt>{label}</dt><dd>{value}<p>{definition}</p></dd></div>)}</dl>
          <p className="proof-scope">Payment figures cover receipt-verified records in this deployment, not all Kvara history or Base Dashboard users. Real test transfers are included; simulated, failed and pending payments are not.</p>
          {proof.coverage.limited && <p className="proof-notice">Coverage is limited to the latest {proof.coverage.checkedRecords.toLocaleString("en-US")} confirmed records out of {proof.coverage.candidateRecords.toLocaleString("en-US")}. Payment totals are a verified subset, not lifetime totals.</p>}
          <section className="proof-ledger">
            <div className="proof-section-heading"><h2>Recent onchain proof</h2><span>Finalized on Base</span></div>
            {proof.recent.length === 0 ? <div className="proof-empty"><h3>No verified transfers yet</h3><p>Confirmed ledger records appear here once a matching USDC transfer is finalized on Base.</p></div> :
              <div className="proof-table-scroll"><table><caption className="sr-only">Recent verified rent transfers on Base Mainnet</caption><thead><tr><th scope="col">Date / UTC</th><th scope="col">Activity</th><th scope="col">USDC</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead><tbody>
                {proof.recent.map((row) => <tr key={`${row.txHash}:${row.logIndex}`}><td><time dateTime={row.timestamp}>{date(row.timestamp)}</time></td><td>Rent transfer</td><td className="proof-amount">{row.amount}</td><td><span className="proof-confirmed">Confirmed</span></td><td><a href={`https://basescan.org/tx/${row.txHash}`} target="_blank" rel="noopener noreferrer" aria-label={`View transaction ${row.txHash} on Basescan`}><code>{short(row.txHash)}</code><ArrowUpRight size={14} /></a></td></tr>)}
              </tbody></table></div>}
          </section>
          <section className="proof-details">
            <div><h2>Builder attribution</h2><p>{proof.attribution.status === "configured" ? "Base Builder Code / ERC-8021 is configured for supported Kvara execution paths." : "A valid Builder Code is not configured on this backend."}</p>
              {proof.attribution.code && <code className="proof-code">{proof.attribution.code}</code>}
              <p>Configuration is not proof of attribution for every historical transaction. Base Dashboard counts are not imported here.</p></div>
            <div><h2>Direct settlement</h2><p>Native USDC on Base Mainnet. Residents grant bounded spending permissions; the agent executes payments through account abstraction.</p><p>Rent moves from each resident to the landlord, without a Kvara rent pool. There is no custom rent contract.</p>
              <a href={`https://basescan.org/address/${proof.addresses.usdc}`} target="_blank" rel="noopener noreferrer">Base USDC contract <ArrowUpRight size={14} /></a>
              <code className="proof-address">{proof.addresses.usdc}</code></div>
          </section>
          <section className="proof-method">
            <h2>What these numbers mean</h2>
            <p>This is early product activity, including real mainnet testing. Wallets are not necessarily different people or customers.</p>
            <details><summary>Sources, counting and limitations</summary><p>Households: all rows in the current Kvara database, including closed leases and testing. These are product records, not onchain attestations.</p><p>Payments: only records marked confirmed, matched to a successful finalized Base receipt and a native USDC Transfer event with the recorded sender, landlord and exact amount. Each transaction hash + log index is counted once. Volume is summed in six-decimal USDC units, without floating-point arithmetic.</p><p>Paying wallets and payment transactions are distinct addresses and hashes within those verified transfers. Profile registrations, invitations, login sessions, gas costs and unverified records are excluded. Missing or changed landlord records can reduce coverage. Payment totals are not a complete chain index.</p><p>The endpoint checks up to 1,000 recent confirmed ledger records and caches successful results for 60 seconds. Finalization may delay newly confirmed transactions. An RPC failure is shown as unavailable, never as zero activity.</p><p>No names, apartment addresses, login data or permission credentials are published. Basescan links expose only already-public transaction evidence. This page does not assert a historical Builder attribution start date.</p></details>
          </section>
        </>}
        <footer className="proof-footer"><img src={propertyHero} alt="" /><div><a className="proof-brand" href="/">Kvara<span>.</span></a><p>A little less to think about.</p></div><a href="/#app">Open your rent desk <ArrowUpRight size={16} /></a></footer>
      </div>
    </main>
  );
}
