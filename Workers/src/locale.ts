export const SUPPORTED_LOCALES = ["zh-cn", "zh-tw", "en", "fr", "ja"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function normalizeLocale(value: unknown): SupportedLocale {
  if (typeof value !== "string") return "zh-cn";
  const normalized = value.trim().toLowerCase().replace("_", "-");
  if (normalized.startsWith("zh-tw") || normalized.startsWith("zh-hk")) return "zh-tw";
  if (normalized.startsWith("zh")) return "zh-cn";
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("en")) return "en";
  return "zh-cn";
}
