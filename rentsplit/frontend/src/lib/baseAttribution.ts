import { Attribution } from "ox/erc8021";
import type { Hex } from "viem";

export function getFrontendBuilderDataSuffix(rawCode = import.meta.env.VITE_BASE_BUILDER_CODE): Hex | undefined {
  const code = rawCode?.trim();
  if (!code) return undefined;
  if (code.length > 64 || !/^[\x21-\x2b\x2d-\x7e]+$/.test(code)) {
    if (import.meta.env.DEV) console.info("Kvara Builder attribution disabled: invalid VITE_BASE_BUILDER_CODE.");
    return undefined;
  }
  try {
    return Attribution.toDataSuffix({ codes: [code] });
  } catch {
    if (import.meta.env.DEV) console.info("Kvara Builder attribution disabled: code could not be encoded.");
    return undefined;
  }
}
