// Victor's controls subscribe to the controller; audio and conversation ownership stay there.
import { useEffect, useState } from "preact/hooks";
import { html, Icon, Spinner } from "./ui.js";
import { victorMode } from "./victor-mode.js";

/** The controller owns speech resources; rendering only subscribes to its current state. */
export function useVictorMode() {
    const [state, setState] = useState(victorMode.state);

    useEffect(() => {
        const unsubscribe = victorMode.subscribe(setState);

        setState(victorMode.state);

        return unsubscribe;
    }, []);

    return state;
}

const VICTOR_STATUS = {
    preparing: "Preparing…",
    listening: "Listening…",
    submitting: "Sending…",
    waiting: "Waiting for Pi…",
    speaking: "Reading reply…",
    error: "Victor stopped",
};

/** Show the starting text and current speech together while Victor owns draft editing. */
export function VictorControls({ state, toggle }) {
    if (state.phase === "off") {
        return null;
    }

    return html`<section
        class=${`victor-mode on ${state.phase === "error" ? "error" : ""}`}
        aria-label="On-device Victor"
        data-phase=${state.phase}
    >
        <div class="victor-mode-row">
            <button
                type="button"
                class="button small victor-toggle"
                aria-pressed="true"
                title="Turn Victor off (does not stop Pi)"
                onClick=${toggle}
            >
                <${Icon} name="mic" size=${14} /> Victor
            </button>
            <span class="grow"></span>
            <label class="victor-speed">
                Speed
                <select
                    value=${state.speed}
                    onChange=${(event) => victorMode.setSpeed(event.currentTarget.value)}
                    title="Applies to the next reply or Read reply"
                >
                    <option value="0.75">0.75×</option>
                    <option value="1">1×</option>
                    <option value="1.25">1.25×</option>
                    <option value="1.5">1.5×</option>
                </select>
            </label>
            <button
                type="button"
                class="button small"
                disabled=${!state.hasReply || state.phase !== "listening"}
                onClick=${() => victorMode.readReply()}
            >
                Read reply
            </button>
        </div>
        ${
            state.phase !== "error" &&
            html`<div class="victor-status" role="status">
                ${["preparing", "submitting", "waiting"].includes(state.phase) && html`<${Spinner} hidden />`}
                <span>${state.message || VICTOR_STATUS[state.phase]}</span>
            </div>`
        }
        ${
            (state.text || state.phase === "listening") &&
            html`<div class="victor-draft" role="region" aria-label="Victor draft">
                ${state.text || "Speak now…"}
            </div>`
        }
        ${
            state.phase === "error" &&
            html`<div class="victor-message error-box" role="alert">
                <strong>${VICTOR_STATUS.error}.</strong> ${state.message}
            </div>`
        }
    </section>`;
}

export function VictorButton({ toggle }) {
    return html`<button
        type="button"
        class="button small victor-chip"
        data-part="composer-button"
        aria-pressed="false"
        title="Turn on Victor (on-device, English)"
        onClick=${toggle}
    >
        Victor
    </button>`;
}
