import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public share delivery keeps bearer tokens in fragments and headers only", async () => {
  const [boundary, receiver, resolveRoute, imageRoute, proxy] = await Promise.all([
    readFile(new URL("../components/app-boundary.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/share/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/share/resolve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/share/image/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/api/share-proxy.ts", import.meta.url), "utf8"),
  ]);

  assert.match(boundary, /pathname === "\/share"/);
  assert.match(receiver, /window\.location\.hash/);
  assert.match(receiver, /type="password"[\s\S]*autoComplete="off"/);
  assert.doesNotMatch(receiver, /current-password/);
  assert.match(receiver, /const receiverState = previewState\(previewMode\) \?\? state/);
  assert.doesNotMatch(receiver, /setState\(preview/);
  assert.match(receiver, /"x-capso-share-token": token/);
  assert.doesNotMatch(receiver, /searchParams.*token|\?token=/);
  assert.match(resolveRoute, /isSameOrigin\(request\)/);
  assert.match(imageRoute, /isSameOrigin\(request\)/);
  assert.match(resolveRoute, /request\.headers\.get\("x-capso-share-token"\)/);
  assert.match(imageRoute, /request\.headers\.get\("x-capso-share-token"\)/);
  assert.doesNotMatch(resolveRoute, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(imageRoute, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(proxy, /response\.headers\.get\("retry-after"\)/);
  assert.match(imageRoute, /"retry-after"/);
});

test("screenshot detail owns create, copy and revoke controls without publishing automatically", async () => {
  const detail = await readFile(new URL("../app/s/[id]/page.tsx", import.meta.url), "utf8");

  assert.match(detail, />Share</);
  assert.match(detail, /accountFetch\("\/api\/share-links"/);
  assert.match(detail, /navigator\.clipboard\.writeText\(`\$\{window\.location\.origin\}\/share#/);
  assert.match(detail, /One-time link/);
  assert.match(detail, /Password protection/);
  assert.match(detail, /Revoke/);
  assert.match(detail, /if \(createdLinkId === linkId\)/);
  assert.match(detail, /Copied/);
  assert.match(detail, /closeRef\.current\?\.focus\(\)/);
  assert.match(detail, /event\.key === "Tab"/);
  assert.match(detail, /ref=\{dialogRef\}/);
  assert.doesNotMatch(detail, /useEffect\(\(\) => \{\s*void createLink\(/);
});
