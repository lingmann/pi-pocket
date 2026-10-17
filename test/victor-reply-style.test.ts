// Victor's input source follows durable run inputs, not browser state or the newest queued message.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import {
    getCurrentSystemPrompt,
    type FauxResponseStep,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    type ConversationId,
    LiveDoc,
    type PromptInput,
    type SubmissionId,
} from "@earendil-works/pi-durable";
import type { SubmitRequest } from "../src/server/commands.ts";
import { InputSourceDoc, SubagentsDoc } from "../src/server/docs.ts";
import createVictorReplyStyle from "../src/server/extensions/victor-reply-style.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { ownRequest } from "../src/server/requests.ts";
import { recordInputSource } from "../src/server/victor-replies.ts";

const input = { conversationId: 1 as ConversationId } as PromptInput;
const answer = () => fauxAssistantMessage([fauxText("Done.")]);

type Seen = { text: string; role: string; style: string | undefined };

function observe(request: TranscriptContext): Seen {
    const prompt = getCurrentSystemPrompt(request.messages);

    return {
        ...lastText(request),
        style: prompt.match(/<victor_reply_style>\n([\s\S]*?)\n<\/victor_reply_style>/)?.[1],
    };
}

function assertVoice(seen: Seen): void {
    assert.match(seen.style ?? "", /at most three short sentences/);
}

function assertText(seen: Seen): void {
    assert.match(seen.style ?? "", /restrictions do not apply/);
}

async function fixture(t: TestContext, route: FauxResponseStep = answer) {
    const data = join(root, crypto.randomUUID());
    const model = scriptedModel(route);
    const app = await openApp(model, data);

    t.after(() => app.close());

    return { app, id: await newSession(app), model, data };
}

async function submit(app: App, id: ConversationId, request: Partial<SubmitRequest> = {}) {
    return app.commands.submit(id, owner(app), {
        text: "A question",
        requestId: crypto.randomUUID(),
        ...request,
    });
}

async function wait(app: App, id: SubmissionId) {
    const settled = await (await app.harness.submission(id, context))!.wait(context);

    assert.equal(settled.status, "done");

    return settled;
}

after(cleanUp);

test("Victor's renderer switches between stable voice and text instructions", async () => {
    let mode: "victor" | "text" | undefined = "victor";
    const extension = createVictorReplyStyle({
        victorReplyMode: async () => mode,
    } as unknown as PocketHost);
    const render = extension.sections![0]!.render;
    const voice = await render(input, context);

    assert.match(voice!, /at most three short sentences/);
    assert.match(voice!, /conversationally/);
    assert.equal(await render(input, context), voice);
    mode = "text";
    assert.match((await render(input, context))!, /restrictions do not apply/);
    mode = undefined;
    assert.equal(await render(input, context), undefined);
});

test("Victor's renderer tolerates an old host and clears voice restrictions on lookup failure", async () => {
    assert.equal(
        await createVictorReplyStyle({} as PocketHost).sections![0]!.render(input, context),
        undefined,
    );
    const warnings: unknown[] = [];
    const extension = createVictorReplyStyle({
        victorReplyMode: async () => {
            throw new Error("lookup failed");
        },
        notice: (...args: unknown[]) => warnings.push(args),
    } as unknown as PocketHost);

    assert.match(
        (await extension.sections![0]!.render(input, context))!,
        /restrictions do not apply/,
    );
    assert.equal(warnings.length, 1);
});

test("a failed source lookup replaces voice instructions in the model's next request", async (t) => {
    const seen: Seen[] = [];
    const { app, id } = await fixture(t, (request) => {
        seen.push(observe(request));

        return answer();
    });

    await wait(app, (await submit(app, id, { source: "victor" })).submissionId);
    assert.equal(seen.length, 1);
    assertVoice(seen[0]!);
    const original = app.host.victorReplyMode;

    try {
        app.host.victorReplyMode = async () => {
            throw new Error("test lookup failure");
        };

        await wait(app, (await submit(app, id)).submissionId);
        assert.equal(seen.length, 2);
        assertText(seen[1]!);
        assert.doesNotMatch(seen[1]!.style!, /at most three short sentences/);
    } finally {
        app.host.victorReplyMode = original;
    }
});

