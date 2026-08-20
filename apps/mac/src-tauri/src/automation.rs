use serde::Serialize;
use std::sync::Mutex;
use url::Url;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationFeedback {
    pub(crate) message: String,
    pub(crate) is_error: bool,
}

#[derive(Debug, Default)]
pub(crate) struct AutomationFeedbackState(Mutex<Option<AutomationFeedback>>);

impl AutomationFeedbackState {
    pub(crate) fn record(&self, message: impl Into<String>, is_error: bool) -> AutomationFeedback {
        let feedback = AutomationFeedback {
            message: message.into(),
            is_error,
        };
        if let Ok(mut current) = self.0.lock() {
            *current = Some(feedback.clone());
        }
        feedback
    }

    pub(crate) fn current(&self) -> Option<AutomationFeedback> {
        self.0.lock().ok().and_then(|current| current.clone())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AutomationAction {
    CaptureArea { delay_seconds: u8 },
    CaptureWindow { delay_seconds: u8 },
    CaptureFullscreen { delay_seconds: u8 },
    OpenHistory,
    OpenRecording,
    OpenSettings,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DeepLinkRoute {
    AuthCallback,
    Automation(AutomationAction),
}

pub(crate) fn parse_deep_link(value: &str) -> Result<DeepLinkRoute, &'static str> {
    let invalid = || "That Capso URL action is not supported.";
    let capture_delay = |base: &str| {
        if value == base {
            return Some(0);
        }
        value
            .strip_prefix(base)
            .and_then(|suffix| suffix.strip_prefix("?delay="))
            .and_then(|delay| match delay {
                "0" => Some(0),
                "3" => Some(3),
                "5" => Some(5),
                "10" => Some(10),
                _ => None,
            })
    };
    let automation = match value {
        "capso://open/history" => Some(AutomationAction::OpenHistory),
        "capso://open/recording" => Some(AutomationAction::OpenRecording),
        "capso://open/settings" => Some(AutomationAction::OpenSettings),
        _ => capture_delay("capso://capture/area")
            .map(|delay_seconds| AutomationAction::CaptureArea { delay_seconds })
            .or_else(|| {
                capture_delay("capso://capture/window")
                    .map(|delay_seconds| AutomationAction::CaptureWindow { delay_seconds })
            })
            .or_else(|| {
                capture_delay("capso://capture/fullscreen")
                    .map(|delay_seconds| AutomationAction::CaptureFullscreen { delay_seconds })
            }),
    };
    if let Some(action) = automation {
        return Ok(DeepLinkRoute::Automation(action));
    }
    if value != "capso://auth/callback" && !value.starts_with("capso://auth/callback?") {
        return Err(invalid());
    }
    let parsed = Url::parse(value).map_err(|_| invalid())?;
    if parsed.scheme() != "capso"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid());
    }
    let host = parsed.host_str().ok_or_else(invalid)?;
    let path = parsed.path();
    if host == "auth" && path == "/callback" {
        return Ok(DeepLinkRoute::AuthCallback);
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::{parse_deep_link, AutomationAction, DeepLinkRoute};

    #[test]
    fn exact_public_urls_map_to_one_bounded_local_action() {
        assert_eq!(
            parse_deep_link("capso://capture/area").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::CaptureArea { delay_seconds: 0 }),
        );
        assert_eq!(
            parse_deep_link("capso://capture/window").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::CaptureWindow { delay_seconds: 0 }),
        );
        assert_eq!(
            parse_deep_link("capso://capture/fullscreen").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::CaptureFullscreen { delay_seconds: 0 }),
        );
        assert_eq!(
            parse_deep_link("capso://open/history").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::OpenHistory),
        );
        assert_eq!(
            parse_deep_link("capso://open/recording").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::OpenRecording),
        );
        assert_eq!(
            parse_deep_link("capso://open/settings").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::OpenSettings),
        );
    }

    #[test]
    fn capture_urls_accept_only_one_exact_supported_delay() {
        assert_eq!(
            parse_deep_link("capso://capture/area?delay=3").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::CaptureArea { delay_seconds: 3 }),
        );
        assert_eq!(
            parse_deep_link("capso://capture/area?delay=0").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::CaptureArea { delay_seconds: 0 }),
        );
        assert_eq!(
            parse_deep_link("capso://capture/window?delay=5").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::CaptureWindow { delay_seconds: 5 }),
        );
        assert_eq!(
            parse_deep_link("capso://capture/fullscreen?delay=10").unwrap(),
            DeepLinkRoute::Automation(AutomationAction::CaptureFullscreen { delay_seconds: 10 }),
        );

        for unsafe_url in [
            "capso://capture/area?delay=1",
            "capso://capture/area?delay=03",
            "capso://capture/area?delay=%33",
            "capso://capture/area?delay=3&delay=5",
            "capso://capture/area?delay=3&token=secret",
            "capso://capture/area?Delay=3",
            "capso://capture/area?delay=",
            "capso://open/history?delay=3",
        ] {
            assert_eq!(
                parse_deep_link(unsafe_url).unwrap_err(),
                "That Capso URL action is not supported.",
            );
        }
    }

    #[test]
    fn auth_callback_is_separate_and_unsafe_automation_shapes_fail_closed() {
        assert_eq!(
            parse_deep_link("capso://auth/callback?code=secret&state=opaque").unwrap(),
            DeepLinkRoute::AuthCallback,
        );
        for unsafe_url in [
            "https://capture/area",
            "capso://capture/area#again",
            "capso://capture/foo/../area",
            "capso://capture/%61rea",
            "capso://capture/unknown?token=do-not-log",
            "capso://open/history/",
        ] {
            let error = parse_deep_link(unsafe_url).unwrap_err();
            assert_eq!(error, "That Capso URL action is not supported.");
            assert!(!error.contains("do-not-log"));
        }
    }
}
