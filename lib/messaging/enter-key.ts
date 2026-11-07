import type { KeyboardEvent } from "react";

// D-M1 (Kinso K3): a one-line field that sits inside a larger form (a search, a new button
// label, a variable name) must not submit that form when Enter is pressed: in the reply box that
// sends the message, in the saved-reply editor it saves, and in the WhatsApp template builder it
// submits the template to Meta for review. Enter runs the field's own action instead, if any.

/**
 * A keydown handler for such a field: Enter (outside IME composition) never submits the form
 * around it, and runs `action` when one is given.
 */
export function enterRunsOwnAction(action?: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    action?.();
  };
}
