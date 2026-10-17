/**
 * Short conversational replies for messages sent through Victor, with normal style restored for text chat.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const VOICE = `This reply is for Victor voice chat and will be read aloud. Respond conversationally in at most three short sentences. Avoid headings, lists, tables, code blocks, and long URLs. Offer to explain further rather than giving a long answer. These limits apply to user-facing replies, not tool calls or the work needed to answer correctly.`;
const TEXT = `Use the normal response style for this conversation. The Victor voice-specific brevity and formatting restrictions do not apply to this reply.`;

export default function createVictorReplyStyle(host: PocketHost) {
    return defineExtension({
        name: "pocket-victor-reply-style",
        sections: [
            section("victor_reply_style", async (input, context) => {
                // A module can hot-reload before the server supplying the new host member is restarted.
                if (typeof host.victorReplyMode !== "function") {
                    return undefined;
                }

                try {
                    const mode = await host.victorReplyMode(input.conversationId, context);

                    return mode === undefined ? undefined : mode === "victor" ? VOICE : TEXT;
                } catch (error) {
                    if (context.abortSignal?.aborted) {
                        throw error;
                    }

                    // A throwing renderer retains its previous section. Do not leave voice mode stuck on a lookup error.
                    host.notice(
                        "warning",
                        `Could not read Victor reply mode: ${String(error)}`,
                        input.conversationId,
                    );

                    return TEXT;
                }
            }),
        ],
    });
}
