export const KVARA_PROFILE_REGISTRY_ADDRESS = "0x49ab431ebeca10baa558c8513fcaa69d2827e070" as const;

export const KVARA_PROFILE_REGISTRY_ABI = [
  {
    type: "function",
    name: "profileOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "role", type: "uint8" }]
  },
  {
    type: "function",
    name: "setProfile",
    stateMutability: "nonpayable",
    inputs: [{ name: "role", type: "uint8" }],
    outputs: []
  },
  {
    type: "event",
    name: "ProfileSet",
    anonymous: false,
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "role", type: "uint8", indexed: false }
    ]
  }
] as const;

export type KvaraProfileRole = "resident" | "landlord" | "both";

export function profileRoleToChain(role: KvaraProfileRole): number {
  if (role === "resident") return 1;
  if (role === "landlord") return 2;
  return 3;
}

export function profileRoleFromChain(value: number): KvaraProfileRole | null {
  if (value === 1) return "resident";
  if (value === 2) return "landlord";
  if (value === 3) return "both";
  return null;
}

export function profileRoleLabel(role: KvaraProfileRole): string {
  if (role === "resident") return "Resident";
  if (role === "landlord") return "Landlord";
  return "Resident + landlord";
}
