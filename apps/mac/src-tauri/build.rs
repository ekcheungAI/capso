fn main() {
    println!("cargo:rerun-if-env-changed=CAPSO_SUPABASE_URL");
    println!("cargo:rerun-if-env-changed=CAPSO_SUPABASE_PUBLISHABLE_KEY");

    let url = std::env::var("CAPSO_SUPABASE_URL").ok();
    let key = std::env::var("CAPSO_SUPABASE_PUBLISHABLE_KEY").ok();
    match (url.as_deref(), key.as_deref()) {
        (None, None) => {}
        (Some(url), Some(key))
            if url.starts_with("https://") && key.starts_with("sb_publishable_") => {}
        _ => panic!(
            "native Supabase config must provide one HTTPS URL and one sb_publishable_ key; secret keys are forbidden"
        ),
    }

    tauri_build::build()
}
