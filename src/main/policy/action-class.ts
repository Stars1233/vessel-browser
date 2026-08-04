import type { ActionClass } from "../../shared/policy-types";

const ACTION_CLASS_BY_NAME: Record<string, ActionClass> = {
  navigate: "navigation",
  go_back: "navigation",
  go_forward: "navigation",
  web_search: "navigation",
  type: "form-fill",
  fill_form: "form-fill",
  autofill: "form-fill",
  submit_form: "form-submit",
  checkout: "purchase",
  purchase: "purchase",
  upload_file: "upload",
  download_file: "download",
  vessel_vault_login: "credential-use",
  vessel_vault_totp: "credential-use",
  delete_session: "destructive",
  vessel_bookmark_remove: "destructive",
  create_tab: "tab-create",
  open_external: "external-open",
};

export function classifyAction(actionName: string): ActionClass {
  const normalized = actionName.trim().toLowerCase();
  const exact = ACTION_CLASS_BY_NAME[normalized];
  if (exact) return exact;
  if (
    normalized.includes("vault") ||
    normalized.includes("credential") ||
    normalized.includes("totp")
  ) {
    return "credential-use";
  }
  if (normalized.includes("submit")) return "form-submit";
  if (normalized.includes("checkout") || normalized.includes("purchase")) return "purchase";
  if (normalized.includes("download")) return "download";
  if (normalized.includes("upload")) return "upload";
  if (
    normalized.includes("delete") ||
    normalized.includes("remove") ||
    normalized.includes("clear")
  ) {
    return "destructive";
  }
  if (normalized.includes("navigate") || normalized.includes("search")) return "navigation";
  if (normalized.includes("type") || normalized.includes("fill")) return "form-fill";
  if (
    normalized.includes("tab") &&
    (normalized.includes("create") || normalized.includes("open"))
  ) {
    return "tab-create";
  }
  return "routine";
}