test("voice/text/voice switching reaches the model and the extension can be disabled", async (t) => {
    const seen: Seen[] = [];
    const { app, id } = await fixture(t, (request) => {
        seen.push(observe(request));

        return answer();
    });

    for (const source of ["victor", undefined, "victor"] as const) {
        await wait(app, (await submit(app, id, { source })).submissionId);
    }

    assert.equal(seen.length, 3);
    assertVoice(seen[0]!);
    assertText(seen[1]!);
    assertVoice(seen[2]!);
    await app.setExtensionEnabled(owner(app), "victor-reply-style.ts", false);
    await wait(app, (await submit(app, id, { source: "victor" })).submissionId);
    assert.equal(seen.at(-1)!.style, undefined);
    await app.setExtensionEnabled(owner(app), "victor-reply-style.ts", true);
    await wait(app, (await submit(app, id)).submissionId);
    assertText(seen.at(-1)!);
});

test("duplicate requests keep the original source and submission, including concurrent conflicting retries", async (t) => {
    const seen: Seen[] = [];
    const { app, id } = await fixture(t, (request) => {
        seen.push(observe(request));

        return answer();
    });

    for (const first of [undefined, "victor"] as const) {
        const key = crypto.randomUUID();
        const original = await submit(app, id, { requestId: key, source: first });
        const retry = await submit(app, id, {
            requestId: key,
            source: first ? undefined : "victor",
        });

        assert.equal(retry.submissionId, original.submissionId);
        await wait(app, original.submissionId);
        assert.equal(
            (await app.harness.snapshot(InputSourceDoc, id, original.requestId, context))?.source,
            first ?? "text",
        );
    }

    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([
        submit(app, id, { requestId: key, source: "victor" }),
        submit(app, id, { requestId: key }),
    ]);

    assert.equal(a.submissionId, b.submissionId);
    await wait(app, a.submissionId);
    const recorded = await app.harness.snapshot(InputSourceDoc, id, a.requestId, context);

    assert.equal(seen.length, 3);
    assertText(seen[0]!);
    assertVoice(seen[1]!);
    (recorded?.source === "victor" ? assertVoice : assertText)(seen[2]!);
});

test("a typed follow-up waits while voice survives a tool round; a withdrawn voice input never applies", async (t) => {
    const gate = Promise.withResolvers<void>();
    const seen: Seen[] = [];
    const { app, id } = await fixture(t, async (request) => {
        const current = observe(request);

        seen.push(current);

        if (seen.length === 1) {
            await gate.promise;

            return fauxAssistantMessage([fauxToolCall("read", { path: "missing-test-file" })], {
                stopReason: "toolUse",
            });
        }

        return answer();
    });

    t.after(() => gate.resolve());
    const voice = await submit(app, id, { source: "victor" });

    await until(() => seen.length === 1, "voice request");
    const typed = await submit(app, id, { text: "Typed follow-up" });
    const withdrawn = await submit(app, id, { source: "victor", text: "Do not answer this" });

    await app.commands.withdraw(id, owner(app), Number(withdrawn.submissionId));
    assert.equal(await app.host.victorReplyMode(id, context), "victor");
    gate.resolve();
    await wait(app, voice.submissionId);
    await wait(app, typed.submissionId);
    assert.equal(seen.length, 3);
    assertVoice(seen[0]!);
    assertVoice(seen[1]!);
    assert.equal(seen[1]!.role, "toolResult");
    assertText(seen[2]!);
});

for (const initial of ["victor", undefined] as const) {
    test(`a ${initial ?? "text"} run switches style when opposite-mode steering is placed`, async (t) => {
        const gate = Promise.withResolvers<void>();
        const seen: Seen[] = [];
        const { app, id } = await fixture(t, async (request) => {
            seen.push(observe(request));

            if (seen.length === 1) {
                await gate.promise;

                return fauxAssistantMessage([fauxToolCall("read", { path: "missing-test-file" })], {
                    stopReason: "toolUse",
                });
            }

            return answer();
        });

        t.after(() => gate.resolve());
        const first = await submit(app, id, { source: initial });

        await until(() => seen.length === 1, "initial request");
        // Admitted before the steer, but placed after it. Submission ID order must not decide the mode.
        const followUp = await submit(app, id, { source: initial, text: "Follow-up" });
        const steer = await submit(app, id, {
            source: initial ? undefined : "victor",
            mode: "steer",
            text: "Steering",
        });

        assert.equal(await app.host.victorReplyMode(id, context), initial ?? "text");
        gate.resolve();
        await wait(app, first.submissionId);
        await wait(app, steer.submissionId);
        await wait(app, followUp.submissionId);
        assert.equal(seen.length, 3);
        (initial ? assertVoice : assertText)(seen[0]!);
        (initial ? assertText : assertVoice)(seen[1]!);
        (initial ? assertVoice : assertText)(seen[2]!);
    });
}

