import assert from "node:assert/strict";
import test from "node:test";

type SigningModule = typeof import("./signing-verification.ts");

async function loadSigningModule(): Promise<SigningModule | null> {
  try {
    return await import("./signing-verification.ts");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Cannot find module") ||
        error.message.includes("ERR_MODULE_NOT_FOUND"))
    ) {
      return null;
    }
    throw error;
  }
}

test("ad-hoc and CDHash-only bundles fail the Screen Recording identity gate", async () => {
  const module = await loadSigningModule();
  assert.ok(module, "signing-verification.ts should provide the install gate");

  const assessment = module.signingIdentityAssessment(
    "Identifier=com.capso.app\nSignature=adhoc\nTeamIdentifier=not set\n",
    'designated => cdhash H"d3b07f"',
  );

  assert.equal(assessment.ok, false);
  assert.match(assessment.problems.join(" "), /ad-hoc/i);
  assert.match(assessment.problems.join(" "), /CDHash/i);
});

test("a team-signed bundle with a stable designated requirement passes", async () => {
  const module = await loadSigningModule();
  assert.ok(module, "signing-verification.ts should provide the install gate");

  const assessment = module.signingIdentityAssessment(
    "Identifier=com.capso.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
    'designated => identifier "com.example.capso" and anchor apple generic',
  );

  assert.equal(assessment.ok, false, "the signed identifier must match Capso");

  assert.deepEqual(
    module.signingIdentityAssessment(
      "Identifier=com.capso.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
      'Executable=/Applications/Capso.app/Contents/MacOS/Capso\ndesignated => identifier "com.capso.app" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ABCDE12345',
    ),
    { ok: true, problems: [] },
  );
});

test("an Apple Development bundle is bound to its certificate common name", async () => {
  const module = await loadSigningModule();
  assert.ok(module, "signing-verification.ts should provide the install gate");
  const details =
    "Identifier=com.capso.app\nAuthority=Apple Development: Example Person (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
  const requirement =
    'designated => identifier "com.capso.app" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Example Person (ABCDE12345)" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */';
  assert.deepEqual(module.signingIdentityAssessment(details, requirement), {
    ok: true,
    problems: [],
  });
  assert.equal(
    module.signingIdentityAssessment(
      details,
      requirement.replace("Example Person", "Another Person"),
    ).ok,
    false,
  );
});

test("missing, malformed, or hash-pinned designated requirements fail closed", async () => {
  const module = await loadSigningModule();
  assert.ok(module, "signing-verification.ts should provide the install gate");
  const details =
    "Identifier=com.capso.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";

  for (const requirement of [
    "",
    "designated => identifier only",
    'designated => identifier "com.capso.app" and anchor apple generic and cdhash H"abc"',
    'designated => identifier "com.capso.app" and anchor apple generic',
    'designated => identifier "com.capso.app" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = OTHER12345',
    'designated => identifier "com.capso.app" or anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ABCDE12345',
  ]) {
    const assessment = module.signingIdentityAssessment(details, requirement);
    assert.equal(assessment.ok, false, requirement || "missing requirement");
  }
});

test("target verification checks integrity before accepting signing metadata", async () => {
  const module = await loadSigningModule();
  assert.ok(module, "signing-verification.ts should provide the install gate");
  const calls: string[][] = [];
  const assessment = module.verifySigningTarget("/tmp/Capso.app", (args) => {
    calls.push(args);
    if (args[0] === "--verify") {
      return { ok: false, output: "sealed resource is missing" };
    }
    if (args[0] === "-dv") {
      return {
        ok: true,
        output:
          "Identifier=com.capso.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
      };
    }
    return {
      ok: true,
      output:
        'designated => identifier "com.capso.app" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ABCDE12345',
    };
  });

  assert.deepEqual(calls[0]?.slice(0, 4), [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
  ]);
  assert.equal(assessment.ok, false);
  assert.match(assessment.problems.join(" "), /integrity/i);
});
