import type { PaymentRecord } from "./types.js";

type Roommate = {
  id: string;
  name: string;
  walletAddress: `0x${string}`;
  share: string;
};

type RentGroup = {
  id: string;
  landlordAddress: `0x${string}`;
  totalRent: string;
  roommates: Roommate[];
};

export type RentCommand =
  | {
      type: "set_splits";
      splits: Array<{ roommateId: string; share: string }>;
      reason?: string;
    }
  | {
      type: "add_roommate";
      name: string;
      walletAddress: `0x${string}`;
      share: string;
    }
  | {
      type: "remove_roommate";
      roommateId: string;
    };

type VeniceAgentResult = {
  message: string;
  commands: RentCommand[];
};

const VENICE_BASE_URL = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";
const VENICE_MODEL = process.env.VENICE_MODEL ?? "llama-3.3-70b";

const SYSTEM_PROMPT = `You are Kvara, an autonomous rent agent for shared apartments.
You receive a rent group, payment history, and one user message.
Return compact JSON only:
{
  "message": "human readable answer",
  "commands": [
    {"type":"set_splits","splits":[{"roommateId":"...","share":"123.45"}],"reason":"..."},
    {"type":"add_roommate","name":"...","walletAddress":"0x...","share":"123.45"},
    {"type":"remove_roommate","roommateId":"..."}
  ]
}
Rules:
- Preserve total monthly rent when changing splits.
- Use decimal USDC strings with two decimals.
- Do not invent wallet addresses.
- If the user only asks a question, return an empty commands array.`;

export async function runVeniceAgent(input: {
  message: string;
  group: RentGroup;
  history: PaymentRecord[];
}): Promise<VeniceAgentResult> {
  if (!process.env.VENICE_API_KEY) {
    return localAgent(input);
  }

  try {
    const response = await fetch(`${VENICE_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`
      },
      body: JSON.stringify({
        model: VENICE_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              message: input.message,
              group: input.group,
              paymentHistory: input.history
            })
          }
        ]
      })
    });

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(json.error?.message ?? `Venice HTTP ${response.status}`);

    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("Venice returned an empty response.");
    return sanitizeAgentResult(JSON.parse(stripJsonFence(content)));
  } catch (cause) {
    const fallback = localAgent(input);
    return {
      message: `${fallback.message} Venice fallback: ${cause instanceof Error ? cause.message : "request failed"}`,
      commands: fallback.commands
    };
  }
}

function localAgent(input: { message: string; group: RentGroup; history: PaymentRecord[] }): VeniceAgentResult {
  const lower = input.message.toLowerCase();
  if (/(total|month|сколько|месяц|итого)/i.test(input.message)) {
    const now = new Date();
    const total = input.history
      .filter((record) => record.status === "confirmed")
      .filter((record) => {
        const date = new Date(record.date);
        return date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth();
      })
      .reduce((sum, record) => sum + Number(record.amount || 0), 0);
    return { message: `Confirmed this month: ${total.toFixed(2)} USDC.`, commands: [] };
  }

  const awayRoommate = input.group.roommates.find((roommate) => lower.includes(roommate.name.toLowerCase()));
  const weeks = input.message.match(/(\d+)\s*(?:week|weeks|недел|нед)/i);
  const days = input.message.match(/(\d+)\s*(?:day|days|день|дня|дней|дн)/i);

  if (awayRoommate && (weeks || days)) {
    const awayDays = weeks ? Number(weeks[1]) * 7 : Number(days?.[1] ?? 0);
    const presentDays = Math.max(0, Math.min(30, 30 - awayDays));
    const originalShare = Number(awayRoommate.share);
    const adjustedShare = roundMoney((originalShare * presentDays) / 30);
    const remainder = roundMoney(originalShare - adjustedShare);
    const others = input.group.roommates.filter((roommate) => roommate.id !== awayRoommate.id);
    const perOther = others.length > 0 ? roundMoney(remainder / others.length) : 0;
    const splits = input.group.roommates.map((roommate) => ({
      roommateId: roommate.id,
      share:
        roommate.id === awayRoommate.id
          ? adjustedShare.toFixed(2)
          : roundMoney(Number(roommate.share) + perOther).toFixed(2)
    }));

    return {
      message: `${awayRoommate.name} prorated for ${awayDays} away days. Updated split keeps total rent at ${Number(
        input.group.totalRent
      ).toFixed(2)} USDC.`,
      commands: [{ type: "set_splits", splits, reason: "Prorated temporary absence" }]
    };
  }

  return {
    message: "I can rebalance splits, summarize payment history, and prepare roommate changes.",
    commands: []
  };
}

function sanitizeAgentResult(value: unknown): VeniceAgentResult {
  if (!value || typeof value !== "object") return { message: "No structured response.", commands: [] };
  const result = value as Partial<VeniceAgentResult>;
  return {
    message: typeof result.message === "string" ? result.message : "Done.",
    commands: Array.isArray(result.commands) ? result.commands.filter(isCommand) : []
  };
}

function isCommand(command: unknown): command is RentCommand {
  if (!command || typeof command !== "object" || !("type" in command)) return false;
  const type = (command as { type?: unknown }).type;
  return type === "set_splits" || type === "add_roommate" || type === "remove_roommate";
}

function stripJsonFence(content: string): string {
  return content.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
