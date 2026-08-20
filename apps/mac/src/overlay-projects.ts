export type CaptureProject = {
  id: string;
  name: string;
};

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function captureProjectList(value: unknown): CaptureProject[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const ids = new Set<string>();
  const projects: CaptureProject[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const keys = Object.keys(candidate).sort();
    if (keys.length !== 2 || keys[0] !== "id" || keys[1] !== "name") return null;
    const { id, name } = candidate as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !PROJECT_ID.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      name.trim() !== name ||
      name.length < 1 ||
      name.length > 120
    ) {
      return null;
    }
    ids.add(id);
    projects.push({ id, name });
  }
  return projects;
}
