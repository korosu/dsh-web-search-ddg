# План: тестирование использования плагина китайскими пользователями (CJK)

Дата: 2026-10-12. Репозиторий: `dsh-web-search-ddg` v0.2.0 (main = 26e9b04).
Статус: план составлен, цель выполнения поставлена (goal текущей сессии).

## 1. Зачем

Плагин поставляется с `README.zh-CN.md` — китайские пользователи являются
целевой аудиторией. При этом покрытия китайских символов в тестах нет вообще:
единственная не-ASCII проверка — кириллица (`tests/ddg.spec.ts:385-392` —
unit, `tests/ddg.e2e.ts:105-110` — live). Нужно проверить все виды китайских
символов (упрощённые, традиционные, смешанные CJK+ASCII, полноширинные
знаки, астральные/Ext-B, эмодзи) по всему пути запроса и парсинга.

## 2. Поверхность риска (где китайские символы проходят через плагин)

| # | Путь | Код | Ожидание |
|---|------|-----|----------|
| 1 | Кодирование запроса | `src/provider.ts:326` `url.searchParams.set('q', request.query)` | UTF-8 percent-encoding, пробел → `+` |
| 2 | Декодирование ответа | `src/provider.ts:363` `response.text()` | charset из заголовка; DDG отдаёт UTF-8 (проверить live) |
| 3 | HTML-entities в title/snippet | `src/provider.ts:481-482` cheerio `.text()` | численные (`&#20013;&#25991;`) и именованные (`&hellip;`) ссылки декодируются |
| 4 | Декодирование редиректа | `src/provider.ts:164` `searchParams.get('uddg')` | percent-encoded и уже декодированный китайский URL |
| 5 | Канонизация URL | `src/provider.ts:162` `new URL(candidate).toString()` | сырой CJK в path → percent-encoded; сыбой IDN-хост → punycode (`中文.cn` → `xn--fiq228c.cn`) |
| 6 | Поле `bytes` в логе | `src/provider.ts:369` `html.length` | **дефект**: это длина в UTF-16 code units, не байты; для китайской страницы занижено ~3× (`'<div id="links">中文标题</div>'` → 26 vs 34) |

Фактические ожидания (проверено на Node 24.18.0 в этой сессии):
- `中文搜索 繁體中文 Python 3 教程 𠮷 🚀 ＂std＂＋` → `q=%E4%B8%AD%E6%96%87%E6%90%9C%E7%B4%A2+%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87+Python+3+%E6%95%99%E7%A8%8B+%F0%A0%AE%B7+%F0%9F%9A%80+%EF%BC%82std%EF%BC%82%EF%BC%8B`
- `https://zh.wikipedia.org/wiki/中文` → `https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87`
- `http://中文.cn/路径` → `http://xn--fiq228c.cn/%E8%B7%AF%E5%BE%84`

## 3. Задачи

### T1. Unit-набор `tests/ddg.cjk.spec.ts` (офлайн, fetch стабается)

Новый файл рядом с `tests/ddg.spec.ts`, тот стиль (`node:test`). Кейсы:

1. Кодирование запроса: упрощённые (`中文搜索`), традиционные (`繁體中文搜尋`),
   смешанные (`Python 3 中文教程`), полноширинные (`＂std::vector＂＋`),
   Ext-B/астральные (`𠮷`), эмодзи (`🚀`) — точные строки ожиданий из §2.
2. `parseResults`: title/snippet с численными (`&#20013;&#25991;`) и
   именованными (`&hellip;`) entity → декодированный текст.
3. `resolveDestination`: `uddg` с percent-encoded CJK path; `uddg` с сырым
   CJK path (канонизация); сырой IDN-хост → punycode; CJK в query-параметре
   (`?search=中文`).
4. `toSource`: title из одной астральной пары (`𠮷`) не отбрасывается.
5. `accept-language: 'zh-CN,zh;q=0.9'` пробрасывается в fetch (документирует
   предназначенный китайскому пользователю knob).
6. Поле `bytes` в `DdgRequestEvent` равно реальной длине UTF-8
   (`Buffer.byteLength`), а не длине строки (после фикса T2).

### T2. Фикс поля `bytes` (подтвердить при выполнении)

`src/provider.ts:369`: `bytes: html.length` → `bytes: Buffer.byteLength(html)`.
Поле документировано как «Response body size in bytes»
(`src/provider.ts:66-67`); китайские страницы недосчитываются в ~3 раза.
Node-only плагин, `Buffer` доступен. Фикс + кейс T1.6.

### T3. Live e2e-кейсы в `tests/ddg.e2e.ts`

Через существующий `liveSearch` (пасинг 10s, self-skip при двойном 202):
упрощённый запрос, традиционный запрос, смешанный CJK+ASCII, запрос с
настроенным `acceptLanguage: 'zh-CN,zh;q=0.9'`. Ассерты — существующий
`expectWellFormed` + допуск percent-encoded CJK в URL результатов.

### T4. Инфраструктура запуска

- `package.json:77` — скрипт `test` добавляет `tests/ddg.cjk.spec.ts`.
- `scripts/compat-matrix.sh:88` — прогон обоих spec-файлов (сейчас только
  `tests/ddg.spec.ts`; иначе CJK-набор не проверяется на матрице версий seam).

### T5. Документация

- Счётчики «73 теста» → новое значение: `README.md:219`, `README.md:168-169`,
  `README.zh-CN.md:217`, `README.zh-CN.md:168-169`, `CONTRIBUTING.md:36`.
- `CHANGELOG.md` — запись в `[Unreleased]` (CJK-покрытие + фикс bytes).
- Краткая заметка о CJK-покрытии в секциях тестирования обоих README.

### T6. Проверка и коммит

`pnpm test` (всё зелёное), `pnpm typecheck`, `pnpm build` ( `lib/` в git),
опционально `DDG_E2E=1 pnpm test:e2e` (live, ~1–2 мин). Коммит в main.
Вопрос релиза 0.2.1 (есть фикс) — вынести пользователю.

## 4. Вне области

- GBK/GB2312: DDG отдаёт UTF-8; кодировку подтверждает live-кейс T3.
  Признаков легаси-кодировок нет — декодирование по заголовку не трогаем.
- Отображение punycode/локальная маршрутизация — зона потребителя и DDG.
- Локализация README — уже есть (`README.zh-CN.md`).
