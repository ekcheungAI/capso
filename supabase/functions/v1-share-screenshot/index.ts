import { createShareHandler } from "./share.ts";

function required(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createProductionHandler() {
  return createShareHandler({
    supabaseUrl: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  });
}

if (import.meta.main) Deno.serve(createProductionHandler());