test("source reservation survives interrupted admission and active voice survives a restart", async (t) => {
    const seen: Seen[] = [];
    let started = false;
    const { app, id, model, data } = await fixture(t, (request) => {
        seen.push(observe(request));

        if (!started) {
            started = true;

            return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2" })], {
                stopReason: "toolUse",
            });
        }

        return answer();
    });
    const key = "reserved-before-restart";
    const canonical = ownRequest(owner(app).id, key);

    await recordInputSource(app, id, canonical, "victor", context);
    await app.close();
    const reopened = await openApp(model, data);

    t.after(() => reopened.close());
    // A conflicting retry cannot replace the source reserved before the interruption.
    const voice = await submit(reopened, id, { requestId: key });

    await until(
        async () =>
            (await reopened.harness.snapshot(LiveDoc, id, context))?.tools?.some(
                (tool) => tool.status === "running",
            ) === true,
        "tool running",
    );
    await reopened.close();
    const recovered = await openApp(model, data);

    t.after(() => recovered.close());
    await wait(recovered, voice.submissionId);
    assert.ok(seen.length >= 2);
    seen.forEach(assertVoice);
    await wait(recovered, (await submit(recovered, id)).submissionId);
    assertText(seen.at(-1)!);
});

test("synthetic continuation keeps voice; a new scheduled-style input resets it", async (t) => {
    const seen: Seen[] = [];
    const { app, id, data } = await fixture(t, (request) => {
        seen.push(observe(request));

        return answer();
    });
    const path = join(data, "extensions", "continue-once.ts");

    mkdirSync(join(data, "extensions"), { recursive: true });
    // Test-only hook: continue once during this process, without changing the run's inputs.
    writeFileSync(
        path,
        `import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
let continued = false;
export default () => defineExtension({ name: "test-continue", hooks: [hook(GenerationTask, {
onYield: () => { if (continued) return; continued = true; return { continue: "Finish the same task." }; }
})] });`,
    );
    await app.setExtensionEnabled(owner(app), "continue-once.ts", true);
    await wait(app, (await submit(app, id, { source: "victor" })).submissionId);
    assert.equal(seen.length, 2);
    seen.forEach(assertVoice);
    await app.setExtensionEnabled(owner(app), "continue-once.ts", false);
    const scheduled = await app.commands.submit(
        id,
        owner(app),
        { text: "Scheduled follow-up", requestId: crypto.randomUUID() },
        "schedule",
    );

    await wait(app, scheduled.submissionId);
    assertText(seen.at(-1)!);
});

test("a fork and reset do not carry a previous voice input into new text work", async (t) => {
    const seen: Seen[] = [];
    const { app, id } = await fixture(t, (request) => {
        seen.push(observe(request));

        return answer();
    });
    const settled = await wait(app, (await submit(app, id, { source: "victor" })).submissionId);

    assert.ok(settled.type === "input" && settled.status === "done");
    const fork = await app.commands.fork(id, owner(app), { entryId: Number(settled.answer) });

    await wait(app, (await submit(app, fork.id)).submissionId);
    assertText(seen.at(-1)!);
    await app.commands.reset(id, owner(app), undefined);
    await wait(app, (await submit(app, id)).submissionId);
    assertText(seen.at(-1)!);
});

