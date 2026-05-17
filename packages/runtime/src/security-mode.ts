import type { LegacyPermissionMode, RuntimeSecurityMode } from "./types.js";

/**
 * Resolve the effective {@link RuntimeSecurityMode} from caller inputs.
 *
 * Precedence: explicit `securityMode` > legacy `permissionMode` mapping > `safe`.
 *
 * Legacy mapping:
 * - `bypassPermissions` → `yolo`
 * - `default`, `acceptEdits`, `auto` → `safe`
 * - `plan`, `dontAsk` → throw (unsupported under the simplified model)
 */
export function resolveSecurityMode(input: {
  securityMode?: RuntimeSecurityMode;
  permissionMode?: LegacyPermissionMode;
}): RuntimeSecurityMode {
  if (input.securityMode) return input.securityMode;
  switch (input.permissionMode) {
    case undefined:
    case "default":
    case "acceptEdits":
    case "auto":
      return "safe";
    case "bypassPermissions":
      return "yolo";
    case "plan":
    case "dontAsk":
      throw new Error(
        `permissionMode "${input.permissionMode}" is no longer supported; use securityMode "safe" or "yolo"`,
      );
  }
}
