import { render } from 'preact';
import { Router, Route, Switch } from 'wouter-preact';
import './styles/globals.css';
import { Layout } from './components/Layout';
import { HomePage } from './pages/Home';
import { SimulatorPage } from './pages/Simulator';
import { ReplayPage } from './pages/Replay';
import { DiffPage } from './pages/Diff';
import { MigratePage } from './pages/Migrate';
import { DetectionPage } from './pages/Detection';
import { ProjectsPage } from './pages/Projects';
import { ConfigPage } from './pages/Config';
import { TestsPage } from './pages/Tests';
import { BlogIndexPage } from './pages/BlogIndex';
import { BlogPostPage } from './pages/BlogPost';
import { DocsPage } from './pages/Docs';
import { NotFoundPage } from './pages/NotFound';

// When the SPA is served from a sub-path (Vite `base=/logflow/`), Wouter
// needs the same prefix or every client-side route mismatches. Strip the
// trailing slash because Wouter expects an "anchor" path, not a slash-
// terminated mount point. Empty string = root mount.
const ROUTER_BASE =
  (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');

function App() {
  return (
    <Router base={ROUTER_BASE}>
      <Layout>
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/simulator" component={SimulatorPage} />
          <Route path="/replay" component={ReplayPage} />
          <Route path="/diff" component={DiffPage} />
          <Route path="/migrate" component={MigratePage} />
          <Route path="/detection" component={DetectionPage} />
          <Route path="/projects" component={ProjectsPage} />
          <Route path="/config" component={ConfigPage} />
          <Route path="/tests" component={TestsPage} />
          <Route path="/blog" component={BlogIndexPage} />
          <Route path="/blog/:slug">
            {(params: Record<string, string | undefined>) =>
              params.slug ? <BlogPostPage slug={params.slug} /> : <NotFoundPage />
            }
          </Route>
          <Route path="/docs">{() => <DocsPage />}</Route>
          <Route path="/docs/:slug">
            {(params: Record<string, string | undefined>) => <DocsPage slug={params.slug} />}
          </Route>
          <Route component={NotFoundPage} />
        </Switch>
      </Layout>
    </Router>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