test("compaction during a voice run does not lose its source", async (t) => {
    const gate = Promise.withResolvers<void>();
    const seen: Seen[] = [];
    let compacting = false;
    const { app, id } = await fixture(t, async (request) => {
        const current = observe(request);

        seen.push(current);

        if (current.text === "Voice work" && current.role === "user") {
            await gate.promise;

            return fauxAssistantMessage([fauxToolCall("read", { path: "missing-test-file" })], {
                stopReason: "toolUse",
            });
        }

        if (current.style === undefined) {
            compacting = true;
        }

        return answer();
    });

    t.after(() => gate.resolve());
    await app.commands.updateSession(id, owner(app), { title: "Compaction test" });
    app.settings.getCompactionSettings = () => ({
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 30,
    });
    await wait(
        app,
        (await submit(app, id, { text: "Earlier context. ".repeat(300) })).submissionId,
    );
    await wait(app, (await submit(app, id, { text: "More context" })).submissionId);
    const voice = await submit(app, id, { text: "Voice work", source: "victor" });

    await until(() => seen.some((item) => item.text === "Voice work"), "voice request");
    const conversation = await app.conversation(id);
    const task = await conversation.compact(undefined, context);

    await until(() => compacting, "compaction model request");
    assert.equal(await app.host.victorReplyMode(id, context), "victor");
    gate.resolve();
    await app.harness.waitForTask(task, context);
    await wait(app, voice.submissionId);
    assertVoice(seen.at(-1)!);
    assert.equal(seen.at(-1)!.role, "toolResult");
    const entries = await conversation.entries({}, 100, undefined, context);

    assert.ok(entries.items.some((entry) => entry.kind === "pi.compaction"));
    await wait(app, (await submit(app, id)).submissionId);
    assertText(seen.at(-1)!);
});

test("subagents and PiP never inherit Victor style; a subagent report starts ordinary work", async (t) => {
    const seen: Seen[] = [];
    const { app, id } = await fixture(t, (request) => {
        const current = observe(request);

        seen.push(current);

        if (current.role === "user" && current.text === "Delegate") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "helper",
                        message: "Child task",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return answer();
    });

    await wait(app, (await submit(app, id, { text: "Delegate", source: "victor" })).submissionId);
    await until(
        () => seen.some((item) => item.text.startsWith("[subagent helper answered")),
        "subagent report",
    );
    await until(() => !app.isBusy(id), "parent idle");
    assertVoice(seen[0]!);
    assert.equal(seen.find((item) => item.text.endsWith("Child task"))?.style, undefined);
    assert.ok(
        seen.some((item) => item.text.endsWith("Child task")),
        "child reached model",
    );
    assertText(seen.find((item) => item.text.startsWith("[subagent helper answered"))!);
    const children = await app.harness.snapshot(SubagentsDoc, id, context);
    const child = children!.agents.helper!.conversationId;
    const pip = await app.pip.ensure(owner(app));

    for (const excluded of [child, pip]) {
        assert.equal(await app.host.victorReplyMode(excluded, context), undefined);
        await assert.rejects(submit(app, excluded, { source: "victor" }), /main sessions only/);
    }
});

test("a retry cannot label an existing untagged submission as Victor", async (t) => {
    const { app, id } = await fixture(t);
    const requestId = "old-untagged";
    const canonical = ownRequest(owner(app).id, requestId);
    const original = await (
        await app.conversation(id)
    ).submit({ type: "input", content: "Earlier client", requestId: canonical }, context);

    await original.wait(context);
    const retry = await submit(app, id, { source: "victor", requestId });

    assert.equal(retry.submissionId, original.id);
    assert.equal(await app.harness.snapshot(InputSourceDoc, id, canonical, context), undefined);
});

test("HTTP validates source, keeps access checks, and treats ordinary dictation as text", async (t) => {
    const seen: Seen[] = [];
    const { app, id } = await fixture(t, (request) => {
        seen.push(observe(request));

        return answer();
    });
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
        () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            ),
    );
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c/${id}/submit`;
    const send = (source: unknown, token = app.config.ownerToken) =>
        fetch(url, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify({
                text: "Dictated or spoken",
                requestId: crypto.randomUUID(),
                source,
            }),
        });

    for (const invalid of ["voice", "text", null, true, {}]) {
        assert.equal((await send(invalid)).status, 400);
    }

    const viewer = app.config.addUser("Viewer", "viewer");

    assert.equal((await send("victor", viewer.token)).status, 403);

    for (const source of ["victor", undefined]) {
        const response = await send(source);

        assert.equal(response.status, 200);
        await wait(app, (await response.json()).submissionId);
    }

    assert.equal(seen.length, 2);
    assertVoice(seen[0]!);
    assertText(seen[1]!);
});
