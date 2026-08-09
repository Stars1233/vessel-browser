export type TabNavigationIntent = "first" | "last" | "next" | "previous";

export function resolveTabNavigationIndex(
  currentIndex: number,
  tabCount: number,
  intent: TabNavigationIntent,
): number | null {
  if (tabCount <= 0 || currentIndex < 0 || currentIndex >= tabCount) {
    return null;
  }

  switch (intent) {
    case "first":
      return 0;
    case "last":
      return tabCount - 1;
    case "next":
      return (currentIndex + 1) % tabCount;
    case "previous":
      return (currentIndex - 1 + tabCount) % tabCount;
  }
}
