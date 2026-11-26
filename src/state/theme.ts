import { create } from "zustand";

/** Appearance setting: follow the system, or always light / dark. */
export type ThemeChoice = "system" | "light" | "dark";

// index.html reads the same key before the first paint
const KEY = "map3d.theme";
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function loadChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

const resolve = (choice: ThemeChoice) => choice === "dark" || (choice === "system" && !!media?.matches);

/** the UI colors come from CSS variables switched by this attribute (index.css) */
function apply(dark: boolean) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

type ThemeStore = {
  choice: ThemeChoice;
  /** what is shown now */
  dark: boolean;
  setChoice: (choice: ThemeChoice) => void;
};

const initial = loadChoice();

export const useThemeStore = create<ThemeStore>((set) => ({
  choice: initial,
  dark: resolve(initial),
  setChoice: (choice) => {
    try {
      localStorage.setItem(KEY, choice);
    } catch {}
    const dark = resolve(choice);
    apply(dark);
    set({ choice, dark });
  },
}));

apply(useThemeStore.getState().dark);
// "system" follows the OS switching between light and dark
media?.addEventListener("change", () => {
  const { choice } = useThemeStore.getState();
  if (choice !== "system") return;
  const dark = resolve(choice);
  apply(dark);
  useThemeStore.setState({ dark });
});
