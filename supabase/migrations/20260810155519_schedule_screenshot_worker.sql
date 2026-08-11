-- Wake the single-item processor once per minute. The shared secret lives in
-- Vault and is resolved only when pg_cron executes the request; neither the
-- migration history nor cron.job contains the credential itself.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

do $$
begin
  if not exists (
    select 1
      from vault.decrypted_secrets
     where name = 'capso_worker_secret'
  ) then
    raise exception 'capso_worker_secret is missing from Vault';
  end if;

  perform cron.unschedule(jobid)
    from cron.job
   where jobname = 'capso-process-screenshot';
end;
$$;

select cron.schedule(
  'capso-process-screenshot',
  '* * * * *',
  $cron$
    select net.http_post(
      url := 'https://xbxedriuelwqjypdkvex.supabase.co/functions/v1/v1-process-screenshot',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-capso-worker-secret', (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'capso_worker_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 65000
    ) as request_id;
  $cron$
);
