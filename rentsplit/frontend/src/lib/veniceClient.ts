import type { PaymentRecord, RentCommand, RentGroup } from "./groupStorage";

const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export type VeniceMessage = {
  role: "user" | "assistant";
  content: string;
};

export type VeniceAgentResponse = {
  message: string;
  commands: RentCommand[];
};

export async function sendVeniceMessage(input: {
  message: string;
  group: RentGroup;
  history: PaymentRecord[];
}): Promise<VeniceAgentResponse> {
  const response = await fetch(`${API_URL}/api/venice/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  const json = (await response.json().catch(() => ({}))) as VeniceAgentResponse & { error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? `Venice request failed with ${response.status}`);
  }
  return json;
}
