/**
 * Short, conversational replies for Victor voice turns, with normal response style restored for text turns.
 */
import { defineExtension, LiveDoc, section } from "@earendil-works/pi-durable";
import { VictorInputsDoc } from "../docs.ts";
import { describe } from "../errors.ts";
import type { PocketHost } from "../host.ts";

const VOICE =
    "The current reply will be read aloud by Victor. Respond naturally and conversationally in at most three short sentences. Avoid headings, lists, tables, and code blocks. Offer to explain further rather than giving a long answer. These restrictions apply only to this voice turn, not to later text-chat turns.";
const NORMAL =
    "This is a normal text-chat turn. Follow the session's usual instructions and the user's request; Victor's voice-only sentence and formatting restrictions do not apply.";

export default function createVictorReplyStyle(host: PocketHost) {
    return defineExtension({
        name: "pocket-victor-reply-style",
        sections: [
            section("victor_reply_style", async (input, context) => {
                // A newly reloaded module may still be running against the host from before a server restart.
                if (typeof host.submissionRequestId !== "function") {
                    return NORMAL;
                }

                try {
                    const live = await input.read.snapshot(LiveDoc, input.conversationId, context);
                    const latest = live?.run?.inputs.at(-1);

                    if (latest === undefined) {
                        return NORMAL;
                    }

                    const requestId = await host.submissionRequestId(latest, context);
                    const inputs = await input.read.snapshot(
                        VictorInputsDoc,
                        input.conversationId,
                        context,
                    );

                    return requestId !== undefined && inputs?.sources[requestId] === "victor"
                        ? VOICE
                        : NORMAL;
                } catch (error) {
                    if (context.abortSignal?.aborted) {
                        throw error;
                    }

                    // The prompt renderer keeps the previous section on a throw. Explicitly reset instead, so a
                    // failed lookup cannot leave voice restrictions active for an unrelated text turn.
                    host.notice(
                        "warning",
                        `Could not determine Victor reply style: ${describe(error)}`,
                        input.conversationId,
                    );

                    return NORMAL;
                }
            }),
        ],
    });
}
