import { FormEvent, useState } from "react";
import { Bot, Check, Send, X } from "lucide-react";
import { sendVeniceMessage, type VeniceMessage } from "../lib/veniceClient";
import type { PaymentRecord, RentCommand, RentGroup } from "../lib/groupStorage";

type Props = {
  group: RentGroup;
  history: PaymentRecord[];
  onCommands: (commands: RentCommand[]) => void;
};

export function VeniceChat({ group, history, onCommands }: Props) {
  const [messages, setMessages] = useState<VeniceMessage[]>([
    { role: "assistant", content: "Household agent online." }
  ]);
  const [input, setInput] = useState("");
  const [pendingCommands, setPendingCommands] = useState<RentCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || loading) return;

    setInput("");
    setError(null);
    setLoading(true);
    setMessages((current) => [...current, { role: "user", content: message }]);

    try {
      const response = await sendVeniceMessage({ message, group, history });
      setPendingCommands(response.commands);
      setMessages((current) => [...current, { role: "assistant", content: response.message }]);
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : "Venice request failed";
      setError(errorMessage);
      setMessages((current) => [...current, { role: "assistant", content: errorMessage }]);
    } finally {
      setLoading(false);
    }
  }

  function applyPendingCommands() {
    onCommands(pendingCommands);
    setPendingCommands([]);
  }

  return (
    <section className="flex min-h-[300px] flex-col border border-stone-300 bg-[#f7f2e8] sm:min-h-[420px]">
      <div className="flex items-center justify-between gap-3 border-b border-stone-300 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot size={18} className="text-emerald-900" />
          <h2 className="text-sm font-semibold uppercase text-stone-950">Agent desk</h2>
        </div>
        <span className="text-xs font-semibold uppercase text-stone-500">Venice</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`max-w-[88%] px-3 py-2 text-sm ${
              message.role === "user"
                ? "ml-auto bg-emerald-950 text-white"
                : "bg-white text-stone-800"
            }`}
          >
            {message.content}
          </div>
        ))}
        {loading ? <div className="bg-white px-3 py-2 text-sm text-stone-500">Thinking</div> : null}
      </div>

      {pendingCommands.length > 0 ? (
        <div className="border-t border-stone-300 bg-[#ebe3d3] px-4 py-3">
          <p className="text-sm font-semibold text-stone-950">{commandSummary(pendingCommands)}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={applyPendingCommands}
              className="inline-flex h-9 items-center gap-2 bg-emerald-950 px-3 text-sm font-semibold text-white transition hover:bg-emerald-900"
            >
              <Check size={15} />
              Apply
            </button>
            <button
              type="button"
              onClick={() => setPendingCommands([])}
              className="inline-flex h-9 items-center gap-2 border border-stone-400 px-3 text-sm font-semibold text-stone-700 transition hover:bg-white"
            >
              <X size={15} />
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {error ? <div className="border-t border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-stone-300 p-3">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Вася уехал на 2 недели, пересчитай"
          className="min-w-0 flex-1 border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-800 focus:ring-2 focus:ring-emerald-100"
        />
        <button
          type="submit"
          disabled={loading}
          className="grid h-10 w-10 place-items-center bg-emerald-950 text-white transition hover:bg-emerald-900 disabled:bg-stone-300"
          aria-label="Send"
          title="Send"
        >
          <Send size={17} />
        </button>
      </form>
    </section>
  );
}

function commandSummary(commands: RentCommand[]): string {
  const splitCommands = commands.filter((command) => command.type === "set_splits").length;
  const addCommands = commands.filter((command) => command.type === "add_roommate").length;
  const removeCommands = commands.filter((command) => command.type === "remove_roommate").length;
  const parts = [
    splitCommands ? `${splitCommands} split update` : "",
    addCommands ? `${addCommands} add` : "",
    removeCommands ? `${removeCommands} remove` : ""
  ].filter(Boolean);
  return parts.length > 0 ? `Pending: ${parts.join(", ")}` : "Pending update";
}
