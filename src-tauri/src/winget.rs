use std::ffi::OsString;

const HASH_MISMATCH: u32 = 0x8A150011;
const NO_PACKAGES: u32 = 0x8A150014;

// Retry only failures that occur before an installer starts. Keep the exact ID,
// source, pinned version, scope and installer options from the approved plan.
pub fn run_with_recovery(
    mut args: Vec<OsString>,
    mut run: impl FnMut(&[OsString]) -> Result<i32, String>,
    mut notify: impl FnMut(&str),
) -> Result<i32, String> {
    let code = run(&args)?;
    let verb = args.first().and_then(|v| v.to_str()).unwrap_or("");
    if !["show", "install", "upgrade", "download"].contains(&verb)
        || !matches!(
            code as u32,
            HASH_MISMATCH | NO_PACKAGES | 0x8A15000F | 0x8A150017
        )
    {
        return Ok(code);
    }

    if verb == "upgrade" && code as u32 == NO_PACKAGES {
        // Registry detection can find an app that WinGet cannot correlate with
        // an installed package (including a different installation scope).
        // `install` resolves the exact source package and can also upgrade it.
        args[0] = "install".into();
        notify("WinGet не сопоставил установленную программу с пакетом. После обновления источника будет выполнена установка по тому же точному ID и с выбранной областью установки.");
    } else {
        notify("Обновление источника winget перед единственным повтором. Проверка SHA-256 остаётся включённой; выбранная версия сохраняется.");
    }

    let refresh_args = [
        "source",
        "update",
        "--name",
        "winget",
        "--disable-interactivity",
    ]
    .map(OsString::from);
    let refresh = run(&refresh_args)?;
    if refresh != 0 {
        return Err(format!(
            "Код WinGet: 0x{:08X}. Не удалось обновить источник winget (0x{:08X}). Проверьте подключение и доступность источника, затем повторите задачу.",
            code as u32, refresh as u32
        ));
    }
    run(&args)
}

pub fn failure(code: i32, package: &str) -> String {
    let unsigned = code as u32;
    let hint = match unsigned {
        0x800704C7 | 0x8A15010C => "Отказ UAC или отмена установки. Подтвердите запрос Windows и повторите.".into(),
        0x80070070 => "Недостаточно места на диске.".into(),
        HASH_MISMATCH => "Хеш установщика не совпал с манифестом. Установка заблокирована проверкой SHA-256. Повторите позже или откройте официальный сайт кнопкой «Источник».".into(),
        NO_PACKAGES | 0x8A150017 => format!("Пакет {package} или выбранная версия не найдены в WinGet. Если закреплена версия, выберите «Последняя доступная в WinGet» в параметрах программы. Также можно открыть официальный сайт кнопкой «Источник»."),
        0x8A150010 => "В WinGet нет установщика для выбранной версии, архитектуры или области установки. Проверьте параметры программы или откройте официальный источник.".into(),
        0x8A15000F | 0x8A150012 | 0x8A150015 => "Источник winget отсутствует или его данные недоступны. Проверьте источники WinGet и App Installer, затем повторите задачу.".into(),
        _ => "Проверьте журнал, сеть, лицензию и требования пакета; независимые задачи продолжатся.".into(),
    };
    format!("Код WinGet: 0x{unsigned:08X}. {hint}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn simulate(args: &[&str], codes: &[u32]) -> (Result<i32, String>, Vec<Vec<OsString>>) {
        let mut codes: VecDeque<_> = codes.iter().copied().collect();
        let mut calls = Vec::new();
        let result = run_with_recovery(
            args.iter().map(OsString::from).collect(),
            |args| {
                calls.push(args.to_vec());
                Ok(codes.pop_front().expect("unexpected extra WinGet call") as i32)
            },
            |_| {},
        );
        assert!(codes.is_empty(), "expected WinGet calls did not happen");
        (result, calls)
    }

    #[test]
    fn hash_failure_refreshes_only_winget_and_retries_the_same_request_once() {
        let (result, calls) = simulate(
            &[
                "download",
                "--id",
                "Google.Chrome",
                "--exact",
                "--source",
                "winget",
                "--version",
                "156.0.8078.48",
                "--download-directory",
                "C:\\Downloads with spaces",
            ],
            &[HASH_MISMATCH, 0, 0],
        );
        assert_eq!(result, Ok(0));
        assert_eq!(calls[0], calls[2]);
        assert_eq!(
            calls[1],
            [
                "source",
                "update",
                "--name",
                "winget",
                "--disable-interactivity"
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn missing_upgrade_falls_back_to_exact_install_preserving_user_scope_and_pin() {
        let (result, calls) = simulate(
            &[
                "upgrade",
                "--id",
                "Microsoft.VisualStudioCode",
                "--exact",
                "--source",
                "winget",
                "--scope",
                "user",
                "--version",
                "1.142.0",
                "--silent",
            ],
            &[NO_PACKAGES, 0, 0],
        );
        assert_eq!(result, Ok(0));
        assert_eq!(calls[2][0], "install");
        assert_eq!(calls[0][1..], calls[2][1..]);
    }

    #[test]
    fn missing_show_or_install_refreshes_without_changing_the_operation() {
        for verb in ["show", "install"] {
            let (result, calls) = simulate(
                &[
                    verb,
                    "--id",
                    "Microsoft.VisualStudioCode",
                    "--exact",
                    "--source",
                    "winget",
                ],
                &[NO_PACKAGES, 0, 0],
            );
            assert_eq!(result, Ok(0));
            assert_eq!(calls[0], calls[2]);
        }
    }

    #[test]
    fn repeated_hash_failure_stops_without_weakening_verification() {
        let (result, calls) = simulate(
            &[
                "install",
                "--id",
                "Google.Chrome",
                "--exact",
                "--source",
                "winget",
            ],
            &[HASH_MISMATCH, 0, HASH_MISMATCH],
        );
        assert_eq!(result, Ok(HASH_MISMATCH as i32));
        assert_eq!(calls.len(), 3);
        assert!(!calls
            .iter()
            .flatten()
            .any(|v| v == "--ignore-security-hash" || v == "--force"));
    }

    #[test]
    fn failed_refresh_keeps_both_error_codes_and_does_not_retry() {
        let (result, calls) = simulate(&["install"], &[HASH_MISMATCH, 0x80072EE7]);
        let error = result.unwrap_err();
        assert!(error.contains("0x8A150011") && error.contains("0x80072EE7"));
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn success_cancellation_and_installer_errors_are_never_retried() {
        for code in [0, 3010, 0x800704C7, 0x8A150049, 0x8A15002B, 0x8A150010] {
            let (result, calls) = simulate(&["install"], &[code]);
            assert_eq!(result, Ok(code as i32));
            assert_eq!(calls.len(), 1);
        }
    }

    #[test]
    fn process_launch_failure_is_reported_without_retry() {
        let result = run_with_recovery(
            vec!["install".into()],
            |_| Err("WinGet не найден".into()),
            |_| {},
        );
        assert_eq!(result, Err("WinGet не найден".into()));
    }

    #[test]
    fn missing_package_and_hash_errors_have_actionable_distinct_messages() {
        let missing = failure(NO_PACKAGES as i32, "Microsoft.VisualStudioCode");
        assert!(
            missing.contains("Microsoft.VisualStudioCode")
                && missing.contains("Последняя доступная в WinGet")
        );
        assert!(!missing.contains("лицензию"));
        let hash = failure(HASH_MISMATCH as i32, "Google.Chrome");
        assert!(hash.contains("SHA-256") && hash.contains("Источник"));
    }
}
