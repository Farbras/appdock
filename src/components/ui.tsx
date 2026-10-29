import type { LucideIcon } from "lucide-react";
import {
  ArrowDownToLine,
  Boxes,
  Code2,
  Coffee,
  Database,
  FileText,
  FolderOpen,
  Globe,
  Heart,
  History,
  KanbanSquare,
  LayoutGrid,
  Monitor,
  Package,
  Palette,
  RefreshCw,
  Ruler,
  Settings2,
  Smartphone,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { Product } from "../types";

const icons: Record<string, LucideIcon> = {
  LayoutGrid,
  Globe,
  Code2,
  Boxes,
  KanbanSquare,
  FileText,
  Palette,
  Ruler,
  Database,
  Package,
  Coffee,
  Smartphone,
};
export const navItems = [
  ["catalog", "Каталог", LayoutGrid],
  ["installed", "Установленные", Monitor],
  ["updates", "Обновления", RefreshCw],
  ["profile", "Профиль ПК", Monitor],
  ["downloads", "Полученные файлы", FolderOpen],
  ["queue", "Загрузки и установка", ArrowDownToLine],
  ["presets", "Наборы", Boxes],
  ["favorites", "Избранное", Heart],
  ["history", "История", History],
  ["settings", "Настройки", Settings2],
] as const;
export const doneStatuses = [
  "installed",
  "current",
  "downloaded",
  "opened",
  "shortcut-created",
  "reboot-required",
];
export const terminalStatuses = [
  ...doneStatuses,
  "error",
  "action-required",
  "cancelled",
  "blocked",
  "user-completed",
];
const iconLetters: Record<string, string> = {
  "visual-studio": "VS",
  vscode: "",
  wordcraft: "W",
  gridcraft: "G",
  deckcraft: "D",
  photocraft: "P",
  word: "W",
  myoffice: "МО",
  r7: "Р7",
  kompas: "К",
  solidworks: "SW",
  catia: "3D",
  creo: "creo",
  nanocad: "nC",
  archicad: "A",
  zeal: "Z",
  yandex: "Я",
  autodesk: "A",
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const Component = icons[name] || Package;
  return <Component size={size} />;
}
export function Logo({
  app,
  small = false,
}: {
  app: Product;
  small?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={`product-logo ${small ? "small" : ""} logo-${app.id}`}
      style={{ "--brand": app.color } as React.CSSProperties}
    >
      {!failed ? (
        <img
          src={`/icons/${app.icon}.svg`}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : app.id === "vscode" ? (
        <Code2 size={small ? 21 : 31} />
      ) : (
        <span>{iconLetters[app.id] || app.name.slice(0, 2)}</span>
      )}
    </span>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <div className="brand-icon">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span>
        AppDock<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab" && el) {
        const nodes = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select,textarea,[tabindex="0"],a[href]',
          ),
        );
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === el)
        ) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
