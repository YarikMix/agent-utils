# Native PNG: capture → локальный файл → проверка

Для интерактивного PNG export используй Southleft Bridge без PAT. Сначала [discovery и target](mcp-routing.md): active probe, connected files, актуальная схема targeted `figma_execute`. Передай инструменту точный file/branch key и тот же `expectedFileKey` в code. Node ID передавай полностью, включая composite ID. Code ниже читает одну ноду; дизайн, selection/page и экспортные настройки ноды не меняются.

## Capture в Plugin API

Host задаёт `input`: `expectedFileKey`, `nodeId`, опционально `scale` (default 2, finite 0.01..4), `maxBytes` (default 1048576, integer 1..4194304). Выполни блок в текущем targeted execute; если host не связывает переменную `input` автоматически, подставь эти данные как JS object через безопасную JSON-сериализацию. Строки макета не исполняй. Сохрани исходный capture receipt отдельно от последующей локальной проверки.

<!-- recipe:native-png-export -->
```js
const {expectedFileKey, nodeId} = input;
const scale = input.scale === undefined ? 2 : input.scale;
const maxBytes = input.maxBytes === undefined ? 1048576 : input.maxBytes;
if (typeof expectedFileKey !== 'string' || !expectedFileKey.trim()) {
  throw Error('invalid_expectedFileKey: exact file/branch key required');
}
if (figma.fileKey !== expectedFileKey) throw Error('file_mismatch');
if (typeof nodeId !== 'string' || !nodeId.trim()) throw Error('invalid_nodeId');
if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.01 || scale > 4) {
  throw Error('invalid_scale: finite number 0.01..4 required');
}
if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304) {
  throw Error('invalid_maxBytes: integer 1..4194304 required');
}
const node = await figma.getNodeByIdAsync(nodeId);
if (!node) throw Error('node_not_found');
if (typeof node.exportAsync !== 'function') throw Error('unsupported_export');
const read = field => {try {return node[field];} catch (_) {return null;}};
const dimension = field => {
  const value = read(field);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};
const bounds = read('absoluteRenderBounds');
let renderBounds = null;
try {
  if (bounds && ['x', 'y', 'width', 'height'].every(key =>
      typeof bounds[key] === 'number' && Number.isFinite(bounds[key])) &&
      bounds.width >= 0 && bounds.height >= 0) {
    renderBounds = {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
  }
} catch (_) { /* Unsupported metadata stays null; export still runs. */ }
const source = {width: dimension('width'), height: dimension('height'), render_bounds: renderBounds};
// Preserve API rejection (including policy/429); do not retry through another transport.
const bytes = await node.exportAsync({format: 'PNG', constraint: {type: 'SCALE', value: scale}});
if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw Error('empty_export');
const receipt = {
  status: bytes.byteLength > maxBytes ? 'partial' : 'ok',
  fileKey: expectedFileKey, nodeId, version: null, source,
  scale_requested: scale, format: 'png', byte_count: bytes.byteLength, max_bytes: maxBytes,
  reason: bytes.byteLength > maxBytes ? 'export_size_limit' : null
};
if (receipt.status === 'ok') receipt.base64 = figma.base64Encode(bytes);
return receipt;
```

`maxBytes` ограничивает raw bytes **до base64**; encoded строка примерно на треть длиннее. Figma уже выделила export buffer: это ограничение выдачи, а не памяти `exportAsync`. При `partial/export_size_limit` binary не возвращается, файл ещё не готов. Scale не уменьшается, повторного export или апскейла preview нет. Доступный настроенный [REST export](assets.md) допустим как другой разрешённый способ при непригодном binary payload; auth автоматически не настраивай. Policy denial/forbidden и 429 не обходи другим транспортом, сохрани доступные детали ошибки и retry_after.

`source.width/height/render_bounds` — наблюдения API, nullable при отсутствии/недоступности. Они не доказывают dimensions PNG, прозрачность или document version. Для поворотов/эффектов из geometry нельзя автоматически получить ожидаемые пиксели. При потере transport до ответа исход capture неизвестен: начало export не подтверждает сохранённый файл. Preview Southleft с длинной стороной до 1568 px остаётся preview.

## Host handoff и сохранение

