import assert from "node:assert/strict";
import test from "node:test";

const DEVICE = "d_0123456789abcdef0123456789abcdef";
const PROJECT = "44444444-4444-4444-8444-444444444444";
let saved = { capsoOrigin: "https://capso.example", capsoDevice: DEVICE };

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((key) => [key, saved[key]]));
      },
    },
  },
};

const { fetchProjects, projectList } = await import("./projects.js");

test("project payloads are bounded to safe owner-facing labels", () => {
  assert.deepEqual(projectList({ projects: [{
    id: PROJECT,
    name: "Launch research",
    description: "References",
  }] }), [{ id: PROJECT, name: "Launch research", description: "References" }]);
  assert.deepEqual(projectList({ projects: [{ id: "not-a-uuid", name: "Forged" }] }), []);
  assert.deepEqual(projectList({ projects: new Array(51).fill({ id: PROJECT, name: "Too many" }) }), []);
});

test("the raw device code stays in a request header, never a project-list URL", async () => {
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return Response.json({ projects: [{ id: PROJECT, name: "Launch research", description: null }] });
  };

  const result = await fetchProjects();
  assert.equal(result.error, null);
  assert.equal(result.projects[0].id, PROJECT);
  assert.equal(request.url, "https://capso.example/api/extension/projects");
  assert.ok(!request.url.includes(DEVICE));
  assert.equal(new Headers(request.init.headers).get("x-capso-device"), DEVICE);
});

test("an unpaired or offline extension returns no stale project choices", async () => {
  saved = { capsoOrigin: "https://capso.example", capsoDevice: "" };
  assert.deepEqual(await fetchProjects(), {
    projects: [],
    error: "Pair this extension before choosing a project.",
  });
});
