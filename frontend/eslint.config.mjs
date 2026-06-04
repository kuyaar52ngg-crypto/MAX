import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Запрещённые библиотеки иконок (см. requirements.md, Requirement 1).
// Любой импорт из этих пакетов приводит к ошибке сборки.
const FORBIDDEN_ICON_PACKAGES = [
  "react-icons",
  "@heroicons/react",
  "@radix-ui/react-icons",
  "@fortawesome/fontawesome-svg-core",
  "@fortawesome/react-fontawesome",
  "@fortawesome/free-solid-svg-icons",
  "@fortawesome/free-regular-svg-icons",
  "@fortawesome/free-brands-svg-icons",
  "react-feather",
  "react-bootstrap-icons",
  "@tabler/icons-react",
];

const NO_INLINE_SVG_MESSAGE =
  "Inline <svg> запрещён вне 'src/components/icons/'. Используйте иконку из 'lucide-react' или создайте Brand_Icon_Component в 'src/components/icons/'.";

const NO_FORBIDDEN_ICON_LIBS_MESSAGE =
  "UI-иконки разрешены только из 'lucide-react'. Бренд-иконки оформляются как компоненты в 'src/components/icons/'.";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      // Все UI-иконки — только из lucide-react. Запрещаем альтернативные библиотеки.
      "no-restricted-imports": [
        "error",
        {
          paths: FORBIDDEN_ICON_PACKAGES.map((name) => ({
            name,
            message: NO_FORBIDDEN_ICON_LIBS_MESSAGE,
          })),
          patterns: [
            {
              group: ["@fortawesome/*"],
              message: NO_FORBIDDEN_ICON_LIBS_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // Inline <svg> разрешён только в директории Brand_Icon_Component.
    // Везде остальное должно использовать lucide-react.
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    ignores: ["src/components/icons/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='svg']",
          message: NO_INLINE_SVG_MESSAGE,
        },
      ],
    },
  },
];

export default eslintConfig;
