import test from "node:test";
import assert from "node:assert/strict";
import { createAppSdk } from "../sdk/app-contract/server-client.js";

test("preserves a legacy unsubscribe function without executing it", async () => {
  let unsubscribeCalls = 0;
  const unsubscribe = () => { unsubscribeCalls += 1; };
  const context = {
    dataDir: "C:/temp/image-url-fix-test",
    bus: {
      request: async () => ({}),
      subscribe: () => unsubscribe,
    },
    storage: { global: {}, agent: () => ({}) },
    models: {},
    media: {},
    providers: {},
    tools: {},
    hooks: {},
  };

  const sdk = createAppSdk(context);
  const result = await sdk.bus.subscribe(() => {}, { types: ["media-gen:task-done"] });

  assert.equal(result, unsubscribe);
  assert.equal(unsubscribeCalls, 0);
});
