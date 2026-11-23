import { Button, createTheme, MantineProvider, Table } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { useThemeSync } from "./theme.tsx";
import "./admin.css";

const theme = createTheme({
  primaryColor: "blue",
  primaryShade: { light: 7, dark: 5 },
  defaultRadius: "md",
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  components: {
    Button: Button.extend({ defaultProps: { variant: "default" } }),
    Table: Table.extend({ defaultProps: { verticalSpacing: "sm", horizontalSpacing: "md" } }),
  },
});

function Admin() {
  const scheme = useThemeSync();
  return (
    <MantineProvider theme={theme} forceColorScheme={scheme}>
      <App />
    </MantineProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
