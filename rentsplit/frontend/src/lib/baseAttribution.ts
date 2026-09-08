import { Attribution } from "ox/erc8021";
import { concatHex, type Hex } from "viem";

export const KVARA_BASE_BUILDER_CODE = "bc_p5fkvcvx";

export function getFrontendBuilderDataSuffix(
  rawCode = import.meta.env.VITE_BASE_BUILDER_CODE ?? KVARA_BASE_BUILDER_CODE
): Hex | undefined {
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

export function appendFrontendBuilderAttribution(
  data: Hex,
  rawCode = import.meta.env.VITE_BASE_BUILDER_CODE ?? KVARA_BASE_BUILDER_CODE
): Hex {
  const suffix = getFrontendBuilderDataSuffix(rawCode);
  if (!suffix) throw new Error("Kvara Builder attribution is not configured.");
  return concatHex([data, suffix]);
}
