# Гайдлайн по иконкам

Короткие правила для всех иконок во фронтенде.

## 1. Источник иконок

- **Единственный разрешённый источник UI-иконок — пакет [`lucide-react`](https://lucide.dev/).**
- Импорт только именованный, например:
  ```tsx
  import { Send, Loader2 } from "lucide-react";
  ```
- **Запрещённые библиотеки иконок** (использовать нельзя ни в `dependencies`,
  ни в `devDependencies`):
  - `react-icons`
  - `@heroicons/react`
  - `@radix-ui/react-icons`
  - `@fortawesome/*` (`fontawesome-svg-core`, `react-fontawesome`,
    `free-solid-svg-icons`, `free-regular-svg-icons`, `free-brands-svg-icons`)
  - `react-feather`
  - `react-bootstrap-icons`
  - `@tabler/icons-react`

Если нужной иконки в `lucide-react` нет, оформляйте её как
[`Brand_Icon_Component`](#5-добавление-brand_icon_component) в этой директории.

## 2. Размеры и обводка

- Размер задаётся **только** Tailwind-классами `h-{n} w-{n}`, где
  `n ∈ {3, 4, 5, 6, 8}` (12, 16, 20, 24, 32 px). Значения `h-` и `w-`
  должны совпадать.
- **Запрещены** атрибуты `width` и `height` на компонентах `lucide-react`.
- **Default `strokeWidth` = 2** (это значение по умолчанию у Lucide).
  При необходимости можно явно использовать значение из набора
  `{1, 1.5, 2, 2.5, 3}` через проп `strokeWidth` конкретного экземпляра.
  Глобальную конфигурацию обводки менять не нужно.
- Цвет наследуется от `currentColor`. **Запрещены** инлайн-атрибуты
  `color`, `fill`, `stroke` на иконках Lucide. Цвет задаётся через
  Tailwind-классы вида `text-accent`, `text-text-muted` и т. д.
  Исключение — `Brand_Icon_Component`, где фирменный цвет логотипа
  «зашит» внутри самого SVG (Google logo).

```tsx
import { Send, Loader2 } from "lucide-react";

// Нормально
<Send className="h-4 w-4" />
<Loader2 className="h-4 w-4 animate-spin text-accent" />

// Нельзя
<Send width={16} height={16} />
<Send className="h-4 w-4" color="red" />
```

## 3. Доступность

- Если рядом с иконкой есть **видимый текст** (например, кнопка
  `<Send /> Отправить`), иконка декоративная — добавляйте
  `aria-hidden="true"`.
- Если иконка передаёт смысл и видимого текста нет (например, кнопка
  только с иконкой), нужно доступное имя на русском, длиной 1–100
  символов. Варианты:
  - `aria-label="Отправить сообщение"` на родительской кнопке;
  - `aria-label="..."` непосредственно на иконке;
  - визуально скрытый текстовый узел (`<span className="sr-only">…</span>`).

```tsx
// Декоративная иконка с текстом
<button>
  <Send className="h-4 w-4" aria-hidden="true" />
  Отправить
</button>

// Иконка-кнопка без текста
<button aria-label="Отправить сообщение">
  <Send className="h-4 w-4" aria-hidden="true" />
</button>
```

## 4. Спиннеры и индикаторы загрузки

Loader реализуется через `Loader2` из `lucide-react` с классом `animate-spin`:

```tsx
import { Loader2 } from "lucide-react";

<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
```

Не используйте кастомные `<svg>` для спиннеров — это нарушает ESLint-правило
`local-icons/no-inline-svg-outside-icons`.

## 5. Добавление `Brand_Icon_Component`

Если нужная иконка отсутствует в `lucide-react` (типичный случай —
фирменный логотип стороннего сервиса):

1. Создайте файл компонента **в этой директории**: `frontend/src/components/icons/MyBrandIcon.tsx`.
2. Имя компонента — `PascalCase`, например `GoogleIcon`, `MetaIcon`.
3. Компонент **обязательно** принимает пропсы `className` и `aria-hidden`,
   чтобы вызывающий код мог управлять размером и доступностью так же,
   как у `Lucide_Icon`. Не меняйте SVG-разметку при использовании.
4. Размер задаётся вызывающим кодом через `className="h-{n} w-{n}"`,
   а не атрибутами `width`/`height`.
5. Цвет фирменного логотипа фиксируется внутри SVG атрибутами `fill`/`stroke`
   на отдельных `<path>` (это исключение из правила «только `currentColor`»,
   допустимое для бренд-иконок).

Пример каркаса:

```tsx
// frontend/src/components/icons/MyBrandIcon.tsx
import type { SVGProps } from "react";

type MyBrandIconProps = Omit<SVGProps<SVGSVGElement>, "children">;

export function MyBrandIcon({
  className,
  "aria-hidden": ariaHidden = true,
  ...rest
}: MyBrandIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden={ariaHidden}
      role="img"
      {...rest}
    >
      {/* Фирменные пути с собственными fill/stroke */}
    </svg>
  );
}
```

Использование:

```tsx
import { GoogleIcon } from "@/components/icons/GoogleIcon";

<button aria-label="Войти через Google">
  <GoogleIcon className="h-5 w-5" />
  Войти через Google
</button>
```

## 6. Защита от регрессий

- ESLint-правило в `frontend/eslint.config.mjs` запрещает JSX-элемент
  `<svg>` во всех файлах внутри `frontend/src`, кроме файлов из этой
  директории (`frontend/src/components/icons/**`).
- Импорт из запрещённых библиотек иконок (см. раздел 1) тоже отлавливается
  ESLint и приводит к ошибке сборки.

Если правило мешает — это сигнал создать `Brand_Icon_Component` в этой
директории, а не отключать линтер.
