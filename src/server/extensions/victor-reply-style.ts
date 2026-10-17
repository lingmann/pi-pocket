/**
 * Conversational replies for Victor with owner-configurable instructions and normal style restored for text chat.
 */
import { defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";

const VOICE = `This reply is for Victor voice chat and will be read aloud. Respond conversationally in at most three short sentences. Avoid headings, lists, tables, code blocks, and long URLs. Offer to explain further rather than giving a long answer. These limits apply to user-facing replies, not tool calls or the work needed to answer correctly.`;
const TEXT = `Use the normal response style for this conversation. The Victor voice-specific brevity and formatting restrictions do not apply to this reply.`;

// "session" is the shared storage session, not an individual Pocket conversation.
const ReplySettings = defineDoc<{ voiceInstruction?: string }>({
    kind: "x.victor-reply-style.settings",
    version: 1,
    scope: "session",
    initial: () => ({}),
});

const USAGE = "Usage: /victor-style [show | set <instructions> | reset]";

/** The same validation applies to owner input and stored overrides. */
function instruction(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("Instructions must be non-empty text.");
    }

    const trimmed = value.trim();

    if (trimmed.length > 3900) {
        throw new Error("Instructions must be at most 3900 JavaScript string code units.");
    }

    return trimmed;
}

function effective(settings: { voiceInstruction?: string } | undefined) {
    if (!settings || !Object.hasOwn(settings, "voiceInstruction")) {
        return { status: "Default", text: VOICE };
    }

    return { status: "Custom", text: instruction(settings.voiceInstruction) };
}

export default function createVictorReplyStyle(host: PocketHost, web: ExtensionWeb) {
    // A module can hot-reload before the server supplying commands is restarted.
    if (typeof web.command === "function") {
        web.command("victor-style", {
            description: "Show, replace, or reset Victor's instance-wide voice instructions",
            args: "[show | set <instructions> | reset]",
            scope: "global",
            handler: async (args, ctx) => {
                const [, action = "show", rest = ""] = args.trim().match(/^(\S+)([\s\S]*)$/) ?? [];
                const value = rest.trim();

                if (action === "show" && !value) {
                    // Read failures are command failures, not a normal default status.
                    const settings = await ctx.snapshot(ReplySettings, ctx.context);
                    let current;

                    try {
                        current = effective(settings);
                    } catch {
                        current = {
                            status: "Default (invalid stored override; using default)",
                            text: VOICE,
                        };
                    }

                    return { type: "card", output: `${current.status}\n\n${current.text}` };
                }

                if (action === "reset" && !value) {
                    await ctx.commit(async (tx) => {
                        delete (await tx.doc(ReplySettings)).voiceInstruction;
                    });

                    return {
                        type: "toast",
                        level: "info",
                        message:
                            "Victor style reset. Applies to subsequent Victor requests across this instance.",
                    };
                }

                if (action === "set") {
                    let text: string;

                    try {
                        text = instruction(value);
                    } catch (error) {
                        throw web.error(400, `${(error as Error).message} ${USAGE}`);
                    }

                    await ctx.commit(async (tx) => {
                        (await tx.doc(ReplySettings)).voiceInstruction = text;
                    });

                    return {
                        type: "toast",
                        level: "info",
                        message:
                            "Victor style saved. Applies to subsequent Victor requests across this instance.",
                    };
                }

                throw web.error(400, USAGE);
            },
        });
    }

    return defineExtension({
        name: "pocket-victor-reply-style",
        sections: [
            section("victor_reply_style", async (input, context) => {
                // A module can hot-reload before the server supplying the new host member is restarted.
                if (typeof host.victorReplyMode !== "function") {
                    return undefined;
                }

                let mode;

                try {
                    mode = await host.victorReplyMode(input.conversationId, context);
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

                if (mode === undefined) {
                    return undefined;
                }

                if (mode !== "victor") {
                    return TEXT;
                }

                try {
                    return effective(await input.read.snapshot(ReplySettings, context)).text;
                } catch (error) {
                    if (context.abortSignal?.aborted) {
                        throw error;
                    }

                    // Read errors may quote stored text. Keep the owner's instruction out of notices.
                    host.notice(
                        "warning",
                        "Could not read Victor reply instructions; using the default.",
                        input.conversationId,
                    );

                    return VOICE;
                }
            }),
        ],
    });
}
