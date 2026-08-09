export interface BrowserShortcutSpec {
  alt?: boolean;
  ctrl?: boolean;
  key: string;
  shift?: boolean;
}

interface BrowserViewShortcutDefinition {
  label: string;
  shortcuts: readonly BrowserShortcutSpec[];
}

export const BROWSER_VIEW_SHORTCUTS = {
  "focus-address": {
    label: "Ctrl+L",
    shortcuts: [{ ctrl: true, key: "l" }],
  },
} as const satisfies Record<string, BrowserViewShortcutDefinition>;

export type BrowserShortcutCommand = keyof typeof BROWSER_VIEW_SHORTCUTS;

export interface BrowserShortcutInput {
  alt: boolean;
  control: boolean;
  key: string;
  meta: boolean;
  shift: boolean;
  type: string;
}

export function getBrowserShortcutCommand(
  input: BrowserShortcutInput,
): BrowserShortcutCommand | null {
  if (input.type !== "keyDown") return null;
  for (const command of Object.keys(BROWSER_VIEW_SHORTCUTS) as BrowserShortcutCommand[]) {
    const shortcuts: readonly BrowserShortcutSpec[] = BROWSER_VIEW_SHORTCUTS[command].shortcuts;
    if (
      shortcuts.some(
        (shortcut) =>
          (input.control || input.meta) === Boolean(shortcut.ctrl) &&
          input.shift === Boolean(shortcut.shift) &&
          input.alt === Boolean(shortcut.alt) &&
          input.key.toLowerCase() === shortcut.key.toLowerCase(),
      )
    ) {
      return command;
    }
  }
  return null;
}
