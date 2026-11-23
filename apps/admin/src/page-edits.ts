import { createContext, useContext, useLayoutEffect } from "react";

export type EditState = "dirty" | "saving";
export const PageEditsContext = createContext<Set<EditStateRegistration> | null>(null);
interface EditStateRegistration {
  state: EditState;
}

/** 记录内存中尚未提交的编辑。保存或卸载后同步解除导航与刷新提示。 */
export function usePageEdits(dirty: boolean, saving = false) {
  const registry = useContext(PageEditsContext);
  useLayoutEffect(() => {
    if (!registry || (!dirty && !saving)) return;
    const item: EditStateRegistration = { state: saving ? "saving" : "dirty" };
    registry.add(item);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      registry.delete(item);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, saving, registry]);
}
