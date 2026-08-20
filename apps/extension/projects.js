import { deviceToken, origin } from "./config.js";

export const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function projectList(value) {
  if (!value || !Array.isArray(value.projects) || value.projects.length > 50) return [];
  return value.projects.flatMap((project) => {
    if (
      !project ||
      typeof project !== "object" ||
      typeof project.id !== "string" ||
      !PROJECT_ID.test(project.id) ||
      typeof project.name !== "string" ||
      project.name.length < 1 ||
      project.name.length > 160 ||
      (project.description !== null &&
        project.description !== undefined &&
        (typeof project.description !== "string" || project.description.length > 256))
    ) return [];
    return [{
      id: project.id,
      name: project.name,
      description: project.description ?? null,
    }];
  });
}

export async function fetchProjects() {
  const base = await origin();
  const token = await deviceToken();
  if (!token) return { projects: [], error: "Pair this extension before choosing a project." };
  try {
    const response = await fetch(`${base}/api/extension/projects`, {
      headers: { "x-capso-device": token },
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { projects: [], error: body?.error ?? "Projects are unavailable." };
    }
    return { projects: projectList(body), error: null };
  } catch {
    return { projects: [], error: "Projects are unavailable while Capso is offline." };
  }
}
