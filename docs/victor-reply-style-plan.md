# Victor reply-style MVP

## Goal

Replies to Victor messages should be conversational and at most three short sentences. Switching
between Victor and typing within one session should select the right style automatically, without
changing the session's standing instructions or sending extra messages to Pi.

## Design

1. Victor adds `inputSource: "victor"` to its existing text submission. Ordinary typing and dictation
   omit it. The server accepts only that optional enum, never client-supplied prompt text.
2. After the existing submission checks, Commands records an immutable source decision keyed by the
   canonical request ID, before admitting the input to Pi Durable. A new conversation-scoped document
   retains both Victor and ordinary decisions; forks start with an empty document. Conflicting retries
   return 409 rather than changing the original decision. Existing submissions without metadata remain
   ordinary inputs.
3. A narrow host method resolves a submission ID to its stored request ID. The new built-in
   **Victor reply style** extension reads `LiveDoc.run.inputs` and the source document before each
   model-request preparation. The newest input admitted to the run selects the style; queued inputs do
   not change the current run. Tool rounds and restart recovery keep the same source.
4. The extension renders fixed voice or normal guidance in a named prompt section. Normal guidance
   explicitly ends voice-only restrictions. Lookup failures fall back to normal guidance rather than
   retaining a stale voice section. The owner can disable the extension in Menu → Extensions.

The metadata and admission use separate commits because Pi Durable's input API has no metadata field.
A crash between them may leave an unused source record; it cannot style an unrelated run. Records stay
for the conversation's lifetime so retries cannot change a decision after pruning.

## Scope and limits

- Tagging is per submission, not a browser-wide or conversation-wide Victor-active flag.
- Turning Victor off does not abort the shared run or rewrite an answer already streaming. Its
  accepted voice turn still gets voice guidance; a later typed turn gets normal guidance.
- New background or scheduled inputs with no source metadata use normal guidance. Continuations
  within the same run retain its style. A typed steering message changes the style at the next
  request preparation.
- The sentence limit is an instruction to the model, not output truncation or a hard validator.
- No speech assets, recognition, synthesis, or audio lifecycle changes are needed.
- No live-data testing, production restart, deployment, or automatic extension-setting changes.

## Validation

Use isolated scripted-model tests for voice → text → voice switching, source validation, immutable
retries (including concurrent conflicts), queue admission, steering, tool rounds, restart recovery,
normal background inputs, forks, extension disabling, and lookup failure. Extend controller assertions
for source tagging across turns and reactivation. Run the affected shared server, prompt/extension,
and Victor controller/browser tests, changed-file formatting and linting, and TypeScript checks.
Physical-device speech quality and whether a real model consistently follows the sentence limit
remain manual checks; scripted tests verify the instructions sent to the model.
