# IVOL Code Agent 5 для IntelliJ IDEA 2025.3.6.1

Цель этой отдельной сборки **5.16.232** — **IntelliJ IDEA 2025.3.6.1, IU-253.33813.55**. Версия IDE и версия плагина независимы. Общие функции, интерфейс и настройки провайдеров берутся из того же ядра IVOL 5.16.232, что и в остальных редакциях.

## Установка и требования

Используйте [готовый ZIP 5.16.232](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.232/ivol-code-agent-5-5.16.232-intellij-idea-2025.3.zip). Не подменяйте его существующим `-intellij-idea.zip`: тот предназначен для платформы 262 и Java 25.

1. Откройте **Settings → Plugins → шестерёнка → Install Plugin from Disk**.
2. Выберите ZIP без распаковки.
3. Завершите текущую работу и перезапустите IDE, когда это будет удобно.

Нужны штатный JetBrains Runtime с Java 21 и JCEF, включённый Terminal и установленный Node.js не ниже 20.6.0, доступный IDE. Node.js в архив не включён. Нативные зависимости предусмотрены для Windows x64, Linux x64, macOS Intel и Apple Silicon; это не означает проверку запуска на всех этих системах.

Не включайте одновременно официальный Kilo Code и IVOL Code. Идентификаторы `pro.ivol.kilocode5.jetbrains` и внутренний `Kilo Code.kilo-code` сохранены. Обновление существующего IVOL не требует удаления задач или настроек. JetBrains-редакции на одном компьютере используют прежние общие `~/.kilocode/globalStorage` и `~/.kilocode/workspaceStorage`; отдельная новая история для этой версии IDEA не создаётся.

## Воспроизводимая сборка

Используйте точный официальный SDK IDEA 2025.3.6.1 и Java 21. Из `jetbrains/plugin`:

```sh
./gradlew verifyBuildTargetConfiguration test buildPlugin \
  -PplatformType=IU -PideaTarget=2025.3 \
  -PlocalIdePath="/path/to/IntelliJ IDEA.app/Contents" \
  -PdebugMode=release \
  -PbundledExtensionPath="/path/to/unpacked-5.16.232/extension" \
  -PplatformZipPath="/path/to/platform.zip" \
  --offline --no-daemon --max-workers=2 \
  -Pkotlin.compiler.execution.strategy=in-process
```

До сборки должны быть готовы общее расширение 5.16.232, `jetbrains/host/dist`, зависимости host и проверенный архив нативных модулей. Java 21 должна быть выбрана через `JAVA_HOME`.

Целевой диапазон: `253.33813.55–253.*`, Kotlin language/API 2.2. Выходной каталог — `build/idea253`, суффикс — `-idea-2025.3.zip`. Параметры и выходные файлы PhpStorm, IDEA 2026.2 и PyCharm 2025.1 остаются отдельными. Не запускайте общий `clean`, если нужно сохранить вложенные результаты других сборок.

У IDEA 253 уже есть модуль `com.intellij.modules.jcef`, поэтому зависимость от него сохранена. При этом обработчик ресурсов использует прежние `processRequest/readResponse`: сборка переиспользует тонкий адаптер из `src/pycharm/kotlin`, не подключая отсутствующие здесь новые callback-классы. Общая реализация открытия файлов, история и провайдеры не разветвляются по IDE.

Официальные источники: [релизы IDEA этой версии](https://data.services.jetbrains.com/products/releases?code=IIU&version=2025.3.6.1&type=release), [версии платформы и Java](https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html), [Kotlin в платформе](https://plugins.jetbrains.com/docs/intellij/using-kotlin.html).

## Проверка и границы результата

После проверки рядом с ZIP создаются `.sha256` и `.verification.json`: целевой build, тесты, результат Plugin Verifier и контрольные суммы общего ядра. Компиляция и проверка API не заменяют запуск в реальной IDE и проверку работы JCEF, терминала и открытия файлов после установки.

Проверено 8 сентября 2026 года:

- Компиляция и упаковка против точного официального SDK **IU-253.33813.55**: успешно.
- **152 теста** пройдены, без ошибок и пропусков.
- Plugin Verifier 1.410: **Compatible**, ошибок бинарной совместимости и структуры не найдено. Предупреждения об устаревших, внутренних и экспериментальных API остаются техническим долгом; это не обещание совместимости с будущими платформами.
- Ядро, интерфейс и host побайтово совпадают с ранее собранными пакетами 5.16.232; их контрольные суммы не изменились.
- SHA256 ZIP: `b1fe95f00962a578b796a3c3502329e04bb3098257ef512e844a3ecd1f00327d`.
- Реальное окно IDEA не запускалось, установка и интерактивный сценарий открытия Markdown ещё не проверены.

Сборка не устанавливает плагин, не запускает IDE и не меняет историю или провайдеров. Все варианты скачивания: [общая страница релиза](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.16.232).
