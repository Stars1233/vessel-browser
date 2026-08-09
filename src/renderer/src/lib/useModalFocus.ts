import { createEffect, onCleanup, type Accessor } from "solid-js";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalFocusEntry {
  document: Document;
  getDialog: () => HTMLElement | undefined;
  onClose: () => void;
  previouslyFocused: HTMLElement | null;
}

const modalStack: ModalFocusEntry[] = [];

function getActiveModal(): ModalFocusEntry | undefined {
  return modalStack[modalStack.length - 1];
}

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

function focusModal(entry: ModalFocusEntry): void {
  const dialog = entry.getDialog();
  if (!dialog) return;
  (getFocusableElements(dialog)[0] ?? dialog).focus();
}

function handleModalKeyDown(event: KeyboardEvent): void {
  const entry = getActiveModal();
  if (!entry || event.currentTarget !== entry.document) return;

  if (event.key === "Escape") {
    event.preventDefault();
    entry.onClose();
    return;
  }
  if (event.key !== "Tab") return;

  const dialog = entry.getDialog();
  if (!dialog) return;
  const focusable = getFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const activeElement = entry.document.activeElement;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!activeElement || !dialog.contains(activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function registerModal(entry: ModalFocusEntry): () => void {
  if (modalStack.length === 0) {
    entry.document.addEventListener("keydown", handleModalKeyDown);
  }
  modalStack.push(entry);
  queueMicrotask(() => {
    if (getActiveModal() === entry) focusModal(entry);
  });

  return () => {
    const index = modalStack.indexOf(entry);
    if (index < 0) return;
    const wasActive = getActiveModal() === entry;
    modalStack.splice(index, 1);

    if (modalStack.length === 0) {
      entry.document.removeEventListener("keydown", handleModalKeyDown);
    }
    if (!wasActive) return;

    queueMicrotask(() => {
      const nextModal = getActiveModal();
      if (nextModal) {
        const previous = entry.previouslyFocused;
        const nextDialog = nextModal.getDialog();
        if (previous?.isConnected && nextDialog?.contains(previous)) {
          previous.focus();
        } else {
          focusModal(nextModal);
        }
      } else if (entry.previouslyFocused?.isConnected) {
        entry.previouslyFocused.focus();
      }
    });
  };
}

export function useModalFocus(
  open: Accessor<boolean>,
  getDialog: () => HTMLElement | undefined,
  onClose: () => void,
): void {
  createEffect(() => {
    if (!open()) return;
    const unregister = registerModal({
      document,
      getDialog,
      onClose,
      previouslyFocused: document.activeElement as HTMLElement | null,
    });
    onCleanup(unregister);
  });
}
