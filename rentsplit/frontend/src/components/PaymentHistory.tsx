import { ExternalLink } from "lucide-react";
import { formatUsd, type PaymentRecord } from "../lib/groupStorage";

type Props = {
  records: PaymentRecord[];
};

export function PaymentHistory({ records }: Props) {
  return (
    <section className="min-h-0 border border-stone-300 bg-[#f7f2e8]">
      <div className="flex items-center justify-between gap-3 border-b border-stone-300 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase text-stone-950">Payment history</h2>
        <span className="text-sm font-medium text-stone-500">{records.length} rows</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="bg-[#ebe3d3] text-xs uppercase text-stone-600">
            <tr>
              <th className="px-4 py-3 font-semibold">Date</th>
              <th className="px-4 py-3 font-semibold">Resident</th>
              <th className="px-4 py-3 font-semibold">Amount</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-200">
            {records.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-stone-500" colSpan={5}>
                  No payments yet
                </td>
              </tr>
            ) : (
              records.map((record) => (
                <tr key={record.id} className="text-stone-700">
                  <td className="px-4 py-3">{new Date(record.date).toLocaleString()}</td>
                  <td className="px-4 py-3 font-medium text-stone-950">{record.roommateName}</td>
                  <td className="px-4 py-3">{formatUsd(record.amount)} USDC</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 text-xs font-semibold uppercase ${statusClass(record.status)}`}>
                      {record.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {record.basescanUrl ? (
                      <a
                        href={record.basescanUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-emerald-800 hover:text-emerald-950"
                      >
                        {record.txHash ? `${record.txHash.slice(0, 8)}...` : record.taskId?.slice(0, 8)}
                        <ExternalLink size={14} />
                      </a>
                    ) : record.taskId ? (
                      <span className="font-mono text-xs text-stone-500">{record.taskId.slice(0, 10)}...</span>
                    ) : (
                      <span className="text-stone-400">{record.error ?? "-"}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function statusClass(status: PaymentRecord["status"]): string {
  if (status === "confirmed") return "bg-emerald-100 text-emerald-900";
  if (status === "submitted" || status === "pending") return "bg-amber-100 text-amber-900";
  return "bg-rose-100 text-rose-900";
}
