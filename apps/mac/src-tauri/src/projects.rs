use crate::auth::{AuthHttpClient, AuthHttpRequest, AuthSession, SupabaseAuthConfig};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use url::Url;

const MAX_PROJECTS: usize = 50;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CaptureProject {
    pub(crate) id: String,
    pub(crate) name: String,
}

pub(crate) fn fetch_capture_projects<C: AuthHttpClient>(
    client: &C,
    config: &SupabaseAuthConfig,
    session: &AuthSession,
    now_ms: u64,
) -> Result<Vec<CaptureProject>, String> {
    let access_token = session.usable_access_token(now_ms).ok_or_else(|| {
        "Capso's account session needs to be refreshed before loading projects.".to_string()
    })?;
    let mut endpoint = Url::parse(&format!("{}/rest/v1/project_threads", config.url))
        .map_err(|_| "Capso's project service is not configured safely.".to_string())?;
    endpoint
        .query_pairs_mut()
        .append_pair("select", "id,name")
        .append_pair("user_id", &format!("eq.{}", session.user_id()))
        .append_pair("archived_at", "is.null")
        .append_pair("order", "last_active_at.desc,id.asc")
        .append_pair("limit", &MAX_PROJECTS.to_string());

    let response = client
        .execute(AuthHttpRequest {
            method: "GET",
            url: endpoint.into(),
            headers: BTreeMap::from([
                ("apikey".into(), config.publishable_key.clone()),
                ("authorization".into(), format!("Bearer {access_token}")),
                ("accept".into(), "application/json".into()),
            ]),
            body: Vec::new(),
        })
        .map_err(|_| "Capso could not load projects; try again when online.".to_string())?;
    if !(200..300).contains(&response.status) {
        return Err(if response.status == 401 || response.status == 403 {
            "Capso could not verify this account; sign in again and retry.".into()
        } else {
            "Capso could not load projects; try again.".into()
        });
    }
    let projects = serde_json::from_slice::<Vec<CaptureProject>>(&response.body)
        .map_err(|_| "Capso received an invalid project list.".to_string())?;
    if projects.len() > MAX_PROJECTS {
        return Err("Capso received too many projects in one response.".into());
    }
    let mut ids = HashSet::new();
    for project in &projects {
        if !canonical_uuid(&project.id)
            || project.name.trim() != project.name
            || !(1..=120).contains(&project.name.encode_utf16().count())
            || !ids.insert(project.id.as_str())
        {
            return Err("Capso received an invalid project list.".into());
        }
    }
    Ok(projects)
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string() == value && (1..=8).contains(&id.get_version_num()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{fetch_capture_projects, CaptureProject};
    use crate::auth::{
        AuthHttpClient, AuthHttpRequest, AuthHttpResponse, AuthSession, SupabaseAuthConfig,
    };
    use std::sync::Mutex;
    use url::Url;

    const USER_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";
    const PROJECT_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92276";

    #[derive(Debug)]
    struct RecordingClient {
        request: Mutex<Option<AuthHttpRequest>>,
        response: AuthHttpResponse,
    }

    impl AuthHttpClient for RecordingClient {
        fn execute(&self, request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
            *self.request.lock().expect("request lock") = Some(request);
            Ok(self.response.clone())
        }
    }

    fn config() -> SupabaseAuthConfig {
        SupabaseAuthConfig {
            url: "https://capso-test.supabase.co".into(),
            publishable_key: "sb_publishable_capso_test".into(),
        }
    }

    fn session() -> AuthSession {
        AuthSession::for_test(
            "header.payload.signature",
            "refresh_0123456789abcdef",
            USER_ID,
            120_001,
        )
    }

    #[test]
    fn project_query_is_owner_scoped_and_keeps_the_bearer_out_of_the_url() {
        let client = RecordingClient {
            request: Mutex::new(None),
            response: AuthHttpResponse {
                status: 200,
                body: serde_json::to_vec(&vec![CaptureProject {
                    id: PROJECT_ID.into(),
                    name: "Launch research".into(),
                }])
                .expect("project JSON"),
            },
        };

        assert_eq!(
            fetch_capture_projects(&client, &config(), &session(), 60_000)
                .expect("valid project list"),
            vec![CaptureProject {
                id: PROJECT_ID.into(),
                name: "Launch research".into(),
            }]
        );
        let request = client
            .request
            .lock()
            .expect("request lock")
            .clone()
            .expect("recorded request");
        let url = Url::parse(&request.url).expect("project URL");
        let query = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<std::collections::HashMap<_, _>>();
        let expected_owner = format!("eq.{USER_ID}");
        assert_eq!(
            query.get("user_id").map(String::as_str),
            Some(expected_owner.as_str())
        );
        assert_eq!(
            query.get("archived_at").map(String::as_str),
            Some("is.null")
        );
        assert_eq!(query.get("limit").map(String::as_str), Some("50"));
        assert!(!request.url.contains("header.payload.signature"));
        assert!(request.body.is_empty());
        assert_eq!(
            request.headers.get("authorization").map(String::as_str),
            Some("Bearer header.payload.signature")
        );
    }

    #[test]
    fn malformed_or_unbounded_project_lists_are_rejected() {
        for body in [
            serde_json::json!([{ "id": "not-a-uuid", "name": "Forged" }]),
            serde_json::json!([{ "id": PROJECT_ID, "name": " padded " }]),
            serde_json::Value::Array(
                (0..51)
                    .map(|index| {
                        serde_json::json!({
                            "id": format!("018f22c4-cada-7c6b-9d5b-{index:012x}"),
                            "name": "Too many"
                        })
                    })
                    .collect(),
            ),
        ] {
            let client = RecordingClient {
                request: Mutex::new(None),
                response: AuthHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&body).expect("invalid project JSON"),
                },
            };
            assert!(fetch_capture_projects(&client, &config(), &session(), 60_000).is_err());
        }
    }
}
