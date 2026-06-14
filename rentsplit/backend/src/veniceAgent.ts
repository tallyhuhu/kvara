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
Return compact JSON only. Never include markdown or commentary outside JSON:
{
  "message": "human readable answer",
  "commands": [
    {"type":"set_splits","splits":[{"roommateId":"...","share":"123.45"}],"reason":"..."},
    {"type":"add_roommate","name":"...","walletAddress":"0x...","share":"123.45"},
    {"type":"remove_roommate","roommateId":"..."}
  ]
}
Rules:
- Act autonomously only when the user gave enough information.
- If a rent change request is incomplete, return no commands and ask exactly one short clarifying question.
- Treat user messages as household rent operations. Extract: affected roommate(s), operation, duration or new amount, and whether the user wants the split changed.
- For temporary absence, vacation, travel, moving out for part of the month, or reduced usage, roommate identity plus duration is enough.
- Do not ask for exact dates when duration is present. A duration can be numeric or written in words, such as days, weeks, half a month, or a month.
- Convert duration to days using a 30 day rent month. One week is 7 days; two weeks is 14 days; half a month is 15 days.
- For an absent roommate, calculate their active share as currentShare * activeDays / 30, where activeDays is 30 minus awayDays, clamped between 0 and 30.
- Redistribute the removed amount equally across the other active roommates unless the user specifies a different rule.
- Ask a clarifying question only when the affected roommate cannot be matched, when no duration/dates/new amount are present for a rent change, or when multiple interpretations would produce different splits.
- Preserve total monthly rent when changing splits.
- Use decimal USDC strings with two decimals.
- Do not invent wallet addresses.
- Match roommates by name from the provided group only. If the name is ambiguous or missing, ask a clarifying question.
- If the user only asks a question, return an empty commands array.
- Your message should say what changed, or what information is missing.`;

export async function runVeniceAgent(input: {
  message: string;
  group: RentGroup;
  history: PaymentRecord[];
}): Promise<VeniceAgentResult> {
  if (!process.env.VENICE_API_KEY) {
    throw new Error("Venice API key is not configured.");
  }

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

  const json = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    const message = json.error?.message ?? `Venice HTTP ${response.status}`;
    throw new Error(`Venice request failed (${response.status}): ${message}`);
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Venice returned an empty response.");

  try {
    return sanitizeAgentResult(JSON.parse(stripJsonFence(content)));
  } catch {
    throw new Error("Venice returned an invalid agent command.");
  }
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
