# Скачать IVOL Code Agent 5

**[Общая страница релиза 5.16.233](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.16.233)** — эту ссылку можно отправлять другим пользователям.

## Выберите свою версию IDE

Версию и номер сборки IDE можно посмотреть в **Help → About**. Версия плагина **5.16.233** не связана с номером версии IDE.

| Приложение    | Проверенная версия и сборка      | Установочный файл                                                                                                                                      |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VS Code       | Пакет VSIX                       | [Скачать для VS Code](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/ivol-code-agent-5-5.16.233.vsix)                         |
| PhpStorm      | **2026.2.2**, PS-262.10315.130   | [Скачать для PhpStorm](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/ivol-code-agent-5-5.16.233-phpstorm.zip)                |
| IntelliJ IDEA | **2026.2.2**, IU-262.10315.125   | [Скачать для IDEA 2026.2](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/ivol-code-agent-5-5.16.233-intellij-idea.zip)        |
| IntelliJ IDEA | **2025.3.6.1**, IU-253.33813.55  | [Скачать для IDEA 2025.3](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/ivol-code-agent-5-5.16.233-intellij-idea-2025.3.zip) |
| PyCharm       | **2025.1.1.1**, PY-251.25410.159 | [Скачать для PyCharm 2025.1](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/ivol-code-agent-5-5.16.233-pycharm-2025.1.zip)    |

**Для IDEA 2025.3 нужен файл с `intellij-idea-2025.3` в имени.** Архив `intellij-idea.zip` предназначен для IDEA 2026.2 и не подходит для 2025.3. Другие основные версии IDE здесь не заявлены.

## Как установить

**VS Code:** Extensions → меню **…** → **Install from VSIX…** → выбрать скачанный `.vsix`.

**PhpStorm / IntelliJ IDEA / PyCharm:** Settings → Plugins → шестерёнка → **Install Plugin from Disk** → выбрать скачанный `.zip` **без распаковки**.

Завершите текущую работу перед перезапуском IDE. Уже установленный IVOL Code обновляется поверх: удалять историю или настройки не требуется. Официальный Kilo Code и IVOL Code не следует включать одновременно в одной IDE.

В GitHub Assets выбирайте файл плагина, а не автоматически добавленные **Source code (zip)** / **Source code (tar.gz)**: это исходники, не установщик.

## Требования

- Для JetBrains нужен установленный **Node.js 20.6.0 или новее**, доступный IDE. Node.js в архивы не включён.
- Используйте штатный JetBrains Runtime с JCEF; встроенный плагин Terminal должен быть включён.
- PhpStorm и IDEA 2026.2 используют Java 25; IDEA 2025.3 и PyCharm 2025.1 — Java 21.
- В JetBrains-пакетах есть нативные зависимости для Windows x64, Linux x64, macOS Intel и Apple Silicon. Windows ARM64 и Linux ARM64 не заявлены. Наличие зависимостей не означает проверку запуска на всех ОС.

## Что изменилось в 5.16.233

- Исправлена ошибка запуска `NoSuchFileException` для `watcher.node`, которая могла возникать при одновременном открытии нескольких проектов.
- Подготовка нативных библиотек защищена от повторного и параллельного запуска. Исправление общего адаптера включено в PhpStorm, оба целевых варианта IntelliJ IDEA и PyCharm.
- VS Code собран из той же версии исходников; ошибочный механизм запуска JetBrains в нём не используется. Все функции предыдущего релиза сохранены.

Общее ядро, интерфейс и функции 5.16.233 одинаковы во всех пакетах. Проверки JetBrains включают автоматические тесты, состав архивов и Plugin Verifier на указанной версии IDE. Интерактивный запуск после установки проверяется отдельно; проверка совместимости не гарантирует работу на любых будущих версиях IDE.

Контрольные суммы установочных файлов находятся в [SHA256SUMS.txt](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.233/SHA256SUMS.txt).
