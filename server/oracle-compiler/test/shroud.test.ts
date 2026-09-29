import { test } from "node:test";
import assert from "node:assert/strict";
import { generateText } from "ai";
import { shroudAnthropicModel } from "../src/shroud.ts";

// Proves the routing plumbing — URL, headers — is correct, using a fake fetch instead of a real
// network call (no Shroud/Anthropic credentials needed or used). Does NOT prove a real extraction
// works; see shroud.ts's own comment for what a live run still needs.
function fakeAnthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("shroudAnthropicModel: routes to shroud.1claw.co/v1/messages with the required Shroud headers", async () => {
  let capturedUrl: string | undefined;
  let capturedHeaders: Headers | undefined;

  const fakeFetch: typeof fetch = async (input, init) => {
    capturedUrl = typeof input === "string" ? input : input.toString();
    capturedHeaders = new Headers(init?.headers);
    return fakeAnthropicResponse("hello from shroud");
  };

  const model = shroudAnthropicModel({
    agentId: "agent-123",
    agentApiKey: "ocv_fake",
    model: "claude-haiku-4-5",
    fetch: fakeFetch,
  });

  const { text } = await generateText({ model, prompt: "say hi" });

  assert.equal(text, "hello from shroud");
  assert.equal(capturedUrl, "https://shroud.1claw.co/v1/messages");
  assert.equal(capturedHeaders?.get("x-shroud-agent-key"), "agent-123:ocv_fake");
  assert.equal(capturedHeaders?.get("x-shroud-provider"), "anthropic");
  assert.equal(capturedHeaders?.get("x-shroud-api-key"), null);
});

test("shroudAnthropicModel: includes X-Shroud-Api-Key only when a providerApiKey is given (BYOK path)", async () => {
  let capturedHeaders: Headers | undefined;
  const fakeFetch: typeof fetch = async (_input, init) => {
    capturedHeaders = new Headers(init?.headers);
    return fakeAnthropicResponse("ok");
  };

  const model = shroudAnthropicModel({
    agentId: "agent-123",
    agentApiKey: "ocv_fake",
    model: "claude-haiku-4-5",
    providerApiKey: "sk-ant-real-key",
    fetch: fakeFetch,
  });

  await generateText({ model, prompt: "say hi" });
  assert.equal(capturedHeaders?.get("x-shroud-api-key"), "sk-ant-real-key");
});

test("shroudAnthropicModel: baseUrl override redirects the request (e.g. for a local mock server)", async () => {
  let capturedUrl: string | undefined;
  const fakeFetch: typeof fetch = async (input) => {
    capturedUrl = typeof input === "string" ? input : input.toString();
    return fakeAnthropicResponse("ok");
  };

  const model = shroudAnthropicModel({
    agentId: "agent-123",
    agentApiKey: "ocv_fake",
    model: "claude-haiku-4-5",
    baseUrl: "http://127.0.0.1:9999",
    fetch: fakeFetch,
  });

  await generateText({ model, prompt: "say hi" });
  assert.equal(capturedUrl, "http://127.0.0.1:9999/v1/messages");
});
