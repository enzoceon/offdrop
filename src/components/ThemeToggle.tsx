import { useEffect, useState, type MouseEvent } from "react";
import { Moon, Sun } from "lucide-react";

const THEME_KEY = "offdrop-theme";

function applyTheme(isDark: boolean) {
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY) || localStorage.getItem("theme");
    const prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = stored ? stored === "dark" : prefers;
    setDark(isDark);
    applyTheme(isDark);
  }, []);

  async function toggle(event: MouseEvent<HTMLButtonElement>) {
    const next = !dark;
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    setDark(next);
    localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    localStorage.setItem("theme", next ? "dark" : "light");
    const root = document.documentElement;
    const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

    const transitionDocument = document as ViewTransitionDocument;
    if (!transitionDocument.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      applyTheme(next);
      return;
    }

    const transition = transitionDocument.startViewTransition(() => applyTheme(next));
    await transition.ready;
    const animationOptions: KeyframeAnimationOptions & { pseudoElement: string } = {
      duration: 720,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      pseudoElement: "::view-transition-new(root)",
    };
    root.animate(
      {
        clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
      },
      animationOptions,
    );
  }

  return (
    <button
      onClick={toggle}
      className="glass grid h-10 w-10 place-items-center rounded-full transition-transform active:scale-90"
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
    </button>
  );
}
