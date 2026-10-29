# AppDock

Версия **0.2.0** включает исправления очереди, новые рабочие разделы и мини-иконки приложений в наборах. Готовые файлы доступны в GitHub Releases. Подробности и ограничения: [изменения 0.2.0](docs/APPDOCK-0.2.0.md).

Настольное приложение для Windows 11: каталог программ, параметры, итоговый план, последовательная установка через WinGet, отдельные загрузки и отчёт. Интерфейс полностью на русском языке. В каталоге 80 отдельных продуктов; 40 основных WinGet-интеграций, 3 редакции Visual Studio и 8 расширений VS Code проверены по источникам.

## Скачать AppDock 0.2.0 для Windows

**[Скачать установщик AppDock для Windows x64](https://github.com/Farbras/appdock/releases/download/v0.2.0/AppDock_0.2.0_x64-setup.exe)**

1. Скачайте установщик по ссылке выше.
2. Откройте `AppDock_0.2.0_x64-setup.exe` и завершите установку.
3. Запустите AppDock через меню «Пуск».

Для запуска без установки скачайте **[ZIP с готовым AppDock.exe](https://github.com/Farbras/appdock/releases/download/v0.2.0/AppDock-0.2.0-windows-x64.zip)**, распакуйте архив в отдельную папку и откройте `AppDock.exe`. Также доступен [отдельный AppDock.exe](https://github.com/Farbras/appdock/releases/download/v0.2.0/AppDock.exe).

Готовая версия рассчитана на Windows 11 x64. Для отображения интерфейса нужен Microsoft Edge WebView2 Runtime; установщик скачает его при отсутствии. Для установки программ из каталога нужен WinGet / App Installer и доступ в интернет. Node.js, Rust и инструменты сборки для запуска готовой программы не нужны.

Все файлы выпуска: **[GitHub Releases](https://github.com/Farbras/appdock/releases/latest)**. Кнопка GitHub «Code → Download ZIP» скачивает исходный код; готовый ZIP с `.exe` находится в Releases по ссылке выше.

## Запуск из исходного кода

Требования обычной среды разработки: Node.js 22+, npm, стабильный Rust MSVC, Microsoft C++ Build Tools с Windows SDK, WebView2. Для реальных пакетных операций нужен WinGet / App Installer.

```powershell
npm ci
npm run desktop
```

В текущей рабочей папке есть локальный npm и скрипт настройки портативных инструментов; глобальный PATH менять не требуется:

```powershell
.\scripts\npm.ps1 run dev       # браузерный деморежим, http://127.0.0.1:1420
.\scripts\desktop.ps1          # нативное окно Tauri
.\scripts\desktop.ps1 -Build   # сборка NSIS
```

В браузере всегда включена явная демонстрация. Нативное приложение по умолчанию работает с реальным компьютером; переключатель деморежима находится в настройках. Первый запуск очереди требует просмотра конкретного плана и подтверждения внутри приложения. Каталог автоматически не выбирается.

## Сборка Windows

```powershell
npm run bundle
```

Результаты стандартной сборки: `src-tauri/target/release/appdock.exe` и `src-tauri/target/release/bundle/nsis/AppDock_0.2.0_x64-setup.exe`. NSIS устанавливает AppDock для текущего пользователя; приложение не требует запуска целиком от администратора. Пакетные установщики запрашивают собственный UAC. Сертификат подписи выпуска не настроен.

После сборки `python scripts/package-release.py` подготовит в `releases/AppDock-0.2.0/` установщик, отдельный `.exe`, ZIP для запуска без установки, архив исходников и файл SHA-256. Для этого шага нужен Python 3.

Если нет системных Build Tools, `scripts/build-env.ps1` умеет использовать уже подготовленные инструменты из `.tools`. Их архивы получены с серверов Microsoft, проверены по SHA-256 каталога Microsoft / SHA-512 метаданных NuGet и распакованы локально. Разработка не требует повторной установки Visual Studio или изменения её компонентов.

## Проверки

```powershell
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Для портативной среды перед Cargo выполните `. .\scripts\build-env.ps1`. Сквозной UI-сценарий: `node scripts/ui-smoke.mjs` с зависимостями проекта (`playwright`) и Edge. Playwright включён в devDependencies; установка программ не выполняется. Тесты не устанавливают программы из каталога.

## Данные и расширение каталога

- `catalog/apps.json` — отдельные продукты, типы, платформы, условия, источники и правила обнаружения.
- `catalog/extensions.json` — точные Marketplace ID и зависимости.
- `catalog/presets.json` — 9 стартовых наборов без конкурирующих браузеров и офисных пакетов.
- `catalog/vs-profiles.json`, `catalog/vsconfig/` — снимок состава Visual Studio для трёх редакций.
- `docs/integration-checks.json` — исходные ответы проверки пакетов и Marketplace.

Новый продукт добавляется отдельным манифестом-записью в `catalog/apps.json`. Для безопасной установки нужно указать точный ID источника WinGet, разрешённые параметры и правила обнаружения, затем выполнить `node scripts/verify-integrations.mjs`, `npm run check` и пересобрать нативную часть. Отметка `verified` без успешной проверки источника не допускается. Наборы JSON не могут добавлять команды или новые установочные источники.

Импорт и экспорт наборов доступны на экране «Наборы». Данные содержат программы, версии, действия и разрешённые параметры. Пароли вводятся только в официальном мастере производителя и не попадают в AppDock.

Подробности: [архитектура](docs/ARCHITECTURE.md), [ограничения интеграций](docs/LIMITATIONS.md), [первичные источники](docs/SOURCES.md), [проверки](docs/VALIDATION.md).
