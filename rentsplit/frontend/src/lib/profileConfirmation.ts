import type { KvaraProfileRole } from "./profileRegistry";

// Pin the read to the receipt block: a load-balanced RPC's latest head can lag behind it.
export async function readConfirmedProfile(
  read: (blockNumber: bigint) => Promise<KvaraProfileRole | null>,
  blockNumber: bigint,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1500))
): Promise<KvaraProfileRole> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const role = await read(blockNumber);
      if (role) return role;
    } catch {
      // A receipt may be available before the same block is readable on every RPC node.
    }
    if (attempt < 5) await pause();
  }
  throw new Error("Your transaction is confirmed, but Base profile verification is still pending. Use Check confirmation to check the same transaction without sending another.");
}
