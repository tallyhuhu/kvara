import { authorizedRequest } from "./api";
import type { RentCommand, RentGroup } from "./groupStorage";

export type VeniceMessage = { role: "user" | "assistant"; content: string };
export type VeniceAgentResponse = { message: string; commands: RentCommand[]; group: RentGroup };

export async function sendVeniceMessage(input: { message: string; groupId: string }): Promise<VeniceAgentResponse> {
  return authorizedRequest("/api/venice/chat", { method: "POST", body: JSON.stringify(input) });
}
