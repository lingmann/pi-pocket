// Import helpers first: these tests never use the real Pi install or application data.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import type { SubmitRequest } from "../src/server/commands.ts";
import { VictorInputsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const observed: { text: string; role: string; prompt: string }[] = [];
let gate: { release: () => void; entered: boolean } | undefined;
let app: App;
const faux = scriptedModel(async (input, options) => {
    const last = lastText(input as never);

    observed.push({ ...last, prompt: getCurrentSystemPrompt(input.messages) });

    if (last.role === "user" && last.text.includes("hold for tool") && gate !== undefined) {
        const current = gate;

        current.entered = true;
        await new Promise<void>((resolve, reject) => {
            current.release = resolve;
            options?.signal?.addEventListener(
                "abort",
                () => reject(new Error("test interrupted")),
                {
                    once: true,
                },
            );
        });

        return fauxAssistantMessage([fauxToolCall("read", { path: work })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("done")]);
});

before(async () => {
    app = await openApp(faux);
});
after(async () => {
    await app?.close();
    cleanUp();
});

const submit = (id: ConversationId, request: Partial<SubmitRequest> = {}) =>
    app.commands.submit(id, owner(app), {
        text: "hello",
        requestId: crypto.randomUUID(),
        ...request,
    });
const wait = async (id: SubmissionId) => (await app.harness.submission(id, context))!.wait(context);

const turn = async (id: ConversationId, request: Partial<SubmitRequest> = {}) => {
    const sent = await submit(id, request);

    await wait(sent.submissionId);

    return sent;
};

const voice = (prompt: string) => {
    assert.match(prompt, /read aloud by Victor/);
    assert.match(prompt, /at most three short sentences/);
    assert.doesNotMatch(prompt, /normal text-chat turn/);
};

const normal = (prompt: string) => {
    assert.match(prompt, /normal text-chat turn/);
    assert.doesNotMatch(prompt, /read aloud by Victor/);
};

const status = (expected: number) => (error: unknown) => {
    assert.equal((error as { status: number }).status, expected);

    return true;
};

test("voice, text, voice, and direct background input select only their own style", async () => {
    const id = await newSession(app);

    await turn(id, { inputSource: "victor" });
    voice(observed.at(-1)!.prompt);
    await turn(id);
    normal(observed.at(-1)!.prompt);
    await turn(id, { inputSource: "victor" });
    voice(observed.at(-1)!.prompt);

    const conversation = await app.harness.conversation(id, context);
    const background = await conversation!.submit(
        { type: "input", content: "background", requestId: "background-direct" },
        context,
    );

    await background.wait(context);
    normal(observed.at(-1)!.prompt);
});

for (const mode of ["followUp", "steer"] as const) {
    test(`${mode}: queued text does not change an in-flight voice request; admission controls tools style`, async () => {
        const id = await newSession(app);
        const start = observed.length;

        gate = { release: () => {}, entered: false };

        try {
            const spoken = await submit(id, { text: "hold for tool", inputSource: "victor" });

            await until(() => gate!.entered, "held provider request");
            const typed = await submit(id, { text: "typed queued", mode });

            voice(observed.at(-1)!.prompt);
            assert.equal(observed.length, start + 1);
            gate.release();
            await wait(spoken.submissionId);
            await wait(typed.submissionId);

            const toolRequest = observed
                .slice(start)
                .find((request) => request.role === "toolResult");

            if (mode === "followUp") {
                assert.ok(toolRequest, "voice run continued after its tool");
                voice(toolRequest.prompt);
            } else {
                for (const request of observed.slice(start + 1)) {
                    normal(request.prompt);
                }
            }

            normal(observed.at(-1)!.prompt);
            assert.ok(
                observed.slice(start + 1).some((request) => /typed queued/.test(request.text)),
            );
        } finally {
            gate.release();
            gate = undefined;
        }
    });
}

test("pending voice metadata survives closing and reopening disposable app data", async () => {
    const id = await newSession(app);

    gate = { release: () => {}, entered: false };
    const sent = await submit(id, { text: "hold for tool", inputSource: "victor" });

    await until(() => gate!.entered, "pending voice request");
    await app.close();
    gate = undefined;
    const start = observed.length;

    app = await openApp(faux);
    await wait(sent.submissionId);
    assert.ok(observed.length > start, "pending generation resumed");
    voice(observed.at(-1)!.prompt);
    await turn(id);
    normal(observed.at(-1)!.prompt);
});

test("request IDs deduplicate and reject source changes in both directions, including concurrent submissions", async () => {
    for (const inputSource of [undefined, "victor"] as const) {
        const id = await newSession(app);
        const requestId = crypto.randomUUID();
        const request = { requestId, inputSource };
        const first = await turn(id, request);
        const count = observed.length;
        const duplicate = await turn(id, request);

        assert.equal(duplicate.submissionId, first.submissionId);
        assert.equal(observed.length, count);
        await assert.rejects(
            submit(id, { requestId, inputSource: inputSource === "victor" ? undefined : "victor" }),
            status(409),
        );
        const concurrentId = crypto.randomUUID();
        const results = await Promise.allSettled([
            submit(id, { requestId: concurrentId, inputSource }),
            submit(id, {
                requestId: concurrentId,
                inputSource: inputSource === "victor" ? undefined : "victor",
            }),
        ]);
        const successes = results.filter((result) => result.status === "fulfilled");
        const failures = results.filter((result) => result.status === "rejected");

        assert.equal(successes.length, 1);
        assert.equal(failures.length, 1);
        status(409)(failures[0]!.reason);
        await wait(successes[0]!.value.submissionId);
    }
});

test("legacy normal requests cannot be relabeled and via submissions reject Victor", async () => {
    const id = await newSession(app);
    const requestId = `u:${owner(app).id}:legacy`;
    const conversation = await app.harness.conversation(id, context);
    const legacy = await conversation!.submit(
        { type: "input", content: "legacy", requestId },
        context,
    );

    await legacy.wait(context);
    await assert.rejects(submit(id, { requestId: "legacy", inputSource: "victor" }), status(409));
    await assert.rejects(
        app.commands.submit(
            id,
            owner(app),
            { text: "via", requestId: crypto.randomUUID(), inputSource: "victor" },
            "test",
        ),
        status(400),
    );
});

test("HTTP validates inputSource and preserves accepted Victor metadata", async () => {
    const id = await newSession(app);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c/${id}/submit`;
    const post = (inputSource: unknown) =>
        fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${app.config.ownerToken}`,
                "X-Pocket": "1",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                text: "HTTP voice",
                requestId: crypto.randomUUID(),
                inputSource,
            }),
        });

    try {
        for (const source of ["text", "", null, false, 1, {}, []]) {
            const response = await post(source);

            assert.equal(response.status, 400, JSON.stringify(source));
            await response.text();
        }

        const response = await post("victor");

        assert.equal(response.status, 200);
        const sent = (await response.json()) as { submissionId: SubmissionId; requestId: string };

        await wait(sent.submissionId);
        voice(observed.at(-1)!.prompt);
        const metadata = await app.harness.snapshot(VictorInputsDoc, id, context);

        assert.equal(metadata?.sources[sent.requestId], "victor");
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});