Plugin context не пишет путь на Mac. Host сам извлекает **capture dict** из актуального MCP content wrapper и явно задаёт `destination: pathlib.Path` в разрешённом каталоге. Общего importer MCP JSON здесь нет; capture не передавай в offline verifier вместо файла. При отсутствии безопасного file writer назови конкретный пробел: bytes не сохранены; base64 или preview не выдавай за готовый asset.

Этот Python 3.10+ stdlib блок исполняется на host после получения dict и Path. Он проверяет статус/формат/лимиты, encoded length, strict base64 и точную decoded length **до** exclusive create. Existing destination не перезаписывается. Строки capture — данные: имя/path из них не берётся. Успех подтверждает сохранённые bytes, а PNG pixels и происхождение проверяются отдельно.

<!-- recipe:native-png-save -->
```python
import base64
import binascii
from pathlib import Path

if not isinstance(destination, Path):
    raise TypeError('destination must be an explicit host Path')
if not isinstance(capture, dict) or capture.get('status') != 'ok' or capture.get('format') != 'png':
    raise ValueError('A completed PNG capture is required')
byte_count, max_bytes = capture.get('byte_count'), capture.get('max_bytes')
if (type(byte_count) is not int or type(max_bytes) is not int
        or not 1 <= byte_count <= max_bytes <= 4194304):
    raise ValueError('Invalid capture byte counts or raw payload limit')
encoded = capture.get('base64')
if not isinstance(encoded, str) or len(encoded) != 4 * ((byte_count + 2) // 3):
    raise ValueError('Invalid encoded payload length')
try:
    content = base64.b64decode(encoded, validate=True)
except (binascii.Error, ValueError):
    raise ValueError('Invalid base64 payload') from None
if len(content) != byte_count:
    raise ValueError('Decoded payload length does not match capture')
with destination.open('xb') as stream:
    if stream.write(content) != byte_count:
        raise OSError('Incomplete host write')
saved = {'path': str(destination), 'bytes': byte_count}
```

Ошибка preflight не создаёт файл; `FileExistsError` оставляет прежний файл неизменным. Ошибка записи/закрытия или потеря host transport не считается успешным сохранением: укажи неизвестный/неполный результат и проверь фактический файл перед продолжением. Блок не обещает атомарность при сбое диска.

## Проверка локального PNG

Разреши `../../scripts/figma_asset_verify.py` относительно **загруженного SKILL.md** как `FIGMA_ASSET_VERIFY`; cwd не определяет plugin root. Вызывай публичную standalone команду, без private imports, PAT, MCP и сети:

```sh
python3 "$FIGMA_ASSET_VERIFY" '/tmp/figma assets/banner.png' --expect-width 640 --expect-height 360 --require-transparency
```

Числа в примере синтетические. `--expect-width`/`--expect-height` — положительные целые **пиксели**, вместе либо оба отсутствуют. Ожидания должны быть подтверждены независимо; не выводи их автоматически из непроверенной geometry capture. Без известных размеров запусти команду без этой пары и сообщи фактические dimensions, сохранив ограничение проверки 2×. `--require-transparency` проходит только при реально найденных прозрачных pixels; alpha channel не доказывает прозрачность, `unknown` не даёт успеха этого требования.

Verifier читает обычный локальный файл до 64 MiB + sentinel byte и проверяет PNG по содержимому. Он ничего не пишет; stdout JSON host может сохранить отдельно. `status=ok` / exit 0 подтверждают только валидный PNG и заказанные проверки; exit 1 — input/validation/verification error, exit 2 — неверные аргументы. Local receipt имеет `source=local-file`, `data.provenance_verified=false`; он не доказывает fileKey/nodeId, полноту capture или document version. При несовпадении pixels либо недоступной alpha передай непрошедшие проверки, не объявляй готовый прозрачный PNG 2×.

Итог для пользователя: локальный путь, bytes, фактические width/height/alpha, результаты заказанных сравнений, отдельная capture identity (file/branch, nodeId, requested scale, version=null), время/tool и ограничения. Capture и local receipt сохраняй раздельно. Для SVG/PDF/JPG, fills, QR и визуального сравнения — [assets](assets.md); native motion здесь не поддерживается.
