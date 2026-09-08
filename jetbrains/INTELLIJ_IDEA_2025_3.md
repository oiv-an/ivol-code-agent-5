# IVOL Code Agent 5 для IntelliJ IDEA 2025.3.6.1

Цель этой отдельной сборки **5.16.233** — **IntelliJ IDEA 2025.3.6.1, IU-253.33813.55**. Версия IDE и версия плагина независимы. Общие функции, интерфейс и настройки провайдеров берутся из того же ядра IVOL 5.16.233, что и в остальных редакциях.

## Установка и требования

Используйте [готовый ZIP 5.16.233](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/ivol-code-agent-5-5.16.233-intellij-idea-2025.3.zip). Не подменяйте его существующим `-intellij-idea.zip`: тот предназначен для платформы 262 и Java 25.

1. Откройте **Settings → Plugins → шестерёнка → Install Plugin from Disk**.
2. Выберите ZIP без распаковки.
3. Завершите текущую работу и перезапустите IDE, когда это будет удобно.

Нужны штатный JetBrains Runtime с Java 21 и JCEF, включённый Terminal и установленный Node.js не ниже 20.6.0, доступный IDE. Node.js в архив не включён. Нативные зависимости предусмотрены для Windows x64, Linux x64, macOS Intel и Apple Silicon; это не означает проверку запуска на всех этих системах.

Не включайте одновременно официальный Kilo Code и IVOL Code. Идентификаторы `pro.ivol.kilocode5.jetbrains` и внутренний `Kilo Code.kilo-code` сохранены. Обновление существующего IVOL не требует удаления задач или настроек. JetBrains-редакции на одном компьютере используют прежние общие `~/.kilocode/globalStorage` и `~/.kilocode/workspaceStorage`; отдельная новая история для этой версии IDEA не создаётся.

В 5.16.233 исправлена ошибка запуска `NoSuchFileException` для `watcher.node`, возникавшая при одновременной инициализации нескольких проектов. Общая подготовка нативных библиотек защищена от повторного и параллельного запуска. Установите новый ZIP поверх имеющегося IVOL; исправление включено также в IDEA 2026.2, PhpStorm и PyCharm.

## Воспроизводимая сборка

Используйте точный официальный SDK IDEA 2025.3.6.1 и Java 21. Из `jetbrains/plugin`:

```sh
./gradlew verifyBuildTargetConfiguration test buildPlugin \
  -PplatformType=IU -PideaTarget=2025.3 \
  -PlocalIdePath="/path/to/IntelliJ IDEA.app/Contents" \
  -PdebugMode=release \
  -PbundledExtensionPath="/path/to/unpacked-5.16.233/extension" \
  -PplatformZipPath="/path/to/platform.zip" \
  --offline --no-daemon --max-workers=2 \
  -Pkotlin.compiler.execution.strategy=in-process
```

До сборки должны быть готовы общее расширение 5.16.233, `jetbrains/host/dist`, зависимости host и проверенный архив нативных модулей. Java 21 должна быть выбрана через `JAVA_HOME`.

Целевой диапазон: `253.33813.55–253.*`, Kotlin language/API 2.2. Выходной каталог — `build/idea253`, суффикс — `-idea-2025.3.zip`. Параметры и выходные файлы PhpStorm, IDEA 2026.2 и PyCharm 2025.1 остаются отдельными. Не запускайте общий `clean`, если нужно сохранить вложенные результаты других сборок.

У IDEA 253 уже есть модуль `com.intellij.modules.jcef`, поэтому зависимость от него сохранена. При этом обработчик ресурсов использует прежние `processRequest/readResponse`: сборка переиспользует тонкий адаптер из `src/pycharm/kotlin`, не подключая отсутствующие здесь новые callback-классы. Общая реализация открытия файлов, история и провайдеры не разветвляются по IDE.

Официальные источники: [релизы IDEA этой версии](https://data.services.jetbrains.com/products/releases?code=IIU&version=2025.3.6.1&type=release), [версии платформы и Java](https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html), [Kotlin в платформе](https://plugins.jetbrains.com/docs/intellij/using-kotlin.html).

## Проверка и границы результата

После проверки рядом с ZIP создаются `.sha256` и `.verification.json`: целевой build, тесты, результат Plugin Verifier и контрольные суммы общего ядра. Компиляция и проверка API не заменяют запуск в реальной IDE и проверку работы JCEF, терминала и открытия файлов после установки.

Для 5.16.233 проверки включают компиляцию и упаковку против точного официального SDK **IU-253.33813.55**, автоматические тесты и Plugin Verifier. Общее ядро, интерфейс и host сравниваются с остальными пакетами того же релиза. Предупреждения об устаревших, внутренних и экспериментальных API остаются техническим долгом; это не обещание совместимости с будущими платформами.

Актуальные контрольные суммы установщиков опубликованы в [SHA256SUMS.txt](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/SHA256SUMS.txt). Реальное окно IDEA в ходе сборки не запускается; установка, одновременное открытие проектов и интерактивный сценарий открытия Markdown проверяются отдельно пользователем.

Сборка не устанавливает плагин, не запускает IDE и не меняет историю или провайдеров. Все варианты скачивания: [общая страница релиза](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.16.233).