test("forks start without inherited source metadata or spoken restrictions", async () => {
    const id = await newSession(app);

    await turn(id, { inputSource: "victor" });
    const conversation = await app.harness.conversation(id, context);
    const view = await conversation!.context(context);
    const reply = view.entries.findLast((entry) => entry.kind === "pi.assistant");

    assert.ok(reply);
    const fork = await app.commands.fork(id, owner(app), { entryId: reply.id });
    const metadata = await app.harness.snapshot(VictorInputsDoc, fork.id, context);

    assert.deepEqual(metadata?.sources ?? {}, {});
    await turn(fork.id);
    normal(observed.at(-1)!.prompt);
});

test("older hosts and failed lookups reset a previously spoken section; extension can be disabled", async () => {
    const id = await newSession(app);
    const original = app.host.submissionRequestId;

    await turn(id, { inputSource: "victor" });
    voice(observed.at(-1)!.prompt);

    try {
        app.host.submissionRequestId = undefined as never;
        await turn(id, { inputSource: "victor" });
        normal(observed.at(-1)!.prompt);
        app.host.submissionRequestId = original;
        await turn(id, { inputSource: "victor" });
        voice(observed.at(-1)!.prompt);

        app.host.submissionRequestId = async () => {
            throw new Error("test lookup failure");
        };

        await turn(id);
        normal(observed.at(-1)!.prompt);
    } finally {
        app.host.submissionRequestId = original;
    }

    await app.setExtensionEnabled(owner(app), "victor-reply-style.ts", false);

    try {
        await turn(id, { inputSource: "victor" });
        assert.doesNotMatch(observed.at(-1)!.prompt, /<victor_reply_style>/);
    } finally {
        await app.setExtensionEnabled(owner(app), "victor-reply-style.ts", true);
    }
});
