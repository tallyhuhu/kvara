import { Attribution } from "ox/erc8021";
import { concatHex, type Hex } from "viem";

export type BuilderAttribution =
  | { status: "absent"; dataSuffix?: undefined; code?: undefined }
  | { status: "configured"; dataSuffix: Hex; code: string }
  | { status: "invalid"; dataSuffix?: undefined; code?: undefined; error: string };

export const ONE_SHOT_ATTRIBUTION_SUPPORT = {
  supported: false,
  reason:
    "The current 1Shot relayer_send7710Transaction OpenRPC schema does not accept a dataSuffix or outer-calldata attribution field."
} as const;

export function getBuilderAttribution(rawCode = process.env.BASE_BUILDER_CODE): BuilderAttribution {
  if (!rawCode?.trim()) return { status: "absent" };
  const code = rawCode.trim();
  if (code.length > 64 || !/^[\x21-\x2b\x2d-\x7e]+$/.test(code)) {
    return {
      status: "invalid",
      error: "Builder Code must be 1-64 printable ASCII characters and cannot contain commas."
    };
  }

  try {
    return {
      status: "configured",
      code,
      dataSuffix: Attribution.toDataSuffix({ codes: [code] })
    };
  } catch (cause) {
    return {
      status: "invalid",
      error: cause instanceof Error ? cause.message : "Builder Code could not be encoded."
    };
  }
}

export function appendBuilderAttribution(data: Hex, rawCode = process.env.BASE_BUILDER_CODE): Hex {
  const attribution = getBuilderAttribution(rawCode);
  return attribution.status === "configured" ? concatHex([data, attribution.dataSuffix]) : data;
}
