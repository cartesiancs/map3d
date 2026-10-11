import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useRoads } from "../src/three/useRoads.ts";

const validArea = [{ lat: 40.8, lng: -73.95 }, { lat: 40.79, lng: -73.96 }];

test("roads survives initial missing area, loads data, and resets on clear", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ elements: [{ id: 123, geometry: [] }] }) };
  };
  const errors = [];
  const root = createRoot(document.getElementById("root"), { onUncaughtError: error => errors.push(error) });
  function Probe({ area }) {
    return React.createElement("output", null, JSON.stringify(useRoads(area)));
  }
  try {
    await act(async () => root.render(React.createElement(Probe, { area: undefined })));
    assert.equal(requests.length, 0);
    await act(async () => root.render(React.createElement(Probe, { area: validArea })));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://overpass-api.de/api/interpreter");
    assert.match(requests[0].options.body, /40\.79,-73\.96,40\.8,-73\.95/);
    assert.match(document.querySelector("output").textContent, /123/);
    await act(async () => root.render(React.createElement(Probe, { area: undefined })));
    assert.equal(document.querySelector("output").textContent, "[]");
    assert.equal(requests[0].options.signal.aborted, true);
    await act(async () => root.render(React.createElement(Probe, { area: [...validArea].reverse() })));
    assert.equal(requests.length, 1, "invalid bounds must not send a request");
    assert.deepEqual(errors, []);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});
