// Keep configuration scenarios here; source attribution regressions live in victor-reply-style.test.ts.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { withAbortSignal } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, type ConversationId, type PromptInput } from "@earendil-works/pi-durable";
import createVictorReplyStyle from "../src/server/extensions/victor-reply-style.ts";
import type {
    CommandContext,
    ExtensionCommand,
    ExtensionWeb,
    PocketHost,
} from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

// Independent descriptor: assert the deployed kind/scope/field contract, including absence after reads.
const Settings = defineDoc<{ voiceInstruction?: string }>({
    kind: "x.victor-reply-style.settings",
    version: 1,
    scope: "session",
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
    initial: () => ({}),
});
const VOICE =
    "This reply is for Victor voice chat and will be read aloud. Respond conversationally in at most three short sentences. Avoid headings, lists, tables, code blocks, and long URLs. Offer to explain further rather than giving a long answer. These limits apply to user-facing replies, not tool calls or the work needed to answer correctly.";
const TEXT =
    "Use this conversation's normal style. Victor voice-specific brevity and formatting restrictions do not apply.";
const FILE = "victor-reply-style.ts";
const answer = () => fauxAssistantMessage([fauxText("Done.")]);
const stored = (app: App) => app.harness.snapshot(Settings, context);
const command = (app: App) => app.webs.commands().find((each) => each.name === "victor-style")!;
const request = (app: App, args = "") => ({
    commandId: command(app).id,
    args,
    requestId: crypto.randomUUID(),
});
const run = (app: App, id: ConversationId, args = "") =>
    app.extensionCommands.run(id, owner(app), request(app, args));

async function show(app: App, id: ConversationId, expected: string, status = "Custom") {
    const result = await run(app, id, "show");

    assert.equal(result.status, "done");
    assert.equal(result.type, "card");
    assert.equal(result.clipped, undefined);

    if (result.type === "card") {
        assert.equal(result.output, `${status}\n\n${expected}`);
    }

    return result;
}

async function fixture(t: TestContext, route?: FauxResponseStep) {
    const seen: (string | undefined)[] = [];
    const model = scriptedModel(
        route ??
            ((request) => {
                seen.push(
                    getCurrentSystemPrompt(request.messages).match(
                        /<victor_reply_style>\n([\s\S]*?)\n<\/victor_reply_style>/,
                    )?.[1],
                );

                return answer();
            }),
    );
    const data = join(root, crypto.randomUUID());
    const app = await openApp(model, data);

    t.after(() => app.close());

    return { app, id: await newSession(app), model, data, seen };
}

async function speak(app: App, id: ConversationId, source?: "victor") {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: "A question",
        requestId: crypto.randomUUID(),
        source,
    });
    const result = await (await app.harness.submission(submissionId, context))!.wait(context);

    assert.equal(result.status, "done");
}

after(cleanUp);

test("default show/render do not write; set/show/reset use cards and private toasts, never a model", async (t) => {
    const { app, id, seen } = await fixture(t);

    assert.equal(command(app).scope, "global");
    assert.equal(command(app).args, "[show | set <instructions> | reset]");
    assert.equal(await stored(app), undefined);
    await show(app, id, VOICE, "Default");
    const implicit = await run(app, id);

    assert.equal(implicit.type, "card");
    assert.equal(await stored(app), undefined);
    assert.equal(seen.length, 0);
    await speak(app, id, "victor");
    assert.deepEqual(seen, [VOICE]);
    assert.equal(await stored(app), undefined);

    const custom = '"Spoken output"  keeps spacing.\n\nTool work is unrestricted. \\n is literal.';
    const saved = await run(app, id, ` \nset\t  ${custom} \n `);

    assert.equal(saved.status, "done");
    assert.equal(saved.type, "toast");

    if (saved.type === "toast") {
        assert.equal(saved.level, "info");
        assert.ok(saved.message.length < 500);
        assert.ok(!saved.message.includes(custom));
        assert.match(saved.message, /subsequent Victor requests across this instance/);
    }

    assert.deepEqual(await stored(app), { voiceInstruction: custom });
    await show(app, id, custom);
    const entries = (await (await app.conversation(id)).context(context)).entries;

    assert.ok(
        entries.some(
            (entry) =>
                entry.kind === "pocket.extension-command" &&
                (entry.data as { output?: string }).output === `Custom\n\n${custom}`,
        ),
    );
    const reset = await run(app, id, "reset");

    assert.equal(reset.status, "done");
    assert.equal(reset.type, "toast");

    if (reset.type === "toast") {
        assert.ok(!reset.message.includes(custom));
        assert.match(reset.message, /subsequent Victor requests across this instance/);
    }

    assert.deepEqual(await stored(app), {});
    await show(app, id, VOICE, "Default");
    assert.equal(seen.length, 1, "commands made no model requests");
    await run(app, id, `set ${VOICE}`);
    await show(app, id, VOICE);
    assert.deepEqual(await stored(app), { voiceInstruction: VOICE });
});

