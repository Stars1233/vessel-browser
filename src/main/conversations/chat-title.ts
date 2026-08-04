const MAX_CHAT_TITLE_LENGTH = 80;

export function buildChatTitlePrompt(userMessage: string, assistantMessage: string): string {
  return [
    "Create a concise title for this chat.",
    "Return only the title, without quotation marks or punctuation commentary.",
    `Keep it under ${MAX_CHAT_TITLE_LENGTH} characters.`,
    "",
    `User: ${userMessage}`,
    `Assistant: ${assistantMessage}`,
  ].join("\n");
}

export function normalizeGeneratedChatTitle(generated: string, fallback: string): string {
  const firstLine = generated.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const unquoted = firstLine.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  const candidate = unquoted || fallback.trim() || "New chat";
  return candidate.slice(0, MAX_CHAT_TITLE_LENGTH).trimEnd();
}
