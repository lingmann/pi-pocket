// Victor's composer-side lifecycle. Shared draft storage, paste syntax, and UI state stay in Composer.

/**
 * Create one adapter for the tab, surviving composer remounts and late POST results.
 * readDraft returns the stored (possibly folded) text; expandDraft expands it with its saved pastes.
 * writeDraft synchronously saves expanded text and clears its paste mappings before listeners run.
 * These operations belong to the composer: this module neither imports it nor defines its formats.
 */
export function createVictorComposer({ mode, notify, readDraft, expandDraft, writeDraft }) {
    const listeners = new Set();
    let owner = null;

    const save = (id, value) => {
        writeDraft(id, value);

        for (const listener of listeners) {
            listener(id, value);
        }
    };

    return {
        /** Subscribe a mounted composer; late restoration reaches its replacement, not stale UI. */
        mount(id, changed) {
            const listener = (conversationId, value) => {
                if (conversationId === id) {
                    changed(value);
                }
            };

            listeners.add(listener);

            return () => {
                listeners.delete(listener);

                if (owner === id && mode.active) {
                    mode.disable();
                    owner = null;
                }
            };
        },

        /** takeDraft stops dictation and returns { text, initialText } without yielding. */
        toggle({ conversationId: id, sending, hasAttachments, takeDraft, validateText }) {
            if (mode.active) {
                mode.disable();
                owner = null;

                return;
            }

            let reason = mode.unavailable(id);

            if (!reason && sending) {
                reason = "Wait until your message is sent before turning Victor on.";
            } else if (!reason && hasAttachments) {
                reason = "Send or remove your attachments before turning Victor on.";
            }

            if (reason) {
                notify("info", reason);

                return;
            }

            const { text, initialText } = takeDraft();
            let ownedDraft = text;

            owner = id;
            mode.enable({
                conversationId: id,
                initialText,
                validateText,
                consumeDraft() {
                    if (readDraft(id) !== ownedDraft) {
                        throw new Error("the composer draft changed while Victor was on");
                    }

                    save(id, "");
                    ownedDraft = "";
                },
                preserveDraft(value) {
                    if (value === "") {
                        return;
                    }

                    // Replace our predecessor, not newer typing. This closure outlives its composer.
                    const current = readDraft(id);
                    const next =
                        current === ownedDraft || current === ""
                            ? value
                            : `${expandDraft(id, current)}\n\n${value}`;

                    save(id, next);
                    ownedDraft = next;
                },
            });
        },
    };
}
