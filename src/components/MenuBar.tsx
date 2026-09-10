import { useEffect, useRef, useState } from "react";

export interface MenuItemDef {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
  shortcut?: string;
}

export interface MenuDef {
  label: string;
  items: MenuItemDef[];
}

/** A minimal desktop-app style menu bar (File / Edit / View / ...). */
export function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="menu-bar" ref={barRef}>
      {menus.map((menu) => (
        <div className="menu-bar-item" key={menu.label}>
          <button
            className={`menu-bar-trigger ${openMenu === menu.label ? "active" : ""}`}
            onClick={() =>
              setOpenMenu((current) => (current === menu.label ? null : menu.label))
            }
          >
            {menu.label}
          </button>
          {openMenu === menu.label && (
            <div className="menu-dropdown">
              {menu.items.map((item, i) => (
                <div key={i}>
                  {item.separatorBefore && <div className="menu-separator" />}
                  <button
                    className="menu-dropdown-item"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpenMenu(null);
                      item.onClick?.();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span className="menu-shortcut">{item.shortcut}</span>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
