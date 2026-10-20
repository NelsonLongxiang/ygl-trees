/**
 * Workbench shell: header (wordmark · view nav · project · theme switch) over
 * one routed view. Hash history keeps api/* paths relative, so the static build
 * still works from any sub-path; webui serve needs no route table.
 */
import { HashRouter, Link, NavLink, Outlet, Route, Routes } from "react-router";
import { Alert, Card, Layout, Tag, Typography } from "antd";
import { useDashboard, DashboardProvider } from "./data";
import { ThemeProvider, ThemeToggle } from "./theme";
import { C } from "./tokens";
import {
  ArtifactsPage, GraphPage, OverviewPage, PipelinePage, TreePage, VerifyPage,
} from "./pages";

const { Header, Content } = Layout;
const { Text } = Typography;

/** View nav — terse nouns (DESIGN.md content fundamentals); path = route. */
export const VIEWS = [
  { path: "/", label: "概览" },
  { path: "/pipeline", label: "研究管线" },
  { path: "/tree", label: "科技树" },
  { path: "/graph", label: "知识图谱" },
  { path: "/verify", label: "验证器" },
  { path: "/artifacts", label: "产出工件" },
] as const;

function ProjectTag() {
  const { data } = useDashboard();
  if (data?.brief?.project) {
    return (
      <Tag color="success" style={{ marginInlineEnd: 0 }}>
        {data.brief.project.name}
        {data.brief.selection_source && (
          <span style={{ opacity: 0.65, marginLeft: 6 }}>· {data.brief.selection_source}</span>
        )}
      </Tag>
    );
  }
  if (data?.unselected) return <Tag color="warning" style={{ marginInlineEnd: 0 }}>未选择项目</Tag>;
  return null;
}

/** Plain links, not antd Menu: six fixed views need no overflow/submenu machinery
 *  (and Menu costs ~25 kB against the web_dist ratchet). Styles: app.css .yt-nav. */
function ViewNav() {
  return (
    <nav className="yt-nav" aria-label="视图">
      {VIEWS.map((v) => (
        <NavLink key={v.path} to={v.path} end={v.path === "/"}>
          {v.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Shell() {
  const { data, error } = useDashboard();

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          borderBottom: `1px solid ${C.border}`,
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <Link to="/" style={{ display: "flex", alignItems: "baseline", gap: 10, whiteSpace: "nowrap" }}>
          <Text style={{ fontSize: 20, fontWeight: 700, color: C.text }}>ygl-trees</Text>
          <Text type="secondary" style={{ fontSize: 13 }}>研究工作台</Text>
        </Link>
        <ViewNav />
        <ProjectTag />
        <ThemeToggle />
      </Header>

      <Content style={{ padding: 24, maxWidth: 1360, margin: "0 auto", width: "100%" }}>
        {error && !data && (
          <Alert
            type="error"
            title="API 不可达"
            description={<Text code>ygl-trees webui serve --port 8642</Text>}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        {!data && !error && <Card loading style={{ marginBottom: 16 }} />}
        <Outlet />
      </Content>
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <DashboardProvider>
        <HashRouter>
          <Routes>
            <Route path="/" element={<Shell />}>
              <Route index element={<OverviewPage />} />
              <Route path="pipeline" element={<PipelinePage />} />
              <Route path="tree" element={<TreePage />} />
              <Route path="graph" element={<GraphPage />} />
              <Route path="verify" element={<VerifyPage />} />
              <Route path="artifacts" element={<ArtifactsPage />} />
              <Route path="*" element={<OverviewPage />} />
            </Route>
          </Routes>
        </HashRouter>
      </DashboardProvider>
    </ThemeProvider>
  );
}
