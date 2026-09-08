# IVOL Code Agent 5 для PyCharm 2025.1.1.1

Отдельная сборка **5.16.233** предназначена для **PyCharm 2025.1.1.1, PY-251.25410.159**. Это не пакет для PhpStorm и IntelliJ IDEA 2026.2: у них другая версия платформы и Java.

## Установка

1. Скачайте [ZIP для PyCharm 2025.1](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/ivol-code-agent-5-5.16.233-pycharm-2025.1.zip).
2. В PyCharm откройте Settings → Plugins → шестерёнка → Install Plugin from Disk и выберите ZIP без распаковки.
3. Перезапустите IDE после завершения текущей работы. Плагин появится как **IVOL Code**.

Нужен штатный JetBrains Runtime с Java 21 и JCEF, включённый Terminal и установленный Node.js не ниже 20.6.0, доступный IDE. Node.js в ZIP не включён. Пакет содержит нативные зависимости для Windows x64, Linux x64, macOS Intel и Apple Silicon; наличие файлов не означает проверку запуска на каждой ОС.

Не включайте одновременно официальный Kilo Code и IVOL Code в одной IDE. Обновлять существующий IVOL можно поверх: идентификатор `pro.ivol.kilocode5.jetbrains` и внутренний `Kilo Code.kilo-code` сохранены. Все JetBrains-редакции на одном компьютере используют прежние каталоги `~/.kilocode/globalStorage` и `~/.kilocode/workspaceStorage`, а не отдельную новую историю.

Сборка 5.16.233 содержит общее для JetBrains исправление запуска нативных библиотек: одновременная инициализация нескольких проектов больше не должна приводить к потере `watcher.node` из-за конкурирующего перемещения файлов. Тот же исправленный адаптер используется в PhpStorm и обоих целевых вариантах IDEA. Удаление задач или настроек перед установкой не требуется.

## Совместимость и сборка

Для этой цели используются Java 21, Kotlin language/API 2.1 и диапазон `251.25410.159–251.*`. PyCharm 251 включает JCEF непосредственно в платформу; его установочный дескриптор генерируется отдельно без требования модуля, добавленного в более новых IDE. Исходный дескриптор и параметры PhpStorm/IDEA 262 сохраняются.

Используйте точный официальный SDK PyCharm 2025.1.1.1 и Java 21. Из `jetbrains/plugin`:

```sh
./gradlew verifyBuildTargetConfiguration test buildPlugin \
  -PplatformType=PY \
  -PlocalIdePath="/path/to/pycharm-2025.1.1.1" \
  -PdebugMode=release \
  -PbundledExtensionPath="/path/to/unpacked-5.16.233/extension" \
  -PplatformZipPath="/path/to/platform.zip" \
  --offline --no-daemon --max-workers=2 \
  -Pkotlin.compiler.execution.strategy=in-process
```

Перед сборкой должны быть готовы общее расширение, `jetbrains/host/dist`, зависимости host и проверенный архив нативных зависимостей. Выходные файлы PyCharm находятся в `build/pycharm`, отдельно от других целей. Не запускайте общий `clean`, если нужно сохранить их вместе с результатами IDEA.

Официальные источники: [релизы PyCharm](https://data.services.jetbrains.com/products/releases?code=PCP&version=2025.1.1.1&type=release), [версии платформы и Java](https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html), [библиотеки Kotlin](https://plugins.jetbrains.com/docs/intellij/using-kotlin.html), [установка плагина из ZIP](https://www.jetbrains.com/help/pycharm/managing-plugins.html#install_plugin_from_disk).

## Проверка

Статус компиляции, тестов, Plugin Verifier и контрольные суммы фиксируются в соседнем с готовым ZIP файле `.verification.json`. Интерактивный запуск в PyCharm пользователя и повторение сценария Markdown проверяются отдельно после установки; автоматическая проверка их не заменяет.

Проверки 5.16.233 включают автоматические тесты и Plugin Verifier на PY-251.25410.159, а также состав ZIP и совпадение общего ядра с остальными пакетами релиза. Установка и интерактивная проверка в IDE выполняются отдельно; процесс сборки не изменяет пользовательские задачи или настройки. Все варианты скачивания: [общая страница релиза](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.16.233).
