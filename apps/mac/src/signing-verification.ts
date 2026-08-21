export type SigningIdentityAssessment = {
  ok: boolean;
  problems: string[];
};

export type CodesignResult = { ok: boolean; output: string };
export type CodesignRunner = (args: string[]) => CodesignResult;

const DEFAULT_IDENTIFIER = "com.capso.app";

function normalizedDesignatedRequirement(output: string) {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.includes("designated =>"));
  if (!line) return "";
  return line
    .slice(line.indexOf("designated =>"))
    .replace(/\/\*\s*exists\s*\*\//gi, "exists")
    .replace(/\s+/g, " ")
    .trim();
}

function supportedDesignatedRequirement(
  output: string,
  identifier: string,
  teamIdentifier: string,
  appleDevelopmentAuthority: string | undefined,
) {
  const actual = normalizedDesignatedRequirement(output);
  const developerIdRequirement = [teamIdentifier, `"${teamIdentifier}"`].some(
    (teamValue) =>
      actual ===
      `designated => identifier "${identifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ${teamValue}`,
  );
  const appleDevelopmentRequirement = Boolean(
    appleDevelopmentAuthority &&
      actual ===
        `designated => identifier "${identifier}" and anchor apple generic and certificate leaf[subject.CN] = "${appleDevelopmentAuthority}" and certificate 1[field.1.2.840.113635.100.6.2.1] exists`,
  );
  return developerIdRequirement || appleDevelopmentRequirement;
}

export function signingIdentityAssessment(
  details: string,
  designatedRequirement: string,
  expectedIdentifier = DEFAULT_IDENTIFIER,
): SigningIdentityAssessment {
  const problems: string[] = [];
  if (details.includes("Signature=adhoc")) {
    problems.push("The app is ad-hoc signed, so every rebuild gets a new macOS identity.");
  }
  if (details.includes("TeamIdentifier=not set")) {
    problems.push("The app has no stable Apple TeamIdentifier.");
  }
  if (/\bcdhash\b/i.test(designatedRequirement)) {
    problems.push("The designated requirement contains a CDHash and can change between builds.");
  }
  const identifier = details
    .split(/\r?\n/)
    .find((line) => line.startsWith("Identifier="))
    ?.slice("Identifier=".length)
    .trim();
  if (identifier !== expectedIdentifier) {
    problems.push(
      `The signed identifier must be ${expectedIdentifier}, not ${identifier || "missing"}.`,
    );
  }
  const teamIdentifier = details
    .split(/\r?\n/)
    .find((line) => line.startsWith("TeamIdentifier="))
    ?.slice("TeamIdentifier=".length)
    .trim();
  const hasStableTeam = Boolean(
    teamIdentifier && /^[A-Z0-9]{10}$/i.test(teamIdentifier),
  );
  if (!hasStableTeam) {
    problems.push("Capso could not prove a stable team signing identity.");
  }
  const appleDevelopmentAuthority = details
    .split(/\r?\n/)
    .find((line) => line.startsWith("Authority=Apple Development:"))
    ?.slice("Authority=".length)
    .trim();
  if (
    !teamIdentifier ||
    !supportedDesignatedRequirement(
      designatedRequirement,
      expectedIdentifier,
      teamIdentifier,
      appleDevelopmentAuthority,
    )
  ) {
    problems.push(
      "Capso could not prove a conjunctive Apple-issued designated requirement bound to this identifier and TeamIdentifier.",
    );
  }
  return { ok: problems.length === 0, problems };
}

export function verifySigningTarget(
  target: string,
  runCodesign: CodesignRunner,
  expectedIdentifier = DEFAULT_IDENTIFIER,
): SigningIdentityAssessment {
  const integrity = runCodesign([
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    target,
  ]);
  const details = runCodesign(["-dv", "--verbose=4", target]);
  const requirement = runCodesign(["-dr", "-", target]);
  const problems: string[] = [];
  if (!integrity.ok) {
    problems.push(
      `The app failed strict code-signature integrity verification${integrity.output.trim() ? `: ${integrity.output.trim()}` : "."}`,
    );
  }
  if (!details.ok) problems.push("Capso could not read the bundle signing details.");
  if (!requirement.ok) {
    problems.push("Capso could not read the bundle designated requirement.");
  }
  problems.push(
    ...signingIdentityAssessment(
      details.output,
      requirement.output,
      expectedIdentifier,
    ).problems,
  );
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
