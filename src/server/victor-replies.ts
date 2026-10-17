/** Durable input attribution for Victor's per-run reply style; no browser-global voice state. */
import type { Context } from "@earendil-works/chord";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { InputSourceDoc, type InputSource } from "./docs.ts";

/** Reserve the source before submission can start a generation. Duplicate request IDs keep their original source. */
export async function recordInputSource(
    app: PocketApp,
    id: ConversationId,
    requestId: string,
    source: InputSource,
    context: Context,
): Promise<void> {
    await app.harness.commit(async (tx) => {
        // An input admitted before this feature has no source record: a retry must not relabel it as voice.
        const existing = await tx.submissionByRequest(id, requestId);

        if (existing !== undefined) {
            return;
        }

        const recorded = await tx.doc(InputSourceDoc, id, requestId, null);

        recorded.source ??= source;
    }, context);
}

/** The latest input actually placed in this run wins; queued follow-ups cannot change an answer in progress. */
export async function victorReplyMode(
    app: PocketApp,
    id: ConversationId,
    context: Context,
): Promise<InputSource | undefined> {
    if (
        app.sessionMeta(id) === undefined ||
        app.parentOf(id) !== undefined ||
        app.pip.ownerOf(id) !== undefined
    ) {
        return undefined;
    }

    const live = await app.harness.snapshot(LiveDoc, id, context);
    const input = live?.run?.inputs.at(-1);

    if (input === undefined) {
        return "text";
    }

    const submission = await app.harness.submission(input, context);
    const record = await submission?.status(context);

    if (record?.requestId === undefined) {
        return "text";
    }

    const source = await app.harness.snapshot(InputSourceDoc, id, record.requestId, context);

    return source?.source ?? "text";
}
