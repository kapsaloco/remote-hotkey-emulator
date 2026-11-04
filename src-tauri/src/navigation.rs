use tauri::Url;

/// Tauri normalizes App("index.html") to the app origin's root URL. Its CLI
/// may also serve frontendDist from a loopback development server.
pub fn allowed(url: &Url, development_url: Option<&Url>) -> bool {
    if !matches!(url.path(), "/" | "/index.html")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let bundled = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none();
    if bundled {
        return true;
    }
    development_url.is_some_and(|development| {
        let host = development
            .host_str()
            .unwrap_or("")
            .trim_start_matches('[')
            .trim_end_matches(']');
        let loopback = host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback());
        loopback
            && matches!(development.scheme(), "http" | "https")
            && url.origin() == development.origin()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_index_normalizes_to_root_and_both_are_allowed() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            for path in ["/", "/index.html"] {
                assert!(allowed(
                    &Url::parse(&format!("{origin}{path}")).unwrap(),
                    None
                ));
            }
        }
    }
    #[test]
    fn development_allows_only_the_configured_loopback_origin() {
        for origin in [
            "http://localhost:1430/",
            "http://127.0.0.1:1430/",
            "http://[::1]:1430/",
        ] {
            let development = Url::parse(origin).unwrap();
            assert!(allowed(&development, Some(&development)));
            assert!(allowed(
                &development.join("index.html").unwrap(),
                Some(&development)
            ));
            assert!(!allowed(&development, None));
            assert!(!allowed(
                &Url::parse("http://localhost:9999/").unwrap(),
                Some(&development)
            ));
        }
    }
    #[test]
    fn external_pages_credentials_and_other_paths_remain_blocked() {
        let development = Url::parse("http://localhost:1430/").unwrap();
        for value in [
            "https://example.com/",
            "http://tauri.localhost.evil/",
            "http://tauri.localhost:9999/",
            "http://localhost:1430/other.html",
            "http://user@localhost:1430/",
            "about:blank",
            "file:///C:/index.html",
        ] {
            assert!(
                !allowed(&Url::parse(value).unwrap(), Some(&development)),
                "{value}"
            );
        }
        let external = Url::parse("https://example.com/").unwrap();
        assert!(!allowed(&external, Some(&external)));
    }
}