test("literal parsing, code-unit limits, and framework argument limit reject without changing settings", async (t) => {
    const { app, id, seen } = await fixture(t);
    const full = "😀".repeat(1950);

    assert.equal(full.length, 3900);
    assert.equal((await run(app, id, `set ${full}`)).status, "done");
    await show(app, id, full);

    for (const args of [
        "set",
        "set \n\t",
        "unknown",
        "SHOW",
        "show extra",
        "reset extra",
        "--help",
        `set ${full}a`,
    ]) {
        const result = await run(app, id, args);

        assert.equal(result.status, "failed", args.slice(0, 40));
        assert.equal(result.type, "toast");

        if (result.type === "toast") {
            assert.equal(result.level, "error");
            assert.match(result.message, /Usage: \/victor-style/);
        }

        assert.deepEqual(await stored(app), { voiceInstruction: full });
    }

    // Padding is part of the framework limit, although the extension trims it.
    assert.equal((await run(app, id, `set ${full}${" ".repeat(96)}`)).status, "done");
    await assert.rejects(run(app, id, `set ${full}${" ".repeat(97)}`), { status: 413 });
    assert.deepEqual(await stored(app), { voiceInstruction: full });
    assert.equal(seen.length, 0);
});

test("global authorization rejects guest, session-limited guest, and viewer direct HTTP calls", async (t) => {
    const { app, id, seen } = await fixture(t);
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
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c/${id}/extension-commands`;

    await run(app, id, "set Original");

    for (const [name, role, sessions] of [
        ["Guest", "guest", undefined],
        ["Limited", "guest", [String(id)]],
        ["Viewer", "viewer", undefined],
    ] as const) {
        const { user, token } = app.config.addUser(
            name,
            role,
            sessions ? [...sessions] : undefined,
        );

        for (const args of ["show", "set Unauthorized", "reset"]) {
            await assert.rejects(app.extensionCommands.run(id, user, request(app, args)), {
                status: 403,
            });
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                    "x-pocket": "1",
                },
                body: JSON.stringify(request(app, args)),
            });

            assert.equal(response.status, 403);
            await response.text();
        }
    }

    assert.deepEqual(await stored(app), { voiceInstruction: "Original" });
    assert.equal(seen.length, 0);
});

test("an override replaces VOICE across conversations, stays instance-local, and typed input resets style", async (t) => {
    const { app, id, seen } = await fixture(t);
    const second = await newSession(app);
    const other = await fixture(t);
    const custom = "These spoken replies use a custom style; tools are unrestricted.";

    await run(app, id, `set ${custom}`);
    await speak(app, id, "victor");
    await speak(app, second, "victor");
    await speak(app, id, "victor");
    assert.deepEqual(seen, [custom, custom, custom]);
    await speak(app, id);
    assert.equal(seen.at(-1), TEXT);
    await speak(other.app, other.id, "victor");
    assert.deepEqual(other.seen, [VOICE]);
    assert.equal(await stored(other.app), undefined);
    await run(app, second, "reset");
    await speak(app, id, "victor");
    assert.equal(seen.at(-1), VOICE);
});

test("a committed change reaches a controlled tool continuation, not an already prepared request", async (t) => {
    const gate = Promise.withResolvers<void>();
    const seen: (string | undefined)[] = [];
    const { app, id } = await fixture(t, async (request) => {
        seen.push(
            getCurrentSystemPrompt(request.messages).match(
                /<victor_reply_style>\n([\s\S]*?)\n<\/victor_reply_style>/,
            )?.[1],
        );

        if (seen.length === 1) {
            await gate.promise;

            return fauxAssistantMessage(
                [fauxToolCall("read", { path: "missing-config-test-file" })],
                { stopReason: "toolUse" },
            );
        }

        return answer();
    });

    t.after(() => gate.resolve());
    await run(app, id, "set Before");
    const speaking = speak(app, id, "victor");

    await until(() => seen.length === 1, "prepared voice request");
    await run(app, id, "set After");
    assert.deepEqual(seen, ["Before"]);
    gate.resolve();
    await speaking;
    assert.deepEqual(seen, ["Before", "After"]);
});

test("reload, disable/re-enable, reopen, and repeated delivery preserve committed preferences", async (t) => {
    const { app, id, model, data, seen } = await fixture(t);
    const earlier = request(app, "set Earlier");
    const first = await app.extensionCommands.run(id, owner(app), earlier);

    await run(app, id, "set Later");
    assert.deepEqual(await app.extensionCommands.run(id, owner(app), earlier), first);
    assert.deepEqual(await stored(app), { voiceInstruction: "Later" });
    const before = command(app).id;

    await app.loader.reload(FILE);
    assert.notEqual(command(app).id, before);
    await show(app, id, "Later");
    const disabledRequest = request(app, "set Unavailable");

    await app.setExtensionEnabled(owner(app), FILE, false);
    assert.equal(command(app), undefined);
    await assert.rejects(app.extensionCommands.run(id, owner(app), disabledRequest), {
        status: 404,
    });
    assert.deepEqual(await stored(app), { voiceInstruction: "Later" });
    await speak(app, id, "victor");
    assert.equal(seen.at(-1), undefined);
    await app.setExtensionEnabled(owner(app), FILE, true);
    await speak(app, id, "victor");
    assert.equal(seen.at(-1), "Later");
    await app.close();
    const reopened = await openApp(model, data);

    t.after(() => reopened.close());
    await show(reopened, id, "Later");
    assert.deepEqual(await reopened.extensionCommands.run(id, owner(reopened), earlier), first);
    await speak(reopened, id, "victor");
    assert.equal(seen.at(-1), "Later");
});

test("voice settings survive repeated delta writes, checkpointing, and reset across restarts", async (t) => {
    const { app, id, model, data } = await fixture(t);

    // The initial write makes a base; 64 deltas follow, then the next change makes a new base.
    for (let index = 0; index <= 65; index++) {
        const result = await run(app, id, `set Instruction ${index}`);

        assert.equal(result.status, "done");
        assert.equal(result.type, "toast");
        assert.deepEqual(await stored(app), { voiceInstruction: `Instruction ${index}` });
    }

    await app.close();
    const reopened = await openApp(model, data);

    t.after(() => reopened.close());
    await show(reopened, id, "Instruction 65");
    const reset = await run(reopened, id, "reset");

    assert.equal(reset.status, "done");
    assert.equal(reset.type, "toast");
    assert.deepEqual(await stored(reopened), {});
    await reopened.close();
    const resetApp = await openApp(model, data);

    t.after(() => resetApp.close());
    await show(resetApp, id, VOICE, "Default");
    assert.deepEqual(await stored(resetApp), {});
});

test("invalid stored fields fall back to the exact default, not a stale custom section", async (t) => {
    const { app, id, seen } = await fixture(t);

    await run(app, id, "set Previous custom instruction");
    await speak(app, id, "victor");
    assert.equal(seen.at(-1), "Previous custom instruction");

    for (const invalid of [null, 42, {}, "", " \n ", "x".repeat(3901)]) {
        await app.harness.commit(async (tx) => {
            (await tx.doc(Settings)).voiceInstruction = invalid as string;
        }, context);
        await show(app, id, VOICE, "Default (invalid stored override; using default)");
        await speak(app, id, "victor");
        assert.equal(seen.at(-1), VOICE);
    }

    await run(app, id, "reset");
    assert.deepEqual(await stored(app), {});
});

/** Narrow module fixture for failures: no live database corruption or global durable monkey patches. */
function moduleFixture() {
    const warnings: unknown[][] = [];
    let mode: "victor" | "text" | undefined = "victor";
    let value: unknown = { voiceInstruction: "Custom" };
    let failure: Error | undefined;
    let sourceFailure: Error | undefined;
    let reads = 0;
    let registered: ExtensionCommand | undefined;
    const extension = createVictorReplyStyle(
        {
            victorReplyMode: async () => {
                if (sourceFailure) {
                    throw sourceFailure;
                }

                return mode;
            },
            notice: (...args: unknown[]) => warnings.push(args),
        } as unknown as PocketHost,
        {
            command: (_name: string, command: ExtensionCommand) => {
                registered = command;
            },
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        } as unknown as ExtensionWeb,
    );

    const snapshot = async () => {
        reads++;

        if (failure) {
            throw failure;
        }

        return value;
    };

    const input = {
        conversationId: 1 as ConversationId,
        read: { snapshot },
    } as unknown as PromptInput;

    return {
        render: (ctx = context) => extension.sections![0]!.render(input, ctx),
        handler: (args: string, ctx: CommandContext) => registered!.handler(args, ctx),
        snapshot,
        warnings,
        reads: () => reads,
        mode: (next: typeof mode) => {
            mode = next;
        },
        value: (next: unknown) => {
            value = next;
        },
        fail: (next: Error) => {
            failure = next;
        },
        sourceFail: (next: Error) => {
            sourceFailure = next;
        },
    };
}

test("only Victor reads settings; failed reads clear custom text and warnings contain no instruction", async () => {
    const f = moduleFixture();

    assert.equal(await f.render(), "Custom");
    f.value({ voiceInstruction: undefined });
    assert.equal(await f.render(), VOICE, "a present undefined field is invalid");
    assert.equal(f.warnings.length, 1);
    f.warnings.length = 0;
    f.fail(new Error("Custom sensitive text from storage"));
    assert.equal(await f.render(), VOICE);
    assert.equal(f.warnings.length, 1);
    assert.ok(!JSON.stringify(f.warnings).includes("Custom"));
    f.mode("text");
    assert.equal(await f.render(), TEXT);
    f.mode(undefined);
    assert.equal(await f.render(), undefined);
    assert.equal(f.reads(), 3);
    f.sourceFail(new Error("source failed"));
    assert.equal(await f.render(), TEXT);
    assert.match(String(f.warnings.at(-1)), /Could not read Victor reply mode/);
    assert.equal(f.reads(), 3);
});

test("cancellation propagates in source and settings paths without warnings or fallback", async () => {
    for (const source of [false, true]) {
        const f = moduleFixture();
        const controller = new AbortController();
        const error = new Error("Cancelled");

        controller.abort(error);
        (source ? f.sourceFail : f.fail)(error);
        await assert.rejects(
            Promise.resolve(f.render(withAbortSignal(controller.signal, context))),
            (caught) => caught === error,
        );
        assert.deepEqual(f.warnings, []);
    }
});

test("command read/write failures propagate, validation uses web.error(400), and no success is returned", async () => {
    const f = moduleFixture();
    const error = new Error("Storage unavailable");
    let commits = 0;
    const ctx = {
        context,
        snapshot: f.snapshot,
        commit: async () => {
            commits++;

            throw error;
        },
    } as unknown as CommandContext;

    for (const args of [
        "set",
        "set \n",
        "show more",
        "reset more",
        "invalid",
        `set ${"x".repeat(3901)}`,
    ]) {
        await assert.rejects(Promise.resolve(f.handler(args, ctx)), { status: 400 });
    }

    assert.equal(commits, 0);
    await assert.rejects(Promise.resolve(f.handler("set New", ctx)), (caught) => caught === error);
    await assert.rejects(Promise.resolve(f.handler("reset", ctx)), (caught) => caught === error);
    assert.equal(await f.render(), "Custom", "no optimistic in-memory override");
    f.fail(error);
    await assert.rejects(Promise.resolve(f.handler("show", ctx)), (caught) => caught === error);
});

test("failed command reads and writes report failure through the dispatcher and leave settings unchanged", async (t) => {
    const { app, id, seen } = await fixture(t);

    await run(app, id, "set Original");
    const registration = app.webs.command(command(app).id)!;
    const original = registration.handler;

    // Replace only the handler's storage methods, leaving authorization/task/result handling real.
    t.mock.method(registration, "handler", (args: string, ctx: CommandContext) =>
        original(args, {
            ...ctx,
            commit: async () => {
                throw new Error("Rejected test commit");
            },
            snapshot: async () => {
                throw new Error("Rejected test read");
            },
        }),
    );

    for (const args of ["set Rejected", "reset", "show"]) {
        const result = await run(app, id, args);

        assert.equal(result.status, "failed");
        assert.equal(result.type, "toast");

        if (result.type === "toast") {
            assert.equal(result.level, "error");
            assert.equal(result.message, "The command failed.");
        }

        assert.deepEqual(await stored(app), { voiceInstruction: "Original" });
        await speak(app, id, "victor");
        assert.equal(seen.at(-1), "Original");
    }
});
